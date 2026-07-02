import { useState, type ReactNode } from 'react';
import { useStore, findPane } from '../state/store';
import { SHELL_ORDER, SHELLS } from '../shells';
import { pickFolder } from '../ipc/api';
import { ShellBadge } from '../components/ShellBadge';
import type { ShellKind } from '../types';

export function AddCmdDialog() {
  const editPaneId = useStore((s) => s.ui.editPaneId);
  const editPane = useStore((s) => (s.ui.editPaneId ? findPane(s, s.ui.editPaneId) : undefined));
  const slot = useStore((s) => s.ui.addCmdSlot);
  const shells = useStore((s) => s.shells);
  const addPane = useStore((s) => s.addPane);
  const updatePane = useStore((s) => s.updatePane);
  const addToLibrary = useStore((s) => s.addToLibrary);
  const closeAddCmd = useStore((s) => s.closeAddCmd);
  const closeEditCmd = useStore((s) => s.closeEditCmd);

  const editing = !!editPaneId;
  const close = editing ? closeEditCmd : closeAddCmd;

  const avail = (k: ShellKind) => {
    const info = shells.find((s) => s.kind === k);
    return info ? info.available : true;
  };
  const firstAvail = SHELL_ORDER.find(avail) ?? 'powershell';

  const [name, setName] = useState(editPane?.name ?? '');
  const [shell, setShell] = useState<ShellKind>(editPane?.shell ?? firstAvail);
  const [cwd, setCwd] = useState(editPane?.cwd ?? '');
  const [presetCommand, setPresetCommand] = useState(editPane?.presetCommand ?? '');
  const [autoStart, setAutoStart] = useState(editPane?.autoStart ?? true);
  const [saveToLib, setSaveToLib] = useState(!editing);

  const submit = () => {
    const finalName = name.trim() || SHELLS[shell].label;
    const fields = {
      name: finalName,
      shell,
      cwd: cwd.trim(),
      presetCommand: presetCommand.trim() || undefined,
      autoStart,
    };
    const savedCmdId = saveToLib ? addToLibrary(fields) : undefined;
    if (editing && editPaneId) {
      updatePane(editPaneId, savedCmdId ? { ...fields, savedCmdId } : fields);
    } else {
      addPane({ ...fields, savedCmdId, slot: slot ?? undefined });
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
          background: 'var(--surface-2)',
          border: '1px solid var(--border-3)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px 0' }}>
          <span style={{ font: '600 15px var(--font-ui)', color: 'var(--text)', flex: 1 }}>
            {editing ? 'Cài đặt cmd' : 'Thêm cmd mới'}
          </span>
          <span className="icon-btn" onClick={close} style={{ width: 24, height: 24, fontSize: 13 }}>
            ✕
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px' }}>
          <Field label="TÊN HIỂN THỊ">
            <input
              className="field"
              autoFocus
              placeholder="VD: API Server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </Field>

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

          <Field
            label={
              <>
                LỆNH CHẠY SẴN <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(tùy chọn)</span>
              </>
            }
          >
            <input
              className="field mono"
              placeholder="VD: npm run dev"
              value={presetCommand}
              onChange={(e) => setPresetCommand(e.target.value)}
            />
          </Field>

          <Row
            label="Tự mở lại cmd này khi khởi động ứng dụng"
            on={autoStart}
            onToggle={() => setAutoStart((v) => !v)}
          />
          <Row
            label='Lưu vào thư viện "CMD ĐÃ LƯU"'
            on={saveToLib}
            onToggle={() => setSaveToLib((v) => !v)}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px',
            background: '#0e1218',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button
            className="icon-btn"
            onClick={close}
            style={{ padding: '8px 18px', font: '600 12.5px var(--font-ui)', color: 'var(--text-2)' }}
          >
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
