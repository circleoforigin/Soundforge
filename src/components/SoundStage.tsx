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
import type { PlaybackRouting } from '../audio/PlaybackEngine';
import { roomAudioEngine } from '../audio/RoomAudioEngine';
import { soundStageNodeGainSignature } from '../audio/SoundStageControlState';
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
import {
  getLoopingZoneSpawnBounds,
  LoopingZoneScheduler,
  type LoopingZoneChild,
} from '../audio/LoopingZoneScheduler';
import { getLoopingZoneOverlayPath } from '../utils/loopingZoneOverlayMath';

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
  playSceneOnLoadOneShot: (assetId: string) => Promise<void>;
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
    roomAudioEngine.subscribe,
    roomAudioEngine.getVersion
  );
  const roomAudioStatus = roomAudioEngine.getStatus();
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
  const loopingZoneSchedulersRef = useRef(new Map<string, LoopingZoneScheduler>());

  useEffect(() => () => {
    if (fieldMessageTimerRef.current !== null) {
      window.clearTimeout(fieldMessageTimerRef.current);
    }
  }, []);
  useEffect(() => () => {
    for (const scheduler of loopingZoneSchedulersRef.current.values()) scheduler.stop();
    loopingZoneSchedulersRef.current.clear();
  }, [scene.instanceId]);

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
  useEffect(() => {
    for (const [instanceId, scheduler] of loopingZoneSchedulersRef.current) {
      const currentNode = allDeployedSoundNodes.find(({ node }) => node.instanceId === instanceId)?.node;
      if (currentNode?.loopingZone?.enabled) scheduler.updateNode(currentNode);
      else { scheduler.stop(); loopingZoneSchedulersRef.current.delete(instanceId); }
    }
  });

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
  const selectedDeployedNode = allDeployedSoundNodes.find(
    ({ node }) => node.instanceId === selectedNodeId
  )?.node ?? null;
  const loopingZoneOverlayPath =
    selectedDeployedNode?.position && selectedDeployedNode.loopingZone?.enabled
      ? getLoopingZoneOverlayPath(getLoopingZoneSpawnBounds(
          selectedDeployedNode.position,
          selectedDeployedNode.loopingZone
        ))
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
  const sceneMasterVolume = scene.volume.master;
  const sceneOneShotVolume = scene.volume.oneShot;
  const sceneLoopVolume = scene.volume.loop;
  const sceneAmbienceVolume = scene.volume.ambience;
  useEffect(() => {
    roomAudioEngine.setSceneVolume(scene.instanceId, {
      master: sceneMasterVolume, oneShot: sceneOneShotVolume,
      loop: sceneLoopVolume, ambience: sceneAmbienceVolume,
    });
  }, [
    scene.instanceId,
    sceneMasterVolume,
    sceneOneShotVolume,
    sceneLoopVolume,
    sceneAmbienceVolume,
  ]);

  const nodeGainSignature = soundStageNodeGainSignature(scene);
  useEffect(() => {
    for (const state of nodeGainSignature.split('|').slice(1).filter(Boolean)) {
      const [nodeId, gainDb, muted] = state.split(':');
      roomAudioEngine.updateNodeGain(
        scene.instanceId,
        nodeId,
        Number(gainDb),
        muted === '1'
      );
    }
  }, [
    scene.instanceId,
    nodeGainSignature,
  ]);

  useEffect(() => {
    void roomAudioEngine.configure(activeRoom, activeSpeakerMap);
  }, [activeRoom, activeSpeakerMap]);

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
      const oldMix = getOutputSpeakerMixForNode(deployedNode);
      roomAudioEngine.updateSpatialMix(
        instanceId,
        getStereoMixForNode({
          ...deployedNode,
          position: clampedPosition,
        })
      );
      const diagnostic = playbackDiagnosticsRef.current.get(instanceId);
      const now = performance.now();
      const updateCorrelationId = `position-${crypto.randomUUID()}`;
      const recordThisUpdate = Boolean(diagnostic && now - (lastPositionDiagnosticRef.current.get(instanceId) ?? 0) >= 500);
      if (recordThisUpdate && diagnostic) {
        lastPositionDiagnosticRef.current.set(instanceId, now);
        void recordDiagnostic({
          category: 'spatial', level: 'info', event: 'spatial.gains_updated',
          message: 'Spatial playback gains updated.', correlationId: diagnostic.correlationId,
          details: {
            oldPosition, newPosition: clampedPosition,
            oldGains: oldMix,
            newGains: getOutputSpeakerMixForNode({ ...deployedNode, position: clampedPosition }),
            updateState: 'requested', updateCorrelationId,
            gainRoutingUpdatedLive: false,
            playbackReconstructed: false,
          },
        });
      }
      const updateRequest = roomAudioEngine.updatePosition(
        instanceId,
        clampedPosition,
        getOutputSpeakerMixForNode({ ...deployedNode, position: clampedPosition }),
        updateCorrelationId
      );
      if (recordThisUpdate) void updateRequest.then(() => {
        void recordDiagnostic({
          category: 'spatial', level: 'info', event: 'spatial.gains_update_accepted',
          message: 'Spatial gain update accepted by the Room Audio backend.',
          correlationId: updateCorrelationId,
          details: { objectInstanceId: instanceId, updateState: 'accepted', gainRoutingUpdatedLive: true },
        });
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unable to update Room audio position.';
        void recordDiagnostic({
          category: 'error', level: 'error', event: 'spatial.gains_update_failed',
          message: 'Spatial gain update failed.', correlationId: updateCorrelationId,
          details: { objectInstanceId: instanceId, updateState: 'failed', error: message },
        });
        showFieldMessage(message);
      });
      else void updateRequest.catch(() => undefined);
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

  function getOutputSpeakerMixForNode(node: SceneObjectInstance) {
    const isAmbience = scene.ambientObjects.some(
      (ambientNode) => ambientNode.instanceId === node.instanceId
    );
    if (isAmbience) {
      return activeSpeakerMap.speakers
        .filter((speaker) => speaker.enabled)
        .map((speaker) => ({ speakerId: speaker.speakerId, gain: 1 }));
    }
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
    if (node.playbackMode === 'loop' && node.loopingZone?.enabled) {
      if (isNodePlaying(node)) stopNodePlayback(node);
      else startLoopingZone(node);
      return;
    }

    const isTemporaryOneShot =
      node.playbackMode === 'oneShot' &&
      temporaryDeployments.some(
        (deployment) => deployment.instanceId === node.instanceId
      );

    if (isTemporaryOneShot) {
      if (roomAudioEngine.isPlaying(node.instanceId)) {
        roomAudioEngine.stop(node.instanceId);
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

    if (isNodePlaying(node)) stopNodePlayback(node);
    else void handleStartNodePlayback(node);
  }

  function handleNodeTransportPlayback(
    node: SceneObjectInstance,
    playing: boolean
  ) {
    if (playing) {
      stopNodePlayback(node);
      return;
    }

    void handleStartNodePlayback(node);
  }

  async function handleStartNodePlayback(
    node: SceneObjectInstance,
    onComplete?: () => void
  ) {
    if (node.playbackMode === 'loop' && node.loopingZone?.enabled) {
      startLoopingZone(node);
      return;
    }
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
    const actualMix = getOutputSpeakerMixForNode(node);
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
      if (!roomAudioEngine.usesBackendRoomAudio()) {
        void recordDiagnostic({
          category: 'playback', level: 'info', event: 'spatial.playback_completed',
          message: 'Spatial playback completed.', correlationId,
          details: {
            assetId: asset.id, assetName: asset.name, expectedDurationMs: asset.durationMs,
            actualElapsedMs: Math.round(performance.now() - startedAt),
            targetSpeakers: state?.targetSpeakers ?? [], sourceInstancesCreated: 1,
          },
        });
      }
      onComplete?.();
    };

    try {
      await roomAudioEngine.play({
        correlationId, room: activeRoom, speakerMap: activeSpeakerMap,
        node, asset, speakerMix: actualMix, stereoMix: getStereoMixForNode(node),
        routing: getPlaybackRouting(node), sceneName: scene.instanceName,
        onComplete: completeDiagnostic,
      });
      const targetIds = activeSpeakerMap.speakers
        .filter((speaker) => speaker.enabled && (actualMix.find((mix) => mix.speakerId === speaker.speakerId)?.gain ?? 0) > 0)
        .map((speaker) => speaker.speakerId);
      const state = playbackDiagnosticsRef.current.get(node.instanceId);
      if (state) { state.sourceInstances = 1; state.targetSpeakers = targetIds; }
      void recordDiagnostic({
        category: 'spatial', level: 'info', event: 'spatial.routing_resolved',
        message: 'Spatial playback routing resolved.', correlationId,
        details: {
          targetSpeakerCount: targetIds.length, targetSpeakerIds: targetIds,
          transports: activeSpeakerMap.speakers.filter((speaker) => targetIds.includes(speaker.speakerId)).map((speaker) => ({ speakerId: speaker.speakerId, providerId: speaker.providerId ?? activeSpeakerMap.adapterType })),
          sharesSourceTimeline: true, sourceInstancesCreated: 1,
        },
      });
    } catch (error) {
      playbackDiagnosticsRef.current.delete(node.instanceId);
      void recordDiagnostic({
        category: 'error', level: 'error', event: 'spatial.playback_failed',
        message: 'Spatial playback failed.', correlationId,
        details: { assetId: asset.id, assetName: asset.name, error: error instanceof Error ? error.message : String(error) },
      });
      showFieldMessage(error instanceof Error ? error.message : 'Unable to play this sound through Room audio.');
    }
  }

  function isNodePlaying(node: SceneObjectInstance): boolean {
    return loopingZoneSchedulersRef.current.get(node.instanceId)?.isRunning
      ?? roomAudioEngine.isPlaying(node.instanceId);
  }

  function stopNodePlayback(node: SceneObjectInstance): void {
    const scheduler = loopingZoneSchedulersRef.current.get(node.instanceId);
    if (scheduler) {
      scheduler.stop();
      loopingZoneSchedulersRef.current.delete(node.instanceId);
      return;
    }
    void roomAudioEngine.stopNode(node);
  }

  function stopLoopingZoneById(instanceId: string): void {
    const scheduler = loopingZoneSchedulersRef.current.get(instanceId);
    if (!scheduler) return;
    scheduler.stop();
    loopingZoneSchedulersRef.current.delete(instanceId);
  }

  function startLoopingZone(node: SceneObjectInstance): void {
    if (!node.loopingZone?.enabled || !node.position) return;
    loopingZoneSchedulersRef.current.get(node.instanceId)?.stop();
    const scheduler = new LoopingZoneScheduler({
      node,
      onSpawn: async (child: LoopingZoneChild, complete) => {
        const asset = soundAssets.find((item) => item.id === child.asset.assetId);
        if (!asset) { complete(); return; }
        const childNode: SceneObjectInstance = {
          ...node,
          instanceId: child.playbackId,
          instanceName: `${node.instanceName ?? 'Looping Zone'} child`,
          soundAssetIds: [child.asset.assetId],
          playbackMode: 'oneShot',
          placement: 'field',
          position: child.position,
          randomStart: false,
          gainDb: (node.gainDb ?? 0) + child.asset.gainDb,
          loopingZone: undefined,
        };
        await handleStartNodePlayback(childNode, () => {
          roomAudioEngine.stop(child.playbackId);
          complete();
        });
      },
      onStopChild: (playbackId) => roomAudioEngine.stop(playbackId),
      onEvent: (event, details) => {
        void recordDiagnostic({
          category: 'playback', level: 'info', event: `looping_zone.${event}`,
          message: `Looping Zone ${event}.`, details: { sceneId: scene.instanceId, ...details },
        });
      },
    });
    loopingZoneSchedulersRef.current.set(node.instanceId, scheduler);
    scheduler.start();
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
      for (const node of nodes) {
        if (node.loopingZone?.enabled) stopNodePlayback(node);
        else void roomAudioEngine.pause(node);
      }
    },
    playSceneOnLoadOneShot: async (assetId) => {
      const asset = soundAssets.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      const runtimeNode: SceneObjectInstance = {
        instanceId: `scene-on-load-${crypto.randomUUID()}`,
        instanceName: asset.name,
        soundAssetIds: [asset.id],
        playbackMode: 'oneShot',
        placement: 'field',
        onLoad: false,
        fadeInEnabled: false,
        fadeInMs: 1000,
        fadeOutEnabled: false,
        fadeOutMs: 1000,
        excludeFromBulkControls: true,
        randomStart: false,
        gainDb: 0,
        position: { x: 0, y: 0 },
        muted: false,
      };
      await handleStartNodePlayback(runtimeNode, () => roomAudioEngine.stop(runtimeNode.instanceId));
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
    stopLoopingZoneById(instanceId);
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
      roomAudioEngine.stop(instanceId);
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
      stopLoopingZoneById(deploymentId);
      roomAudioEngine.stop(deploymentId);
    }

    if (sourceNode?.placement === 'shelf') {
      for (const deployment of temporaryDeployments) {
        if (deployment.sourceNodeId === instanceId) {
          roomAudioEngine.stop(deployment.instanceId);
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
        {roomAudioStatus.state !== 'idle' && (
          <div className={`room-audio-status room-audio-${roomAudioStatus.state}`}>
            Room Audio: {roomAudioStatus.state === 'connecting' ? 'Connecting' : roomAudioStatus.state === 'ready' ? 'Ready' : roomAudioStatus.state === 'degraded' ? 'Degraded' : 'Error'}
          </div>
        )}
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

          {loopingZoneOverlayPath && (
            <svg
              className="looping-zone-overlay"
              viewBox="0 0 100 100"
              aria-hidden="true"
            >
              <path d={loopingZoneOverlayPath} fillRule="evenodd" />
            </svg>
          )}

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
                playing={isNodePlaying(node)}
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
                  isNodePlaying(node) ? 'playing' : '',
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
                      isNodePlaying(node)
                        ? `Pause ${node.instanceName ?? 'ambience'}`
                        : `Play ${node.instanceName ?? 'ambience'}`
                    }
                    title={
                      isNodePlaying(node)
                        ? 'Pause'
                        : 'Play'
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      handleNodeTransportPlayback(
                        node,
                        isNodePlaying(node)
                      );
                    }}
                  >
                    {isNodePlaying(node) ? '■' : '▶'}
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
