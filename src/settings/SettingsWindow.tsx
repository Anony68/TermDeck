import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { IS_MAC, IS_WIN, SHELL_ORDER, SHELLS } from '../shells';
import { LAYOUT_ORDER, LAYOUTS } from '../layouts';
import { PresetIcon } from '../components/PresetIcon';
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
import { pickFolder, pickFile } from '../ipc/api';
import { exportBackup, importBackup } from '../ipc/backup';
import { useT, type TKey } from '../i18n';
import type { Lang, Settings } from '../types';

type Section = 'general' | 'projects' | 'session' | 'layout' | 'shells' | 'editor' | 'keys' | 'update';

const NAV: Array<{ id: Section; key: TKey }> = [
  { id: 'general', key: 'set.nav.general' },
  { id: 'projects', key: 'set.nav.projects' },
  { id: 'session', key: 'set.nav.session' },
  { id: 'layout', key: 'set.nav.layout' },
  { id: 'shells', key: 'set.nav.shells' },
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

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SettingsWindow() {
  const initialSection = useStore((s) => s.ui.settingsSection);
  const [section, setSection] = useState<Section>((initialSection as Section) || 'general');
  const closeSettings = useStore((s) => s.closeSettings);
  const t = useT();

  return (
    <div
      onMouseDown={closeSettings}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 60,
      }}
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 38,
            background: 'var(--bg-panel)',
            borderBottom: '1px solid var(--border)',
            padding: '0 0 0 14px',
            flex: 'none',
          }}
        >
          <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{t('set.title')}</span>
          <div style={{ flex: 1 }} />
          <div className="wc close" style={{ height: 38 }} onClick={closeSettings}>
            <IconClose size={15} />
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div
            style={{
              width: 200,
              flex: 'none',
              background: 'var(--bg-panel)',
              borderRight: '1px solid var(--border)',
              padding: '12px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {NAV.map((n) => (
              <div
                key={n.id}
                className={`nav-item${section === n.id ? ' active' : ''}`}
                onClick={() => setSection(n.id)}
              >
                {t(n.key)}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, padding: '24px 28px', overflow: 'auto', minWidth: 0 }}>
            {section === 'session' && <SessionSection />}
            {section === 'general' && <GeneralSection />}
            {section === 'projects' && <ProjectsSection />}
            {section === 'layout' && <LayoutSection />}
            {section === 'shells' && <ShellsSection />}
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
  settingKey: keyof Pick<
    Settings,
    'restoreOnStartup' | 'restoreCwd' | 'restoreGrid' | 'autoRunCommand' | 'usageClaude' | 'usageCursor'
  >;
}) {
  const value = useStore((s) => s.settings[settingKey]);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '13px 16px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{title}</div>
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>{desc}</div>
      </div>
      <div
        className={`toggle${value ? ' on' : ''}`}
        onClick={() => updateSettings({ [settingKey]: !value } as Partial<Settings>)}
      >
        <span className="knob" />
      </div>
    </div>
  );
}

