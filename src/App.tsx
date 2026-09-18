import { useEffect } from 'react';
import { useStore } from './state/store';
import { IS_TAURI, IS_MAC } from './ipc/env';
import { TitleBar } from './components/TitleBar';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { HostDetail } from './components/HostDetail';
import { StatusBar } from './components/StatusBar';
import { TerminalLayer } from './components/TerminalLayer';
import { AddHostDialog } from './dialogs/AddHostDialog';
import { SettingsWindow } from './settings/SettingsWindow';
import { useT } from './i18n';
import { onSshStatus } from './ipc/ssh';
import { wireEditUploads } from './state/edits';

export default function App() {
  const hydrated = useStore((s) => s.hydrated);
  const t = useT();
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible);
  const uiScale = useStore((s) => s.settings.uiScale);
  const addHostOpen = useStore((s) => s.ui.addHostOpen);
  const editHostId = useStore((s) => s.ui.editHostId);
  const settingsOpen = useStore((s) => s.ui.settingsOpen);

  // App-wide zoom (font size for the whole UI).
  useEffect(() => {
    if (!IS_TAURI) {
      document.body.style.setProperty('zoom', String(uiScale));
      return;
    }
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().setZoom(uiScale).catch(() => {})
    );
  }, [uiScale]);

  // Startup: restore the VPS list + subscribe to SSH connection health.
  useEffect(() => {
    void useStore.getState().hydrate();
    const unlisteners: Array<() => void> = [];
    void onSshStatus((s) =>
      useStore.getState().setSshStatus(s.paneId, s.state, s.attempt)
    ).then((fn) => unlisteners.push(fn));
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  // Edit-in-place auto-upload pump: wired once here (survives FileBrowser unmounts).
  useEffect(() => {
    wireEditUploads();
  }, []);

  // Block webview reload (F5 / Ctrl+R) — a reload would kill every SSH session.
  // F5 is repurposed to reload the focused file browser panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  // Global shortcuts. Primary modifier is Cmd on macOS, Ctrl elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const k = e.key.toLowerCase();
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && k === 'n') {
        e.preventDefault();
        s.openAddHost();
      } else if (mod && k === 'a') {
        // Block the webview's select-all from highlighting the whole UI; real
        // inputs keep native behavior; terminals handle ^A themselves.
        const el = e.target as HTMLElement | null;
        const editable =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          !!el?.isContentEditable;
        if (!editable) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!hydrated) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-muted)',
          font: '400 13px var(--font-ui)',
        }}
      >
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TitleBar />
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {sidebarVisible && <Sidebar />}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <HostDetail />
        </div>
      </div>
      <StatusBar />
      <TerminalLayer />
      {(addHostOpen || editHostId) && <AddHostDialog />}
      {settingsOpen && <SettingsWindow />}
    </div>
  );
}
