import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function Dialog({ title, subtitle, children, busy, onClose, onSubmit, initialFocus }) {
  const dialog = useRef(null);
  const state = useRef({ busy, onClose });
  state.current = { busy, onClose };
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    const controls = () => [...dialog.current.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")].filter(control => !control.hidden && control.getAttribute("aria-hidden") !== "true");
    const focusFirst = () => (controls()[0] || dialog.current).focus();
    document.body.style.overflow = "hidden";
    (initialFocus && dialog.current.querySelector(initialFocus) || controls()[0] || dialog.current).focus();
    const keydown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!state.current.busy) state.current.onClose();
      }
      if (event.key !== "Tab") return;
      const elements = controls();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!elements.length || !dialog.current.contains(document.activeElement)) { event.preventDefault(); focusFirst(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const focusin = event => { if (!dialog.current.contains(event.target)) focusFirst(); };
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocus]);
  const Element = onSubmit ? "form" : "section";
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <Element ref={dialog} className="batch-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onSubmit={onSubmit}>
      <div className="dialog-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div><button type="button" className="cancel-button" disabled={busy} onClick={onClose}>关闭</button></div>
      {children}
    </Element>
  </div>, document.body);
}
