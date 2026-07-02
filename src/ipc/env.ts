/** True when running inside the Tauri webview (false in a plain `vite` browser). */
export const IS_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
