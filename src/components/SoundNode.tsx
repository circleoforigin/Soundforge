import { useRef } from 'react';
import type { RefObject } from 'react';

import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundPosition } from '../utils/soundStageMath';

interface SoundNodeProps {
  node: SceneObjectInstance;

  stageRef: RefObject<HTMLDivElement | null>;

  selected: boolean;
  playing: boolean;
  isAmbient: boolean;

  onSelect: (instanceId: string) => void;
  
  onTogglePlayback: (
    node: SceneObjectInstance
  ) => void;
  onPositionChange: (
    instanceId: string,
    position: SoundPosition,
    isAmbient: boolean
  ) => void;

  onContextMenu: (
    instanceId: string,
    clientX: number,
    clientY: number
  ) => void;
}

function SoundNode({
  node,
  stageRef,
  selected,
  playing,
  isAmbient,
  onSelect,
  onPositionChange,
  onContextMenu,
  onTogglePlayback,
}: SoundNodeProps) {
  const lastDragAtRef = useRef(0);
  const position = node.position ?? {
    x: 0,
    y: 0,
  };

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

  function handlePointerDown(
    event: React.PointerEvent<HTMLDivElement>
  ) {
    // Only left-click starts a drag.
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    onSelect(node.instanceId);
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let dragged = false;

    function handlePointerMove(
      event: PointerEvent
    ) {
      if (
        !dragged &&
        Math.hypot(
          event.clientX - startClientX,
          event.clientY - startClientY
        ) < 4
      ) {
        return;
      }

      dragged = true;
      const newPosition =
        getPositionFromPointer(
          event.clientX,
          event.clientY
        );

      if (!newPosition) {
        return;
      }

      onPositionChange(
        node.instanceId,
        newPosition,
        isAmbient
      );
    }

    function handlePointerUp() {
      if (dragged) {
        lastDragAtRef.current = Date.now();
      }

      window.removeEventListener(
        'pointermove',
        handlePointerMove
      );

      window.removeEventListener(
        'pointerup',
        handlePointerUp
      );

      window.removeEventListener(
        'pointercancel',
        handlePointerUp
      );
    }

    window.addEventListener(
      'pointermove',
      handlePointerMove
    );

    window.addEventListener(
      'pointerup',
      handlePointerUp
    );

    window.addEventListener(
      'pointercancel',
      handlePointerUp
    );
  }

  function handleContextMenu(
    event: React.MouseEvent<HTMLDivElement>
  ) {
    event.preventDefault();
    event.stopPropagation();

    onSelect(node.instanceId);

    onContextMenu(
      node.instanceId,
      event.clientX,
      event.clientY
    );
  }

  function handleDoubleClick(
    event: React.MouseEvent<HTMLDivElement>
  ) {
    event.preventDefault();
    event.stopPropagation();

    if (Date.now() - lastDragAtRef.current < 500) {
      return;
    }

    onSelect(node.instanceId);

    onTogglePlayback(node);
  }

  const labelAbove = position.y < 0;

return (
  <div
    className={[
      'sound-node',
      selected ? 'selected' : '',
      playing ? 'playing' : '',
      node.muted ? 'muted' : '',
      node.soundAssetIds.length === 0 ? 'no-sound' : '',
      isAmbient ? 'ambient' : 'positional',
    ]
      .filter(Boolean)
      .join(' ')}
    onPointerDown={handlePointerDown}
    onContextMenu={handleContextMenu}
    onDoubleClick={handleDoubleClick}
    title={node.instanceName ?? 'Sound'}
    data-node-id={node.instanceId}
    data-placement="field"
    data-playback-mode={node.playbackMode}
    style={{
      left: `${((position.x + 1) / 2) * 100}%`,
      top: `${((1 - position.y) / 2) * 100}%`,
    }}
  >
    {node.soundAssetIds.length === 0 && (
      <span className="sound-node-no-sound">No Sound</span>
    )}

    <div
      className={[
        'sound-node-label',
        labelAbove ? 'above' : 'below',
      ].join(' ')}
    >
      {node.instanceName ?? 'New Sound'}
    </div>
  </div>
);
}

export default SoundNode;
