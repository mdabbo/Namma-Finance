import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";
import type { Contract } from "@mep/core";
import { useProject } from "../../repositories/projects";
import { useContractMutations, useContractsByProject, contractCascadeInfo } from "../../repositories/contracts";
import { usePaymentMutations } from "../../repositories/payments";
import { todayIso } from "../../lib/format";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useExpensesByProject } from "../../repositories/expenses";
import { useAssignmentsByProject, usePeople, usePeopleMutations, usePersonPayments } from "../../repositories/people";
import { assignmentSchema, computeAssignmentAccount, type AssignmentInput } from "@mep/core";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, RatioBar, Select, cx } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MoneyInput } from "../../components/MoneyInput";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { useRole } from "../../lib/roles";
import { ContractForm } from "./ContractForm";
import { PersonForm } from "../people/PeoplePage";
import { StagesTab } from "./StagesTab";
import { DocumentsTab } from "./DocumentsTab";

type Tab = "overview" | "stages" | "contracts" | "certificates" | "payments" | "expenses" | "team" | "documents";

export function ProjectDetailPage() {
  const { id } = useParams();
  const projectId = Number(id);
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();

  const { data: project } = useProject(projectId);
  const { data: contracts = [] } = useContractsByProject(projectId);
  const { data: financials } = useWorkspaceFinancials();
  const { data: expenses = [] } = useExpensesByProject(projectId);
  const { data: assignments = [] } = useAssignmentsByProject(projectId);
  const { data: personPayments = [] } = usePersonPayments(assignments.map((a) => a.id));
  const contractMutations = useContractMutations();

  const role = useRole();
  const [tab, setTab] = useState<Tab>("overview");
  const [contractModal, setContractModal] = useState<Contract | "new" | null>(null);
  const [deletingContract, setDeletingContract] = useState<{ contract: Contract; details: string[] } | null>(null);
  const [advanceConfirm, setAdvanceConfirm] = useState<{ contract: Contract; amountMinor: number } | null>(null);
  const paymentMutations = usePaymentMutations();
  const [addingMember, setAddingMember] = useState(false);
  const base = useBaseMoney();

  if (!project) return <EmptyState message={t("common.loading")} />;

  const fin = financials?.projects.find((f) => f.project.id === projectId);
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;
  const currency = project.currency;

  const teamCost = assignments.reduce(
    (acc, a) => {
      const paid = personPayments.filter((p) => p.assignmentId === a.id).reduce((s, p) => s + p.amountMinor, 0);
      return {
        agreed: acc.agreed + base.convertFrom(a.agreedMinor, a.currency, a.fxRateMicro),
        paid: acc.paid + base.convertFrom(paid, a.currency, a.fxRateMicro),
      };
    },
    { agreed: 0, paid: 0 },
  );

  // engineers see the delivery side only — no money tabs
  const ENGINEER_TABS: Tab[] = ["stages", "documents"];
  const ALL_TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: t("projects.overview") },
    { key: "stages", label: t("stages.title") },
    { key: "contracts", label: t("projects.contracts") },
    { key: "certificates", label: t("certificates.title") },
    { key: "payments", label: t("payments.title") },
    { key: "expenses", label: t("expenses.title") },
    { key: "team", label: t("projects.team") },
    { key: "documents", label: t("documents.title") },
  ];
  const TABS = role === "ENGINEER" ? ALL_TABS.filter((x) => ENGINEER_TABS.includes(x.key)) : ALL_TABS;
  const activeTab = TABS.some((x) => x.key === tab) ? tab : TABS[0]!.key;

  return (
    <div>
      <button onClick={() => navigate("/projects")} className="mb-3 flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <BackIcon size={15} /> {t("projects.title")}
      </button>

      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{project.name}</h1>
            <Badge value={project.status} label={t(`status.${project.status}`)} />
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            <span className="tnum">{project.code}</span> · {project.clientName} · {t(`discipline.${project.discipline}`)}
            {project.city ? ` · ${project.city}` : ""}
            {currency !== "EGP" ? ` · ${currency} @ ${(project.fxRateMicro / 1_000_000).toLocaleString()}` : ""}
          </p>
        </div>
      </div>

      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cx(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              activeTab ===key
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab ==="overview" && (
        <div className="grid grid-cols-4 gap-3">
          <Card className="p-4">
            <p className="text-xs text-slate-500">{t("clients.totalContracts")}</p>
            <p className="mt-1 text-lg font-semibold tnum">{fmt.money(fin?.contractValueMinor ?? 0, currency, { compactFraction: true })}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-slate-500">{t("projects.certified")}</p>
            <p className="mt-1 text-lg font-semibold tnum">{fmt.money(fin?.certifiedBaseMinor ?? 0, currency, { compactFraction: true })}</p>
            <p className="text-xs text-slate-400 tnum">{fmt.percent(fin?.certifiedRatioBp ?? 0)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-slate-500">{t("projects.collected")}</p>
            <p className="mt-1 text-lg font-semibold tnum text-emerald-600 dark:text-emerald-400">
              {fmt.money(fin?.totalPaidMinor ?? 0, currency, { compactFraction: true })}
            </p>
            <p className="text-xs text-slate-400 tnum">{fmt.percent(fin?.collectionRatioBp ?? 0)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-slate-500">{t("clients.outstanding")}</p>
            <p className="mt-1 text-lg font-semibold tnum text-amber-600 dark:text-amber-400">
              {fmt.money(fin?.outstandingMinor ?? 0, currency, { compactFraction: true })}
            </p>
          </Card>

          <Card className="col-span-2 p-4">
            <p className="mb-2 text-sm font-semibold">{t("dashboard.certifiedVsCollected")}</p>
            <RatioBar ratioBp={fin?.collectionRatioBp ?? 0} secondaryBp={fin?.certifiedRatioBp ?? 0} className="!h-3" />
            <div className="mt-2 flex justify-between text-xs text-slate-500">
              <span>{t("projects.collected")}: <b className="tnum">{fmt.percent(fin?.collectionRatioBp ?? 0)}</b></span>
              <span>{t("projects.certified")}: <b className="tnum">{fmt.percent(fin?.certifiedRatioBp ?? 0)}</b></span>
            </div>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-slate-500">{t("dashboard.kpiExpenses")}</p>
            <p className="mt-1 text-lg font-semibold tnum">{base.format(fin?.expensesEgp ?? 0)}</p>
            <p className="text-xs text-slate-400 tnum">
              {t("projects.teamCost")}: {fmt.money(teamCost.paid, base.code, { compactFraction: true })} / {fmt.money(teamCost.agreed, base.code, { compactFraction: true })}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-slate-500">{t("dashboard.kpiProfit")}</p>
            <p className={cx("mt-1 text-lg font-semibold tnum", (fin?.profitEgp ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600")}>
              {base.format(fin?.profitEgp ?? 0)}
            </p>
            <p className="text-xs text-slate-400 tnum">{t("dashboard.kpiMargin")}: {fmt.percent(fin?.marginBp ?? 0)}</p>
          </Card>

          {project.description && (
            <Card className="col-span-4 p-4 text-sm text-slate-600 dark:text-slate-300">{project.description}</Card>
          )}
        </div>
      )}

      {activeTab ==="contracts" && (
        <div>
          <div className="mb-3 flex justify-end">
            <Button variant="primary" onClick={() => setContractModal("new")}>
              <Plus size={16} /> {t("contracts.newContract")}
            </Button>
          </div>
          {contracts.length === 0 ? (
            <EmptyState message={t("common.empty")} />
          ) : (
            <div className="space-y-3">
              {contracts.map((contract) => {
                const state = financials?.contractStates.get(contract.id);
                return (
                  <Card key={contract.id} className="p-4">
                    <div className="mb-3 flex items-start justify-between">
                      <div>
                        <p className="font-semibold">
                          <span className="tnum">{contract.number}</span>
                          {contract.title ? ` — ${contract.title}` : ""}
                        </p>
                        <p className="text-xs text-slate-500">
                          {t("contracts.paymentTerms")}: <span className="tnum">{contract.paymentTermsDays}</span>
                          {contract.performanceBondBp > 0 &&
                            ` · ${t("contracts.performanceBond")}: ${fmt.percent(contract.performanceBondBp)}`}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button variant="ghost" onClick={() => setContractModal(contract)}>{t("common.edit")}</Button>
                        <Button
                          variant="ghost"
                          className="!text-red-600"
                          onClick={async () => {
                            const info = await contractCascadeInfo(contract.id);
                            setDeletingContract({
                              contract,
                              details: [`${info.certificates} ${t("certificates.title")}`, `${info.payments} ${t("payments.title")}`],
                            });
                          }}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-x-6 gap-y-2 text-sm md:grid-cols-8">
                      {[
                        [t("contracts.value"), fmt.money(contract.valueMinor, currency, { compactFraction: true })],
                        [t("contracts.vatAmount"), fmt.money(state?.figures.vatMinor ?? 0, currency, { compactFraction: true })],
                        [t("contracts.netValue"), fmt.money(state?.figures.netContractMinor ?? 0, currency, { compactFraction: true })],
                        [t("contracts.certifiedToDate"), fmt.money(state?.certifiedBaseMinor ?? 0, currency, { compactFraction: true })],
                        [t("contracts.remainingValue"), fmt.money(state?.remainingUncertifiedMinor ?? 0, currency, { compactFraction: true })],
                        [t("contracts.retentionHeld"), fmt.money(state?.retentionHeldMinor ?? 0, currency, { compactFraction: true })],
                        [t("contracts.advanceRecovered"), `${fmt.money(state?.advanceRecoveredMinor ?? 0, currency, { compactFraction: true })} / ${fmt.money(contract.advanceMinor, currency, { compactFraction: true })}`],
                        [t("contracts.collection"), fmt.percent(state?.collectionRatioBp ?? 0)],
                      ].map(([label, value]) => (
                        <div key={label as string}>
                          <p className="text-xs text-slate-400">{label}</p>
                          <p className="font-medium tnum">{value}</p>
                        </div>
                      ))}
                    </div>
                    {contract.advanceMinor > 0 && state && (
                      <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
                        <span className="text-xs text-slate-400">{t("contracts.advanceReceived")}:</span>
                        <span className={cx("font-medium tnum", state.advanceReceivedMinor >= contract.advanceMinor ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                          {fmt.money(state.advanceReceivedMinor, currency, { compactFraction: true })} / {fmt.money(contract.advanceMinor, currency, { compactFraction: true })}
                        </span>
                        {state.advanceReceivedMinor < contract.advanceMinor && (
                          <Button
                            variant="primary"
                            className="!px-2.5 !py-1 !text-xs"
                            disabled={paymentMutations.create.isPending}
                            onClick={() => setAdvanceConfirm({ contract, amountMinor: contract.advanceMinor - state.advanceReceivedMinor })}
                          >
                            {t("contracts.recordAdvance")}
                          </Button>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab ==="stages" && <StagesTab projectId={projectId} />}
      {activeTab ==="documents" && <DocumentsTab projectId={projectId} />}
      {activeTab ==="certificates" && <ProjectCertificates projectId={projectId} currency={currency} />}
      {activeTab ==="payments" && <ProjectPayments projectId={projectId} currency={currency} />}

      {activeTab ==="expenses" && (
        <Card className="p-4">
          {expenses.length === 0 ? (
            <EmptyState message={t("common.empty")} />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-start text-xs uppercase text-slate-500 dark:border-slate-800">
                  <th className="py-2 text-start">{t("common.date")}</th>
                  <th className="text-start">{t("expenses.category")}</th>
                  <th className="text-start">{t("common.description")}</th>
                  <th className="text-end">{t("common.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 tnum">{fmt.date(e.date)}</td>
                    <td>{i18n.language === "ar" ? e.categoryAr : e.categoryEn}</td>
                    <td>{e.description}</td>
                    <td className="text-end tnum">{fmt.money(e.amountMinor, e.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {activeTab ==="team" && (
        <Card className="p-4">
          <div className="mb-3 flex justify-end">
            <Button variant="primary" onClick={() => setAddingMember(true)}>
              <Plus size={15} /> {t("projects.addTeamMember")}
            </Button>
          </div>
          {assignments.length === 0 ? (
            <EmptyState message={t("common.empty")} />
          ) : (
            <div className="space-y-2">
              {assignments.map((a) => {
                const account = computeAssignmentAccount(a, personPayments);
                const payable = financials?.teamPayables.find((x) => x.assignmentId === a.id);
                return (
                  <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2.5 dark:border-slate-800">
                    <div>
                      <button className="text-sm font-medium hover:text-brand-600" onClick={() => navigate(`/people/${a.personId}`)}>
                        {a.personName}
                      </button>
                      {a.scope && <p className="text-xs text-slate-400">{a.scope}</p>}
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      {payable && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold tnum text-red-700 dark:bg-red-900/50 dark:text-red-300">
                          {t("team.dueNow")}: {fmt.money(payable.dueMinor, a.currency, { compactFraction: true })}
                        </span>
                      )}
                      <span className="tnum">{t("people.agreedAmount")}: {fmt.money(a.agreedMinor, a.currency, { compactFraction: true })}</span>
                      <span className="tnum text-emerald-600 dark:text-emerald-400">{t("people.paidToDate")}: {fmt.money(account.paidMinor, a.currency, { compactFraction: true })}</span>
                      <span className="tnum text-amber-600 dark:text-amber-400">{t("people.remainingAmount")}: {fmt.money(account.remainingMinor, a.currency, { compactFraction: true })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {addingMember && (
        <ProjectTeamForm
          projectId={projectId}
          currency={currency}
          fxRateMicro={project.fxRateMicro}
          onClose={() => setAddingMember(false)}
        />
      )}

      {contractModal !== null && (
        <ContractForm
          projectId={projectId}
          currency={currency}
          initial={contractModal === "new" ? null : contractModal}
          busy={contractMutations.create.isPending || contractMutations.update.isPending}
          onClose={() => setContractModal(null)}
          onSubmit={(input) => {
            if (contractModal === "new") contractMutations.create.mutate(input, { onSuccess: () => setContractModal(null) });
            else contractMutations.update.mutate({ id: contractModal.id, input }, { onSuccess: () => setContractModal(null) });
          }}
        />
      )}

      {advanceConfirm && (
        <ConfirmDialog
          title={t("contracts.recordAdvance")}
          message={t("contracts.recordAdvanceConfirm", {
            amount: fmt.money(advanceConfirm.amountMinor, currency, { compactFraction: true }),
          })}
          confirmLabel={t("common.confirm")}
          busy={paymentMutations.create.isPending}
          onCancel={() => setAdvanceConfirm(null)}
          onConfirm={() =>
            paymentMutations.create.mutate(
              {
                input: {
                  contractId: advanceConfirm.contract.id,
                  kind: "ADVANCE",
                  number: `ADV-${advanceConfirm.contract.number}`,
                  date: todayIso(),
                  amountMinor: advanceConfirm.amountMinor,
                  method: "BANK_TRANSFER",
                  bank: null,
                  reference: null,
                  notes: null,
                },
                allocations: [],
              },
              { onSuccess: () => setAdvanceConfirm(null) },
            )
          }
        />
      )}

      {deletingContract && (
        <ConfirmDialog
          message={`${t("common.confirmDeleteMessage")} ${deletingContract.contract.number}`}
          details={deletingContract.details}
          busy={contractMutations.remove.isPending}
          onCancel={() => setDeletingContract(null)}
          onConfirm={() => contractMutations.remove.mutate(deletingContract.contract.id, { onSuccess: () => setDeletingContract(null) })}
        />
      )}
    </div>
  );
}

/**
 * Assign a person to this project from the Team tab. The picker offers
 * "New person…" which opens the quick person form; the created person is
 * selected automatically and also appears on the Team page (confirmed rule).
 */
function ProjectTeamForm({
  projectId,
  currency,
  fxRateMicro,
  onClose,
}: {
  projectId: number;
  currency: string;
  fxRateMicro: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: people = [] } = usePeople();
  const mutations = usePeopleMutations();

  const [personId, setPersonId] = useState(0);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [agreedMinor, setAgreedMinor] = useState(0);
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");

  function submit() {
    const parsed = assignmentSchema.safeParse({
      personId,
      projectId,
      agreedMinor,
      currency,
      fxRateMicro,
      scope: scope || null,
      progressNote: null,
    } satisfies AssignmentInput);
    if (!parsed.success) {
      setError(t("validation.required"));
      return;
    }
    mutations.createAssignment.mutate(parsed.data, { onSuccess: onClose });
  }

  return (
    <>
      <Modal title={t("projects.addTeamMember")} onClose={onClose}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("people.selectPerson")} error={personId === 0 ? error : undefined} className="col-span-2">
            <div className="flex gap-2">
              <Select className="flex-1" value={personId} onChange={(e) => setPersonId(Number(e.target.value))}>
                <option value={0}>—</option>
                {people.filter((p) => p.isActive).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({t(`personType.${p.type}`)})
                  </option>
                ))}
              </Select>
              <Button onClick={() => setCreatingPerson(true)}>{t("people.orCreateNew")}</Button>
            </div>
          </Field>
          <Field label={t("people.agreedAmount")}>
            <MoneyInput currency={currency} valueMinor={agreedMinor} onChange={(v) => setAgreedMinor(v ?? 0)} />
          </Field>
          <Field label={t("common.description")}>
            <Input value={scope} onChange={(e) => setScope(e.target.value)} />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={personId === 0 || mutations.createAssignment.isPending}>
            {t("common.save")}
          </Button>
        </div>
      </Modal>
      {creatingPerson && (
        <PersonForm
          initial={null}
          busy={mutations.create.isPending}
          onClose={() => setCreatingPerson(false)}
          onSubmit={(input) =>
            mutations.create.mutate(input, {
              onSuccess: (newId) => {
                setPersonId(newId);
                setCreatingPerson(false);
              },
            })
          }
        />
      )}
    </>
  );
}

/** Read-only per-project certificate list; editing happens on the Certificates page. */
function ProjectCertificates({ projectId, currency }: { projectId: number; currency: string }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const { data: financials } = useWorkspaceFinancials();

  const states = [...(financials?.contractStates.values() ?? [])].filter((s) => s.contract.projectId === projectId);
  const rows = states.flatMap((s) => s.certificates.map((c) => ({ state: s, cert: c })));

  if (rows.length === 0) return <EmptyState message={t("common.empty")} />;
  return (
    <Card className="p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <th className="py-2 text-start">{t("certificates.number")}</th>
            <th className="text-start">{t("common.date")}</th>
            <th className="text-end">{t("certificates.gross")}</th>
            <th className="text-end">{t("certificates.netPayable")}</th>
            <th className="text-end">{t("certificates.paid")}</th>
            <th className="text-start">{t("common.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ cert }) => (
            <tr
              key={cert.certificate.id}
              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-brand-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50"
              onClick={() => navigate("/certificates")}
            >
              <td className="py-2 tnum">{cert.certificate.number}</td>
              <td className="tnum">{fmt.date(cert.certificate.date)}</td>
              <td className="text-end tnum">{fmt.money(cert.breakdown.grossMinor, currency)}</td>
              <td className="text-end tnum font-medium">{fmt.money(cert.breakdown.netPayableMinor, currency)}</td>
              <td className="text-end tnum text-emerald-600 dark:text-emerald-400">{fmt.money(cert.paidMinor, currency)}</td>
              <td>
                <div className="flex items-center gap-1.5">
                  <Badge value={cert.certificate.status} label={t(`status.${cert.certificate.status}`)} />
                  {cert.overdue && <Badge value="OVERDUE" label={t("certificates.overdue")} />}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Read-only per-project payments list. */
function ProjectPayments({ projectId, currency }: { projectId: number; currency: string }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: financials } = useWorkspaceFinancials();
  const states = [...(financials?.contractStates.values() ?? [])].filter((s) => s.contract.projectId === projectId);

  const totals = states.reduce(
    (acc, s) => ({
      due: acc.due + s.totalDueMinor,
      paid: acc.paid + s.totalPaidMinor,
      cashIn: acc.cashIn + s.totalCashInMinor,
      // what the contract will bring in over its whole life: value + VAT
      // (retention is inside that — withheld now, released at the end)
      lifetime: acc.lifetime + s.contract.valueMinor + s.figures.vatMinor,
    }),
    { due: 0, paid: 0, cashIn: 0, lifetime: 0 },
  );
  const remaining = Math.max(0, totals.lifetime - totals.cashIn);
  const dueNow = Math.max(0, totals.due - totals.paid);

  return (
    <div className="grid grid-cols-3 gap-3">
      <Card className="p-4">
        <p className="text-xs text-slate-500">{t("payments.totalPaid")}</p>
        <p className="mt-1 text-lg font-semibold tnum text-emerald-600 dark:text-emerald-400">
          {fmt.money(totals.paid, currency, { compactFraction: true })}
        </p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-slate-500">{t("payments.remainingBalance")}</p>
        <p className="mt-1 text-lg font-semibold tnum text-amber-600 dark:text-amber-400">
          {fmt.money(remaining, currency, { compactFraction: true })}
        </p>
        <p className="text-xs text-slate-400 tnum">
          {t("payments.remainingHint", { due: fmt.money(dueNow, currency, { compactFraction: true }) })}
        </p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-slate-500">{t("dashboard.cashIn")}</p>
        <p className="mt-1 text-lg font-semibold tnum">{fmt.money(totals.cashIn, currency, { compactFraction: true })}</p>
      </Card>
    </div>
  );
}
