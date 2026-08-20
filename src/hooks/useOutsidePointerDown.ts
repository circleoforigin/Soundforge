import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useOutsidePointerDown<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  onOutsidePointerDown: () => void
): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const element = ref.current;

      if (
        element &&
        event.target instanceof Node &&
        !element.contains(event.target)
      ) {
        onOutsidePointerDown();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [active, onOutsidePointerDown, ref]);
}
