import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Mounts printable content in a `.print-area` overlay and opens the system
 * print dialog (where "Microsoft Print to PDF" produces the PDF file).
 * The WebView renders Arabic/RTL perfectly, unlike JS PDF libraries.
 */
export function PrintPortal({ children, onDone }: { children: ReactNode; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      window.print();
      onDone();
    }, 150); // let the content paint first
    return () => clearTimeout(timer);
  }, [onDone]);

  return createPortal(<div className="print-area p-10">{children}</div>, document.body);
}
