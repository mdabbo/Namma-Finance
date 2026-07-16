import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button, Modal } from "./ui";

interface ConfirmDialogProps {
  title?: string;
  message: string;
  /** e.g. cascade counts: ["3 projects", "5 contracts"] */
  details?: string[];
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({ title, message, details, confirmLabel, onConfirm, onCancel, busy }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal title={title ?? t("common.confirmDeleteTitle")} onClose={onCancel}>
      <div className="flex gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-red-100 p-2 text-red-600 dark:bg-red-900/40 dark:text-red-300">
          <AlertTriangle size={18} />
        </div>
        <div className="text-sm">
          <p>{message}</p>
          {details && details.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-slate-500 dark:text-slate-400">
              {details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {confirmLabel ?? t("common.delete")}
        </Button>
      </div>
    </Modal>
  );
}
