import type { RefObject } from 'react';

import type { SceneObjectInstance } from '../models/SceneObjectInstance';
import type { SoundPosition } from '../utils/soundStageMath';

interface SoundNodeProps {
  node: SceneObjectInstance;

  stageRef: RefObject<HTMLDivElement | null>;

  selected: boolean;
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
  isAmbient,
  onSelect,
  onPositionChange,
  onContextMenu,
  onTogglePlayback,
}: SoundNodeProps) {
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

    function handlePointerMove(
      event: PointerEvent
    ) {
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

    onSelect(node.instanceId);

    onTogglePlayback(node);
  }

  const labelAbove = position.y < 0;

return (
  <div
    className={[
      'sound-node',
      selected ? 'selected' : '',
      isAmbient ? 'ambient' : 'positional',
    ]
      .filter(Boolean)
      .join(' ')}
    onPointerDown={handlePointerDown}
    onContextMenu={handleContextMenu}
    onDoubleClick={handleDoubleClick}
    title={node.instanceName ?? 'Sound'}
    style={{
      left: `${((position.x + 1) / 2) * 100}%`,
      top: `${((1 - position.y) / 2) * 100}%`,
    }}
  >
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