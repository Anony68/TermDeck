import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** Submenu items — this item then opens a nested menu on hover. */
  children?: MenuItem[];
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const [sub, setSub] = useState<number | null>(null);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const menuW = 210;
  const menuH = items.length * 32 + 8;
  const left = Math.max(6, Math.min(x, window.innerWidth - menuW - 8));
  const top = Math.max(6, Math.min(y, window.innerHeight - menuH - 8));

  const renderItem = (it: MenuItem, i: number) =>
    it.separator ? (
      <div key={i} className="menu-sep" />
    ) : (
      <div
        key={i}
        className={`menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
        style={it.children ? { position: 'relative' } : undefined}
        onMouseEnter={() => setSub(it.children && !it.disabled ? i : null)}
        onClick={() => {
          if (it.disabled || it.children) return;
          onClose();
          it.onClick?.();
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          {it.label}
          {it.children && <span style={{ color: 'var(--text-muted)' }}>▸</span>}
        </span>
        {it.children && sub === i && (
          <div
            style={{
              position: 'absolute',
              left: '100%',
              top: -4,
              zIndex: 101,
              minWidth: 190,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-3)',
              borderRadius: 8,
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              padding: 4,
            }}
          >
            {it.children.map((c, j) =>
              c.separator ? (
                <div key={j} className="menu-sep" />
              ) : (
                <div
                  key={j}
                  className={`menu-item${c.danger ? ' danger' : ''}${c.disabled ? ' disabled' : ''}`}
                  onClick={() => {
                    if (c.disabled) return;
                    onClose();
                    c.onClick?.();
                  }}
                >
                  {c.label}
                </div>
              )
            )}
          </div>
        )}
      </div>
    );

  return createPortal(
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 100,
        minWidth: 190,
        background: 'var(--surface-2)',
        border: '1px solid var(--border-3)',
        borderRadius: 8,
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        padding: 4,
      }}
    >
      {items.map(renderItem)}
    </div>,
    document.body
  );
}
