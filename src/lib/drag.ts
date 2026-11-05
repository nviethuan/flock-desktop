import { invoke } from '@tauri-apps/api/core';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** How far the pointer must travel before a press counts as a drag, in CSS pixels. */
const DRAG_THRESHOLD = 3;

/** Resolved once per session; a failed lookup falls back to moving the window by hand. */
let handRolled: Promise<boolean> | null = null;

function needsHandRolledDrag(): Promise<boolean> {
  handRolled ??= invoke<string>('platform')
    .then((os) => os === 'macos')
    .catch(() => true);
  return handRolled;
}

/**
 * Moves the clock window while the pointer is down.
 *
 * Everywhere but macOS the OS drag is the right tool: Windows anchors it on `GetCursorPos`
 * and GTK on the pointer position, so the grab point is exact. It is also the only option
 * on Wayland, where clients may not place their own windows.
 *
 * macOS is the exception. tao starts the drag with `performWindowDragWithEvent:` and an
 * `NSApp.currentEvent` that, by the time the IPC lands, is a different event — or nil, and
 * then it fabricates a mouse-down. The window picks up a wrong grab anchor, jumps away from
 * the pointer and even a plain click shifts it. So on macOS the clock follows the cursor
 * itself: exact grab point, no movement at all until the pointer travels past the threshold.
 */
export function beginWindowDrag(press: PointerEvent): void {
  if (press.button !== 0) return;

  void needsHandRolledDrag().then((handRolled) => {
    if (!handRolled) {
      void getCurrentWindow().startDragging().catch(() => {
        /* dragging is a nicety; a failure must not break the clock */
      });
      return;
    }
    followPointer(press);
  });
}

/**
 * Positions are absolute — logical window origin plus the distance the cursor travelled
 * from the press — so rounding and dropped frames can never accumulate into drift.
 */
function followPointer(press: PointerEvent): void {
  const win = getCurrentWindow();
  const startX = press.screenX;
  const startY = press.screenY;
  let pointerX = startX;
  let pointerY = startY;
  /** Logical origin of the window; null until the round trip answers. */
  let origin: { x: number; y: number } | null = null;
  let frame = 0;
  let dragging = false;
  let ended = false;

  const stop = (): void => {
    if (ended) return;
    ended = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    removeEventListener('pointermove', onMove, true);
    removeEventListener('pointerup', onRelease, true);
    removeEventListener('pointercancel', onRelease, true);
  };

  const apply = (): void => {
    frame = 0;
    if (ended || !origin) return;
    const position = new LogicalPosition(origin.x + pointerX - startX, origin.y + pointerY - startY);
    void win.setPosition(position).catch(stop);
  };

  const schedule = (): void => {
    if (frame !== 0 || ended) return;
    frame = requestAnimationFrame(apply);
  };

  function onMove(move: PointerEvent): void {
    if (move.pointerId !== press.pointerId) return;
    pointerX = move.screenX;
    pointerY = move.screenY;
    if (!dragging) {
      const travelled =
        Math.abs(pointerX - startX) >= DRAG_THRESHOLD || Math.abs(pointerY - startY) >= DRAG_THRESHOLD;
      if (!travelled) return;
      dragging = true;
    }
    schedule();
  }

  function onRelease(release: PointerEvent): void {
    if (release.pointerId !== press.pointerId) return;
    pointerX = release.screenX;
    pointerY = release.screenY;
    if (dragging) apply();
    stop();
  }

  // Captured on `window` so the drag survives the pointer leaving the clock's own elements;
  // macOS keeps sending the button's events to the window that received the press.
  addEventListener('pointermove', onMove, true);
  addEventListener('pointerup', onRelease, true);
  addEventListener('pointercancel', onRelease, true);

  // One round trip per press. A move that arrives before the origin does is not lost: the
  // next frame reads the latest cursor position and the answer is just as exact.
  void win
    .outerPosition()
    .then(async (position) => {
      const scale = await win.scaleFactor();
      origin = { x: position.x / scale, y: position.y / scale };
      if (dragging) schedule();
    })
    .catch(stop);
}
