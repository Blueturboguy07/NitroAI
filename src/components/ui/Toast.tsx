import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/* One toast at a time, bottom centre. A toast with `undo` shows an Undo
   button; `onExpire` runs if the toast times out or is replaced without Undo
   being pressed (used for deferred deletes). */

interface ToastInput {
  message: string;
  undo?: () => void | Promise<void>;
  onExpire?: () => void | Promise<void>;
  duration?: number;
}

interface ToastState extends ToastInput {
  id: number;
}

const Ctx = createContext<{ show: (t: ToastInput) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const current = useRef<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const settle = useCallback((undo: boolean) => {
    const t = current.current;
    if (!t) return;
    current.current = null;
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
    if (undo) void t.undo?.();
    else void t.onExpire?.();
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      settle(false);
      const t = { ...input, id: ++seq.current };
      current.current = t;
      setToast(t);
      timer.current = setTimeout(() => settle(false), input.duration ?? 6000);
    },
    [settle],
  );

  // Never leave a deferred action hanging if the app is closed mid-toast.
  useEffect(() => {
    const flush = () => settle(false);
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [settle]);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4">
        {toast && (
          <div
            key={toast.id}
            role="status"
            className="nitro-toast pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-ink py-2 pr-2 pl-4 text-sm text-bg shadow-modal"
          >
            <span className="min-w-0 flex-1">{toast.message}</span>
            {toast.undo && (
              <button
                onClick={() => settle(true)}
                className="rounded-lg px-2.5 py-1 font-display font-bold text-accent-soft hover:bg-white/10"
              >
                Undo
              </button>
            )}
            <button
              onClick={() => settle(false)}
              aria-label="Dismiss"
              className="rounded-lg p-1 opacity-70 hover:bg-white/10 hover:opacity-100"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  // Outside the provider (isolated component tests) toasts are no-ops and
  // deferred actions run straight away.
  return (
    v ?? {
      show: (t: ToastInput) => {
        void t.onExpire?.();
      },
    }
  );
}
