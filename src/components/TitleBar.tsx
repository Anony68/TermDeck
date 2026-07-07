import { windowControls } from '../ipc/api';
import { TabStrip } from './TabStrip';
import { useT } from '../i18n';

export function TitleBar() {
  const t = useT();
  return (
    <div
      data-tauri-drag-region
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 38,
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border)',
        padding: '0 0 0 12px',
        flex: 'none',
      }}
    >
      <div data-tauri-drag-region style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            background: 'var(--accent)',
            display: 'grid',
            placeItems: 'center',
            font: '700 10px var(--font-mono)',
            color: 'var(--accent-ink)',
          }}
        >
          {'>_'}
        </div>
        <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>TermDeck</span>
      </div>

      <div style={{ marginLeft: 20, alignSelf: 'center' }}>
        <TabStrip />
      </div>

      <div data-tauri-drag-region style={{ flex: 1, alignSelf: 'stretch' }} />

      <div style={{ display: 'flex', height: 38 }}>
        <div className="wc" title={t('win.minimize')} style={{ fontSize: 13 }} onClick={() => windowControls.minimize()}>
          ─
        </div>
        <div className="wc" title={t('win.maximize')} style={{ fontSize: 11 }} onClick={() => windowControls.toggleMaximize()}>
          ▢
        </div>
        <div className="wc close" title={t('win.close')} style={{ fontSize: 16 }} onClick={() => windowControls.close()}>
          ✕
        </div>
      </div>
    </div>
  );
}
