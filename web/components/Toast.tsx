'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { AlertTriangle, CheckCircle2, X, XCircle } from 'lucide-react';

type Tone = 'ok' | 'warn' | 'fail';
interface Note { id: number; tone: Tone; text: string }

const ToastContext = createContext<(tone: Tone, text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

const STYLE: Record<Tone, { ring: string; icon: typeof CheckCircle2; tint: string }> = {
  ok:   { ring: 'border-ok/40',   icon: CheckCircle2,  tint: 'text-ok' },
  warn: { ring: 'border-warn/40', icon: AlertTriangle, tint: 'text-warn' },
  fail: { ring: 'border-bad/40',  icon: XCircle,       tint: 'text-bad' },
};

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [notes, setNotes] = useState<Note[]>([]);

  const push = useCallback((tone: Tone, text: string) => {
    const id = Date.now() + Math.random();
    setNotes((n) => [...n, { id, tone, text }]);
    // Failures linger; the operator needs time to read what went wrong.
    setTimeout(() => setNotes((n) => n.filter((x) => x.id !== id)), tone === 'fail' ? 8000 : 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[min(26rem,calc(100vw-2.5rem))] flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {notes.map((n) => {
          const s = STYLE[n.tone];
          const Icon = s.icon;
          return (
            <div
              key={n.id}
              className={`card-hi pointer-events-auto flex animate-slideIn items-start gap-3 border ${s.ring} p-3.5 shadow-pop`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.tint}`} strokeWidth={2} />
              <p className="min-w-0 flex-1 text-xs2 leading-relaxed text-text">{n.text}</p>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setNotes((x) => x.filter((y) => y.id !== n.id))}
                className="shrink-0 rounded p-0.5 text-faint hover:text-soft"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
