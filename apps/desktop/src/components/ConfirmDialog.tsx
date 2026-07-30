import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Archive } from "lucide-react";
import { Button, Field, Modal, Textarea } from "./ui";

interface ConfirmDialogProps {
  title?: string;
  message: string;
  /** e.g. cascade counts: ["3 projects", "5 contracts"] */
  details?: string[];
  confirmLabel?: string;
  /**
   * "danger" (red) for financially significant or irreversible actions —
   * voiding money records, permanently deleting a draft. "neutral" for
   * reversible visibility changes such as archiving, which keep all history.
   */
  tone?: "danger" | "neutral";
  /** When true, a non-empty reason must be entered before confirming. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** Surfaced under the message, e.g. when a guarded action was refused. */
  error?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({
  title,
  message,
  details,
  confirmLabel,
  tone = "danger",
  requireReason,
  reasonLabel,
  reasonPlaceholder,
  error,
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const reasonMissing = requireReason ? !reason.trim() : false;
  const danger = tone === "danger";
  return (
    <Modal title={title ?? t("common.confirmDeleteTitle")} onClose={onCancel}>
      <div className="flex gap-3">
        <div
          className={
            danger
              ? "mt-0.5 shrink-0 rounded-full bg-red-100 p-2 text-red-600 dark:bg-red-900/40 dark:text-red-300"
              : "mt-0.5 shrink-0 rounded-full bg-slate-100 p-2 text-slate-500 dark:bg-slate-800 dark:text-slate-300"
          }
        >
          {danger ? <AlertTriangle size={18} /> : <Archive size={18} />}
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
          {error && (
            <p className="mt-2 font-medium text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      {requireReason && (
        <div className="mt-4">
          <Field label={reasonLabel ?? t("lifecycle.reason")}>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={reasonPlaceholder ?? t("lifecycle.reasonPlaceholder")}
            />
          </Field>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}
          disabled={busy || reasonMissing}
          aria-busy={busy}
        >
          {confirmLabel ?? t("common.delete")}
        </Button>
      </div>
    </Modal>
  );
}
