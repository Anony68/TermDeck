import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { SHELL_ORDER, SHELLS } from '../shells';
import { LAYOUT_ORDER, LAYOUTS } from '../layouts';
import { PresetIcon } from '../components/PresetIcon';
import { FONT_ORDER, FONT_LABEL, FONT_PX } from '../fontSizes';
import { checkUpdate, openUpdateUrl, getAppVersion, type UpdateResult } from '../ipc/update';
import { pickFolder } from '../ipc/api';
import type { Settings } from '../types';

type Section = 'general' | 'projects' | 'session' | 'layout' | 'shells' | 'keys' | 'update';

const NAV: Array<{ id: Section; label: string }> = [
  { id: 'general', label: 'Chung' },
  { id: 'projects', label: 'Dự án' },
  { id: 'session', label: 'Phiên & Khôi phục' },
  { id: 'layout', label: 'Bố cục mặc định' },
  { id: 'shells', label: 'Cấu hình shell' },
  { id: 'keys', label: 'Phím tắt' },
  { id: 'update', label: 'Cập nhật' },
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
  const [section, setSection] = useState<Section>('general');
  const closeSettings = useStore((s) => s.closeSettings);

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
          <span style={{ font: '600 12.5px var(--font-ui)', color: 'var(--text)' }}>Cài đặt</span>
          <div style={{ flex: 1 }} />
          <div className="wc close" style={{ height: 38, fontSize: 12 }} onClick={closeSettings}>
            ✕
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
                {n.label}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, padding: '24px 28px', overflow: 'auto', minWidth: 0 }}>
            {section === 'session' && <SessionSection />}
            {section === 'general' && <GeneralSection />}
            {section === 'projects' && <ProjectsSection />}
            {section === 'layout' && <LayoutSection />}
            {section === 'shells' && <ShellsSection />}
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
  settingKey: keyof Pick<Settings, 'restoreOnStartup' | 'restoreCwd' | 'restoreGrid' | 'autoRunCommand'>;
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Phiên & Khôi phục</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>
          Khi tắt ứng dụng, toàn bộ tab, terminal, đường dẫn và bố cục grid được lưu lại và mở đúng như cũ.
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
          title="Mở lại các terminal khi khởi động"
          desc="Khôi phục toàn bộ tab và terminal của phiên trước"
          settingKey="restoreOnStartup"
        />
        <ToggleRow
          title="Khôi phục đúng đường dẫn làm việc"
          desc="Mỗi terminal mở lại đúng thư mục đã đặt"
          settingKey="restoreCwd"
        />
        <ToggleRow
          title="Khôi phục bố cục grid từng tab"
          desc="Giữ nguyên mẫu grid và vị trí từng terminal trong lưới"
          settingKey="restoreGrid"
        />
        <ToggleRow
          title="Tự chạy lại lệnh đã cấu hình"
          desc='Chạy lại "lệnh chạy sẵn" của mỗi terminal — cẩn thận với lệnh có tác dụng phụ'
          settingKey="autoRunCommand"
        />
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
            PHIÊN GẦN ĐÂY
          </span>
          <button
            className="ghost-btn"
            onClick={captureSnapshot}
            style={{ padding: '5px 12px', fontSize: 11 }}
          >
            Lưu ảnh phiên hiện tại
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
              Bây giờ
            </span>
            <span style={{ font: '400 11.5px var(--font-ui)', color: 'var(--text-muted)', flex: 1 }}>
              {tabs.length} tab · {liveCmd} terminal
            </span>
            <span style={{ font: '600 11px var(--font-ui)', color: 'var(--accent)' }}>
              Phiên hiện tại
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
                {snap.tabCount} tab · {snap.cmdCount} terminal
              </span>
              <span className="link-btn" onClick={() => restoreSnapshot(snap.at)}>
                Khôi phục
              </span>
            </div>
          ))}
          {snapshots.length === 0 && (
            <div style={{ padding: '11px 16px', font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>
              Chưa có ảnh phiên nào được lưu.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GeneralSection() {
  const fontSize = useStore((s) => s.settings.fontSize);
  const uiScale = useStore((s) => s.settings.uiScale);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Chung</div>
        <div
          style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', lineHeight: 1.7, marginTop: 3 }}
        >
          TermDeck — dashboard quản lý terminal: CMD / Git Bash / PowerShell / WSL. Gom terminal theo
          tab, xếp thành grid, đặt tên và khôi phục nguyên trạng khi mở lại.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '600 11px var(--font-ui)', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
          CỠ CHỮ / THU PHÓNG TOÀN ỨNG DỤNG
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
          Phóng to/thu nhỏ toàn bộ giao diện (chữ, nút, terminal).
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
          CỠ CHỮ TERMINAL
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
                {FONT_LABEL[fs]}{' '}
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({FONT_PX[fs]}px)</span>
              </div>
            );
          })}
        </div>
        <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
          Áp dụng ngay cho tất cả terminal đang mở.
        </div>
      </div>
    </div>
  );
}

