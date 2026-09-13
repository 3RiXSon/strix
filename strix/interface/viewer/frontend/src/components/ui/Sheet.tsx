"use client";

import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared overlay primitive: a full-screen bottom sheet on mobile (slides up
 * from the bottom edge, rounded top corners) and a centered panel on desktop
 * (fades + scales in place). Both driven by the shared `.sheet-panel`
 * data-state keyframes in index.css.
 *
 * Kept mounted through its exit animation (render vs. state), matches the
 * lifecycle dialogs in this app use. Closes on backdrop
 * click, the X button, or Escape; locks body scroll while open.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  label,
  panelClassName,
  exitMs = 200,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** aria-label for the dialog when `title` isn't plain text. */
  label?: string;
  panelClassName?: string;
  exitMs?: number;
}) {
  const [render, setRender] = useState(open);
  const [state, setState] = useState<"open" | "closed">(open ? "open" : "closed");

  useEffect(() => {
    if (open) {
      setRender(true);
      setState("open");
      return;
    }
    setState("closed");
    const t = setTimeout(() => setRender(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  useEffect(() => {
    if (!render) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [render, onClose]);

  if (!render) return null;

  return (
    <div
      data-state={state}
      className="dialog-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? (typeof title === "string" ? title : "Dialog")}
    >
      <div
        data-state={state}
        className={cn(
          "sheet-panel relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0a0a0a] shadow-2xl sm:max-h-[80vh] sm:max-w-lg sm:rounded-2xl",
          panelClassName
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile grab handle */}
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
          <div className="h-1 w-9 rounded-full bg-white/15" />
        </div>

        {title != null && (
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
            <div className="min-w-0 text-sm font-semibold text-white">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex-shrink-0 cursor-pointer rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>

        {footer}
      </div>
    </div>
  );
}

export default Sheet;
