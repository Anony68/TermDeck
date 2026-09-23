import { useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { IconClose, IconRefresh } from '../components/icons';
import { useT } from '../i18n';

type Mode = 'login' | 'register' | 'recover';

/** Default sync server (the deployed Cloudflare Worker); users can override it. */
const DEFAULT_SYNC_URL = 'https://termdeck-sync.block-blash.workers.dev';

/** Account + E2EE vault: register / sign in / unlock / recover / sync status. */
export function AccountDialog() {
  const cloud = useStore((s) => s.cloud);
  const close = useStore((s) => s.closeAccount);
  const cloudRegister = useStore((s) => s.cloudRegister);
  const cloudUnlock = useStore((s) => s.cloudUnlock);
  const cloudRecover = useStore((s) => s.cloudRecover);
  const cloudChangePassword = useStore((s) => s.cloudChangePassword);
  const cloudLock = useStore((s) => s.cloudLock);
  const cloudSignOut = useStore((s) => s.cloudSignOut);
  const cloudSync = useStore((s) => s.cloudSync);
  const t = useT();

  const [mode, setMode] = useState<Mode>('login');
  const [baseUrl, setBaseUrl] = useState(cloud.baseUrl || DEFAULT_SYNC_URL);
  const [email, setEmail] = useState(cloud.email || '');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState<string | null>(null);
  const [changePw, setChangePw] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- unlocked: account panel ----
  if (cloud.unlocked) {
    return (
      <Shell title={t('account.title')} onClose={close}>
        <Row label={t('account.email')}>{cloud.email}</Row>
        <Row label={t('account.serverUrl')}>{cloud.baseUrl}</Row>
        <Row label={t('account.lastSync')}>
          {cloud.syncing
            ? t('account.status.syncing')
            : cloud.lastSyncAt
            ? new Date(cloud.lastSyncAt).toLocaleTimeString()
            : t('account.never')}
        </Row>
        {cloud.lastError && <div style={errStyle}>{cloud.lastError}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="accent-btn" disabled={busy} onClick={() => void cloudSync()}>
            <IconRefresh size={13} /> {t('account.syncNow')}
          </button>
          <button className="ghost-btn" onClick={cloudLock}>{t('account.lock')}</button>
          <button className="ghost-btn" onClick={() => { cloudSignOut(); close(); }}>{t('account.signOut')}</button>
        </div>
        <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <label style={labelStyle}>{t('account.changePassword')}</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input className="field mono" type="password" placeholder={t('account.newMasterPassword')} value={changePw} onChange={(e) => setChangePw(e.target.value)} />
            <button
              className="ghost-btn"
              disabled={busy || changePw.length < 8}
              onClick={() => void run(async () => { await cloudChangePassword(changePw); setChangePw(''); })}
            >
              {t('account.changePassword')}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // ---- signed in but locked: unlock ----
  if (cloud.signedIn) {
    return (
      <Shell title={t('account.unlock')} onClose={close}>
        <Row label={t('account.email')}>{cloud.email}</Row>
        <Field label={t('account.masterPassword')}>
          <input
            className="field mono"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run(async () => { await cloudUnlock(cloud.baseUrl, cloud.email, password); close(); })}
          />
        </Field>
        {error && <div style={errStyle}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="accent-btn" disabled={busy || !password} onClick={() => void run(async () => { await cloudUnlock(cloud.baseUrl, cloud.email, password); close(); })}>
            {t('account.unlock')}
          </button>
          <button className="ghost-btn" onClick={() => setMode('recover')}>{t('account.recover')}</button>
          <button className="ghost-btn" onClick={() => { cloudSignOut(); }}>{t('account.signOut')}</button>
        </div>
        {mode === 'recover' && <RecoverForm {...{ baseUrl, email: cloud.email, recoveryCode, password, setRecoveryCode, setPassword, busy, run, cloudRecover, close, t }} />}
      </Shell>
    );
  }

  // ---- not signed in: register / login (+ recover) ----
  if (showRecovery) {
    return (
      <Shell title={t('account.recoveryCode')} onClose={close}>
        <div style={{ font: '400 12px var(--font-ui)', color: 'var(--text-2)' }}>{t('account.recoveryHint')}</div>
        <div style={{ margin: '12px 0', padding: '14px 16px', background: 'var(--surface-3)', border: '1px solid var(--accent)', borderRadius: 8, font: '700 15px var(--font-mono)', color: 'var(--accent)', letterSpacing: '0.06em', wordBreak: 'break-all', textAlign: 'center' }}>
          {showRecovery}
        </div>
        <button className="accent-btn" onClick={() => { setShowRecovery(null); close(); }}>{t('account.recoverySaved')}</button>
      </Shell>
    );
  }

  return (
    <Shell title={t('account.title')} onClose={close}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Seg active={mode === 'login'} onClick={() => setMode('login')}>{t('account.signin')}</Seg>
        <Seg active={mode === 'register'} onClick={() => setMode('register')}>{t('account.register')}</Seg>
        <Seg active={mode === 'recover'} onClick={() => setMode('recover')}>{t('account.recover')}</Seg>
      </div>
      <Field label={t('account.serverUrl')}>
        <input className="field mono" placeholder="https://sync.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label={t('account.email')}>
        <input className="field mono" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {mode === 'recover' ? (
        <RecoverForm {...{ baseUrl, email, recoveryCode, password, setRecoveryCode, setPassword, busy, run, cloudRecover, close, t }} />
      ) : (
        <>
          <Field label={mode === 'register' ? t('account.masterPassword') + ' ' + t('account.min8') : t('account.masterPassword')}>
            <input className="field mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <div style={errStyle}>{error}</div>}
          {mode === 'register' ? (
            <button
              className="accent-btn"
              disabled={busy || !baseUrl || !email || password.length < 8}
              onClick={() => void run(async () => { const code = await cloudRegister(baseUrl, email, password); setShowRecovery(code); })}
            >
              {t('account.register')}
            </button>
          ) : (
            <button
              className="accent-btn"
              disabled={busy || !baseUrl || !email || !password}
              onClick={() => void run(async () => { await cloudUnlock(baseUrl, email, password); close(); })}
            >
              {t('account.signin')}
            </button>
          )}
        </>
      )}
    </Shell>
  );
}

function RecoverForm(p: any) {
  const { baseUrl, email, recoveryCode, password, setRecoveryCode, setPassword, busy, run, cloudRecover, close, t } = p;
  return (
    <div style={{ marginTop: 10 }}>
      <Field label={t('account.recoveryCode')}>
        <input className="field mono" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} />
      </Field>
      <Field label={t('account.newMasterPassword')}>
        <input className="field mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <button
        className="accent-btn"
        disabled={busy || !recoveryCode || password.length < 8}
        onClick={() => void run(async () => { await cloudRecover(baseUrl, email, recoveryCode, password); close(); })}
      >
        {t('account.recover')}
      </button>
    </div>
  );
}

const labelStyle = { font: '600 11px var(--font-ui)', color: 'var(--text-2)' } as const;
const errStyle = { font: '400 11.5px var(--font-ui)', color: 'var(--danger)', margin: '4px 0' } as const;

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,7,10,0.55)', display: 'grid', placeItems: 'center', zIndex: 55 }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: 440, maxHeight: '90vh', overflowY: 'auto', background: 'var(--surface-2)', border: '1px solid var(--border-3)', borderRadius: 12, boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px 0' }}>
          <span style={{ font: '600 15px var(--font-ui)', color: 'var(--text)', flex: 1 }}>{title}</span>
          <span className="icon-btn" onClick={onClose} style={{ width: 24, height: 24 }}><IconClose size={15} /></span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px' }}>{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, font: '400 12px var(--font-ui)' }}>
      <span style={{ color: 'var(--text-muted)', width: 90 }}>{label}</span>
      <span style={{ color: 'var(--text)', flex: 1, wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}
function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: `1px solid ${active ? 'var(--accent)' : 'var(--border-3)'}`, background: active ? 'var(--accent-soft)' : 'transparent', color: active ? 'var(--text)' : 'var(--text-2)', font: `${active ? 600 : 400} 11.5px var(--font-ui)`, cursor: 'pointer' }}>
      {children}
    </button>
  );
}
