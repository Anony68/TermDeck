import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { IS_MAC, IS_WIN } from '../ipc/env';
import { IconClose, IconCheck } from '../components/icons';
import { FONT_ORDER, FONT_PX } from '../fontSizes';
import {
  checkUpdate,
  openUpdateUrl,
  downloadAndRun,
  quitApp,
  getAppVersion,
  type UpdateResult,
} from '../ipc/update';
import { pickFile } from '../ipc/api';
import { exportBackup, importBackup } from '../ipc/backup';
import { useT, type TKey } from '../i18n';
import type { Lang, Settings } from '../types';

type Section = 'general' | 'session' | 'editor' | 'keys' | 'update';

const NAV: Array<{ id: Section; key: TKey }> = [
  { id: 'general', key: 'set.nav.general' },
  { id: 'session', key: 'set.nav.session' },
  { id: 'editor', key: 'set.nav.editor' },
  { id: 'keys', key: 'set.nav.keys' },
  { id: 'update', key: 'set.nav.update' },
];

const UI_SCALES: Array<{ v: number; label: string }> = [
  { v: 0.9, label: '90%' },
  { v: 1, label: '100%' },
  { v: 1.1, label: '110%' },
  { v: 1.25, label: '125%' },
];

export function SettingsWindow() {
  const initialSection = useStore((s) => s.ui.settingsSection);
  const [section, setSection] = useState<Section>((initialSection as Section) || 'general');
  const closeSettings = useStore((s) => s.closeSettings);
  const t = useT();

  return (
    <div
      onMouseDown={closeSettings}
      style={{ position: 'fixed', inset: 0, background: 'rgba(5,7,10,0.55)', display: 'grid', placeItems: 'center', zIndex: 60 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, 94vw)',
          height: 'min(640px, 90vh)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-2)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', height: 38, background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', padding: '0 0 0 14px', flex: 'none' }}>
          <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{t('set.title')}</span>
          <div style={{ flex: 1 }} />
          <div className="wc close" style={{ height: 38 }} onClick={closeSettings}>
            <IconClose size={15} />
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 200, flex: 'none', background: 'var(--bg-panel)', borderRight: '1px solid var(--border)', padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {NAV.map((n) => (
              <div key={n.id} className={`nav-item${section === n.id ? ' active' : ''}`} onClick={() => setSection(n.id)}>
                {t(n.key)}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, padding: '24px 28px', overflow: 'auto', minWidth: 0 }}>
            {section === 'general' && <GeneralSection />}
            {section === 'session' && <SessionSection />}
            {section === 'editor' && <EditorSection />}
            {section === 'keys' && <KeysSection />}
            {section === 'update' && <UpdateSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  desc,
  settingKey,
}: {
  title: string;
  desc: string;
  settingKey: keyof Pick<Settings, 'restoreOnStartup'>;
}) {
  const value = useStore((s) => s.settings[settingKey]);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{title}</div>
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>{desc}</div>
      </div>
      <div className={`toggle${value ? ' on' : ''}`} onClick={() => updateSettings({ [settingKey]: !value } as Partial<Settings>)}>
        <span className="knob" />
      </div>
    </div>
  );
}

function SessionSection() {
  const exportData = useStore((s) => s.exportData);
  const importData = useStore((s) => s.importData);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const t = useT();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.session.title')}</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>{t('set.session.desc')}</div>
      </div>

      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, overflow: 'hidden' }}>
        <ToggleRow
          title={t('set.session.restoreOnStartup')}
          desc={t('set.session.restoreOnStartupDesc')}
          settingKey="restoreOnStartup"
        />
      </div>

      <div>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 8 }}>
          {t('set.session.backup')}
        </div>
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{t('set.session.exportImport')}</div>
            <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>{t('set.session.exportImportDesc')}</div>
            {msg && (
              <div style={{ font: '400 11px var(--font-ui)', color: msg.ok ? 'var(--accent)' : 'var(--danger)', marginTop: 4 }}>{msg.text}</div>
            )}
          </div>
          <button
            className="ghost-btn"
            style={{ padding: '6px 14px' }}
            onClick={async () => {
              const ok = await exportBackup(exportData());
              if (ok) setMsg({ ok: true, text: t('set.session.exported') });
            }}
          >
            {t('set.session.exportJson')}
          </button>
          <button
            className="ghost-btn"
            style={{ padding: '6px 14px' }}
            onClick={async () => {
              const json = await importBackup();
              if (json == null) return;
              const ok = importData(json);
              setMsg(ok ? { ok: true, text: t('set.session.imported') } : { ok: false, text: t('set.session.invalidFile') });
            }}
          >
            {t('set.session.importJson')}
          </button>
        </div>
      </div>
    </div>
  );
}

const LANGS: Array<{ v: Lang; label: string }> = [
  { v: 'vi', label: 'Tiếng Việt' },
  { v: 'en', label: 'English' },
];

