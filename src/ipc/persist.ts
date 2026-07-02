import type { PersistedState } from '../types';
import { IS_TAURI } from './env';

const FILE = 'termdeck.json';
const KEY = 'state';

let storeP: Promise<import('@tauri-apps/plugin-store').Store> | null = null;
async function getStore() {
  const { load } = await import('@tauri-apps/plugin-store');
  if (!storeP) storeP = load(FILE);
  return storeP;
}

export async function loadPersisted(): Promise<PersistedState | null> {
  if (!IS_TAURI) {
    try {
      const raw = localStorage.getItem(FILE);
      return raw ? (JSON.parse(raw) as PersistedState) : null;
    } catch {
      return null;
    }
  }
  try {
    const store = await getStore();
    const val = await store.get<PersistedState>(KEY);
    return val ?? null;
  } catch {
    return null;
  }
}

export async function savePersisted(state: PersistedState): Promise<void> {
  if (!IS_TAURI) {
    try {
      localStorage.setItem(FILE, JSON.stringify(state));
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const store = await getStore();
    await store.set(KEY, state);
    await store.save();
  } catch {
    /* ignore */
  }
}
