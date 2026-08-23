import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { getDistanceFromCenter } from '../utils/soundStageMath';
import SoundNode from './SoundNode';
import { playbackEngine } from '../audio/PlaybackEngine';
import type { PlaybackRouting } from '../audio/PlaybackEngine';
import { playSonosOneShot } from '../audio/SonosOneShotOutput';
import RoomLayer from './RoomLayer';
import { getRoomSpeakerGeometry } from '../utils/roomSpeakerMath';
import { getSpeakerMix } from '../utils/spatialMixMath';

import type { SceneInstance } from '../models/SceneInstance';
import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import { DEFAULT_NODE_FADE_MS } from '../models/SceneObjectInstance';
import type { SoundPosition } from '../utils/soundStageMath';
import type { Room } from '../models/Room';
import type { SpeakerMap } from '../models/SpeakerMap';
import type { SoundAsset } from '../models/SoundAsset';
import type { DeployedSceneObjectInstance } from '../models/DeployedSceneObjectInstance';
import { useOutsidePointerDown } from '../hooks/useOutsidePointerDown';
import { getBalancedFieldPositionalMix } from '../utils/balancedFieldRouting';
import { recordDiagnostic } from '../services/diagnostics/DiagnosticClient';

interface SoundStageProps {
  scene: SceneInstance;
  soundAssets: SoundAsset[];
  activeRoom: Room | null;
  activeSpeakerMap: SpeakerMap;
  onRoomChange: (room: Room) => void;
  onSceneChange: (scene: SceneInstance) => void;

  selectedNodeId: string | null;
  onSelectedNodeChange: (
    instanceId: string | null,
    sourceNodeId?: string
  ) => void;
}

export interface SoundStageHandle {
  startNodes: (nodes: SceneObjectInstance[]) => Promise<void>;
  pauseNodes: (nodes: SceneObjectInstance[]) => void;
}

interface NodeContextMenu {
  instanceId: string;
  x: number;
  y: number;
  kind: 'field' | 'soundShelf' | 'ambienceShelf';
}

