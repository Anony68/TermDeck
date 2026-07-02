// Last PTY-output timestamp per pane, kept OUTSIDE the reactive store so the
// per-chunk writes are free. The stats tick (every ~1.5s) reads this map to
// derive "Claude busy vs idle" — while Claude works its spinner repaints
// continuously, so recent output ⇒ busy; silence ⇒ waiting for input.
const lastOutputAt = new Map<string, number>();

/** How long after the last output a Claude pane still counts as busy. */
export const BUSY_WINDOW_MS = 2500;

export function markPaneActivity(paneId: string): void {
  lastOutputAt.set(paneId, Date.now());
}

export function isPaneActive(paneId: string, now = Date.now()): boolean {
  return now - (lastOutputAt.get(paneId) ?? 0) < BUSY_WINDOW_MS;
}

export function clearPaneActivity(paneId: string): void {
  lastOutputAt.delete(paneId);
}
