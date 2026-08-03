import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { CertificateStatus } from "@mep/core";
import { type WorkspaceFinancials } from "../../repositories/financials";
import { type ExpenseListItem } from "../../repositories/expenses";
import { type PaymentListItem } from "../../repositories/payments";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge, Button, Select, cx } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { PROJECT_FINANCE_VIEWS, readModelAmount, type ProjectFinanceView } from "./projectWorkspaceModel";

export function ProjectFinance({
  projectId,
  projectCurrency,
  financials,
  financialsPending,
  expenses,
  payments,
  activeView,
  onViewChange,
}: {
  projectId: number;
  projectCurrency: string;
  financials: WorkspaceFinancials | undefined;
  financialsPending: boolean;
  expenses: ExpenseListItem[];
  payments: PaymentListItem[];
  activeView: ProjectFinanceView;
  onViewChange: (view: ProjectFinanceView) => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const navigate = useNavigate();
  const [certificateStatus, setCertificateStatus] = useState<
    CertificateStatus | ""
  >("");
  const [paymentKind, setPaymentKind] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("");

  const states = [
    ...(financials?.contractStates.values() ?? []),
  ].filter((state) => state.contract.projectId === projectId);
  const certificates = states.flatMap((state) =>
    state.certificates.map((certificate) => ({
      ...certificate,
      contractNumber: state.contract.number,
    })),
  );
  const visibleCertificates = certificates.filter(
    (row) =>
      !certificateStatus || row.certificate.status === certificateStatus,
  );
  const visiblePayments = payments.filter(
    (payment) => !paymentKind || payment.kind === paymentKind,
  );
  const categories = Array.from(
    new Map(
      expenses.map((expense) => [
        String(expense.categoryId),
        i18n.language === "ar" ? expense.categoryAr : expense.categoryEn,
      ]),
    ),
  );
  const visibleExpenses = expenses.filter(
    (expense) =>
      !expenseCategory || String(expense.categoryId) === expenseCategory,
  );
  const receivables = certificates.filter(
    (row) =>
      row.certificate.status !== "DRAFT" && row.unpaidMinor > 0,
  );

  const certificateColumns: Column<(typeof certificates)[number]>[] = [
    {
      key: "number",
      header: t("certificates.number"),
      value: (row) => row.certificate.number,
      render: (row) => (
        <span className="font-medium tnum">{row.certificate.number}</span>
      ),
    },
    {
      key: "contract",
      header: t("certificates.contract"),
      value: (row) => row.contractNumber,
      render: (row) => <span className="tnum">{row.contractNumber}</span>,
    },
    {
      key: "date",
      header: t("common.date"),
      value: (row) => row.certificate.date,
      render: (row) => fmt.date(row.certificate.date),
    },
    {
      key: "gross",
      header: t("certificates.gross"),
      value: (row) => row.breakdown.grossMinor,
      render: (row) =>
        fmt.money(
          row.breakdown.grossMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "net",
      header: t("certificates.netPayable"),
      value: (row) => row.breakdown.netPayableMinor,
      render: (row) =>
        fmt.money(
          row.breakdown.netPayableMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "paid",
      header: t("certificates.paid"),
      value: (row) => row.paidMinor,
      render: (row) =>
        fmt.money(
          row.paidMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "status",
      header: t("common.status"),
      value: (row) => row.certificate.status,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <Badge
            value={row.certificate.status}
            label={t(`status.${row.certificate.status}`)}
          />
          {row.overdue && (
            <Badge
              value="OVERDUE"
              label={t("certificates.overdue")}
            />
          )}
        </div>
      ),
    },
  ];

  const paymentColumns: Column<PaymentListItem>[] = [
    {
      key: "number",
      header: t("payments.number"),
      value: (payment) => payment.number,
      render: (payment) => (
        <span className="font-medium tnum">{payment.number}</span>
      ),
    },
    {
      key: "date",
      header: t("common.date"),
      value: (payment) => payment.date,
      render: (payment) => fmt.date(payment.date),
    },
    {
      key: "contract",
      header: t("certificates.contract"),
      value: (payment) => payment.contractNumber,
      render: (payment) => (
        <span className="tnum">{payment.contractNumber}</span>
      ),
    },
    {
      key: "kind",
      header: t("payments.kind"),
      value: (payment) => payment.kind,
      render: (payment) => t(`paymentKind.${payment.kind}`),
    },
    {
      key: "method",
      header: t("payments.method"),
      value: (payment) => payment.method,
      render: (payment) => t(`method.${payment.method}`),
    },
    {
      key: "amount",
      header: t("common.amount"),
      value: (payment) =>
        financials?.cashIn.find((item) => item.paymentId === payment.id)
          ?.egpMinor ?? 0,
      // Never print a zero the read model did not produce: until the audited
      // snapshot resolves, the consolidated amount is unknown, not nil.
      render: (payment) =>
        readModelAmount(
          financials?.cashIn.find((item) => item.paymentId === payment.id),
          (cash) => base.format(cash.egpMinor),
        ),
      align: "end",
    },
  ];

  const expenseColumns: Column<ExpenseListItem>[] = [
    {
      key: "number",
      header: t("expenses.number"),
      value: (expense) => expense.number,
      render: (expense) => (
        <span className="font-medium tnum">{expense.number}</span>
      ),
    },
    {
      key: "date",
      header: t("common.date"),
      value: (expense) => expense.date,
      render: (expense) => fmt.date(expense.date),
    },
    {
      key: "category",
      header: t("expenses.category"),
      value: (expense) =>
        i18n.language === "ar" ? expense.categoryAr : expense.categoryEn,
    },
    {
      key: "description",
      header: t("common.description"),
      value: (expense) => expense.description,
    },
    {
      key: "supplier",
      header: t("expenses.supplier"),
      value: (expense) => expense.supplier,
    },
    {
      key: "amount",
      header: t("common.amount"),
      value: (expense) => expense.amountMinor,
      render: (expense) =>
        fmt.money(expense.amountMinor, expense.currency),
      align: "end",
    },
  ];

  const receivableColumns: Column<(typeof receivables)[number]>[] = [
    {
      key: "number",
      header: t("certificates.number"),
      value: (row) => row.certificate.number,
      render: (row) => (
        <span className="font-medium tnum">{row.certificate.number}</span>
      ),
    },
    {
      key: "contract",
      header: t("certificates.contract"),
      value: (row) => row.contractNumber,
      render: (row) => <span className="tnum">{row.contractNumber}</span>,
    },
    {
      key: "due",
      header: t("certificates.dueDate"),
      value: (row) => row.dueDate,
      render: (row) => fmt.date(row.dueDate),
    },
    {
      key: "net",
      header: t("certificates.netPayable"),
      value: (row) => row.breakdown.netPayableMinor,
      render: (row) =>
        fmt.money(
          row.breakdown.netPayableMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "unpaid",
      header: t("certificates.unpaid"),
      value: (row) => row.unpaidMinor,
      render: (row) =>
        fmt.money(
          row.unpaidMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "status",
      header: t("common.status"),
      value: (row) => (row.overdue ? "OVERDUE" : row.certificate.status),
      render: (row) => (
        <Badge
          value={row.overdue ? "OVERDUE" : row.certificate.status}
          label={
            row.overdue
              ? t("certificates.overdue")
              : t(`status.${row.certificate.status}`)
          }
        />
      ),
    },
  ];

  const destination = {
    certificates: "/finance/certificates",
    payments: "/finance/payments",
    expenses: "/finance/expenses",
    receivables: "/finance/receivables",
  }[activeView];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex rounded-[var(--radius-control)] bg-surface-subtle p-1"
          role="tablist"
          aria-label={t("projects.financeSections")}
        >
          {PROJECT_FINANCE_VIEWS.map((view) => (
            <button
              key={view}
              role="tab"
              aria-selected={activeView === view}
              className={cx(
                "rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-xs font-medium",
                activeView === view
                  ? "bg-surface text-foreground shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
              onClick={() => onViewChange(view)}
            >
              {t(`projects.financeViews.${view}`)}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          onClick={() =>
            navigate(
              `${destination}${destination.includes("?") ? "&" : "?"}projectId=${projectId}`,
            )
          }
        >
          <Plus size={15} aria-hidden="true" />
          {t(`projects.financeActions.${activeView}`)}
        </Button>
      </div>

      {activeView === "certificates" && (
        <DataTable
          rows={visibleCertificates}
          columns={certificateColumns}
          rowKey={(row) => row.certificate.id}
          density="compact"
          loading={financialsPending}
          onRowClick={() => navigate("/finance/certificates")}
          toolbar={
            <Select
              className="!w-44"
              value={certificateStatus}
              onChange={(event) =>
                setCertificateStatus(
                  event.target.value as CertificateStatus | "",
                )
              }
            >
              <option value="">
                {t("common.status")}: {t("common.all")}
              </option>
              {(["DRAFT", "SUBMITTED", "APPROVED", "PAID"] as const).map(
                (status) => (
                  <option key={status} value={status}>
                    {t(`status.${status}`)}
                  </option>
                ),
              )}
            </Select>
          }
          emptyMessage={t("projects.emptyCertificates")}
        />
      )}

      {activeView === "payments" && (
        <DataTable
          rows={visiblePayments}
          columns={paymentColumns}
          rowKey={(payment) => payment.id}
          density="compact"
          onRowClick={() => navigate("/finance/payments")}
          toolbar={
            <Select
              className="!w-44"
              value={paymentKind}
              onChange={(event) => setPaymentKind(event.target.value)}
            >
              <option value="">
                {t("payments.kind")}: {t("common.all")}
              </option>
              {(["CERTIFICATE", "ADVANCE", "RETENTION_RELEASE"] as const).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {t(`paymentKind.${kind}`)}
                  </option>
                ),
              )}
            </Select>
          }
          emptyMessage={t("projects.emptyPayments")}
        />
      )}

      {activeView === "expenses" && (
        <DataTable
          rows={visibleExpenses}
          columns={expenseColumns}
          rowKey={(expense) => expense.id}
          density="compact"
          onRowClick={() => navigate("/finance/expenses")}
          toolbar={
            <Select
              className="!w-48"
              value={expenseCategory}
              onChange={(event) => setExpenseCategory(event.target.value)}
            >
              <option value="">
                {t("expenses.category")}: {t("common.all")}
              </option>
              {categories.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          }
          emptyMessage={t("projects.emptyExpenses")}
        />
      )}

      {activeView === "receivables" && (
        <DataTable
          rows={receivables}
          columns={receivableColumns}
          rowKey={(row) => row.certificate.id}
          density="compact"
          loading={financialsPending}
          onRowClick={() => navigate(`/finance/receivables?projectId=${projectId}`)}
          emptyMessage={t("projects.emptyReceivables")}
        />
      )}
    </section>
  );
}