const SoundStage = forwardRef<SoundStageHandle, SoundStageProps>(function SoundStage({
  scene,
  soundAssets,
  activeRoom,
  activeSpeakerMap,
  onSceneChange,
  selectedNodeId,
  onSelectedNodeChange,
  onRoomChange,
}: SoundStageProps, ref) {
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  useSyncExternalStore(
    playbackEngine.subscribe,
    playbackEngine.getPlaybackVersion
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const roomDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);

  const [roomLocked, setRoomLocked] = useState(true);
  const [roomZoom, setRoomZoom] = useState(1);
  const [roomDragging, setRoomDragging] = useState(false);
  const [soundSpawnMenuOpen, setSoundSpawnMenuOpen] = useState(false);
  const [draggingShelfNodeId, setDraggingShelfNodeId] =
    useState<string | null>(null);
  const [fieldDropActive, setFieldDropActive] = useState(false);
  const [temporaryDeployments, setTemporaryDeployments] =
    useState<DeployedSceneObjectInstance[]>([]);
  const [fieldMessage, setFieldMessage] = useState<string | null>(null);
  const fieldMessageTimerRef = useRef<number | null>(null);
  const playbackDiagnosticsRef = useRef(new Map<string, {
    correlationId: string;
    assetId: string;
    startedAt: number;
    sourceInstances: number;
    targetSpeakers: string[];
  }>());
  const lastPositionDiagnosticRef = useRef(new Map<string, number>());

  useEffect(() => () => {
    if (fieldMessageTimerRef.current !== null) {
      window.clearTimeout(fieldMessageTimerRef.current);
    }
  }, []);

  const [resizingCircle, setResizingCircle] =
    useState<'center' | 'full' | null>(null);
  
  const [nodeContextMenu, setNodeContextMenu] =
    useState<NodeContextMenu | null>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement>(null);

  useOutsidePointerDown(
    nodeContextMenuRef,
    nodeContextMenu !== null,
    () => setNodeContextMenu(null)
  );

  const [centerRadius, setCenterRadius] = useState(0.14);

  const [fullVolumeRadius, setFullVolumeRadius] = useState(0.62);

  const MAX_POSITIONAL_RADIUS = 0.98;
  const shelvedSoundNodes = scene.positionalObjects.filter(
    (node) => node.placement === 'shelf'
  );
  const deployedSoundNodes = scene.positionalObjects.filter(
    (node) => node.placement !== 'shelf'
  );
  const referencedDeployments = [
    ...(scene.deployedObjects ?? []),
    ...temporaryDeployments,
  ].flatMap((deployment) => {
    const sourceNode = scene.positionalObjects.find(
      (node) => node.instanceId === deployment.sourceNodeId
    );

    return sourceNode
      ? [{
          deployment,
          node: {
            ...sourceNode,
            instanceId: deployment.instanceId,
            placement: 'field' as const,
            position: deployment.position,
          },
        }]
      : [];
  });
  const allDeployedSoundNodes = [
    ...deployedSoundNodes.map((node) => ({
      node,
      deployment: undefined as DeployedSceneObjectInstance | undefined,
    })),
    ...referencedDeployments,
  ];

  const speakerGeometry =
  activeRoom
    ? getRoomSpeakerGeometry(activeRoom)
    : [];
  const selectedNode =
    scene.positionalObjects.find(
      (node) => node.instanceId === selectedNodeId
    ) ??
    scene.ambientObjects.find(
      (node) => node.instanceId === selectedNodeId
    ) ??
    referencedDeployments.find(
      ({ node }) => node.instanceId === selectedNodeId
    )?.node ??
    null;

  const selectedNodePosition =
    selectedNode &&
    allDeployedSoundNodes.some(
      ({ node }) => node.instanceId === selectedNode.instanceId
    )
      ? selectedNode.position ?? null
      : null;

  const speakerMix =
    selectedNodePosition
      ? getSpeakerMix(
        selectedNodePosition,
        speakerGeometry,
        centerRadius,
        fullVolumeRadius
      )
    : [];
  const sceneVolume = scene.volume;
  const isSonosRoom = activeSpeakerMap.adapterType === 'sonos';

  useEffect(() => {
    playbackEngine.setSceneVolume(scene.instanceId, sceneVolume);

    for (const node of [
      ...scene.positionalObjects,
      ...scene.ambientObjects,
    ]) {
      playbackEngine.updateNodeGain(
        scene.instanceId,
        node.instanceId,
        node.gainDb ?? 0,
        node.muted
      );
    }
  }, [
    scene.instanceId,
    sceneVolume,
    scene.positionalObjects,
    scene.ambientObjects,
  ]);

  useEffect(() => {
    if (isSonosRoom) {
      playbackEngine.stopScene(scene.instanceId);
    }
  }, [isSonosRoom, scene.instanceId]);

  function getPositionFromPointer(
    clientX: number,
    clientY: number
  ): SoundPosition | null {
    const bounds =
      stageRef.current?.getBoundingClientRect();

    if (!bounds) {
      return null;
    }

    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;

    return {
      x: (localX / bounds.width) * 2 - 1,
      y: -((localY / bounds.height) * 2 - 1),
    };
  }

  function clampToPositionalArea(
    position: SoundPosition
  ): SoundPosition {
    const distance =
      getDistanceFromCenter(position);

    if (distance <= MAX_POSITIONAL_RADIUS) {
      return position;
    }

    const scale =
      MAX_POSITIONAL_RADIUS / distance;

    return {
      x: position.x * scale,
      y: position.y * scale,
    };
  }

  function handleStageContextMenu(
    event: React.MouseEvent<HTMLDivElement>
  ) {
    event.preventDefault();

    setNodeContextMenu(null);

  }

  function createShelfNode(
    kind: 'oneShot' | 'loop' | 'ambience'
  ) {
    const isAmbience = kind === 'ambience';
    const newNode: SceneObjectInstance = {
      instanceId: crypto.randomUUID(),
      instanceName: isAmbience ? 'New Ambience' : 'New Sound',
      soundAssetIds: [],
      playbackMode: kind === 'oneShot' ? 'oneShot' : 'loop',
      placement: 'shelf',
      onLoad: isAmbience,
      fadeInEnabled: false,
      fadeInMs: DEFAULT_NODE_FADE_MS,
      fadeOutEnabled: false,
      fadeOutMs: DEFAULT_NODE_FADE_MS,
      excludeFromBulkControls: false,
      randomStart: false,
      gainDb: 0,
      muted: false,
    };

    onSceneChange({
      ...scene,
      positionalObjects: isAmbience
        ? scene.positionalObjects
        : [...scene.positionalObjects, newNode],
      ambientObjects: isAmbience
        ? [...scene.ambientObjects, newNode]
        : scene.ambientObjects,
    });
    onSelectedNodeChange(newNode.instanceId);
    setSoundSpawnMenuOpen(false);
  }

  function handleNodePositionChange(
    instanceId: string,
    position: SoundPosition,
    isAmbient: boolean
  ) {
    if (isAmbient) {
      return;
    }

    const clampedPosition = clampToPositionalArea(position);
    const deployedNode = allDeployedSoundNodes.find(
      ({ node }) => node.instanceId === instanceId
    )?.node;

    if (deployedNode) {
      const oldPosition = deployedNode.position;
      const oldMix = getRoomSpeakerMixForNode(deployedNode);
      playbackEngine.updateSpatialMix(
        instanceId,
        getStereoMixForNode({
          ...deployedNode,
          position: clampedPosition,
        })
      );
      const diagnostic = playbackDiagnosticsRef.current.get(instanceId);
      const now = performance.now();
      if (diagnostic && now - (lastPositionDiagnosticRef.current.get(instanceId) ?? 0) >= 500) {
        lastPositionDiagnosticRef.current.set(instanceId, now);
        void recordDiagnostic({
          category: 'spatial', level: 'info', event: 'spatial.gains_updated',
          message: 'Spatial playback gains updated.', correlationId: diagnostic.correlationId,
          details: {
            oldPosition, newPosition: clampedPosition,
            oldGains: oldMix,
            newGains: getRoomSpeakerMixForNode({ ...deployedNode, position: clampedPosition }),
            gainRoutingUpdatedLive: !isSonosRoom,
            playbackReconstructed: false,
          },
        });
      }
    }

    const temporaryDeployment = temporaryDeployments.find(
      (deployment) => deployment.instanceId === instanceId
    );

    if (temporaryDeployment) {
      setTemporaryDeployments((current) =>
        current.map((deployment) =>
          deployment.instanceId === instanceId
            ? { ...deployment, position: clampedPosition }
            : deployment
        )
      );
      return;
    }

    onSceneChange({
      ...scene,

      positionalObjects:
        scene.positionalObjects.map((node) =>
          node.instanceId === instanceId
            ? {
                ...node,
                position: clampedPosition,
              }
            : node
        ),
      deployedObjects: (scene.deployedObjects ?? []).map((deployment) =>
        deployment.instanceId === instanceId
          ? { ...deployment, position: clampedPosition }
          : deployment
      ),
    });
  }

  function getStereoMixForNode(
    node: SceneObjectInstance
  ) {
    const isAmbience = scene.ambientObjects.some(
      (ambientNode) => ambientNode.instanceId === node.instanceId
    );

    if (isAmbience || !node.position) {
      return {
        left: 1,
        right: 1,
      };
    }

    const mix =
      getSpeakerMix(
        node.position,
        speakerGeometry,
        centerRadius,
        fullVolumeRadius
      );

    const leftSpeaker =
      activeSpeakerMap.speakers.find(
        (speaker) =>
          speaker.enabled &&
          speaker.deviceId === 'channel-0'
      );

    const rightSpeaker =
      activeSpeakerMap.speakers.find(
        (speaker) =>
          speaker.enabled &&
          speaker.deviceId === 'channel-1'
      );

    const left =
      leftSpeaker
        ? mix.find(
          (item) =>
            item.speakerId ===
            leftSpeaker.speakerId
        )?.gain ?? 0
      : 0;

    const right =
      rightSpeaker
        ? mix.find(
          (item) =>
            item.speakerId ===
            rightSpeaker.speakerId
        )?.gain ?? 0
      : 0;

    return {
      left,
      right,
    };
  }

  function getPlaybackRouting(
    node: SceneObjectInstance
  ): PlaybackRouting {
    const deployment = referencedDeployments.find(
      ({ node: deployedNode }) =>
        deployedNode.instanceId === node.instanceId
    )?.deployment;
    const isAmbience = scene.ambientObjects.some(
      (ambientNode) => ambientNode.instanceId === node.instanceId
    );

    return {
      sceneInstanceId: scene.instanceId,
      sourceNodeId: deployment?.sourceNodeId ?? node.instanceId,
      type: isAmbience
        ? 'ambience'
        : node.playbackMode === 'loop'
          ? 'loop'
          : 'oneShot',
      volume: scene.volume,
    };
  }

  function getRoomSpeakerMixForNode(node: SceneObjectInstance) {
    return node.position
      ? getSpeakerMix(
          node.position,
          speakerGeometry,
          centerRadius,
          fullVolumeRadius
        )
      : [];
  }

  function getSonosSpeakerMixForNode(node: SceneObjectInstance) {
    const fullSpatialMix = getRoomSpeakerMixForNode(node);

    if ((activeSpeakerMap.spatialOutputMode ?? 'balanced') === 'fullSpatial') {
      return fullSpatialMix;
    }

    if (!node.position) {
      throw new Error('Unable to determine this sound\'s Spatial Field position.');
    }

    return getBalancedFieldPositionalMix(
      node.position,
      activeSpeakerMap.speakers,
      speakerGeometry,
      centerRadius,
      fullVolumeRadius
    );
  }

  function handleToggleNodePlayback(
    node: SceneObjectInstance
  ) {
    const isTemporaryOneShot =
      node.playbackMode === 'oneShot' &&
      temporaryDeployments.some(
        (deployment) => deployment.instanceId === node.instanceId
      );

    if (isTemporaryOneShot) {
      if (playbackEngine.isPlaying(node.instanceId)) {
        playbackEngine.stop(node.instanceId);
        despawnTemporaryDeployment(node.instanceId);
        return;
      }

      void handleStartNodePlayback(
        node,
        () => despawnTemporaryDeployment(node.instanceId)
      );
      return;
    }

    const soundAssetId =
      node.soundAssetIds[0];

    if (!soundAssetId) {
      return;
    }

    const asset =
      soundAssets.find(
        (soundAsset) =>
          soundAsset.id === soundAssetId
      );

    if (!asset) {
      console.error(
        `Sound asset not found: ${soundAssetId}`
      );

      return;
    }

    if (isSonosRoom) {
      if (node.playbackMode !== 'oneShot') {
        showFieldMessage('Sonos looping/ambience playback not implemented yet.');
        return;
      }

      void handleStartNodePlayback(node);
      return;
    }

    const stereoMix = getStereoMixForNode(node);

    void playbackEngine.toggle(
      node,
      asset,
      stereoMix,
      getPlaybackRouting(node)
    );
  }

  function handleNodeTransportPlayback(
    node: SceneObjectInstance,
    playing: boolean
  ) {
    if (isSonosRoom) {
      showFieldMessage('Sonos looping/ambience playback not implemented yet.');
      return;
    }

    if (playing) {
      void playbackEngine.stopNode(node);
      return;
    }

    void handleStartNodePlayback(node);
  }

  async function handleStartNodePlayback(
    node: SceneObjectInstance,
    onComplete?: () => void
  ) {
    const soundAssetId = node.soundAssetIds[0];

    if (!soundAssetId) {
      return;
    }

    const asset = soundAssets.find(
      (soundAsset) => soundAsset.id === soundAssetId
    );

    if (!asset) {
      console.error(`Sound asset not found: ${soundAssetId}`);
      return;
    }

    const correlationId = `playback-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    const roomMix = getRoomSpeakerMixForNode(node);
    const actualMix = isSonosRoom ? getSonosSpeakerMixForNode(node) : roomMix;
    const speakerDetails = actualMix.map((mix) => {
      const geometry = speakerGeometry.find((item) => item.speakerId === mix.speakerId);
      const mapped = activeSpeakerMap.speakers.find((item) => item.speakerId === mix.speakerId);
      const roomSpeaker = activeRoom?.speakers.find((item) => item.speakerId === mix.speakerId);
      const dx = (geometry?.position.x ?? 0) - (node.position?.x ?? 0);
      const dy = (geometry?.position.y ?? 0) - (node.position?.y ?? 0);
      return {
        speakerId: mix.speakerId,
        deviceId: mapped?.deviceId,
        speakerName: roomSpeaker?.name ?? mapped?.displayName,
        directionDegrees: geometry?.angleDegrees,
        distance: Math.hypot(dx, dy),
        calculatedGain: mix.gain,
        enabled: mapped?.enabled,
        trimDb: mapped?.trim,
      };
    });
    const routeMode = isSonosRoom ? 'sonos' : 'browser';
    playbackDiagnosticsRef.current.set(node.instanceId, {
      correlationId, assetId: asset.id, startedAt, sourceInstances: 1, targetSpeakers: [],
    });
    void recordDiagnostic({
      category: 'playback', level: 'info', event: 'spatial.playback_requested',
      message: 'Spatial playback requested.', correlationId,
      details: {
        sceneId: scene.instanceId, sceneName: scene.instanceName,
        objectInstanceId: node.instanceId, sourceNodeId: getPlaybackRouting(node).sourceNodeId,
        assetId: asset.id, assetName: asset.name, playbackMode: node.playbackMode,
        roomId: activeRoom?.id, roomName: activeRoom?.name, position: node.position,
        requestedAt: new Date().toISOString(),
      },
    });
    void recordDiagnostic({
      category: 'audio', level: 'info', event: 'spatial.asset_resolved',
      message: 'Playback asset resolved.', correlationId,
      details: { assetId: asset.id, assetName: asset.name, sourceType: asset.source.type, durationMs: asset.durationMs, mimeType: asset.mimeType },
    });
    void recordDiagnostic({
      category: 'spatial', level: 'info', event: 'spatial.gains_calculated',
      message: 'Spatial speaker gains calculated.', correlationId,
      details: {
        position: node.position, centerCircle: node.position ? getDistanceFromCenter(node.position) <= centerRadius : false,
        fullVolumeDirectionalArea: node.position ? getDistanceFromCenter(node.position) <= fullVolumeRadius : false,
        speakers: speakerDetails,
      },
    });

    const completeDiagnostic = () => {
      const state = playbackDiagnosticsRef.current.get(node.instanceId);
      if (state?.correlationId === correlationId) playbackDiagnosticsRef.current.delete(node.instanceId);
      void recordDiagnostic({
        category: 'playback', level: 'info', event: 'spatial.playback_completed',
        message: 'Spatial playback completed.', correlationId,
        details: {
          assetId: asset.id, assetName: asset.name, expectedDurationMs: asset.durationMs,
          actualElapsedMs: Math.round(performance.now() - startedAt),
          targetSpeakers: state?.targetSpeakers ?? [], sourceInstancesCreated: state?.sourceInstances ?? 1,
        },
      });
      onComplete?.();
    };

    if (isSonosRoom) {
      if (node.playbackMode !== 'oneShot') {
        showFieldMessage('Sonos looping/ambience playback not implemented yet.');
        return;
      }

      try {
        const results = await playSonosOneShot({
          asset,
          node,
          speakerMap: activeSpeakerMap,
          speakerMix: getSonosSpeakerMixForNode(node),
          sceneOneShotVolume: scene.volume.oneShot,
          sceneMasterVolume: scene.volume.master,
          balancedFieldRoute:
            (activeSpeakerMap.spatialOutputMode ?? 'balanced') === 'balanced'
              ? getDistanceFromCenter(node.position ?? { x: 0, y: 0 }) <= centerRadius
                ? 'center'
                : 'directional'
              : undefined,
          roomSpeakerNames: new Map(
            activeRoom?.speakers.map((speaker) => [speaker.speakerId, speaker.name]) ?? []
          ),
          correlationId,
        });

        const state = playbackDiagnosticsRef.current.get(node.instanceId);
        if (state) {
          state.sourceInstances = results.length;
          state.targetSpeakers = results.map((result) => result.playerId);
        }
        void recordDiagnostic({
          category: 'spatial', level: 'info', event: 'spatial.routing_resolved',
          message: 'Spatial playback routing resolved.', correlationId,
          details: {
            targetSpeakerCount: results.length,
            targetSpeakerIds: results.map((result) => result.playerId),
            transports: results.map((result) => ({ speakerId: result.playerId, transport: 'sonos-audio-clip', volume: result.volume, routingKind: result.routingKind })),
            sharesSourceTimeline: results.length <= 1,
            sourceInstancesCreated: results.length,
          },
        });
        for (const result of results) {
          void recordDiagnostic({
            category: 'playback', level: result.accepted ? 'info' : 'error', event: 'spatial.speaker_playback_started',
            message: result.accepted ? 'Speaker playback started.' : 'Spatial playback failed.', correlationId,
            details: { speakerId: result.speakerId, playerId: result.playerId, speakerName: result.label, gain: result.volume / 100, transport: 'sonos-audio-clip', httpStatus: result.httpStatus, response: result.message },
          });
        }
        if (results.length > 1) {
          void recordDiagnostic({
            category: 'playback', level: 'warning', event: 'spatial.additional_source_created',
            message: 'Additional playback source created for active spatial event.', correlationId,
            details: { assetId: asset.id, sourceInstancesCreated: results.length, targetSpeakerIds: results.map((result) => result.playerId) },
          });
        }

        if (results.length > 0) {
          showFieldMessage(
            results.map((result) => {
              const idSuffix = result.playerId.slice(-8);
              return result.accepted
                ? `${result.label} (…${idSuffix}): accepted`
                : `${result.label} (…${idSuffix}): Sonos ${result.httpStatus ?? 'request failed'}`;
            }).join(' · ')
          );
        }

        const failedResults = results.filter((result) => !result.accepted);
        if (failedResults.length > 0 || results.length === 0) {
          playbackDiagnosticsRef.current.delete(node.instanceId);
          void recordDiagnostic({
            category: 'error', level: 'error', event: 'spatial.playback_failed',
            message: 'Spatial playback failed.', correlationId,
            details: {
              assetId: asset.id,
              reason: results.length === 0 ? 'No eligible target speakers.' : 'One or more Sonos targets rejected the request.',
              targets: failedResults,
            },
          });
        }

        if (
          onComplete &&
          results.length > 0 && results.every((result) => result.accepted)
        ) {
          window.setTimeout(completeDiagnostic, Math.max(250, asset.durationMs ?? 1000));
        } else if (!onComplete && results.length > 0 && results.every((result) => result.accepted)) {
          window.setTimeout(completeDiagnostic, Math.max(250, asset.durationMs ?? 1000));
        }
      } catch (error) {
        playbackDiagnosticsRef.current.delete(node.instanceId);
        void recordDiagnostic({
          category: 'error', level: 'error', event: 'spatial.playback_failed',
          message: 'Spatial playback failed.', correlationId,
          details: { assetId: asset.id, assetName: asset.name, error: error instanceof Error ? error.message : String(error) },
        });
        showFieldMessage(
          error instanceof Error ? error.message : 'Unable to play this One Shot through Sonos.'
        );
      }

      return;
    }

    await playbackEngine.start(
      node,
      asset,
      getStereoMixForNode(node),
      getPlaybackRouting(node),
      completeDiagnostic
    );
    void recordDiagnostic({
      category: 'spatial', level: 'info', event: 'spatial.routing_resolved',
      message: 'Spatial playback routing resolved.', correlationId,
      details: { targetSpeakerCount: 2, targetSpeakerIds: ['browser-left', 'browser-right'], transports: ['browser-web-audio'], sharesSourceTimeline: true, sourceInstancesCreated: 1 },
    });
    void recordDiagnostic({
      category: 'playback', level: 'info', event: 'spatial.speaker_playback_started',
      message: 'Speaker playback started.', correlationId,
      details: { speaker: 'browser stereo output', sourcePlaybackInstanceId: node.instanceId, transport: routeMode, scheduledSourceStart: startedAt, stereoMix: getStereoMixForNode(node) },
    });
  }

  function despawnTemporaryDeployment(instanceId: string) {
    setTemporaryDeployments((current) =>
      current.filter((deployment) => deployment.instanceId !== instanceId)
    );

    if (selectedNodeId === instanceId) {
      onSelectedNodeChange(null);
    }
  }

  function showFieldMessage(message: string) {
    setFieldMessage(message);

    if (fieldMessageTimerRef.current !== null) {
      window.clearTimeout(fieldMessageTimerRef.current);
    }

    fieldMessageTimerRef.current = window.setTimeout(() => {
      setFieldMessage(null);
      fieldMessageTimerRef.current = null;
    }, 2200);
  }

  function handleShelfNodeDragStart(
    event: React.DragEvent<HTMLDivElement>,
    node: SceneObjectInstance
  ) {
    if (event.button !== 0) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(
      'application/x-sacscape-scene-node',
      node.instanceId
    );
    setDraggingShelfNodeId(node.instanceId);
  }

  function handleShelfNodeDragEnd() {
    setDraggingShelfNodeId(null);
    setFieldDropActive(false);
  }

  function handleSpatialFieldDrop(
    event: React.DragEvent<HTMLDivElement>
  ) {
    event.preventDefault();
    event.stopPropagation();

    const instanceId =
      event.dataTransfer.getData(
        'application/x-sacscape-scene-node'
      ) || draggingShelfNodeId;
    const latestScene = sceneRef.current;
    const node = latestScene.positionalObjects.find(
      (item) =>
        item.instanceId === instanceId &&
        item.placement === 'shelf'
    );
    const position = getPositionFromPointer(
      event.clientX,
      event.clientY
    );
    const soundAssetId = node?.soundAssetIds[0];
    const assetExists = soundAssets.some(
      (asset) => asset.id === soundAssetId
    );

    setDraggingShelfNodeId(null);
    setFieldDropActive(false);

    if (!node || !position) {
      return;
    }

    if (!soundAssetId || !assetExists) {
      showFieldMessage('No sound assigned to this node.');
      return;
    }

    const deployment: DeployedSceneObjectInstance = {
      instanceId: crypto.randomUUID(),
      sourceNodeId: node.instanceId,
      position: clampToPositionalArea(position),
    };
    const deployedNode: SceneObjectInstance = {
      ...node,
      instanceId: deployment.instanceId,
      placement: 'field',
      position: deployment.position,
    };

    if (node.playbackMode === 'loop') {
      onSceneChange({
        ...latestScene,
        deployedObjects: [
          ...(latestScene.deployedObjects ?? []),
          deployment,
        ],
      });
    } else {
      setTemporaryDeployments((current) => [...current, deployment]);
    }

    onSelectedNodeChange(deployedNode.instanceId, node.instanceId);

    void handleStartNodePlayback(
      deployedNode,
      deployedNode.playbackMode === 'oneShot'
        ? () => despawnTemporaryDeployment(deployedNode.instanceId)
        : undefined
    );
  }

  useImperativeHandle(ref, () => ({
    startNodes: async (nodes) => {
      for (const node of nodes) {
        await handleStartNodePlayback(node);
      }
    },
    pauseNodes: (nodes) => {
      if (isSonosRoom && nodes.length > 0) {
        showFieldMessage('Sonos looping/ambience playback not implemented yet.');
        return;
      }

      for (const node of nodes) {
        void playbackEngine.pause(node);
      }
    },
  }));

  function handleStagePointerDown(
    event: React.PointerEvent<HTMLDivElement>
    ) {
    const target = event.target as HTMLElement;

    const startedOnNode = !!target.closest('.sound-node');

    const startedOnControl =
      !!target.closest(
        'button, input, label, .stage-settings-test'
      );

    if (event.button === 2) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    if (startedOnNode || startedOnControl) {
      return;
    }

    event.preventDefault();

    onSelectedNodeChange(null);
    setNodeContextMenu(null);

    if (roomLocked) {
      return;
    } 

    if (!activeRoom) {
      return;
    }

    roomDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: activeRoom.offset.x,
      startOffsetY: activeRoom.offset.y,
    };

    event.currentTarget.setPointerCapture(
      event.pointerId
    );

    setRoomDragging(true);
  }

  function handleStagePointerMove(
    event: React.PointerEvent<HTMLDivElement>
  ) {
    const drag = roomDragRef.current;

    if (
      !drag ||
      drag.pointerId !== event.pointerId || !activeRoom
    ) {
      return;
    }

    const bounds =
      stageRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    const deltaX =
      ((event.clientX - drag.startClientX) /
        bounds.width) *
      2;

    const deltaY =
      -(
        (event.clientY - drag.startClientY) /
        bounds.height
      ) * 2;

    onRoomChange({
      ...activeRoom,

      offset: {
        x: drag.startOffsetX + deltaX,
        y: drag.startOffsetY + deltaY,
      },
    });
  }

  function handleStagePointerUp(
    event: React.PointerEvent<HTMLDivElement>
  ) {
    const drag = roomDragRef.current;

    if (
      !drag ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    roomDragRef.current = null;

    if (
      event.currentTarget.hasPointerCapture(
        event.pointerId
      )
    ) {
      event.currentTarget.releasePointerCapture(
        event.pointerId
      );
    }

    setRoomDragging(false);
  }

  function handleNodeContextMenu(
    instanceId: string,
    clientX: number,
    clientY: number,
    kind: NodeContextMenu['kind'] = 'field'
  ) {
    setNodeContextMenu({
      instanceId,
      x: clientX,
      y: clientY,
      kind,
    });
  }

  function handleDuplicateShelfNode(instanceId: string) {
    const sourceNode = scene.positionalObjects.find(
      (node) =>
        node.instanceId === instanceId && node.placement === 'shelf'
    );

    if (!sourceNode) {
      return;
    }

    const duplicate: SceneObjectInstance = {
      ...sourceNode,
      instanceId: crypto.randomUUID(),
      instanceName: `${sourceNode.instanceName ?? 'Sound'} Copy`,
      soundAssetIds: [...sourceNode.soundAssetIds],
      position: undefined,
      placement: 'shelf',
    };

    onSceneChange({
      ...scene,
      positionalObjects: [...scene.positionalObjects, duplicate],
    });
    onSelectedNodeChange(duplicate.instanceId);
    setNodeContextMenu(null);
  }

  function handleRemoveNode(
    instanceId: string
  ) {
    const sourceNode = scene.positionalObjects.find(
      (node) => node.instanceId === instanceId
    );
    const persistentDeployment = (scene.deployedObjects ?? []).find(
      (deployment) => deployment.instanceId === instanceId
    );
    const temporaryDeployment = temporaryDeployments.find(
      (deployment) => deployment.instanceId === instanceId
    );
    const removedDeploymentIds = sourceNode?.placement === 'shelf'
      ? (scene.deployedObjects ?? [])
          .filter((deployment) => deployment.sourceNodeId === instanceId)
          .map((deployment) => deployment.instanceId)
      : [];

    if (persistentDeployment || temporaryDeployment) {
      playbackEngine.stop(instanceId);
    }

    if (temporaryDeployment) {
      setTemporaryDeployments((current) =>
        current.filter((deployment) => deployment.instanceId !== instanceId)
      );

      if (selectedNodeId === instanceId) {
        onSelectedNodeChange(null);
      }

      setNodeContextMenu(null);
      return;
    }

    for (const deploymentId of removedDeploymentIds) {
      playbackEngine.stop(deploymentId);
    }

    if (sourceNode?.placement === 'shelf') {
      for (const deployment of temporaryDeployments) {
        if (deployment.sourceNodeId === instanceId) {
          playbackEngine.stop(deployment.instanceId);
        }
      }

      setTemporaryDeployments((current) =>
        current.filter(
          (deployment) => deployment.sourceNodeId !== instanceId
        )
      );
    }

    onSceneChange({
      ...scene,

      positionalObjects:
        scene.positionalObjects.filter(
          (node) =>
            node.instanceId !== instanceId
        ),

      ambientObjects:
        scene.ambientObjects.filter(
          (node) =>
            node.instanceId !== instanceId
        ),
      deployedObjects: (scene.deployedObjects ?? []).filter(
        (deployment) =>
          deployment.instanceId !== instanceId &&
          deployment.sourceNodeId !== instanceId
      ),
    });

    if (
      selectedNodeId === instanceId ||
      removedDeploymentIds.includes(selectedNodeId ?? '') ||
      temporaryDeployments.some(
        (deployment) =>
          deployment.sourceNodeId === instanceId &&
          deployment.instanceId === selectedNodeId
      )
    ) {
      onSelectedNodeChange(null);
    }

    setNodeContextMenu(null);
  }

  function handleCircleResizeStart(
  event: React.PointerEvent<SVGCircleElement>,
  circle: 'center' | 'full'
) {
  event.preventDefault();
  event.stopPropagation();

  setResizingCircle(circle);

  event.currentTarget.setPointerCapture(
    event.pointerId
  );
}

function handleCircleResizeMove(
  event: React.PointerEvent<SVGCircleElement>
) {
  if (!resizingCircle) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const position =
    getPositionFromPointer(
      event.clientX,
      event.clientY
    );

  if (!position) {
    return;
  }

  const radius =
    getDistanceFromCenter(position);

  const MIN_RADIUS = 0.05;
  const MAX_RADIUS = 0.95;
  const MIN_GAP = 0.05;

  if (resizingCircle === 'center') {
    const newRadius =
      Math.max(
        MIN_RADIUS,
        Math.min(
          radius,
          fullVolumeRadius - MIN_GAP
        )
      );

    setCenterRadius(newRadius);
    return;
  }

  const newRadius =
    Math.max(
      centerRadius + MIN_GAP,
      Math.min(
        radius,
        MAX_RADIUS
      )
    );

  setFullVolumeRadius(newRadius);
}

function handleCircleResizeEnd(
  event: React.PointerEvent<SVGCircleElement>
) {
  if (!resizingCircle) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  setResizingCircle(null);

  if (
    event.currentTarget.hasPointerCapture(
      event.pointerId
    )
  ) {
    event.currentTarget.releasePointerCapture(
      event.pointerId
    );
  }
}

  return (
    <div
       className={[
        'soundstage',
        !roomLocked ? 'room-unlocked' : '',
        roomDragging ? 'room-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="spatial-field-area">
        <div className="spatial-field-label">Spatial Field</div>
        <div
          className={[
            'soundstage-field',
            fieldDropActive ? 'shelf-drop-active' : '',
          ].filter(Boolean).join(' ')}
          onContextMenu={handleStageContextMenu}
          onDragEnter={(event) => {
            if (draggingShelfNodeId) {
              event.preventDefault();
              setFieldDropActive(true);
            }
          }}
          onDragOver={(event) => {
            if (draggingShelfNodeId) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setFieldDropActive(true);
            }
          }}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;

            if (
              !(nextTarget instanceof Node) ||
              !event.currentTarget.contains(nextTarget)
            ) {
              setFieldDropActive(false);
            }
          }}
          onDrop={handleSpatialFieldDrop}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerUp}
          onPointerCancel={handleStagePointerUp}
          onDragStart={(event) => event.preventDefault()}
        >
        <div
          ref={stageRef}
          className="soundstage-circle-layer"
        >
          {activeRoom && (
            <RoomLayer
              room={activeRoom}
              viewScale={roomZoom}
              speakerMap={activeSpeakerMap}
              speakerGeometry={speakerGeometry}
              speakerMix={speakerMix}
            />
          )}

          <div className="outer-circle" />

          <div
            className="full-volume-circle"
            style={{
              width: `${fullVolumeRadius * 100}%`,
              height: `${fullVolumeRadius * 100}%`,
            }}
          />
                    
          <div
            className="center-zone"
            style={{
              width: `${centerRadius * 100}%`,
              height: `${centerRadius * 100}%`,
            }}
          />

          <svg
  className="circle-resize-overlay"
  viewBox="0 0 100 100"
>
  <circle
    className="circle-resize-handle"
    cx="50"
    cy="50"
    r={fullVolumeRadius * 50}
    onPointerDown={(event) =>
      handleCircleResizeStart(
        event,
        'full'
      )
    }
    onPointerMove={handleCircleResizeMove}
    onPointerUp={handleCircleResizeEnd}
    onPointerCancel={handleCircleResizeEnd}
  />

  <circle
    className="circle-resize-handle"
    cx="50"
    cy="50"
    r={centerRadius * 50}
    onPointerDown={(event) =>
      handleCircleResizeStart(
        event,
        'center'
      )
    }
    onPointerMove={handleCircleResizeMove}
    onPointerUp={handleCircleResizeEnd}
    onPointerCancel={handleCircleResizeEnd}
  />
</svg>

          <div className="center-point" />

          {allDeployedSoundNodes.map(
            ({ node, deployment }) => (
              <SoundNode
                key={node.instanceId}
                node={node}
                stageRef={stageRef}
                selected={
                  node.instanceId ===
                  selectedNodeId
                }
                playing={playbackEngine.isPlaying(node.instanceId)}
                isAmbient={false}
                onSelect={(instanceId) =>
                  onSelectedNodeChange(
                    instanceId,
                    deployment?.sourceNodeId
                  )
                }
                onPositionChange={
                  handleNodePositionChange
                }
                onContextMenu={(instanceId, x, y) =>
                  handleNodeContextMenu(instanceId, x, y, 'field')
                }
                onTogglePlayback={
                  handleToggleNodePlayback
                }
              />
            )
          )}

        </div>

        {fieldMessage && (
          <div className="spatial-field-message" role="status">
            {fieldMessage}
          </div>
        )}

        {activeRoom && (
          <div className="stage-settings-test">
            {!roomLocked && (
              <label className="room-zoom-control">
                <span>Room Zoom</span>

                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.05"
                  value={roomZoom}
                  onChange={(event) =>
                    setRoomZoom(
                      Number(event.target.value)
                    )
                  }
                />

                <output>
                  {Math.round(roomZoom * 100)}%
                </output>
              </label>
            )}

            <label className="room-lock-control">
              <input
                type="checkbox"
                checked={roomLocked}
                onChange={(event) =>
                  setRoomLocked(event.target.checked)
                }
              />
              Lock Room
            </label>
          </div>
        )}
      </div>
      </div>

      <div className="soundstage-shelves">
        <section className="sound-shelf node-shelf">
          <header className="node-shelf-header">
            <span>Sound Shelf</span>
            <div className="shelf-spawn-control">
              <button
                onClick={() => setSoundSpawnMenuOpen((open) => !open)}
              >
                Spawn Node
              </button>
              {soundSpawnMenuOpen && (
                <div className="shelf-spawn-menu">
                  <button onClick={() => createShelfNode('oneShot')}>
                    One Shot
                  </button>
                  <button onClick={() => createShelfNode('loop')}>
                    Loop
                  </button>
                </div>
              )}
            </div>
          </header>
          <div className="node-shelf-contents">
            {shelvedSoundNodes.map((node) => (
              <div
                key={node.instanceId}
                className={[
                  'shelf-node-tile',
                  'sound-shelf-node',
                  node.instanceId === selectedNodeId ? 'selected' : '',
                  node.muted ? 'muted' : '',
                  node.soundAssetIds.length === 0 ? 'no-sound' : '',
                ].filter(Boolean).join(' ')}
                data-node-id={node.instanceId}
                data-placement="shelf"
                data-playback-mode={node.playbackMode}
                draggable
                onDragStart={(event) =>
                  handleShelfNodeDragStart(event, node)
                }
                onDragEnd={handleShelfNodeDragEnd}
                onClick={() => onSelectedNodeChange(node.instanceId)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectedNodeChange(node.instanceId);
                  handleNodeContextMenu(
                    node.instanceId,
                    event.clientX,
                    event.clientY,
                    'soundShelf'
                  );
                }}
              >
                <div className="shelf-node-icon" aria-hidden="true">
                  <span className="shelf-node-type-badge">
                    {node.playbackMode === 'loop' ? '∞' : '1'}
                  </span>
                  {node.soundAssetIds.length === 0 && (
                    <span className="shelf-node-no-sound">No Sound</span>
                  )}
                </div>
                <span className="shelf-node-name">
                  {node.instanceName ?? 'New Sound'}
                </span>
              </div>
            ))}
            {shelvedSoundNodes.length === 0 && (
              <div className="node-shelf-empty">
                Spawn Node to add a prepared sound.
              </div>
            )}
          </div>
        </section>

        <section className="ambience-shelf node-shelf">
          <header className="node-shelf-header">
            <span>Ambience Shelf</span>
            <button onClick={() => createShelfNode('ambience')}>
              Spawn Node
            </button>
          </header>
          <div className="node-shelf-contents">
            {scene.ambientObjects.map((node) => (
              <div
                key={node.instanceId}
                className={[
                  'shelf-node-tile',
                  'ambience-shelf-node',
                  node.instanceId === selectedNodeId ? 'selected' : '',
                  playbackEngine.isPlaying(node.instanceId) ? 'playing' : '',
                  node.muted ? 'muted' : '',
                  node.soundAssetIds.length === 0 ? 'no-sound' : '',
                ].filter(Boolean).join(' ')}
                data-node-id={node.instanceId}
                data-placement="shelf"
                data-node-kind="ambience"
                onClick={() => onSelectedNodeChange(node.instanceId)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectedNodeChange(node.instanceId);
                  handleNodeContextMenu(
                    node.instanceId,
                    event.clientX,
                    event.clientY,
                    'ambienceShelf'
                  );
                }}
              >
                <div className="shelf-node-icon">
                  <span className="shelf-node-type-badge" aria-hidden="true">
                    A
                  </span>
                  {node.soundAssetIds.length === 0 && (
                    <span className="shelf-node-no-sound">No Sound</span>
                  )}
                  {node.soundAssetIds.length > 0 && (
                  <button
                    className="ambience-playback-toggle"
                    aria-label={
                      playbackEngine.isPlaying(node.instanceId)
                        ? `Pause ${node.instanceName ?? 'ambience'}`
                        : `Play ${node.instanceName ?? 'ambience'}`
                    }
                    title={
                      playbackEngine.isPlaying(node.instanceId)
                        ? 'Pause'
                        : 'Play'
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      handleNodeTransportPlayback(
                        node,
                        playbackEngine.isPlaying(node.instanceId)
                      );
                    }}
                  >
                    {playbackEngine.isPlaying(node.instanceId) ? '■' : '▶'}
                  </button>
                  )}
                </div>
                <span className="shelf-node-name">
                  {node.instanceName ?? 'New Ambience'}
                </span>
              </div>
            ))}
            {scene.ambientObjects.length === 0 && (
              <div className="node-shelf-empty">
                Spawn Node to add ambience.
              </div>
            )}
          </div>
        </section>
      </div>

      {nodeContextMenu && (
        <div
          ref={nodeContextMenuRef}
          className="node-context-menu"
          style={{
            left: nodeContextMenu.x,
            top: nodeContextMenu.y,
          }}
        >
          {nodeContextMenu.kind === 'soundShelf' && (
            <button
              onClick={() =>
                handleDuplicateShelfNode(nodeContextMenu.instanceId)
              }
            >
              Duplicate
            </button>
          )}

          <button
            onClick={() =>
              handleRemoveNode(
                nodeContextMenu.instanceId
              )
            }
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
});

export default SoundStage;