function SessionSection() {
  const snapshots = useStore((s) => s.snapshots);
  const tabs = useStore((s) => s.tabs);
  const liveCmd = useStore((s) => s.panes.length);
  const restoreSnapshot = useStore((s) => s.restoreSnapshot);
  const captureSnapshot = useStore((s) => s.captureSnapshot);
  const exportData = useStore((s) => s.exportData);
  const importData = useStore((s) => s.importData);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const t = useT();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.session.title')}</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>
          {t('set.session.desc')}
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border-2)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <ToggleRow
          title={t('set.session.restoreOnStartup')}
          desc={t('set.session.restoreOnStartupDesc')}
          settingKey="restoreOnStartup"
        />
        <ToggleRow
          title={t('set.session.restoreCwd')}
          desc={t('set.session.restoreCwdDesc')}
          settingKey="restoreCwd"
        />
        <ToggleRow
          title={t('set.session.restoreGrid')}
          desc={t('set.session.restoreGridDesc')}
          settingKey="restoreGrid"
        />
        <ToggleRow
          title={t('set.session.autoRun')}
          desc={t('set.session.autoRunDesc')}
          settingKey="autoRunCommand"
        />
      </div>

      <div>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 8 }}>
          {t('set.session.backup')}
        </div>
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>{t('set.session.exportImport')}</div>
            <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
              {t('set.session.exportImportDesc')}
            </div>
            {msg && (
              <div style={{ font: '400 11px var(--font-ui)', color: msg.ok ? 'var(--accent)' : 'var(--danger)', marginTop: 4 }}>
                {msg.text}
              </div>
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

      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <span
            style={{
              font: '600 11px var(--font-ui)',
              color: 'var(--text-muted)',
              letterSpacing: '0.08em',
              flex: 1,
            }}
          >
            {t('set.session.recent')}
          </span>
          <button
            className="ghost-btn"
            onClick={captureSnapshot}
            style={{ padding: '5px 12px', fontSize: 11 }}
          >
            {t('set.session.saveSnapshot')}
          </button>
        </div>
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-2)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '11px 16px',
              borderBottom: snapshots.length ? '1px solid var(--border)' : 'none',
            }}
          >
            <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--text-2)' }}>
              {t('set.session.now')}
            </span>
            <span style={{ font: '400 11.5px var(--font-ui)', color: 'var(--text-muted)', flex: 1 }}>
              {t('set.session.tabsCmds', { tabs: tabs.length, cmds: liveCmd })}
            </span>
            <span style={{ font: '600 11px var(--font-ui)', color: 'var(--accent)' }}>
              {t('set.session.current')}
            </span>
          </div>
          {snapshots.map((snap, i) => (
            <div
              key={snap.at}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '11px 16px',
                borderBottom: i < snapshots.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--text-2)' }}>
                {fmtDate(snap.at)}
              </span>
              <span
                style={{ font: '400 11.5px var(--font-ui)', color: 'var(--text-muted)', flex: 1 }}
              >
                {t('set.session.tabsCmds', { tabs: snap.tabCount, cmds: snap.cmdCount })}
              </span>
              <span className="link-btn" onClick={() => restoreSnapshot(snap.at)}>
                {t('set.session.restore')}
              </span>
            </div>
          ))}
          {snapshots.length === 0 && (
            <div style={{ padding: '11px 16px', font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>
              {t('set.session.noSnapshots')}
            </div>
          )}
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.general.title')}</div>
        <div
          style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', lineHeight: 1.7, marginTop: 3 }}
        >
          {t('set.general.about')}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
          {t('set.general.language')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {LANGS.map((l) => {
            const active = language === l.v;
            return (
              <div
                key={l.v}
                onClick={() => updateSettings({ language: l.v })}
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
                {l.label}
              </div>
            );
          })}
        </div>
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
          {t('set.general.langHint')}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
          {t('set.general.zoom')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {UI_SCALES.map((s) => {
            const active = Math.abs(uiScale - s.v) < 0.001;
            return (
              <div
                key={s.v}
                onClick={() => updateSettings({ uiScale: s.v })}
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
                {s.label}
              </div>
            );
          })}
        </div>
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
          {t('set.general.zoomHint')}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            font: '600 11px var(--font-ui)',
            color: 'var(--text-muted)',
            letterSpacing: '0.08em',
          }}
        >
          {t('set.general.termFont')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {FONT_ORDER.map((fs) => {
            const active = fontSize === fs;
            return (
              <div
                key={fs}
                onClick={() => updateSettings({ fontSize: fs })}
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
                {t(`font.${fs}` as TKey)}{' '}
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({FONT_PX[fs]}px)</span>
              </div>
            );
          })}
        </div>
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
          {t('set.general.termFontHint')}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
          {t('set.general.usage')}
        </div>
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-2)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <ToggleRow
            title={t('set.general.usageClaude')}
            desc={t('set.general.usageClaudeDesc')}
            settingKey="usageClaude"
          />
          <ToggleRow
            title={t('set.general.usageCursor')}
            desc={t('set.general.usageCursorDesc')}
            settingKey="usageCursor"
          />
        </div>
      </div>
    </div>
  );
}

