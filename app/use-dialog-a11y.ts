"use client";

import { useEffect, useRef } from "react";

export function useDialogA11y(active: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!active) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.closest<HTMLElement>(".modal-backdrop, .onboarding-backdrop");
    const hiddenSiblings = Array.from(backdrop?.parentElement?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop).map((element) => ({ element, hadInert: element.hasAttribute("inert"), ariaHidden: element.getAttribute("aria-hidden") }));
    hiddenSiblings.forEach(({ element }) => { element.setAttribute("inert", ""); element.setAttribute("aria-hidden", "true"); });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const getFocusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []).filter((element) => !element.hasAttribute("hidden") && element.offsetParent !== null);
    const focusInitial = window.setTimeout(() => (getFocusable()[0] ?? dialog)?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      const first = focusable[0] ?? dialog;
      const last = focusable[focusable.length - 1] ?? dialog;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusInitial);
      document.removeEventListener("keydown", onKeyDown);
      hiddenSiblings.forEach(({ element, hadInert, ariaHidden }) => { if (!hadInert) element.removeAttribute("inert"); if (ariaHidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", ariaHidden); });
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [active]);

  return dialogRef;
}
