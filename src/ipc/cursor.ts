// Cursor plan usage (see src-tauri/src/cursor.rs). Best-effort: null when
// Cursor isn't installed/logged in on this machine.
import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI } from './env';

export interface CursorUsage {
  found: boolean;
  /** Membership tier (e.g. "ultra", "pro", "free"); "" if unknown. */
  plan: string;
  /** Percent of the included allowance used this cycle (0–100). */
  utilization: number;
  /** Raw used / limit of the included allowance (0 when not applicable). */
  used: number;
  limit: number;
  /** ISO end of the current billing cycle (allowance reset). */
  resetsAt: string;
  /** Plans with no fixed cap. */
  unlimited: boolean;
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