function LayoutSection() {
  const defaultLayout = useStore((s) => s.settings.defaultLayout);
  const updateSettings = useStore((s) => s.updateSettings);
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.layout.title')}</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>
        {t('set.layout.desc')}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[...LAYOUT_ORDER, 'auto' as const].map((id) => {
          const active = defaultLayout === id;
          return (
            <div
              key={id}
              onClick={() => updateSettings({ defaultLayout: id })}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                padding: '14px 16px',
                borderRadius: 9,
                background: active ? 'var(--accent-soft-2)' : 'var(--surface-2)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border-2)'}`,
                cursor: 'pointer',
              }}
            >
              <PresetIcon preset={id} active={active} w={40} h={28} />
              <span
                style={{
                  font: `${active ? 600 : 400} 11px var(--font-ui)`,
                  color: active ? 'var(--accent)' : 'var(--text-2)',
                }}
              >
                {id === 'auto' ? 'Auto' : LAYOUTS[id].label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShellsSection() {
  const shells = useStore((s) => s.shells);
  const shellPaths = useStore((s) => s.settings.shellPaths);
  const updateSettings = useStore((s) => s.updateSettings);
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.shells.title')}</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>
        {t('set.shells.desc')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {SHELL_ORDER.map((k) => {
          const info = shells.find((s) => s.kind === k);
          const detected = info?.available;
          return (
            <div
              key={k}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-2)',
                borderRadius: 10,
                padding: '12px 14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)', flex: 1 }}>
                  {SHELLS[k].label}
                </span>
                <span
                  style={{
                    font: '600 10.5px var(--font-ui)',
                    color: detected ? 'var(--accent)' : 'var(--danger)',
                  }}
                >
                  {detected ? t('set.shells.found') : t('set.shells.notFound')}
                </span>
              </div>
              <input
                className="field mono"
                placeholder={info?.path || t('set.shells.pathPlaceholder')}
                value={shellPaths[k] ?? ''}
                onChange={(e) =>
                  updateSettings({ shellPaths: { ...shellPaths, [k]: e.target.value } })
                }
              />
            </div>
          );
        })}
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
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>
        {t('set.editorDefaultHint')}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="field mono"
          value={settings.defaultEditor}
          onChange={(e) => updateSettings({ defaultEditor: e.target.value })}
          placeholder="C:\Program Files\Notepad++\notepad++.exe"
          style={{ flex: 1 }}
        />
        <button
          className="ghost-btn"
          onClick={() => void pickExe().then((p) => p && updateSettings({ defaultEditor: p }))}
        >
          {t('set.editorBrowse')}
        </button>
        {settings.defaultEditor && (
          <button className="ghost-btn" onClick={() => updateSettings({ defaultEditor: '' })}>
            {t('set.editorClear')}
          </button>
        )}
      </div>

      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.editorList')}</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>
        {t('set.editorListHint')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {settings.editors.length === 0 && (
          <div style={{ font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>
            {t('set.editorEmpty')}
          </div>
        )}
        {settings.editors.map((ed, i) => (
          <div
            key={`${ed.path}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-2)',
              borderRadius: 10,
              padding: '12px 14px',
            }}
          >
            <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)', flex: 1 }}>{ed.name}</span>
            <span
              className="mono"
              style={{
                font: '400 11px var(--font-mono)',
                color: 'var(--text-muted)',
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={ed.path}
            >
              {ed.path}
            </span>
            <button
              className="ghost-btn"
              onClick={() => updateSettings({ editors: settings.editors.filter((_, j) => j !== i) })}
            >
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
  const alt = IS_MAC ? '⌥' : 'Alt';
  const keys: Array<[string, string]> = [
    [`${mod} + T`, t('set.keys.newTab')],
    [`${mod} + N`, t('set.keys.newTerminal')],
    [`${mod} + W`, t('set.keys.closeTerminal')],
    ['Ctrl + Tab', t('set.keys.switchTab')],
    [`${alt} + 1..6`, t('set.keys.changeLayout')],
    [`${mod} + Click`, t('set.keys.openLink')],
    [`${mod} + A`, t('set.keys.selectAllInput')],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.keys.title')}</div>
      <div
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border-2)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        {keys.map(([k, label], i) => (
          <div
            key={k}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '11px 16px',
              borderBottom: i < keys.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <span style={{ font: '400 12px var(--font-ui)', color: 'var(--text)', flex: 1 }}>
              {label}
            </span>
            <span
              style={{
                font: '600 11px var(--font-mono)',
                color: 'var(--text-2)',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-2)',
                borderRadius: 6,
                padding: '3px 8px',
              }}
            >
              {k}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectsSection() {
  const projects = useStore((s) => s.projects);
  const addProject = useStore((s) => s.addProject);
  const updateProject = useStore((s) => s.updateProject);
  const removeProject = useStore((s) => s.removeProject);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const t = useT();

  const add = () => {
    if (!name.trim()) return;
    addProject(name.trim(), path.trim() || undefined);
    setName('');
    setPath('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>{t('set.projects.title')}</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>
          {t('set.projects.desc')}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>{t('set.projects.name')}</label>
          <input
            className="field"
            placeholder={t('set.projects.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>{t('set.projects.folder')}</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="field mono"
              placeholder="D:\work\api"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <button
              className="ghost-btn"
              style={{ padding: '8px 12px' }}
              onClick={async () => {
                const p = await pickFolder(path || undefined);
                if (p) setPath(p);
              }}
            >
              {t('common.choose')}
            </button>
          </div>
        </div>
        <button className="accent-btn" style={{ height: 35 }} onClick={add}>
          {t('common.add')}
        </button>
      </div>

      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, overflow: 'hidden' }}>
        {projects.length === 0 && (
          <div style={{ padding: '14px 16px', font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>
            {t('set.projects.empty')}
          </div>
        )}
        {projects.map((pr, i) => (
          <div
            key={pr.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderBottom: i < projects.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <input
              className="field"
              value={pr.name}
              onChange={(e) => updateProject(pr.id, { name: e.target.value })}
              style={{ flex: '0 0 40%' }}
            />
            <input
              className="field mono"
              placeholder={t('set.projects.noFolder')}
              value={pr.path ?? ''}
              onChange={(e) => updateProject(pr.id, { path: e.target.value || undefined })}
              style={{ flex: 1 }}
            />
            <span
              className="pane-ctl danger"
              title={t('set.projects.delete')}
              onClick={() => removeProject(pr.id)}
              style={{ width: 22, height: 22 }}
            >
              <IconClose size={13} />
            </span>
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
          {t('set.update.current')}{' '}
          <span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>v{version}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>{t('set.update.repo')}</label>
        <input
          className="field mono"
          placeholder={t('set.update.repoPlaceholder')}
          value={githubRepo}
          onChange={(e) => updateSettings({ githubRepo: e.target.value })}
        />
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
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--accent)',
            borderRadius: 10,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>
              {t('set.update.available', { version: result.latest })}
            </div>
            <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
              {t('set.update.youHave', { version: result.current })}
            </div>
            {note && (
              <div style={{ font: '400 11px var(--font-ui)', color: 'var(--accent)', marginTop: 4 }}>
                {note}
              </div>
            )}
          </div>
          <button className="accent-btn" onClick={install} disabled={installing}>
            {installing ? t('set.update.installing') : t('set.update.install')}
          </button>
        </div>
      )}
    </div>
  );
}
