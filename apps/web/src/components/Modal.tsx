import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

interface Props {
  open: boolean;
  title: string;
  /** Called for Escape or the close control; the owner decides whether to actually close. */
  onRequestClose(): void;
  children: ReactNode;
  /** Element to focus first; defaults to the dialog heading. */
  initialFocus?: RefObject<HTMLElement | null>;
}

/** Native modal dialog: focus trap, inert background and Escape come from the platform. Focus returns to the trigger. */
export function Modal({ open, title, onRequestClose, children, initialFocus }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
      (initialFocus?.current ?? heading.current)?.focus();
    } else if (!open && d.open) {
      d.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    }
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(e) => { e.preventDefault(); onRequestClose(); }}
    >
      {open && (
        <div className="modal__body">
          <h2 id={id} ref={heading} tabIndex={-1} className="modal__title">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
