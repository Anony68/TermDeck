import { useState, type ReactNode } from 'react';
import { useStore, findPane } from '../state/store';
import { SHELL_ORDER, SHELLS } from '../shells';
import { pickFolder, pickFile } from '../ipc/api';
import { secretSet, sshConfigHosts, parseTlp, type SshConfigHost } from '../ipc/ssh';
import { ShellBadge } from '../components/ShellBadge';
import { useT, type TKey } from '../i18n';
import type { PaneKind, ShellKind, SshConfig } from '../types';

const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

const KINDS: Array<{ kind: PaneKind; labelKey: TKey; badge: string; color: string; hintKey: TKey }> = [
  { kind: 'shell', labelKey: 'dlg.kindShell', badge: '>_', color: 'var(--sh-cmd)', hintKey: 'dlg.kindShellHint' },
  { kind: 'ssh', labelKey: 'dlg.kindSsh', badge: 'SSH', color: 'var(--sh-wsl)', hintKey: 'dlg.kindSshHint' },
  { kind: 'browser', labelKey: 'dlg.kindBrowser', badge: 'FB', color: 'var(--sh-ps)', hintKey: 'dlg.kindBrowserHint' },
];

export function AddCmdDialog() {
  const editPaneId = useStore((s) => s.ui.editPaneId);
  const editPane = useStore((s) => (s.ui.editPaneId ? findPane(s, s.ui.editPaneId) : undefined));
  const slot = useStore((s) => s.ui.addCmdSlot);
  const shells = useStore((s) => s.shells);
  const addPane = useStore((s) => s.addPane);
  const updatePane = useStore((s) => s.updatePane);
  const restartPane = useStore((s) => s.restartPane);
  const projects = useStore((s) => s.projects);
  const addProject = useStore((s) => s.addProject);
  const recentKeys = useStore((s) => s.recentKeys);
  const rememberKey = useStore((s) => s.rememberKey);
  const forgetKey = useStore((s) => s.forgetKey);
  const closeAddCmd = useStore((s) => s.closeAddCmd);
  const closeEditCmd = useStore((s) => s.closeEditCmd);
  const t = useT();

  const editing = !!editPaneId;
  const close = editing ? closeEditCmd : closeAddCmd;

  const avail = (k: ShellKind) => {
    const info = shells.find((s) => s.kind === k);
    return info ? info.available : true;
  };
  const firstAvail = SHELL_ORDER.find(avail) ?? 'powershell';

  const [kind, setKind] = useState<PaneKind>(editPane?.kind ?? 'shell');
  const [name, setName] = useState(editPane?.name ?? '');
  const [shell, setShell] = useState<ShellKind>(editPane?.shell ?? firstAvail);
  const [cwd, setCwd] = useState(editPane?.cwd ?? '');
  const [presetCommand, setPresetCommand] = useState(editPane?.presetCommand ?? '');
  const [autoStart, setAutoStart] = useState(editPane?.autoStart ?? true);
  const [projectId, setProjectId] = useState<string>(editPane?.projectId ?? '');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  // SSH fields (shared by 'ssh' and 'browser').
  const [host, setHost] = useState(editPane?.ssh?.host ?? '');
  const [port, setPort] = useState(String(editPane?.ssh?.port ?? 22));
  const [user, setUser] = useState(editPane?.ssh?.user ?? '');
  const [auth, setAuth] = useState<'password' | 'key'>(editPane?.ssh?.auth ?? 'password');
  const [keyPath, setKeyPath] = useState(editPane?.ssh?.keyPath ?? '');
  const [showKeys, setShowKeys] = useState(false);
  const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
  const chooseKey = async () => {
    const f = await pickFile(keyPath || undefined, [
      { name: 'SSH key', extensions: ['pem', 'ppk', 'key'] },
      { name: 'All files', extensions: ['*'] },
    ]);
    if (f) {
      setKeyPath(f);
      rememberKey(f);
    }
  };
  const [secret, setSecret] = useState('');
  const [remotePath, setRemotePath] = useState(editPane?.ssh?.remotePath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [cfgHosts, setCfgHosts] = useState<SshConfigHost[] | null>(null);
  const [showCfg, setShowCfg] = useState(false);

  const isRemote = kind === 'ssh' || kind === 'browser';

  const openSshConfig = async () => {
    setShowCfg((v) => !v);
    if (cfgHosts === null) setCfgHosts(await sshConfigHosts());
  };
  const importTlp = async () => {
    setError(null);
    const f = await pickFile(undefined, [{ name: 'Bitvise profile', extensions: ['tlp', 'bscp'] }]);
    if (!f) return;
    try {
      const p = await parseTlp(f);
      setHost(p.host);
      if (p.port) setPort(String(p.port));
      if (p.user) setUser(p.user);
      setAuth('password'); // Bitvise encrypts the password per-machine — can't import it.
      if (!name.trim() && p.user && p.host) setName(`${p.user}@${p.host}`);
    } catch (e) {
      setError(t('dlg.tlpError', { e: String(e) }));
    }
  };

  const applyCfgHost = (h: SshConfigHost) => {
    setHost(h.hostName || h.alias);
    if (h.port) setPort(String(h.port));
    if (h.user) setUser(h.user);
    if (h.identityFile) {
      setAuth('key');
      setKeyPath(h.identityFile);
    }
    if (!name.trim()) setName(h.alias);
    setShowCfg(false);
  };

  const onProjectChange = (v: string) => {
    if (v === '__new__') {
      setCreatingNew(true);
      setProjectId('');
      return;
    }
    setCreatingNew(false);
    setProjectId(v);
    const pr = projects.find((p) => p.id === v);
    if (pr?.path && !cwd.trim()) setCwd(pr.path);
  };

  const defaultName = () => {
    if (kind === 'ssh') return user && host ? `${user}@${host}` : 'SSH';
    if (kind === 'browser') return host ? `Files — ${host}` : t('dlg.kindBrowser');
    return SHELLS[shell].label;
  };

  const submit = async () => {
    setError(null);
    if (isRemote) {
      if (!host.trim()) return setError(t('dlg.errHost'));
      if (!user.trim()) return setError(t('dlg.errUser'));
      const p = parseInt(port, 10);
      if (!p || p < 1 || p > 65535) return setError(t('dlg.errPort'));
      if (auth === 'key' && !keyPath.trim()) return setError(t('dlg.errKey'));
      if (auth === 'key') rememberKey(keyPath.trim());
    }

    const finalName = name.trim() || defaultName();
    let finalProjectId: string | undefined = projectId || undefined;
    if (creatingNew && newProjectName.trim()) {
      finalProjectId = addProject(newProjectName.trim(), cwd.trim() || undefined);
    }

    const ssh: SshConfig | undefined = isRemote
      ? {
          host: host.trim(),
          port: parseInt(port, 10),
          user: user.trim(),
          auth,
          keyPath: auth === 'key' ? keyPath.trim() : undefined,
          remotePath: remotePath.trim() || undefined,
        }
      : undefined;

    const fields = {
      name: finalName,
      shell,
      cwd: cwd.trim(),
      presetCommand: presetCommand.trim() || undefined,
      autoStart,
      projectId: finalProjectId,
      kind,
      ssh,
    };

    if (editing && editPaneId) {
      // Save secret first (if changed) so the respawn can read it.
      if (isRemote && secret) await secretSet(editPaneId, secret);
      updatePane(editPaneId, fields);
      // updatePane only respawns on connection-field changes; if the user just
      // changed the password, force a reconnect too.
      if (isRemote && secret) restartPane(editPaneId);
    } else {
      const id = uid();
      // Store the secret BEFORE the pane mounts, so the SSH/SFTP connect succeeds
      // on first try (the Rust side reads it from the OS credential store).
      if (isRemote && secret) await secretSet(id, secret);
      addPane({ ...fields, id, slot: slot ?? undefined });
    }
    close();
  };

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,7,10,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px 0' }}>
          <span style={{ font: '600 15px var(--font-ui)', color: 'var(--text)', flex: 1 }}>
            {editing ? t('dlg.editTitle') : t('dlg.addTitle')}
          </span>
          <span className="icon-btn" onClick={close} style={{ width: 24, height: 24, fontSize: 13 }}>
            ✕
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px' }}>
          <Field label={t('dlg.kind')}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {KINDS.map((k) => {
                const selected = kind === k.kind;
                return (
                  <div
                    key={k.kind}
                    className={`shell-card${selected ? ' selected' : ''}`}
                    onClick={() => setKind(k.kind)}
                    title={t(k.hintKey)}
                    style={{ gap: 6 }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        display: 'grid',
                        placeItems: 'center',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        fontSize: 8.5,
                        background: `color-mix(in srgb, ${k.color} 16%, transparent)`,
                        color: k.color,
                      }}
                    >
                      {k.badge}
                    </div>
                    <span
                      style={{
                        font: `${selected ? 600 : 400} 10.5px var(--font-ui)`,
                        color: selected ? 'var(--text)' : 'var(--text-2)',
                        textAlign: 'center',
                      }}
                    >
                      {t(k.labelKey)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Field>

          <Field label={t('dlg.displayName')}>
            <input
              className="field"
              autoFocus
              placeholder={defaultName()}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isRemote && submit()}
            />
          </Field>

          {kind === 'shell' && (
            <Field label={t('dlg.shellKind')}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
                {SHELL_ORDER.map((k) => {
                  const enabled = avail(k);
                  const selected = shell === k;
                  return (
                    <div
                      key={k}
                      className={`shell-card${selected ? ' selected' : ''}${enabled ? '' : ' disabled'}`}
                      onClick={() => enabled && setShell(k)}
                      title={enabled ? SHELLS[k].label : t('dlg.shellNotFound', { label: SHELLS[k].label })}
                    >
                      <ShellBadge shell={k} size={24} />
                      <span
                        style={{
                          font: `${selected ? 600 : 400} 10.5px var(--font-ui)`,
                          color: selected ? 'var(--text)' : 'var(--text-2)',
                        }}
                      >
                        {SHELLS[k].label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Field>
          )}

          {isRemote && (
            <>
              <div style={{ position: 'relative', display: 'flex', gap: 8 }}>
                <button className="ghost-btn" style={{ padding: '6px 12px', fontSize: 11.5 }} onClick={openSshConfig}>
                  ⤓ {t('dlg.fromSshConfig')} ▾
                </button>
                <button
                  className="ghost-btn"
                  style={{ padding: '6px 12px', fontSize: 11.5 }}
                  title={t('dlg.fromTlpHint')}
                  onClick={importTlp}
                >
                  ⤓ {t('dlg.fromTlp')}
                </button>
                {showCfg && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      marginTop: 4,
                      maxHeight: 220,
                      overflow: 'auto',
                      background: 'var(--surface-3)',
                      border: '1px solid var(--border-3)',
                      borderRadius: 8,
                      boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                      zIndex: 10,
                      padding: 4,
                    }}
                  >
                    {cfgHosts?.length === 0 && (
                      <div style={{ padding: 10, font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>
                        {t('dlg.sshConfigEmpty')}
                      </div>
                    )}
                    {cfgHosts?.map((h) => (
                      <div key={h.alias} className="menu-item" onClick={() => applyCfgHost(h)}>
                        <span style={{ flex: 1 }}>{h.alias}</span>
                        <span style={{ color: 'var(--text-muted)', font: '400 10px var(--font-mono)' }}>
                          {h.user ? `${h.user}@` : ''}
                          {h.hostName || h.alias}
                          {h.port && h.port !== 22 ? `:${h.port}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label={t('dlg.host')}>
                    <input
                      className="field mono"
                      placeholder="VD: 192.168.1.10"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ width: 96 }}>
                  <Field label={t('dlg.port')}>
                    <input
                      className="field mono"
                      placeholder="22"
                      value={port}
                      onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                  </Field>
                </div>
              </div>

              <Field label={t('dlg.username')}>
                <input
                  className="field mono"
                  placeholder="VD: root"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </Field>

              <Field label={t('dlg.auth')}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                  <SegBtn active={auth === 'password'} onClick={() => setAuth('password')}>
                    {t('dlg.authPassword')}
                  </SegBtn>
                  <SegBtn active={auth === 'key'} onClick={() => setAuth('key')}>
                    {t('dlg.authKey')}
                  </SegBtn>
                </div>
                {auth === 'password' ? (
                  <input
                    className="field mono"
                    type="password"
                    placeholder={editing ? t('dlg.passwordKeep') : t('dlg.password')}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
                      <input
                        className="field mono"
                        placeholder={t('dlg.keyPath')}
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                      />
                      {recentKeys.length > 0 && (
                        <button
                          className="ghost-btn"
                          style={{ padding: '8px 12px' }}
                          title={t('dlg.savedKeys')}
                          onClick={() => setShowKeys((v) => !v)}
                        >
                          ★ ▾
                        </button>
                      )}
                      <button className="ghost-btn" style={{ padding: '8px 14px' }} onClick={chooseKey}>
                        {t('common.choose')}
                      </button>
                      {showKeys && recentKeys.length > 0 && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            marginTop: 4,
                            maxHeight: 200,
                            overflow: 'auto',
                            background: 'var(--surface-3)',
                            border: '1px solid var(--border-3)',
                            borderRadius: 8,
                            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                            zIndex: 10,
                            padding: 4,
                          }}
                        >
                          {recentKeys.map((k) => (
                            <div key={k} className="menu-item" style={{ gap: 6 }}>
                              <span
                                style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
                                onClick={() => {
                                  setKeyPath(k);
                                  rememberKey(k);
                                  setShowKeys(false);
                                }}
                              >
                                <div style={{ font: '600 11.5px var(--font-mono)', color: 'var(--text)' }}>
                                  {baseName(k)}
                                </div>
                                <div
                                  style={{
                                    font: '400 9.5px var(--font-mono)',
                                    color: 'var(--text-muted)',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    direction: 'rtl',
                                    textAlign: 'left',
                                  }}
                                >
                                  {k}
                                </div>
                              </span>
                              <span
                                className="icon-btn"
                                title={t('dlg.forgetKey')}
                                onClick={() => forgetKey(k)}
                                style={{ width: 20, height: 20, fontSize: 11, flex: 'none' }}
                              >
                                ✕
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <input
                      className="field mono"
                      type="password"
                      placeholder={editing ? t('dlg.passphraseKeep') : t('dlg.passphrase')}
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      style={{ marginTop: 6 }}
                    />
                  </>
                )}
              </Field>

              <Field
                label={
                  <>
                    {t('dlg.remoteDir')}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{t('common.optional')}</span>
                  </>
                }
              >
                <input
                  className="field mono"
                  placeholder="VD: /var/www"
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                />
              </Field>
            </>
          )}

          {kind === 'shell' && (
            <Field label={t('dlg.startDir')}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="field mono"
                  placeholder={t('dlg.startPath')}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
                <button
                  className="ghost-btn"
                  style={{ padding: '8px 14px' }}
                  onClick={async () => {
                    const picked = await pickFolder(cwd || undefined);
                    if (picked) setCwd(picked);
                  }}
                >
                  {t('common.choose')}
                </button>
              </div>
            </Field>
          )}

          {kind !== 'browser' && (
            <Field
              label={
                <>
                  {t('dlg.presetCmd')}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{t('common.optional')}</span>
                </>
              }
            >
              <input
                className="field mono"
                placeholder={kind === 'ssh' ? t('dlg.presetSsh') : t('dlg.presetShell')}
                value={presetCommand}
                onChange={(e) => setPresetCommand(e.target.value)}
              />
            </Field>
          )}

          <Field
            label={
              <>
                {t('dlg.project')} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{t('common.optional')}</span>
              </>
            }
          >
            <select
              className="field"
              value={creatingNew ? '__new__' : projectId}
              onChange={(e) => onProjectChange(e.target.value)}
              style={{ cursor: 'pointer' }}
            >
              <option value="">{t('dlg.projectNone')}</option>
              {projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
              <option value="__new__">{t('dlg.projectNew')}</option>
            </select>
            {creatingNew && (
              <input
                className="field"
                placeholder={t('dlg.projectNewName')}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                style={{ marginTop: 6 }}
              />
            )}
          </Field>

          {kind !== 'browser' && (
            <Row
              label={t('dlg.autostart')}
              on={autoStart}
              onToggle={() => setAutoStart((v) => !v)}
            />
          )}

          {error && (
            <div style={{ font: '400 11.5px var(--font-ui)', color: 'var(--danger)' }}>{error}</div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px',
            background: '#0e1218',
            borderTop: '1px solid var(--border)',
            position: 'sticky',
            bottom: 0,
          }}
        >
          <button className="ghost-btn" onClick={close} style={{ padding: '8px 18px', fontSize: 12.5 }}>
            {t('common.cancel')}
          </button>
          <button className="accent-btn" style={{ padding: '8px 18px', fontSize: 12.5 }} onClick={submit}>
            {editing ? t('dlg.save') : t('dlg.addToTab')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>{label}</label>
      {children}
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '7px 10px',
        borderRadius: 7,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-3)'}`,
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-2)',
        font: `${active ? 600 : 400} 11.5px var(--font-ui)`,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function Row({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <div className={`toggle${on ? ' on' : ''}`} onClick={onToggle}>
        <span className="knob" />
      </div>
      <span style={{ font: '400 12px var(--font-ui)', color: 'var(--text)' }}>{label}</span>
    </div>
  );
}