function GeneralSection() {
  const fontSize = useStore((s) => s.settings.fontSize);
  const uiScale = useStore((s) => s.settings.uiScale);
  const language = useStore((s) => s.settings.language);
  const updateSettings = useStore((s) => s.updateSettings);
  const t = useT();

  const chip = (active: boolean, label: React.ReactNode, onClick: () => void, key: string) => (
    <div
      key={key}
      onClick={onClick}
      style={{
        padding: '8px 16px',
        borderRadius: 8,
        cursor: 'pointer',
        background: active ? 'var(--accent-soft-2)' : 'var(--surface-2)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-2)'}`,
        color: active ? 'var(--accent)' : 'var(--text-2)',
        font: `${active ? 600 : 400} 12.5px var(--font-ui)`,
      }}
    >
      {label}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.general.title')}</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', lineHeight: 1.7, marginTop: 3 }}>{t('set.general.about')}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>{t('set.general.language')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {LANGS.map((l) => chip(language === l.v, l.label, () => updateSettings({ language: l.v }), l.v))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>{t('set.general.zoom')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {UI_SCALES.map((s) => chip(Math.abs(uiScale - s.v) < 0.001, s.label, () => updateSettings({ uiScale: s.v }), String(s.v)))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>{t('set.general.termFont')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {FONT_ORDER.map((fs) =>
            chip(
              fontSize === fs,
              <>
                {t(`font.${fs}` as TKey)} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({FONT_PX[fs]}px)</span>
              </>,
              () => updateSettings({ fontSize: fs }),
              fs
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Pick an executable with the OS file dialog; returns null when cancelled. */
async function pickExe(): Promise<string | null> {
  return pickFile(undefined, IS_WIN ? [{ name: 'Program', extensions: ['exe', 'cmd', 'bat'] }] : undefined);
}

/** Filename without extension — the display name for a picked editor exe. */
export function editorNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function EditorSection() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.editorDefault')}</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>{t('set.editorDefaultHint')}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="field mono"
          value={settings.defaultEditor}
          onChange={(e) => updateSettings({ defaultEditor: e.target.value })}
          placeholder="/usr/local/bin/code"
          style={{ flex: 1 }}
        />
        <button className="ghost-btn" onClick={() => void pickExe().then((p) => p && updateSettings({ defaultEditor: p }))}>
          {t('set.editorBrowse')}
        </button>
        {settings.defaultEditor && (
          <button className="ghost-btn" onClick={() => updateSettings({ defaultEditor: '' })}>
            {t('set.editorClear')}
          </button>
        )}
      </div>

      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.editorList')}</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>{t('set.editorListHint')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {settings.editors.length === 0 && (
          <div style={{ font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>{t('set.editorEmpty')}</div>
        )}
        {settings.editors.map((ed, i) => (
          <div key={`${ed.path}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '12px 14px' }}>
            <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)', flex: 1 }}>{ed.name}</span>
            <span className="mono" style={{ font: '400 11px var(--font-mono)', color: 'var(--text-muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ed.path}>
              {ed.path}
            </span>
            <button className="ghost-btn" onClick={() => updateSettings({ editors: settings.editors.filter((_, j) => j !== i) })}>
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="ghost-btn"
        style={{ alignSelf: 'flex-start' }}
        onClick={() =>
          void pickExe().then((p) => {
            if (!p) return;
            const editors = useStore.getState().settings.editors;
            if (editors.some((e) => e.path === p)) return;
            updateSettings({ editors: [...editors, { name: editorNameOf(p), path: p }] });
          })
        }
      >
        {t('set.editorAdd')}
      </button>
    </div>
  );
}

function KeysSection() {
  const t = useT();
  const mod = IS_MAC ? '⌘' : 'Ctrl';
  const keys: Array<[string, string]> = [
    [`${mod} + N`, t('set.keys.newHost')],
    [`${mod} + Click`, t('set.keys.openLink')],
    [`${mod} + A`, t('set.keys.selectAllInput')],
    ['F5', t('set.keys.reloadPanel')],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.keys.title')}</div>
      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, overflow: 'hidden' }}>
        {keys.map(([k, label], i) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: i < keys.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <span style={{ font: '400 12px var(--font-ui)', color: 'var(--text)', flex: 1 }}>{label}</span>
            <span style={{ font: '600 11px var(--font-mono)', color: 'var(--text-2)', background: 'var(--bg-panel)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '3px 8px' }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UpdateSection() {
  const githubRepo = useStore((s) => s.settings.githubRepo);
  const updateSettings = useStore((s) => s.updateSettings);
  const [version, setVersion] = useState('…');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

  const install = async () => {
    if (!result) return;
    if (!result.downloadUrl) {
      void openUpdateUrl(result.url);
      return;
    }
    setInstalling(true);
    setError(null);
    setNote(t('set.update.downloading'));
    try {
      await downloadAndRun(result.downloadUrl);
      setNote(t('set.update.downloaded'));
      setTimeout(() => void quitApp(), 1800);
    } catch (e) {
      setInstalling(false);
      setNote(null);
      setError(t('set.update.downloadFailed', { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  const check = async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      setResult(await checkUpdate(githubRepo));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.update.title')}</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>
          {t('set.update.current')} <span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>v{version}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>{t('set.update.repo')}</label>
        <input className="field mono" placeholder={t('set.update.repoPlaceholder')} value={githubRepo} onChange={(e) => updateSettings({ githubRepo: e.target.value })} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="accent-btn" onClick={check} disabled={checking}>
          {checking ? t('set.update.checking') : t('set.update.check')}
        </button>
        {result && !result.hasUpdate && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '400 12px var(--font-ui)', color: 'var(--accent)' }}>
            <IconCheck size={14} /> {t('set.update.latest')}
          </span>
        )}
        {error && <span style={{ font: '400 12px var(--font-ui)', color: 'var(--danger)' }}>{error}</span>}
      </div>

      {result?.hasUpdate && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--accent)', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{t('set.update.available', { version: result.latest })}</div>
            <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>{t('set.update.youHave', { version: result.current })}</div>
            {note && <div style={{ font: '400 11px var(--font-ui)', color: 'var(--accent)', marginTop: 4 }}>{note}</div>}
          </div>
          <button className="accent-btn" onClick={install} disabled={installing}>
            {installing ? t('set.update.installing') : t('set.update.install')}
          </button>
        </div>
      )}
    </div>
  );
}
