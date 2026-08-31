import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, ArrowRight, FileDown, Plus, Trash2 } from "lucide-react";
import {
  assignmentCostPosition,
  assignmentSchema,
  computeTeamPayout,
  personPaymentSchema,
  type AssignmentCostPosition,
  type AssignmentInput,
  type ContractState,
  type PersonPaymentInput,
  type TeamPayoutState,
  type TeamStage,
} from "@mep/core";
import {
  useAssignmentsByPerson,
  usePeopleMutations,
  usePerson,
  usePersonPayments,
  type AssignmentListItem,
} from "../../repositories/people";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useProjects } from "../../repositories/projects";
import { Badge, Button, Card, DateInput, EmptyState, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { PrintPortal } from "../../components/PrintPortal";
import { todayIso, useFormat } from "../../lib/format";
import { UNKNOWN_AMOUNT } from "../../lib/readModel";

export function PersonDetailPage() {
  const { id } = useParams();
  const personId = Number(id);
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();

  const { data: person } = usePerson(personId);
  const { data: assignments = [] } = useAssignmentsByPerson(personId);
  const { data: payments = [] } = usePersonPayments(assignments.map((a) => a.id));
  const { data: financials } = useWorkspaceFinancials();
  const mutations = usePeopleMutations();

  const [assignmentModal, setAssignmentModal] = useState<AssignmentListItem | "new" | null>(null);
  const [paymentModal, setPaymentModal] = useState<{ assignment: AssignmentListItem; amountMinor?: number; note?: string } | null>(null);
  const [printStatement, setPrintStatement] = useState(false);

  if (!person) return <EmptyState message={t("common.loading")} />;
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;

  const statesByProject = new Map<number, ContractState[]>();
  for (const state of financials?.contractStates.values() ?? []) {
    const list = statesByProject.get(state.contract.projectId) ?? [];
    list.push(state);
    statesByProject.set(state.contract.projectId, list);
  }
  const payoutOf = (a: AssignmentListItem): TeamPayoutState => {
    const paid = payments.filter((p) => p.assignmentId === a.id).reduce((s, p) => s + p.amountMinor, 0);
    return computeTeamPayout(a.agreedMinor, statesByProject.get(a.projectId) ?? [], paid);
  };

  /**
   * One authoritative account position, shared with Project Team.
   *
   * `financials.teamAccounts` is the audited read model and is preferred; it
   * omits assignments of archived projects, so those fall back to the SAME core
   * selector over the same inputs rather than to a legacy agreed-minus-paid
   * balance. `undefined` means the read model has not resolved yet — the caller
   * shows an unknown placeholder instead of a fabricated zero.
   */
  const positionOf = (a: AssignmentListItem): AssignmentCostPosition | undefined => {
    const account = financials?.teamAccounts.find((item) => item.assignmentId === a.id);
    if (account) {
      return {
        earnedMinor: account.accruedMinor,
        paidMinor: account.paidMinor,
        dueMinor: account.dueMinor,
        committedMinor: account.committedMinor,
      };
    }
    if (!financials) return undefined;
    const payout = payoutOf(a);
    return assignmentCostPosition({
      lifecycle: a.lifecycleStatus,
      agreedMinor: a.agreedMinor,
      releasedMinor: payout.releasedMinor,
      paidOutMinor: payout.paidOutMinor,
      earnedAtCancellationMinor: a.earnedMinorAtCancellation,
    });
  };

  return (
    <div>
      <button onClick={() => navigate("/team/people")} className="mb-3 flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <BackIcon size={15} /> {t("people.title")}
      </button>

      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{person.name}</h1>
            <Badge value={person.type === "EMPLOYEE" ? "APPROVED" : "SUBMITTED"} label={t(`personType.${person.type}`)} />
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            {person.specialization}
            {person.phone ? ` · ${person.phone}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setPrintStatement(true)}>
            <FileDown size={15} /> {t("people.statement")}
          </Button>
          <Button variant="primary" onClick={() => setAssignmentModal("new")}>
            <Plus size={16} /> {t("people.newAssignment")}
          </Button>
        </div>
      </div>

      {assignments.length === 0 ? (
        <EmptyState message={t("common.empty")} />
      ) : (
        <div className="space-y-3">
          {assignments.map((a) => {
            const assignmentPayments = payments.filter((p) => p.assignmentId === a.id);
            const position = positionOf(a);
            const payout = payoutOf(a);
            const cancelled = a.lifecycleStatus === "CANCELLED";
            const archived = a.archivedAt !== null || a.personArchived;
            // Terms are final once the work is no longer running: editing the
            // agreed fee of cancelled work would move a frozen accounting base.
            const termsFinal = a.lifecycleStatus !== "ACTIVE" || archived;
            const canPay = !archived && (position?.dueMinor ?? 0) > 0;
            const money = (minor: number) => fmt.money(minor, a.currency, { compactFraction: true });
            const figure = (value: number | undefined, className?: string) =>
              value === undefined
                ? <p className="font-medium tnum text-muted">{UNKNOWN_AMOUNT}</p>
                : <p className={`font-medium tnum${className ? ` ${className}` : ""}`}>{money(value)}</p>;
            return (
              <Card key={a.id} className="p-4">
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{a.projectName}</p>
                      <Badge value={a.lifecycleStatus} label={t(`assignments.lifecycle.${a.lifecycleStatus}`)} />
                      {a.archivedAt !== null && <Badge value="CANCELLED" label={t("lifecycle.archived")} />}
                    </div>
                    <p className="text-xs text-slate-400 tnum">{a.projectCode}</p>
                    {a.scope && <p className="mt-1 text-sm text-slate-500">{a.scope}</p>}
                  </div>
                  <div className="flex gap-1">
                    {canPay && (
                      <Button variant="ghost" onClick={() => setPaymentModal({ assignment: a, amountMinor: position?.dueMinor })}>
                        <Plus size={14} /> {t("people.newPayment")}
                      </Button>
                    )}
                    {!termsFinal && (
                      <Button variant="ghost" onClick={() => setAssignmentModal(a)}>{t("common.edit")}</Button>
                    )}
                    {a.archivedAt === null && (
                      <Button variant="ghost" title={t("lifecycle.archiveAssignment")} aria-label={t("lifecycle.archiveAssignment")} onClick={() => mutations.removeAssignment.mutate(a.id)}>
                        <Archive size={14} />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Cancellation is an accounting event: say when, why, and what
                    was frozen, so the earned figure is never mistaken for live
                    progress. */}
                {cancelled && (
                  <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">
                    {t("assignments.cancelledOn", { date: fmt.date(a.cancelledAt) })}
                    {a.cancellationReason ? ` — ${a.cancellationReason}` : ""}
                  </p>
                )}

                <div className="mb-2 grid grid-cols-5 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-400">{t("people.agreedAmount")}</p>
                    {figure(a.agreedMinor)}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">
                      {cancelled ? t("assignments.earnedFrozen") : t("projects.teamAccrued")}
                    </p>
                    {figure(position?.earnedMinor)}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("people.paidToDate")}</p>
                    {figure(position?.paidMinor, "text-emerald-600 dark:text-emerald-400")}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("team.dueNow")}</p>
                    {figure(position?.dueMinor, "text-amber-600 dark:text-amber-400")}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("projects.teamCommitted")}</p>
                    {figure(position?.committedMinor)}
                  </div>
                </div>

                {/* The live contract schedule is hidden once work is cancelled:
                    its stages describe a payout that can no longer accrue. */}
                {!cancelled && payout.stages.length > 0 && (
                  <TeamScheduleTable
                    payout={payout}
                    currency={a.currency}
                    onPay={(stage) =>
                      setPaymentModal({
                        assignment: a,
                        // Never more than the lifecycle-aware amount due, whatever
                        // the stage is worth; Rust rejects anything above it.
                        amountMinor: Math.min(stage.amountMinor - stage.paidOutMinor, position?.dueMinor ?? 0),
                        note: stage.title || t("team.remainder"),
                      })
                    }
                  />
                )}

                {a.progressNote && (
                  <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">{t("people.workProgress")}: {a.progressNote}</p>
                )}

                {assignmentPayments.length > 0 && (
                  <table className="w-full text-sm">
                    <tbody>
                      {assignmentPayments.map((p) => (
                        <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="py-1.5 tnum">{fmt.date(p.date)}</td>
                          <td className="text-slate-500">{p.note}</td>
                          <td className="text-end tnum">{fmt.money(p.amountMinor, a.currency)}</td>
                          <td className="w-10 text-end">
                            <button className="text-slate-300 hover:text-red-600" onClick={() => mutations.removePersonPayment.mutate(p.id)}>
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {assignmentModal !== null && (
        <AssignmentForm
          personId={personId}
          initial={assignmentModal === "new" ? null : assignmentModal}
          busy={mutations.createAssignment.isPending || mutations.updateAssignment.isPending}
          onClose={() => setAssignmentModal(null)}
          onSubmit={(input) => {
            if (assignmentModal === "new") mutations.createAssignment.mutate(input, { onSuccess: () => setAssignmentModal(null) });
            else mutations.updateAssignment.mutate({ id: assignmentModal.id, input }, { onSuccess: () => setAssignmentModal(null) });
          }}
        />
      )}

      {paymentModal && (
        <PersonPaymentForm
          assignment={paymentModal.assignment}
          initialAmountMinor={paymentModal.amountMinor}
          initialNote={paymentModal.note}
          dueMinor={positionOf(paymentModal.assignment)?.dueMinor}
          busy={mutations.createPersonPayment.isPending}
          error={
            mutations.createPersonPayment.isError
              ? (mutations.createPersonPayment.error as Error).message === "DUPLICATE_PERSON_PAYMENT"
                ? t("people.duplicatePayment")
                : (mutations.createPersonPayment.error as Error).message === "PERSON_PAYMENT_EXCEEDS_DUE"
                  ? t("people.paymentExceedsDueShort")
                  : (mutations.createPersonPayment.error as Error).message
              : undefined
          }
          onClose={() => {
            mutations.createPersonPayment.reset();
            setPaymentModal(null);
          }}
          onSubmit={(input) => mutations.createPersonPayment.mutate(input, { onSuccess: () => setPaymentModal(null) })}
        />
      )}

      {printStatement && (
        <PrintPortal onDone={() => setPrintStatement(false)}>
          <div dir={i18n.dir()} className="mx-auto max-w-3xl text-[13px] text-black">
            <div className="mb-6 flex items-start justify-between border-b-2 border-slate-800 pb-4">
              <div>
                <h1 className="text-2xl font-bold">{t("people.statement")}</h1>
                <p className="mt-1 text-slate-600">{t("common.appName")}</p>
              </div>
              <div className="text-end">
                <p className="text-lg font-bold">{person.name}</p>
                <p className="text-slate-600 tnum">{fmt.date(todayIso())}</p>
              </div>
            </div>
            {assignments.map((a) => {
              const assignmentPayments = payments.filter((p) => p.assignmentId === a.id);
              // The statement reports the same lifecycle-aware account as the
              // screen; a printed balance that disagrees with the app is worse
              // than no statement at all.
              const position = positionOf(a);
              const cancelled = a.lifecycleStatus === "CANCELLED";
              const printMoney = (minor: number | undefined) =>
                minor === undefined ? UNKNOWN_AMOUNT : fmt.money(minor, a.currency);
              return (
                <div key={a.id} className="mb-6">
                  <h2 className="mb-2 font-bold">
                    {a.projectCode} — {a.projectName}
                    <span className="ms-2 text-xs font-normal">
                      ({t(`assignments.lifecycle.${a.lifecycleStatus}`)})
                    </span>
                  </h2>
                  {cancelled && (
                    <p className="mb-2 text-xs text-slate-600">
                      {t("assignments.cancelledOn", { date: fmt.date(a.cancelledAt) })}
                      {a.cancellationReason ? ` — ${a.cancellationReason}` : ""}
                    </p>
                  )}
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-slate-100">
                        <th className="border border-slate-300 px-3 py-1.5 text-start">{t("common.date")}</th>
                        <th className="border border-slate-300 px-3 py-1.5 text-start">{t("common.description")}</th>
                        <th className="border border-slate-300 px-3 py-1.5 text-end">{t("common.amount")} ({a.currency})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignmentPayments.map((p) => (
                        <tr key={p.id}>
                          <td className="border border-slate-300 px-3 py-1.5 tnum">{fmt.date(p.date)}</td>
                          <td className="border border-slate-300 px-3 py-1.5">{p.note ?? t("people.payments")}</td>
                          <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{fmt.money(p.amountMinor, a.currency)}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold">
                        <td colSpan={2} className="border border-slate-300 px-3 py-1.5">{t("people.agreedAmount")}</td>
                        <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{fmt.money(a.agreedMinor, a.currency)}</td>
                      </tr>
                      <tr className="font-semibold">
                        <td colSpan={2} className="border border-slate-300 px-3 py-1.5">
                          {cancelled ? t("assignments.earnedFrozen") : t("projects.teamAccrued")}
                        </td>
                        <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{printMoney(position?.earnedMinor)}</td>
                      </tr>
                      <tr className="font-semibold">
                        <td colSpan={2} className="border border-slate-300 px-3 py-1.5">{t("people.paidToDate")}</td>
                        <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{printMoney(position?.paidMinor)}</td>
                      </tr>
                      <tr className="bg-slate-100 font-bold">
                        <td colSpan={2} className="border border-slate-300 px-3 py-1.5">{t("team.dueNow")}</td>
                        <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{printMoney(position?.dueMinor)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </PrintPortal>
      )}
    </div>
  );
}

/**
 * The assignment's payment schedule, mirrored live from the project contract
 * (confirmed rule): same milestones / payment stages, fee split by the same
 * shares. A stage's certificate being PAID makes it payable to the person.
 */
const STAGE_BADGE: Record<TeamStage["status"], string> = {
  PENDING: "DRAFT",
  AWAITING_COLLECTION: "SUBMITTED",
  PAYABLE: "OVERDUE",
  PAID_OUT: "PAID",
};

function TeamScheduleTable({
  payout,
  currency,
  onPay,
}: {
  payout: TeamPayoutState;
  currency: string;
  onPay: (stage: TeamStage) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const manyContracts = new Set(payout.stages.map((s) => s.contractNumber)).size > 1;

  return (
    <div className="mb-2 rounded-lg border border-slate-100 dark:border-slate-800">
      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-xs font-semibold text-slate-500">{t("team.schedule")}</p>
        {payout.dueMinor > 0 && (
          <span className="text-xs font-semibold tnum text-red-600 dark:text-red-400">
            {t("team.dueNow")}: {fmt.money(payout.dueMinor, currency, { compactFraction: true })}
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {payout.stages.map((stage, i) => (
            <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-1.5">
                {stage.title || t("team.remainder")}
                {manyContracts && <span className="ms-1 text-xs text-slate-400 tnum">({stage.contractNumber})</span>}
              </td>
              <td className="py-1.5 text-end tnum">{fmt.money(stage.amountMinor, currency, { compactFraction: true })}</td>
              <td className="px-3 py-1.5 text-end">
                <Badge value={STAGE_BADGE[stage.status]} label={t(`team.status.${stage.status}`)} />
              </td>
              <td className="w-16 pe-3 text-end">
                {stage.status === "PAYABLE" && (
                  <button className="text-xs font-semibold text-brand-600 hover:underline" onClick={() => onPay(stage)}>
                    {t("team.payStage")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AssignmentForm({
  personId,
  initial,
  onSubmit,
  onClose,
  busy,
}: {
  personId: number;
  initial: AssignmentListItem | null;
  onSubmit: (input: AssignmentInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const { data: projects = [] } = useProjects();
  const [form, setForm] = useState({
    projectId: initial?.projectId ?? 0,
    agreedMinor: initial?.agreedMinor ?? 0,
    currency: initial?.currency ?? "EGP",
    fxRateMicro: initial?.fxRateMicro ?? 1_000_000,
    scope: initial?.scope ?? "",
    progressNote: initial?.progressNote ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
    const parsed = assignmentSchema.safeParse({
      ...form,
      personId,
      scope: form.scope || null,
      progressNote: form.progressNote || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("people.newAssignment")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("projects.single")} error={errors.projectId} className="col-span-2">
          <Select
            value={form.projectId}
            disabled={!!initial}
            onChange={(e) => {
              const projectId = Number(e.target.value);
              const project = projects.find((p) => p.id === projectId);
              setForm((f) => ({
                ...f,
                projectId,
                currency: project?.currency ?? "EGP",
                fxRateMicro: project?.fxRateMicro ?? 1_000_000,
              }));
            }}
          >
            <option value={0}>—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("people.agreedAmount")}>
          <MoneyInput currency={form.currency} valueMinor={form.agreedMinor} onChange={(v) => setForm((f) => ({ ...f, agreedMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("people.workProgress")}>
          <Input value={form.progressNote} onChange={(e) => setForm((f) => ({ ...f, progressNote: e.target.value }))} />
        </Field>
        <Field label={t("common.description")} className="col-span-2">
          <Textarea value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}

function PersonPaymentForm({
  assignment,
  initialAmountMinor,
  initialNote,
  dueMinor,
  onSubmit,
  onClose,
  busy,
  error,
}: {
  assignment: AssignmentListItem;
  initialAmountMinor?: number;
  initialNote?: string;
  /** Lifecycle-aware ceiling; Rust re-derives and enforces it regardless. */
  dueMinor?: number;
  onSubmit: (input: PersonPaymentInput) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const [form, setForm] = useState({ date: todayIso(), amountMinor: initialAmountMinor ?? 0, note: initialNote ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // same-tick double-click latch: isPending flips only on the next render,
  // which is too late to stop a fast second click from double-recording
  const firing = useRef(false);
  useEffect(() => {
    if (!busy) firing.current = false;
  }, [busy]);

  function submit() {
    if (firing.current) return;
    if (dueMinor !== undefined && form.amountMinor > dueMinor) {
      setErrors({ amountMinor: t("people.paymentExceedsDue", { due: fmt.money(dueMinor, assignment.currency) }) });
      return;
    }
    const parsed = personPaymentSchema.safeParse({
      ...form,
      assignmentId: assignment.id,
      note: form.note || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    firing.current = true;
    onSubmit(parsed.data);
  }

  return (
    <Modal title={`${t("people.newPayment")} — ${assignment.projectName}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.date")}>
          <DateInput value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("common.amount")} error={errors.amountMinor}>
          <MoneyInput currency={assignment.currency} valueMinor={form.amountMinor} onChange={(v) => setForm((f) => ({ ...f, amountMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("common.notes")} className="col-span-2">
          <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
