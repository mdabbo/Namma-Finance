import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, Image as ImageIcon, Smartphone, X } from "lucide-react";
import {
  downloadClaimReceipt,
  useExpenseClaimMutations,
  useExpenseClaims,
  type ExpenseClaim,
} from "../../repositories/expenseClaims";
import { useCategories } from "../../repositories/expenses";
import { useProjects } from "../../repositories/projects";
import { useCurrencyRates } from "../../repositories/currencies";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Alert, Badge, Button, Card, EmptyState, Field, LoadingState, Modal, PageHeader, Select } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { claimRate, formatRateMicro } from "./claimRate";

/**
 * Expense claims filed on the phone (plan step F6). The office accepts a
 * claim -- which creates a numbered expense from the claim's own figures -- or
 * rejects it with a reason. Nothing a claim says can be edited here: what the
 * phone filed is what is decided.
 */
export function ExpenseClaimsPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: claims = [], isLoading } = useExpenseClaims();
  const [accepting, setAccepting] = useState<ExpenseClaim | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseClaim | null>(null);
  const [viewing, setViewing] = useState<ExpenseClaim | null>(null);
  const mutations = useExpenseClaimMutations();

  const pending = claims.filter((c) => c.decision === null);
  const decided = claims.filter((c) => c.decision !== null);

  return (
    <div>
      <PageHeader title={t("claims.title")} description={t("claims.description")} />

      {isLoading ? (
        <LoadingState label={t("common.loading")} />
      ) : claims.length === 0 ? (
        <EmptyState icon={Smartphone} title={t("claims.emptyTitle")} description={t("claims.emptyHint")} />
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="claims-pending">
            <h2 id="claims-pending" className="mb-2 text-sm font-semibold">
              {t("claims.pending")} <span className="text-muted">({pending.length})</span>
            </h2>
            {pending.length === 0 ? (
              <p className="text-sm text-muted">{t("claims.nonePending")}</p>
            ) : (
              <div className="space-y-2">
                {pending.map((claim) => (
                  <ClaimCard key={claim.id} claim={claim} onView={() => setViewing(claim)}>
                    <Button variant="primary" onClick={() => setAccepting(claim)}>
                      <Check size={15} aria-hidden="true" /> {t("claims.accept")}
                    </Button>
                    <Button className="!text-red-600" onClick={() => setRejecting(claim)}>
                      <X size={15} aria-hidden="true" /> {t("claims.reject")}
                    </Button>
                  </ClaimCard>
                ))}
              </div>
            )}
          </section>

          {decided.length > 0 && (
            <section aria-labelledby="claims-decided">
              <h2 id="claims-decided" className="mb-2 text-sm font-semibold">{t("claims.decided")}</h2>
              <div className="space-y-2">
                {decided.map((claim) => (
                  <ClaimCard key={claim.id} claim={claim} onView={() => setViewing(claim)}>
                    {claim.decision === "ACCEPTED" ? (
                      <Badge tone="success" label={claim.expenseNumber ? t("claims.acceptedAs", { number: claim.expenseNumber }) : t("claims.accepted")} />
                    ) : (
                      <Badge tone="danger" label={t("claims.rejected")} />
                    )}
                    {claim.decidedAt && <span className="text-xs text-muted tnum">{fmt.date(claim.decidedAt.slice(0, 10))}</span>}
                  </ClaimCard>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {accepting && (
        <AcceptClaimDialog
          claim={accepting}
          busy={mutations.accept.isPending}
          error={mutations.accept.error ? claimError(t, mutations.accept.error) : undefined}
          onCancel={() => {
            mutations.accept.reset();
            setAccepting(null);
          }}
          onAccept={(input) => mutations.accept.mutate(input, { onSuccess: () => setAccepting(null) })}
        />
      )}

      {rejecting && (
        <ConfirmDialog
          title={t("claims.rejectTitle")}
          message={t("claims.rejectMessage", { description: rejecting.description, person: rejecting.personName })}
          confirmLabel={t("claims.reject")}
          requireReason
          reasonLabel={t("claims.rejectReason")}
          busy={mutations.reject.isPending}
          error={mutations.reject.error ? claimError(t, mutations.reject.error) : undefined}
          onCancel={() => {
            mutations.reject.reset();
            setRejecting(null);
          }}
          onConfirm={(reason) =>
            mutations.reject.mutate({ claimId: rejecting.id, reason: reason ?? "" }, { onSuccess: () => setRejecting(null) })}
        />
      )}

      {viewing && <ReceiptDialog claim={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function claimError(t: TFunction, error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return t(`claims.errors.${code}`, { defaultValue: code });
}

function ClaimCard({ claim, onView, children }: { claim: ExpenseClaim; onView: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium">{claim.description}</span>
          <span className="font-semibold tnum">{fmt.money(claim.amountMinor, claim.currency)}</span>
        </div>
        <div className="mt-1 text-xs text-muted">
          {[claim.personName, fmt.date(claim.date), claim.projectCode ? `${claim.projectCode} · ${claim.projectName ?? ""}` : t("common.overhead"), claim.supplier]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {claim.decision === "REJECTED" && claim.decisionReason && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">{t("claims.reasonLabel")}: {claim.decisionReason}</div>
        )}
      </div>
      {claim.receiptStorageKey ? (
        <Button variant="ghost" onClick={onView}>
          <ImageIcon size={15} aria-hidden="true" /> {t("claims.viewReceipt")}
        </Button>
      ) : (
        <span className="text-xs text-muted">{t("claims.noReceipt")}</span>
      )}
      <div className="flex items-center gap-2">{children}</div>
    </Card>
  );
}

function AcceptClaimDialog({
  claim,
  busy,
  error,
  onCancel,
  onAccept,
}: {
  claim: ExpenseClaim;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onAccept: (input: { claimId: number; categoryId: number; projectId: number | null; fxRateMicro: number }) => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const { data: categories = [] } = useCategories();
  const { data: projects = [] } = useProjects();
  const { data: rates = [] } = useCurrencyRates();
  const [categoryId, setCategoryId] = useState(claim.categoryId ?? 0);
  const [projectId, setProjectId] = useState<number | null>(claim.projectId);
  const liveProjects = projects.filter((p) => !p.archivedAt);
  const rate = claimRate(claim.currency, projects.find((p) => p.id === projectId) ?? null, rates);

  return (
    <Modal title={t("claims.acceptTitle")} onClose={onCancel}>
      <p className="mb-4 text-sm">
        {t("claims.acceptMessage", { amount: fmt.money(claim.amountMinor, claim.currency), person: claim.personName, description: claim.description })}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("expenses.category")} error={categoryId ? undefined : t("claims.categoryRequired")}>
          <Select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
            <option value={0}>—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{i18n.language === "ar" ? c.nameAr : c.nameEn}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("expenses.project")}>
          <Select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">{t("common.overhead")}</option>
            {liveProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </Select>
        </Field>
        {claim.currency !== "EGP" && (
          <Field label={t("claims.rate", { currency: claim.currency })} className="col-span-2" hint={rate ? t(`claims.rateFrom.${rate.source}`) : undefined}>
            <div className="text-sm font-medium tnum" dir="ltr">{rate ? formatRateMicro(rate.fxRateMicro) : "—"}</div>
          </Field>
        )}
      </div>
      {claim.currency !== "EGP" && !rate && (
        <Alert tone="warning" className="mt-3">{t("claims.rateMissing", { currency: claim.currency })}</Alert>
      )}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <p className="mt-3 text-xs text-muted">{t("claims.acceptHint")}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={busy || !categoryId || !rate}
          onClick={() => rate && onAccept({ claimId: claim.id, categoryId, projectId, fxRateMicro: rate.fxRateMicro })}
        >
          {t("claims.accept")}
        </Button>
      </div>
    </Modal>
  );
}

function ReceiptDialog({ claim, onClose }: { claim: ExpenseClaim; onClose: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    downloadClaimReceipt(claim)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e: unknown) => !cancelled && setError(claimError(t, e)));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [claim, t]);
  return (
    <Modal title={t("claims.receipt")} onClose={onClose} wide>
      {error ? (
        <Alert tone="danger">{error}</Alert>
      ) : url ? (
        <img src={url} alt={t("claims.receiptAlt", { description: claim.description })} className="mx-auto max-h-[70vh] rounded-lg" />
      ) : (
        <LoadingState label={t("common.loading")} />
      )}
    </Modal>
  );
}
