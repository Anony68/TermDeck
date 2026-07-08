// Cursor plan usage (see src-tauri/src/cursor.rs). Best-effort: null when
// Cursor isn't installed/logged in on this machine.
import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI } from './env';

export interface CursorUsage {
  found: boolean;
  usedRequests: number;
  /** 0 = no fixed request quota (usage-based plan). */
  maxRequests: number;
  /** Percent of the monthly quota used (0 when quota unknown). */
  utilization: number;
  /** ISO start of the billing month; resets one month later. */
  startOfMonth: string;
}

export async function cursorUsage(): Promise<CursorUsage | null> {
  if (!IS_TAURI) return null;
  try {
    const u = await invoke<CursorUsage>('cursor_usage');
    return u.found ? u : null;
  } catch {
    return null;
  }
}
