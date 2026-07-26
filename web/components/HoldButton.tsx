'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * A button that has to be held down.
 *
 * The usual answer is a modal confirm, and it stops working within about a week:
 * operators learn to clear dialogs without reading them, so the guard protects
 * nothing. A press-and-hold cannot be dismissed by muscle memory, and it stays
 * cancellable right up to the last moment — letting go aborts.
 *
 * It looks like an ordinary button until pressed, so it costs nothing visually.
 * Keyboard has parity: Space or Enter held arms and fires, releasing aborts.
 *
 * To make any of these fire on a single click instead, pass holdMs={0}.
 */
export function HoldButton({
  label,
  holdingLabel,
  icon: Icon,
  holdMs = 1200,
  onFire,
  disabled,
  variant = 'danger',
  className = '',
}: {
  label: string;
  holdingLabel?: string;
  icon?: LucideIcon;
  holdMs?: number;
  onFire: () => void | Promise<void>;
  disabled?: boolean;
  variant?: 'danger' | 'danger-outline' | 'ghost';
  className?: string;
}) {
  const [progress, setProgress] = useState(0);
  const [firing, setFiring] = useState(false);
  const raf = useRef<number | null>(null);
  const started = useRef(0);
  const held = useRef(false);

  const abort = useCallback(() => {
    held.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  }, []);

  useEffect(() => abort, [abort]);

  const fire = useCallback(async () => {
    setFiring(true);
    try {
      await onFire();
    } finally {
      setFiring(false);
    }
  }, [onFire]);

  const begin = useCallback(() => {
    if (disabled || firing || held.current) return;
    if (holdMs <= 0) {
      void fire();
      return;
    }
    held.current = true;
    started.current = performance.now();

    const tick = (now: number) => {
      if (!held.current) return;
      const p = Math.min(1, (now - started.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        held.current = false;
        setProgress(0);
        void fire();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, firing, holdMs, fire]);

  const base = {
    danger: 'btn-danger',
    'danger-outline': 'btn-danger-outline',
    ghost: 'btn-ghost',
  }[variant];

  const active = progress > 0;

  return (
    <button
      type="button"
      onMouseDown={begin}
      onMouseUp={abort}
      onMouseLeave={abort}
      onTouchStart={(e) => {
        e.preventDefault();
        begin();
      }}
      onTouchEnd={abort}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={abort}
      onBlur={abort}
      disabled={disabled || firing}
      title={holdMs > 0 ? `Hold to confirm — release to cancel` : undefined}
      className={`${base} relative select-none overflow-hidden ${className}`}
    >
      {/* Fill sweeps across as the hold completes. */}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-white/25"
          style={{ width: `${progress * 100}%` }}
        />
      ) : null}
      <span className="relative flex items-center gap-2">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {firing
          ? 'Working…'
          : active
            ? `${holdingLabel ?? 'Hold'} ${Math.round(progress * 100)}%`
            : label}
      </span>
    </button>
  );
}
