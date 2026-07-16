import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { paymentSchema, suggestAllocation, type PaymentInput, type PaymentKind, type PaymentMethod } from "@mep/core";
import type { PaymentListItem, AllocationInput } from "../../repositories/payments";
import { listAllocationsByPayment } from "../../repositories/payments";
import { useProjects } from "../../repositories/projects";
import { useContractsByProject } from "../../repositories/contracts";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { Button, Card, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { todayIso, useFormat } from "../../lib/format";

/** Prefill for the "mark certificate paid" flow. */
export interface PaymentDefaults {
  projectId: number;
  contractId: number;
  amountMinor: number;
  certificateId: number;
}

interface PaymentFormProps {
  initial?: PaymentListItem | null;
  defaults?: PaymentDefaults;
  onSubmit: (input: PaymentInput, allocations: AllocationInput[]) => void;
  onClose: () => void;
  busy?: boolean;
}

export function PaymentForm({ initial, defaults, onSubmit, onClose, busy }: PaymentFormProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: projects = [] } = useProjects();
  const { data: financials } = useWorkspaceFinancials();

  const [projectId, setProjectId] = useState(initial?.projectId ?? defaults?.projectId ?? 0);
  const { data: contracts = [] } = useContractsByProject(projectId);

  const [form, setForm] = useState({
    contractId: initial?.contractId ?? defaults?.contractId ?? 0,
    kind: initial?.kind ?? ("CERTIFICATE" as PaymentKind),
    number: initial?.number ?? "",
    date: initial?.date ?? todayIso(),
    amountMinor: initial?.amountMinor ?? defaults?.amountMinor ?? 0,
    method: initial?.method ?? ("BANK_TRANSFER" as PaymentMethod),
    bank: initial?.bank ?? "",
    reference: initial?.reference ?? "",
    notes: initial?.notes ?? "",
  });
  const [allocations, setAllocations] = useState<Map<number, number>>(
    () => new Map(defaults ? [[defaults.certificateId, defaults.amountMinor]] : []),
  );
  const [existingLoaded, setExistingLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // load existing allocations when editing
  useEffect(() => {
    if (!initial || existingLoaded) return;
    void listAllocationsByPayment(initial.id).then((rows) => {
      setAllocations(new Map(rows.map((r) => [r.certificateId, r.amountMinor])));
      setExistingLoaded(true);
    });
  }, [initial, existingLoaded]);

  const state = form.contractId ? financials?.contractStates.get(form.contractId) : undefined;
  const currency = projects.find((p) => p.id === projectId)?.currency ?? initial?.currency ?? "EGP";

  /** Open certificates with capacity = unpaid + this payment's own allocation. */
  const openCertificates = useMemo(() => {
    if (!state) return [];
    return state.certificates
      .filter((cs) => cs.certificate.status !== "DRAFT")
      .map((cs) => ({
        id: cs.certificate.id,
        number: cs.certificate.number,
        capacity: cs.unpaidMinor + (initial ? (allocations.get(cs.certificate.id) ?? 0) : 0),
        net: cs.breakdown.netPayableMinor,
      }))
      .filter((c) => c.capacity > 0 || allocations.has(c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, initial, existingLoaded]);

  const allocatedTotal = [...allocations.values()].reduce((a, b) => a + b, 0);
  const unallocated = form.amountMinor - allocatedTotal;

  function autoAllocate() {
    const { allocations: suggested } = suggestAllocation(
      form.amountMinor,
      openCertificates.map((c) => ({ certificateId: c.id, unpaidMinor: c.capacity })),
    );
    setAllocations(new Map(suggested.map((s) => [s.certificateId, s.amountMinor])));
  }

  function submit() {
    const parsed = paymentSchema.safeParse({
      ...form,
      bank: form.bank || null,
      reference: form.reference || null,
      notes: form.notes || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    if (form.kind === "CERTIFICATE") {
      if (allocatedTotal > form.amountMinor) {
        setErrors({ allocation: t("validation.allocation_exceeds_payment") });
        return;
      }
      for (const cert of openCertificates) {
        if ((allocations.get(cert.id) ?? 0) > cert.capacity) {
          setErrors({ allocation: t("validation.allocation_exceeds_unpaid") });
          return;
        }
      }
    }
    if (form.kind === "RETENTION_RELEASE" && state) {
      const capacity = state.retentionHeldMinor + (initial?.kind === "RETENTION_RELEASE" ? initial.amountMinor : 0);
      if (form.amountMinor > capacity) {
        setErrors({ amountMinor: t("validation.release_exceeds_retention") });
        return;
      }
    }
    let allocationList: AllocationInput[] =
      form.kind === "CERTIFICATE"
        ? [...allocations.entries()].filter(([, v]) => v > 0).map(([certificateId, amountMinor]) => ({ certificateId, amountMinor }))
        : [];
    // No manual split → allocate automatically, oldest certificate first, so
    // the money always counts toward "collected".
    if (form.kind === "CERTIFICATE" && allocationList.length === 0 && openCertificates.length > 0) {
      const { allocations: auto } = suggestAllocation(
        form.amountMinor,
        openCertificates.map((c) => ({ certificateId: c.id, unpaidMinor: c.capacity })),
      );
      allocationList = auto.map((a) => ({ certificateId: a.certificateId, amountMinor: a.amountMinor }));
    }
    onSubmit(parsed.data, allocationList);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("payments.newPayment")} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("projects.single")}>
          <Select
            value={projectId}
            disabled={!!initial}
            onChange={(e) => {
              setProjectId(Number(e.target.value));
              setForm((f) => ({ ...f, contractId: 0 }));
              setAllocations(new Map());
            }}
          >
            <option value={0}>—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("certificates.contract")}>
          <Select
            value={form.contractId}
            disabled={!!initial}
            onChange={(e) => {
              setForm((f) => ({ ...f, contractId: Number(e.target.value) }));
              setAllocations(new Map());
            }}
          >
            <option value={0}>—</option>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>{c.number}{c.title ? ` — ${c.title}` : ""}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("payments.kind")}>
          <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as PaymentKind }))}>
            {(["CERTIFICATE", "ADVANCE", "RETENTION_RELEASE"] as const).map((k) => (
              <option key={k} value={k}>{t(`paymentKind.${k}`)}</option>
            ))}
          </Select>
        </Field>

        <Field label={t("payments.number")} error={errors.number}>
          <Input value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} className="tnum" />
        </Field>
        <Field label={t("common.date")}>
          <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("common.amount")} error={errors.amountMinor}>
          <MoneyInput currency={currency} valueMinor={form.amountMinor} onChange={(v) => setForm((f) => ({ ...f, amountMinor: v ?? 0 }))} />
        </Field>

        <Field label={t("payments.method")}>
          <Select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as PaymentMethod }))}>
            {(["BANK_TRANSFER", "CHEQUE", "CASH"] as const).map((m) => (
              <option key={m} value={m}>{t(`method.${m}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("payments.bank")}>
          <Input value={form.bank} onChange={(e) => setForm((f) => ({ ...f, bank: e.target.value }))} />
        </Field>
        <Field label={t("payments.reference")}>
          <Input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} className="tnum" />
        </Field>

        <Field label={t("common.notes")} className="col-span-3">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>

      {form.kind === "CERTIFICATE" && form.contractId > 0 && (
        <Card className="mt-4 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">{t("payments.allocation")}</p>
            <Button onClick={autoAllocate} disabled={form.amountMinor <= 0}>
              {t("payments.autoAllocate")}
            </Button>
          </div>
          {openCertificates.length === 0 ? (
            <p className="text-sm text-slate-400">{t("common.empty")}</p>
          ) : (
            <div className="space-y-2">
              {openCertificates.map((cert) => (
                <div key={cert.id} className="flex items-center gap-3 text-sm">
                  <span className="w-28 font-medium tnum">{cert.number}</span>
                  <span className="w-48 text-xs text-slate-400 tnum">
                    {t("certificates.unpaid")}: {fmt.money(cert.capacity, currency)}
                  </span>
                  <MoneyInput
                    className="w-44"
                    currency={currency}
                    valueMinor={allocations.get(cert.id) ?? null}
                    onChange={(v) =>
                      setAllocations((prev) => {
                        const next = new Map(prev);
                        if (v === null || v === 0) next.delete(cert.id);
                        else next.set(cert.id, v);
                        return next;
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-6 border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
            <span>{t("payments.allocated")}: <b className="tnum">{fmt.money(allocatedTotal, currency)}</b></span>
            <span className={unallocated < 0 ? "text-red-600" : "text-slate-500"}>
              {t("payments.unallocated")}: <b className="tnum">{fmt.money(unallocated, currency)}</b>
            </span>
          </div>
          {errors.allocation && <p className="mt-1 text-xs text-red-600">{errors.allocation}</p>}
        </Card>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy || form.contractId === 0}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
