import { useState, type ReactNode } from 'react';
import { useStore, findHost, termId, sftpId } from '../state/store';
import { pickFile } from '../ipc/api';
import { secretSet, secretCopy, sshConfigHosts, parseTlp, type SshConfigHost } from '../ipc/ssh';
import { IconClose, IconImport, IconChevronDown, IconStar } from '../components/icons';
import { useT } from '../i18n';
import type { SshConfig } from '../types';

const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

/** Add or edit a VPS (one SSH connection; SFTP is derived from it). */
export function AddHostDialog() {
  const editHostId = useStore((s) => s.ui.editHostId);
  const editHost = useStore((s) => (s.ui.editHostId ? findHost(s, s.ui.editHostId) : undefined));
  const addHost = useStore((s) => s.addHost);
  const updateHost = useStore((s) => s.updateHost);
  const restartPane = useStore((s) => s.restartPane);
  const recentKeys = useStore((s) => s.recentKeys);
  const rememberKey = useStore((s) => s.rememberKey);
  const forgetKey = useStore((s) => s.forgetKey);
  const closeAddHost = useStore((s) => s.closeAddHost);
  const closeEditHost = useStore((s) => s.closeEditHost);
  const t = useT();

  const editing = !!editHostId;
  const close = editing ? closeEditHost : closeAddHost;

  const [name, setName] = useState(editHost?.name ?? '');
  const [host, setHost] = useState(editHost?.ssh.host ?? '');
  const [port, setPort] = useState(String(editHost?.ssh.port ?? 22));
  const [user, setUser] = useState(editHost?.ssh.user ?? '');
  const [auth, setAuth] = useState<'password' | 'key'>(editHost?.ssh.auth ?? 'password');
  const [keyPath, setKeyPath] = useState(editHost?.ssh.keyPath ?? '');
  const [secret, setSecret] = useState('');
  const [remotePath, setRemotePath] = useState(editHost?.ssh.remotePath ?? '');
  const [presetCommand, setPresetCommand] = useState(editHost?.presetCommand ?? '');
  const [error, setError] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [cfgHosts, setCfgHosts] = useState<SshConfigHost[] | null>(null);
  const [showCfg, setShowCfg] = useState(false);

  const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
  const defaultName = () => (user && host ? `${user}@${host}` : 'VPS');

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
      setAuth('password');
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

  const submit = async () => {
    setError(null);
    if (!host.trim()) return setError(t('dlg.errHost'));
    if (!user.trim()) return setError(t('dlg.errUser'));
    const p = parseInt(port, 10);
    if (!p || p < 1 || p > 65535) return setError(t('dlg.errPort'));
    if (auth === 'key' && !keyPath.trim()) return setError(t('dlg.errKey'));
    if (auth === 'key') rememberKey(keyPath.trim());

    const ssh: SshConfig = {
      host: host.trim(),
      port: p,
      user: user.trim(),
      auth,
      keyPath: auth === 'key' ? keyPath.trim() : undefined,
      remotePath: remotePath.trim() || undefined,
    };
    const fields = { name: name.trim(), ssh, presetCommand: presetCommand.trim() || undefined };

    if (editing && editHostId) {
      // Store the secret under the terminal session slot; propagate to SFTP if open.
      if (secret) {
        await secretSet(termId(editHostId), secret);
        await secretCopy(termId(editHostId), sftpId(editHostId)).catch(() => {});
      }
      updateHost(editHostId, fields);
      // updateHost reconnects on SSH-field changes; a bare password change needs a
      // forced reconnect too.
      if (secret) restartPane(termId(editHostId));
    } else {
      const id = uid();
      // Store the secret BEFORE the host mounts, so the first SSH/SFTP connect
      // reads it from the OS credential store and succeeds.
      if (secret) await secretSet(termId(id), secret);
      addHost({ ...fields, id });
    }
    close();
  };

  return (
    <div
      onMouseDown={close}
      style={{ position: 'fixed', inset: 0, background: 'rgba(5,7,10,0.55)', display: 'grid', placeItems: 'center', zIndex: 50 }}
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
            {editing ? t('host.editTitle') : t('host.addTitle')}
          </span>
          <span className="icon-btn" onClick={close} style={{ width: 24, height: 24 }}>
            <IconClose size={15} />
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-btn" style={{ padding: '6px 12px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, position: 'relative' }} onClick={openSshConfig}>
              <IconImport size={13} /> {t('dlg.fromSshConfig')} <IconChevronDown size={13} />
            </button>
            <button className="ghost-btn" style={{ padding: '6px 12px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }} title={t('dlg.fromTlpHint')} onClick={importTlp}>
              <IconImport size={13} /> {t('dlg.fromTlp')}
            </button>
          </div>
          {showCfg && (
            <div style={{ maxHeight: 200, overflow: 'auto', background: 'var(--surface-3)', border: '1px solid var(--border-3)', borderRadius: 8, padding: 4, marginTop: -8 }}>
              {cfgHosts?.length === 0 && (
                <div style={{ padding: 10, font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>{t('dlg.sshConfigEmpty')}</div>
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

          <Field label={t('host.name')}>
            <input
              className="field"
              autoFocus
              placeholder={defaultName()}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Field label={t('dlg.host')}>
                <input className="field mono" placeholder="VD: 192.168.1.10" value={host} onChange={(e) => setHost(e.target.value)} />
              </Field>
            </div>
            <div style={{ width: 96 }}>
              <Field label={t('dlg.port')}>
                <input className="field mono" placeholder="22" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
              </Field>
            </div>
          </div>

          <Field label={t('dlg.username')}>
            <input className="field mono" placeholder="VD: root" value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>

          <Field label={t('dlg.auth')}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
              <SegBtn active={auth === 'password'} onClick={() => setAuth('password')}>{t('dlg.authPassword')}</SegBtn>
              <SegBtn active={auth === 'key'} onClick={() => setAuth('key')}>{t('dlg.authKey')}</SegBtn>
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
                  <input className="field mono" placeholder={t('dlg.keyPath')} value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
                  {recentKeys.length > 0 && (
                    <button className="ghost-btn" style={{ padding: '8px 12px', display: 'inline-flex', alignItems: 'center', gap: 3 }} title={t('dlg.savedKeys')} onClick={() => setShowKeys((v) => !v)}>
                      <IconStar size={14} />
                      <IconChevronDown size={13} />
                    </button>
                  )}
                  <button className="ghost-btn" style={{ padding: '8px 14px' }} onClick={chooseKey}>{t('common.choose')}</button>
                  {showKeys && recentKeys.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 200, overflow: 'auto', background: 'var(--surface-3)', border: '1px solid var(--border-3)', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.5)', zIndex: 10, padding: 4 }}>
                      {recentKeys.map((k) => (
                        <div key={k} className="menu-item" style={{ gap: 6 }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} onClick={() => { setKeyPath(k); rememberKey(k); setShowKeys(false); }}>
                            <div style={{ font: '600 11.5px var(--font-mono)', color: 'var(--text)' }}>{baseName(k)}</div>
                            <div style={{ font: '400 9.5px var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>{k}</div>
                          </span>
                          <span className="icon-btn" title={t('dlg.forgetKey')} onClick={() => forgetKey(k)} style={{ width: 20, height: 20, flex: 'none' }}>
                            <IconClose size={12} />
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

          <Field label={<>{t('dlg.remoteDir')} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{t('common.optional')}</span></>}>
            <input className="field mono" placeholder="VD: /var/www" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} />
          </Field>

          <Field label={<>{t('dlg.presetCmd')} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{t('common.optional')}</span></>}>
            <input className="field mono" placeholder={t('dlg.presetSsh')} value={presetCommand} onChange={(e) => setPresetCommand(e.target.value)} />
          </Field>

          {error && <div style={{ font: '400 11.5px var(--font-ui)', color: 'var(--danger)' }}>{error}</div>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', background: '#0e1218', borderTop: '1px solid var(--border)', position: 'sticky', bottom: 0 }}>
          <button className="ghost-btn" onClick={close} style={{ padding: '8px 18px', fontSize: 12.5 }}>{t('common.cancel')}</button>
          <button className="accent-btn" style={{ padding: '8px 18px', fontSize: 12.5 }} onClick={submit}>
            {editing ? t('dlg.save') : t('common.add')}
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
