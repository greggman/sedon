import { useEffect, type RefObject } from 'react';

// While `open` is true, calls `onDismiss()` when:
//   • the user mouses down outside `ref`'s subtree, or
//   • the user presses Escape.
//
// Use for dropdowns / popovers that should close on "click away" — the
// trigger button itself stays inside the ref subtree, so clicking it
// again doesn't both close (via dismiss) and re-open (via the button's
// own onClick) in the same gesture.
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const root = ref.current;
      if (root && root.contains(e.target as Node)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    // mousedown rather than click — by the time `click` fires, focus
    // and selection state may have already shifted, and we want the
    // popup gone before the new click target processes its own handler.
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onDismiss]);
}
