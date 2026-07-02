import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
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
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className={`menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick?.();
            }}
          >
            {it.label}
          </div>
        )
      )}
    </div>,
    document.body
  );
}
