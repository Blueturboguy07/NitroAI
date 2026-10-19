import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

/* A floating panel anchored to a rect (or a point), rendered in a portal so
   scroll containers never clip it. Flips above the anchor when there is no
   room below and clamps to the viewport. Closes on outside pointerdown and
   Escape. */

export interface Anchor {
  left: number;
  top: number;
  bottom: number;
  right?: number;
}

export function anchorOf(el: Element | null): Anchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, right: r.right };
}

export default function Popover({
  anchor,
  onClose,
  onEscape,
  children,
  align = "start",
  className = "",
  gap = 6,
  closeOnOutside = true,
  role = "dialog",
  label,
}: {
  anchor: Anchor;
  onClose: () => void;
  /* Escape handler; defaults to onClose. */
  onEscape?: () => void;
  children: ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
  gap?: number;
  closeOnOutside?: boolean;
  role?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left =
      align === "end"
        ? (anchor.right ?? anchor.left) - width
        : align === "center"
          ? (anchor.left + (anchor.right ?? anchor.left)) / 2 - width / 2
          : anchor.left;
    left = Math.max(8, Math.min(left, vw - width - 8));
    let top = anchor.bottom + gap;
    if (top + height > vh - 8 && anchor.top - gap - height > 8) {
      top = anchor.top - gap - height;
    }
    top = Math.max(8, Math.min(top, vh - height - 8));
    setPos({ left, top });
  }, [anchor.left, anchor.top, anchor.bottom, anchor.right, align, gap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        (onEscapeRef.current ?? onCloseRef.current)();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!closeOnOutside) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [closeOnOutside]);

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      style={{
        position: "fixed",
        left: pos?.left ?? anchor.left,
        top: pos?.top ?? anchor.bottom + gap,
        visibility: pos ? "visible" : "hidden",
      }}
      className={`z-[70] rounded-xl border border-edge bg-card shadow-modal ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}

/* A menu row used inside popovers and context menus. */
export function MenuItem({
  icon: Icon,
  children,
  onSelect,
  danger,
  active,
  hint,
  disabled,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  active?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none focus-visible:bg-card-hover disabled:opacity-40 ${
        danger
          ? "text-danger-ink hover:bg-danger-soft"
          : active
            ? "bg-accent-softer font-semibold text-ink"
            : "hover:bg-card-hover"
      }`}
    >
      {Icon && <Icon className={`size-4 shrink-0 ${danger ? "" : "text-ink-dim"}`} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-ink-faint">{hint}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 border-t border-edge" />;
}
