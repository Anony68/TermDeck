import { useState, type ReactNode } from 'react';
import { useStore, findPane } from '../state/store';
import { SHELL_ORDER, SHELLS } from '../shells';
import { pickFolder, pickFile } from '../ipc/api';
import { secretSet } from '../ipc/ssh';
import { ShellBadge } from '../components/ShellBadge';
import type { PaneKind, ShellKind, SshConfig } from '../types';

const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

const KINDS: Array<{ kind: PaneKind; label: string; badge: string; color: string; hint: string }> = [
  { kind: 'shell', label: 'Shell cục bộ', badge: '>_', color: 'var(--sh-cmd)', hint: 'PowerShell, CMD, Git Bash, WSL' },
  { kind: 'ssh', label: 'SSH', badge: 'SSH', color: 'var(--sh-wsl)', hint: 'Terminal tới máy chủ từ xa' },
  { kind: 'browser', label: 'Quản lý File', badge: 'FB', color: 'var(--sh-ps)', hint: 'Duyệt & truyền file (local/SFTP)' },
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
  const closeAddCmd = useStore((s) => s.closeAddCmd);
  const closeEditCmd = useStore((s) => s.closeEditCmd);

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
  const [secret, setSecret] = useState('');
  const [remotePath, setRemotePath] = useState(editPane?.ssh?.remotePath ?? '');
  const [error, setError] = useState<string | null>(null);

  const isRemote = kind === 'ssh' || kind === 'browser';

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
    if (kind === 'browser') return host ? `Files — ${host}` : 'Quản lý File';
    return SHELLS[shell].label;
  };

  const submit = async () => {
    setError(null);
    if (isRemote) {
      if (!host.trim()) return setError('Nhập địa chỉ máy chủ (IP hoặc hostname).');
      if (!user.trim()) return setError('Nhập tên đăng nhập (username).');
      const p = parseInt(port, 10);
      if (!p || p < 1 || p > 65535) return setError('Cổng (port) không hợp lệ.');
      if (auth === 'key' && !keyPath.trim()) return setError('Chọn file private key (.pem).');
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
            {editing ? 'Cài đặt' : 'Thêm mới'}
          </span>
          <span className="icon-btn" onClick={close} style={{ width: 24, height: 24, fontSize: 13 }}>
            ✕
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px' }}>
          <Field label="LOẠI">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {KINDS.map((k) => {
                const selected = kind === k.kind;
                return (
                  <div
                    key={k.kind}
                    className={`shell-card${selected ? ' selected' : ''}`}
                    onClick={() => setKind(k.kind)}
                    title={k.hint}
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
                      {k.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </Field>

          <Field label="TÊN HIỂN THỊ">
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
            <Field label="LOẠI SHELL">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
                {SHELL_ORDER.map((k) => {
                  const enabled = avail(k);
                  const selected = shell === k;
                  return (
                    <div
                      key={k}
                      className={`shell-card${selected ? ' selected' : ''}${enabled ? '' : ' disabled'}`}
                      onClick={() => enabled && setShell(k)}
                      title={enabled ? SHELLS[k].label : `${SHELLS[k].label} — không tìm thấy trên máy`}
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
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label="MÁY CHỦ (IP / HOSTNAME)">
                    <input
                      className="field mono"
                      placeholder="VD: 192.168.1.10"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ width: 96 }}>
                  <Field label="CỔNG">
                    <input
                      className="field mono"
                      placeholder="22"
                      value={port}
                      onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                  </Field>
                </div>
              </div>

              <Field label="TÊN ĐĂNG NHẬP">
                <input
                  className="field mono"
                  placeholder="VD: root"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </Field>

              <Field label="XÁC THỰC">
                <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                  <SegBtn active={auth === 'password'} onClick={() => setAuth('password')}>
                    Mật khẩu
                  </SegBtn>
                  <SegBtn active={auth === 'key'} onClick={() => setAuth('key')}>
                    Private Key (.pem)
                  </SegBtn>
                </div>
                {auth === 'password' ? (
                  <input
                    className="field mono"
                    type="password"
                    placeholder={editing ? '•••••• (để trống = giữ nguyên)' : 'Mật khẩu'}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="field mono"
                        placeholder="Đường dẫn file key"
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                      />
                      <button
                        className="ghost-btn"
                        style={{ padding: '8px 14px' }}
                        onClick={async () => {
                          const f = await pickFile(keyPath || undefined);
                          if (f) setKeyPath(f);
                        }}
                      >
                        Chọn…
                      </button>
                    </div>
                    <input
                      className="field mono"
                      type="password"
                      placeholder={
                        editing ? 'Passphrase (để trống = giữ nguyên/không có)' : 'Passphrase (nếu key có)'
                      }
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
                    THƯ MỤC TỪ XA{' '}
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(tùy chọn)</span>
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
            <Field label="ĐƯỜNG DẪN KHỞI ĐỘNG">
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="field mono"
                  placeholder="VD: D:\work\api"
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
                  Chọn…
                </button>
              </div>
            </Field>
          )}

          {kind !== 'browser' && (
            <Field
              label={
                <>
                  LỆNH CHẠY SẴN{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(tùy chọn)</span>
                </>
              }
            >
              <input
                className="field mono"
                placeholder={kind === 'ssh' ? 'VD: htop' : 'VD: npm run dev'}
                value={presetCommand}
                onChange={(e) => setPresetCommand(e.target.value)}
              />
            </Field>
          )}

          <Field
            label={
              <>
                DỰ ÁN <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(tùy chọn)</span>
              </>
            }
          >
            <select
              className="field"
              value={creatingNew ? '__new__' : projectId}
              onChange={(e) => onProjectChange(e.target.value)}
              style={{ cursor: 'pointer' }}
            >
              <option value="">(Không thuộc dự án)</option>
              {projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
              <option value="__new__">＋ Tạo dự án mới…</option>
            </select>
            {creatingNew && (
              <input
                className="field"
                placeholder="Tên dự án mới"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                style={{ marginTop: 6 }}
              />
            )}
          </Field>

          {kind !== 'browser' && (
            <Row
              label="Tự mở lại khi khởi động ứng dụng"
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
            Hủy
          </button>
          <button className="accent-btn" style={{ padding: '8px 18px', fontSize: 12.5 }} onClick={submit}>
            {editing ? 'Lưu thay đổi' : 'Thêm vào tab'}
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
