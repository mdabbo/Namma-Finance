import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  certificateSchema,
  computeCertificate,
  isBillable,
  type CertificateInput,
  type CertificateStatus,
} from "@mep/core";
import type { CertificateListItem } from "../../repositories/certificates";
import { useProjects } from "../../repositories/projects";
import { useContractsByProject } from "../../repositories/contracts";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { Button, Card, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { todayIso, useFormat } from "../../lib/format";
import { useSettings } from "../../lib/settings";
import { nextCertificateNumber } from "../../repositories/certificates";

const STATUSES: CertificateStatus[] = ["DRAFT", "SUBMITTED", "APPROVED"];

interface CertificateFormProps {
  initial?: CertificateListItem | null;
  onSubmit: (input: CertificateInput) => void;
  onClose: () => void;
  busy?: boolean;
}

export function CertificateForm({ initial, onSubmit, onClose, busy }: CertificateFormProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: projects = [] } = useProjects();
  const { data: financials } = useWorkspaceFinancials();
  const { data: settings } = useSettings();

  const [projectId, setProjectId] = useState(initial?.projectId ?? 0);
  const { data: contracts = [] } = useContractsByProject(projectId);

  const [form, setForm] = useState({
    contractId: initial?.contractId ?? 0,
    number: initial?.number ?? "",
    date: initial?.date ?? todayIso(),
    submissionDate: initial?.submissionDate ?? "",
    dueDateOverride: initial?.dueDateOverride ?? "",
    description: initial?.description ?? "",
    grossMinor: initial?.grossMinor ?? 0,
    discountMinor: initial?.discountMinor ?? 0,
    manualAdvanceRecoveryMinor: initial?.manualAdvanceRecoveryMinor ?? null,
    status: initial?.status ?? ("DRAFT" as CertificateStatus),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (initial || form.number) return;
    void nextCertificateNumber(settings?.certificateNumberPrefix ?? "CERT", new Date(`${form.date}T00:00:00Z`)).then((number) => setForm((current) => current.number ? current : { ...current, number }));
  }, [initial, form.number, form.date, settings?.certificateNumberPrefix]);

  const contract = contracts.find((c) => c.id === form.contractId);
  const terms = initial && initial.contractId === form.contractId ? {
    valueMinor: initial.contractValueMinorSnapshot ?? contract?.valueMinor ?? 0,
    vatBp: initial.vatBpSnapshot ?? contract?.vatBp ?? 0,
    retentionBp: initial.retentionBpSnapshot ?? contract?.retentionBp ?? 0,
    withholdingBp: initial.withholdingBpSnapshot ?? contract?.withholdingBp ?? 0,
    advanceMinor: initial.advanceMinorSnapshot ?? contract?.advanceMinor ?? 0,
    advanceRecoveryMethod: initial.advanceMethodSnapshot ?? contract?.advanceRecoveryMethod ?? "PROPORTIONAL",
  } : contract;
  const state = form.contractId ? financials?.contractStates.get(form.contractId) : undefined;
  const currency = projects.find((p) => p.id === projectId)?.currency ?? initial?.currency ?? "EGP";

  /** Advance already recovered by OTHER billable certificates (exclude the one being edited). */
  const recoveredBefore = useMemo(() => {
    if (!state) return 0;
    return state.certificates
      .filter((cs) => cs.certificate.id !== initial?.id && isBillable(cs.certificate.status) && cs.certificate.seq < (initial?.seq ?? Number.MAX_SAFE_INTEGER))
      .reduce((sum, cs) => sum + cs.breakdown.advanceRecoveryMinor, 0);
  }, [state, initial]);

  const breakdown = useMemo(() => {
    if (!terms || form.discountMinor > form.grossMinor) return null;
    try {
      return computeCertificate({
        grossMinor: form.grossMinor,
        discountMinor: form.discountMinor,
        vatBp: terms.vatBp,
        retentionBp: terms.retentionBp,
        withholdingBp: terms.withholdingBp,
        advance: {
          method: terms.advanceRecoveryMethod,
          contractValueMinor: terms.valueMinor,
          advanceMinor: terms.advanceMinor,
          recoveredBeforeMinor: recoveredBefore,
          manualRecoveryMinor: form.manualAdvanceRecoveryMinor,
        },
      });
    } catch {
      return null;
    }
  }, [terms, form.grossMinor, form.discountMinor, form.manualAdvanceRecoveryMinor, recoveredBefore]);

  function submit() {
    const dueBeforeSubmission=!!form.submissionDate && !!form.dueDateOverride && form.dueDateOverride<form.submissionDate;
    if(dueBeforeSubmission && !window.confirm(t("validation.confirm_due_before_submission"))){
      setErrors({dueDateOverride:t("validation.due_before_submission")});
      return;
    }
    const parsed = certificateSchema.safeParse({
      ...form,
      submissionDate: form.submissionDate || null,
      dueDateOverride: form.dueDateOverride || null,
      description: form.description || null,
      manualAdvanceRecoveryMinor: form.manualAdvanceRecoveryMinor,
      dueDateConfirmed: dueBeforeSubmission,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    onSubmit(initial?.status === "PAID" ? { ...parsed.data, status: "APPROVED" } : parsed.data);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("certificates.newCertificate")} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("projects.single")}>
          <Select
            value={projectId}
            disabled={!!initial}
            onChange={(e) => {
              setProjectId(Number(e.target.value));
              setForm((f) => ({ ...f, contractId: 0 }));
            }}
          >
            <option value={0}>—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("certificates.contract")} error={form.contractId === 0 ? errors.contractId : undefined}>
          <Select
            value={form.contractId}
            disabled={!!initial}
            onChange={(e) => setForm((f) => ({ ...f, contractId: Number(e.target.value) }))}
          >
            <option value={0}>—</option>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>{c.number}{c.title ? ` — ${c.title}` : ""}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("certificates.number")} error={errors.number}>
          <Input value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} className="tnum" />
        </Field>

        <Field label={t("common.date")}>
          <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("certificates.submissionDate")}>
          <Input type="date" value={form.submissionDate} onChange={(e) => setForm((f) => ({ ...f, submissionDate: e.target.value }))} />
        </Field>
        <Field label={t("certificates.dueDateOverride")}>
          <Input type="date" value={form.dueDateOverride} onChange={(e) => setForm((f) => ({ ...f, dueDateOverride: e.target.value }))} />
        </Field>

        <Field label={t("certificates.gross")} error={errors.grossMinor}>
          <MoneyInput currency={currency} valueMinor={form.grossMinor} onChange={(v) => setForm((f) => ({ ...f, grossMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("certificates.discount")} error={errors.discountMinor}>
          <MoneyInput currency={currency} valueMinor={form.discountMinor} onChange={(v) => setForm((f) => ({ ...f, discountMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("common.status")}>
          {initial?.status === "PAID" ? (
            <Select value="PAID" disabled><option value="PAID">{t("status.PAID")}</option></Select>
          ) : (
            <Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CertificateStatus }))}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{t(`status.${s}`)}</option>
              ))}
            </Select>
          )}
        </Field>

        {contract?.advanceRecoveryMethod === "MANUAL" && (
          <Field label={t("certificates.advanceRecovery")}>
            <MoneyInput
              currency={currency}
              valueMinor={form.manualAdvanceRecoveryMinor}
              onChange={(v) => setForm((f) => ({ ...f, manualAdvanceRecoveryMinor: v }))}
            />
          </Field>
        )}

        <Field label={t("common.description")} className="col-span-3">
          <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
      </div>

      {breakdown && terms && (
        <Card className="mt-4 bg-slate-50 p-4 text-sm dark:bg-slate-800/50">
          <p className="mb-2 font-semibold">{t("certificates.breakdown")}</p>
          <table className="w-full max-w-md">
            <tbody>
              <Row label={t("certificates.gross")} value={fmt.money(breakdown.grossMinor, currency)} />
              {breakdown.discountMinor > 0 && (
                <Row label={t("certificates.discount")} value={`− ${fmt.money(breakdown.discountMinor, currency)}`} />
              )}
              {breakdown.discountMinor > 0 && <Row label={t("certificates.base")} value={fmt.money(breakdown.baseMinor, currency)} strong />}
              <Row label={`${t("certificates.vat")} (${fmt.percent(terms.vatBp)})`} value={`+ ${fmt.money(breakdown.vatMinor, currency)}`} />
              <Row label={`${t("certificates.retention")} (${fmt.percent(terms.retentionBp)})`} value={`− ${fmt.money(breakdown.retentionMinor, currency)}`} />
              <Row label={t("certificates.advanceRecovery")} value={`− ${fmt.money(breakdown.advanceRecoveryMinor, currency)}`} />
              {terms.withholdingBp > 0 && (
                <Row label={`${t("certificates.withholding")} (${fmt.percent(terms.withholdingBp)})`} value={`− ${fmt.money(breakdown.withholdingMinor, currency)}`} />
              )}
              <tr className="border-t border-slate-300 dark:border-slate-600">
                <td className="pt-2 font-semibold">{t("certificates.netPayable")}</td>
                <td className="pt-2 text-end font-bold tnum text-brand-700 dark:text-brand-300">{fmt.money(breakdown.netPayableMinor, currency)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !contract}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td className={`py-0.5 ${strong ? "font-medium" : "text-slate-600 dark:text-slate-300"}`}>{label}</td>
      <td className={`py-0.5 text-end tnum ${strong ? "font-medium" : ""}`}>{value}</td>
    </tr>
  );
}
