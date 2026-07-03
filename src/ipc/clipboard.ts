// Clipboard access that actually works in the Tauri WebView. The browser
// `navigator.clipboard` API is unreliable inside WebView2 (writeText often
// rejects silently, so a "copied" selection never reaches the OS clipboard);
// route through the Tauri plugin instead, falling back to the web API in preview.
import { IS_TAURI } from './env';

export async function copyText(text: string): Promise<void> {
  if (IS_TAURI) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return;
    } catch {
      /* fall through to web API */
    }
  }
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* ignore */
  }
}

export async function pasteText(): Promise<string> {
  if (IS_TAURI) {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return (await readText()) ?? '';
    } catch {
      /* fall through to web API */
    }
  }
  try {
    return (await navigator.clipboard?.readText()) ?? '';
  } catch {
    return '';
  }
}
