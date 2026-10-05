import { t } from "./ui-language";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function NativeModal({ title, onCancel, children }: { title: string; onCancel(): void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const titleId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous = previousFocus.current;
    const element = root.current!;
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(item => item.getClientRects().length);
    (element.querySelector<HTMLElement>("[autofocus], textarea, input, select") ?? focusable()[0] ?? element).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancel.current(); }
      if (event.key === "Tab") {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); element.focus(); }
        else if (index === -1 || (event.shiftKey ? index === 0 : index === items.length - 1)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (!element.contains(event.target as Node)) (focusable()[0] ?? element).focus(); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="native-modal-backdrop"><div className="native-modal" ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><h2 id={titleId}>{t(title)}</h2>{children}</div></div>;
}