function LayoutSection() {
  const defaultLayout = useStore((s) => s.settings.defaultLayout);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Bố cục mặc định</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>
        Mẫu grid áp dụng cho tab mới.
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {LAYOUT_ORDER.map((id) => {
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
                {LAYOUTS[id].label}
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Cấu hình shell</div>
      <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>
        Đường dẫn tự dò. Nhập tay để ghi đè nếu shell nằm ở vị trí khác.
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
                  {detected ? '● Đã tìm thấy' : '○ Không tìm thấy'}
                </span>
              </div>
              <input
                className="field mono"
                placeholder={info?.path || 'Đường dẫn executable…'}
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

function KeysSection() {
  const keys: Array<[string, string]> = [
    ['Ctrl + T', 'Tab mới'],
    ['Ctrl + N', 'Terminal mới'],
    ['Ctrl + W', 'Đóng terminal đang chọn'],
    ['Ctrl + Tab', 'Chuyển tab'],
    ['Alt + 1..6', 'Đổi bố cục grid'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Phím tắt</div>
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

  const add = () => {
    if (!name.trim()) return;
    addProject(name.trim(), path.trim() || undefined);
    setName('');
    setPath('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Dự án</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>
          Lưu danh sách dự án (thư mục làm việc) để gợi ý & chọn nhanh khi tạo terminal. Danh sách
          terminal ở sidebar được nhóm theo dự án.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>TÊN DỰ ÁN</label>
          <input
            className="field"
            placeholder="VD: Dự án API"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>THƯ MỤC (tùy chọn)</label>
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
              Chọn…
            </button>
          </div>
        </div>
        <button className="accent-btn" style={{ height: 35 }} onClick={add}>
          Thêm
        </button>
      </div>

      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 10, overflow: 'hidden' }}>
        {projects.length === 0 && (
          <div style={{ padding: '14px 16px', font: '400 11.5px var(--font-ui)', color: 'var(--text-faint)' }}>
            Chưa có dự án nào.
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
              placeholder="(không có thư mục)"
              value={pr.path ?? ''}
              onChange={(e) => updateProject(pr.id, { path: e.target.value || undefined })}
              style={{ flex: 1 }}
            />
            <span
              className="pane-ctl danger"
              title="Xóa dự án"
              onClick={() => removeProject(pr.id)}
              style={{ width: 22, height: 22, fontSize: 12 }}
            >
              ✕
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

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

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
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--text)' }}>Cập nhật</div>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)', marginTop: 3 }}>
          Phiên bản hiện tại:{' '}
          <span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>v{version}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ font: '600 11px var(--font-ui)', color: 'var(--text-2)' }}>GITHUB REPO (owner/repo)</label>
        <input
          className="field mono"
          placeholder="vd: yourname/termdeck"
          value={githubRepo}
          onChange={(e) => updateSettings({ githubRepo: e.target.value })}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="accent-btn" onClick={check} disabled={checking}>
          {checking ? 'Đang kiểm tra…' : 'Kiểm tra cập nhật'}
        </button>
        {result && !result.hasUpdate && (
          <span style={{ font: '400 12px var(--font-ui)', color: 'var(--accent)' }}>
            ✔ Đã là bản mới nhất
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
              Có bản mới: v{result.latest}
            </div>
            <div style={{ font: '400 11px var(--font-ui)', color: 'var(--text-muted)' }}>
              Bạn đang dùng v{result.current}
            </div>
          </div>
          <button className="accent-btn" onClick={() => void openUpdateUrl(result.url)}>
            Tải bản mới
          </button>
        </div>
      )}
    </div>
  );
}
