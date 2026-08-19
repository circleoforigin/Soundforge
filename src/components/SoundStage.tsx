import { useRef, useState } from 'react';

import { getDistanceFromCenter } from '../utils/soundStageMath';
import SoundNode from './SoundNode';
import { playbackEngine } from '../audio/PlaybackEngine';
import RoomLayer from './RoomLayer';
import { getRoomSpeakerGeometry } from '../utils/roomSpeakerMath';
import { getSpeakerMix } from '../utils/spatialMixMath';

import type { SceneInstance } from '../models/SceneInstance';
import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundPosition } from '../utils/soundStageMath';
import type { Room } from '../models/Room';
import type { SpeakerMap } from '../models/SpeakerMap';
import type { SoundAsset } from '../models/SoundAsset';

interface SoundStageProps {
  scene: SceneInstance;
  soundAssets: SoundAsset[];
  activeRoom: Room | null;
  activeSpeakerMap: SpeakerMap;
  onRoomChange: (room: Room) => void;
  onSceneChange: (scene: SceneInstance) => void;

  selectedNodeId: string | null;
  onSelectedNodeChange: (
    instanceId: string | null
  ) => void;
}

interface NodeContextMenu {
  instanceId: string;
  x: number;
  y: number;
}

function SoundStage({
  scene,
  soundAssets,
  activeRoom,
  activeSpeakerMap,
  onSceneChange,
  selectedNodeId,
  onSelectedNodeChange,
  onRoomChange,
}: SoundStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const roomDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);

  const [roomLocked, setRoomLocked] = useState(true);
  const [roomDragging, setRoomDragging] = useState(false);

  const rightClickStartedOnNodeRef = useRef(false);

  const [resizingCircle, setResizingCircle] =
    useState<'center' | 'full' | null>(null);
  
  const [nodeContextMenu, setNodeContextMenu] =
    useState<NodeContextMenu | null>(null);

  const [centerRadius, setCenterRadius] = useState(0.14);

  const [fullVolumeRadius, setFullVolumeRadius] = useState(0.62);

  const MAX_POSITIONAL_RADIUS = 0.98;
  const MIN_AMBIENT_RADIUS = 1.03;

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
    null;

  const selectedNodePosition = selectedNode?.position ?? null;

  const speakerMix =
    selectedNodePosition
      ? getSpeakerMix(
        selectedNodePosition,
        speakerGeometry,
        centerRadius,
        fullVolumeRadius
      )
    : [];

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

  function clampToAmbientArea(
    position: SoundPosition
  ): SoundPosition {
    const distance =
      getDistanceFromCenter(position);

    if (distance >= MIN_AMBIENT_RADIUS) {
      return position;
    }

    if (distance === 0) {
      return {
        x: MIN_AMBIENT_RADIUS,
        y: 0,
      };
    }

    const scale =
      MIN_AMBIENT_RADIUS / distance;

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

    if (rightClickStartedOnNodeRef.current) {
      rightClickStartedOnNodeRef.current = false;
      return;
    }

    const position = getPositionFromPointer(
      event.clientX,
      event.clientY
    );

    if (!position) {
      return;
    }

    const distance =
      getDistanceFromCenter(position);

    const newNode: SceneObjectInstance = {
      instanceId: crypto.randomUUID(),

      instanceName: 'New Sound',

      soundAssetIds: [],
      playbackMode: 'oneShot',
      gainDb: 0,
      position,

      muted: false,
    };

    if (distance <= 1) {
      const positionalNode = {
        ...newNode,
        position:
          clampToPositionalArea(position),
      };

      onSceneChange({
        ...scene,
        positionalObjects: [
          ...scene.positionalObjects,
          positionalNode,
        ],
      });

      onSelectedNodeChange(
        positionalNode.instanceId
      );

      return;
    }

    const ambientNode = {
      ...newNode,
      position: clampToAmbientArea(position),
    };

    onSceneChange({
      ...scene,
      ambientObjects: [
        ...scene.ambientObjects,
        ambientNode,
      ],
    });

    onSelectedNodeChange(
      ambientNode.instanceId
    );
  }

  function handleNodePositionChange(
    instanceId: string,
    position: SoundPosition,
    isAmbient: boolean
  ) {
    const clampedPosition = isAmbient
      ? clampToAmbientArea(position)
      : clampToPositionalArea(position);

    if (isAmbient) {
      onSceneChange({
        ...scene,

        ambientObjects:
          scene.ambientObjects.map((node) =>
            node.instanceId === instanceId
              ? {
                  ...node,
                  position: clampedPosition,
                }
              : node
          ),
      });

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
    });
  }

  function getStereoMixForNode(
    node: SceneObjectInstance
  ) {
    if (!node.position) {
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

  function handleToggleNodePlayback(
    node: SceneObjectInstance
  ) {
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

    const stereoMix =
      getStereoMixForNode(node);

    void playbackEngine.toggle(
      node,
      asset,
      stereoMix
    );
  }

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
      rightClickStartedOnNodeRef.current =
        startedOnNode;

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
    clientY: number
  ) {
    setNodeContextMenu({
      instanceId,
      x: clientX,
      y: clientY,
    });
  }

  function handleRemoveNode(
    instanceId: string
  ) {
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
    });

    if (selectedNodeId === instanceId) {
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
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={handleStagePointerUp}
      onPointerCancel={handleStagePointerUp}
      onDragStart={(event) => event.preventDefault()}
    >
      <div
        className="soundstage-field"
        onContextMenu={handleStageContextMenu}
      >
        <div
          ref={stageRef}
          className="soundstage-circle-layer"
        >
          {activeRoom && (
            <RoomLayer
              room={activeRoom}
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

          {scene.positionalObjects.map(
            (node) => (
              <SoundNode
                key={node.instanceId}
                node={node}
                stageRef={stageRef}
                selected={
                  node.instanceId ===
                  selectedNodeId
                }
                isAmbient={false}
                onSelect={onSelectedNodeChange}
                onPositionChange={
                  handleNodePositionChange
                }
                onContextMenu={
                  handleNodeContextMenu
                }
                onTogglePlayback={
                  handleToggleNodePlayback
                }
              />
            )
          )}

          {scene.ambientObjects.map(
            (node) => (
              <SoundNode
                key={node.instanceId}
                node={node}
                stageRef={stageRef}
                selected={
                  node.instanceId ===
                  selectedNodeId
                }
                isAmbient={true}
                onSelect={onSelectedNodeChange}
                onPositionChange={
                  handleNodePositionChange
                }
                onContextMenu={
                  handleNodeContextMenu
                }
                onTogglePlayback={
                  handleToggleNodePlayback
                }
              />
            )
          )}

          {activeRoom && (
  <div className="stage-settings-test">
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

      {nodeContextMenu && (
        <div
          className="node-context-menu"
          style={{
            left: nodeContextMenu.x,
            top: nodeContextMenu.y,
          }}
        >
          <button
            onClick={() =>
              setNodeContextMenu(null)
            }
          >
            Edit
          </button>

          <button disabled>
            Duplicate
          </button>

          <div className="node-context-separator" />

          <button
            onClick={() =>
              handleRemoveNode(
                nodeContextMenu.instanceId
              )
            }
          >
            Remove from Scene
          </button>
        </div>
      )}
    </div>
  );
}

export default SoundStage;