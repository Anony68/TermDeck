/** True when running inside the Tauri webview (false in a plain `vite` browser). */
export const IS_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Rough platform sniff from the webview UA — used for keybinding modifiers. */
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const IS_MAC = /Mac|iPhone|iPad/i.test(UA);
export const IS_WIN = /Win/i.test(UA);
