import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, FileDown, Plus, Trash2 } from "lucide-react";
import { assignmentSchema, computeAssignmentAccount, personPaymentSchema, type AssignmentInput, type PersonPaymentInput } from "@mep/core";
import {
  useAssignmentsByPerson,
  usePeopleMutations,
  usePerson,
  usePersonPayments,
  type AssignmentListItem,
} from "../../repositories/people";
import { useProjects } from "../../repositories/projects";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, RatioBar, Select, Textarea } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { PrintPortal } from "../../components/PrintPortal";
import { todayIso, useFormat } from "../../lib/format";

export function PersonDetailPage() {
  const { id } = useParams();
  const personId = Number(id);
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();

  const { data: person } = usePerson(personId);
  const { data: assignments = [] } = useAssignmentsByPerson(personId);
  const { data: payments = [] } = usePersonPayments(assignments.map((a) => a.id));
  const mutations = usePeopleMutations();

  const [assignmentModal, setAssignmentModal] = useState<AssignmentListItem | "new" | null>(null);
  const [paymentModal, setPaymentModal] = useState<AssignmentListItem | null>(null);
  const [printStatement, setPrintStatement] = useState(false);

  if (!person) return <EmptyState message={t("common.loading")} />;
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;

  const accounts = assignments.map((a) => computeAssignmentAccount(a, payments));

  return (
    <div>
      <button onClick={() => navigate("/people")} className="mb-3 flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
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
          {accounts.map((account) => {
            const a = assignments.find((x) => x.id === account.assignment.id)!;
            const assignmentPayments = payments.filter((p) => p.assignmentId === a.id);
            return (
              <Card key={a.id} className="p-4">
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <p className="font-semibold">{a.projectName}</p>
                    <p className="text-xs text-slate-400 tnum">{a.projectCode}</p>
                    {a.scope && <p className="mt-1 text-sm text-slate-500">{a.scope}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" onClick={() => setPaymentModal(a)}>
                      <Plus size={14} /> {t("people.newPayment")}
                    </Button>
                    <Button variant="ghost" onClick={() => setAssignmentModal(a)}>{t("common.edit")}</Button>
                    <Button variant="ghost" className="!text-red-600" onClick={() => mutations.removeAssignment.mutate(a.id)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-400">{t("people.agreedAmount")}</p>
                    <p className="font-medium tnum">{fmt.money(a.agreedMinor, a.currency, { compactFraction: true })}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("people.paidToDate")}</p>
                    <p className="font-medium tnum text-emerald-600 dark:text-emerald-400">{fmt.money(account.paidMinor, a.currency, { compactFraction: true })}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">{t("people.remainingAmount")}</p>
                    <p className="font-medium tnum text-amber-600 dark:text-amber-400">{fmt.money(account.remainingMinor, a.currency, { compactFraction: true })}</p>
                  </div>
                  <div className="flex items-end">
                    <RatioBar ratioBp={account.paidRatioBp} className="mb-1.5" />
                  </div>
                </div>

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
          assignment={paymentModal}
          busy={mutations.createPersonPayment.isPending}
          onClose={() => setPaymentModal(null)}
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
            {accounts.map((account) => {
              const a = assignments.find((x) => x.id === account.assignment.id)!;
              const assignmentPayments = payments.filter((p) => p.assignmentId === a.id);
              return (
                <div key={a.id} className="mb-6">
                  <h2 className="mb-2 font-bold">{a.projectCode} — {a.projectName}</h2>
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
                        <td colSpan={2} className="border border-slate-300 px-3 py-1.5">{t("people.paidToDate")}</td>
                        <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{fmt.money(account.paidMinor, a.currency)}</td>
                      </tr>
                      <tr className="bg-slate-100 font-bold">
                        <td colSpan={2} className="border border-slate-300 px-3 py-1.5">{t("people.remainingAmount")}</td>
                        <td className="border border-slate-300 px-3 py-1.5 text-end tnum">{fmt.money(account.remainingMinor, a.currency)}</td>
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
  onSubmit,
  onClose,
  busy,
}: {
  assignment: AssignmentListItem;
  onSubmit: (input: PersonPaymentInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ date: todayIso(), amountMinor: 0, note: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
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
    onSubmit(parsed.data);
  }

  return (
    <Modal title={`${t("people.newPayment")} — ${assignment.projectName}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.date")}>
          <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("common.amount")} error={errors.amountMinor}>
          <MoneyInput currency={assignment.currency} valueMinor={form.amountMinor} onChange={(v) => setForm((f) => ({ ...f, amountMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("common.notes")} className="col-span-2">
          <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
