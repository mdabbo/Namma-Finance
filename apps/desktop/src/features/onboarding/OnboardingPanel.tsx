import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Banknote,
  BriefcaseBusiness,
  Building2,
  Check,
  FlaskConical,
  Hash,
  Landmark,
  Plus,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button, Card, EmptyState, RatioBar, cx } from "../../components/ui";
import { useUpdateSetting } from "../../lib/settings";
import { useDemoWorkspaceMutations } from "../../repositories/demo";
import {
  onboardingDestination,
  type OnboardingStatus,
  type OnboardingStepId,
} from "./onboardingModel";

const STEP_ICONS: Record<OnboardingStepId, LucideIcon> = {
  company: Building2,
  currency: Banknote,
  numbering: Hash,
  client: Users,
  project: BriefcaseBusiness,
  contract: Landmark,
};

/** Configuration steps the user can acknowledge without changing defaults. */
const ACKNOWLEDGEABLE: Partial<Record<OnboardingStepId, "onboardingCurrencyDone" | "onboardingNumberingDone">> = {
  currency: "onboardingCurrencyDone",
  numbering: "onboardingNumberingDone",
};

export function OnboardingPanel({
  status,
  firstProjectId,
  demoLoaded,
}: {
  status: OnboardingStatus;
  firstProjectId: number | null;
  demoLoaded: boolean;
}) {
  const { t } = useTranslation();
  const updateSetting = useUpdateSetting();
  const demo = useDemoWorkspaceMutations();
  const demoBusy = demo.create.isPending || demo.remove.isPending;

  return (
    <Card className="mx-auto mt-8 max-w-3xl overflow-hidden">
      <div className="border-b border-border-subtle bg-gradient-to-r from-brand-50 to-surface px-6 py-5 dark:bg-slate-900 dark:bg-none">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
          <BriefcaseBusiness size={20} aria-hidden="true" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{t("onboarding.title")}</h2>
        <p className="mt-1 max-w-xl text-sm leading-6 text-muted">{t("onboarding.description")}</p>
        <div className="mt-4 flex items-center gap-3">
          <RatioBar
            ratioBp={(status.completedCount * 10_000) / status.steps.length}
            className="max-w-xs"
          />
          <span className="text-xs text-muted tnum">
            {t("dashboard.setup.progress", {
              completed: status.completedCount,
              total: status.steps.length,
            })}
          </span>
        </div>
      </div>

      <div className="grid gap-px bg-border-subtle sm:grid-cols-2">
        {status.steps.map(({ id, complete }, index) => {
          const Icon = STEP_ICONS[id];
          const isNext = id === status.nextStep;
          const acknowledgeKey = ACKNOWLEDGEABLE[id];
          return (
            <div key={id} className="flex min-h-24 items-center gap-3 bg-surface px-5 py-4">
              <div
                className={cx(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                  complete
                    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300"
                    : isNext
                      ? "bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300"
                      : "bg-surface-subtle text-slate-400",
                )}
              >
                {complete ? <Check size={17} aria-hidden="true" /> : <Icon size={17} aria-hidden="true" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted tnum">
                  {t("dashboard.setup.step", { number: index + 1 })}
                </p>
                <p className="truncate text-sm font-medium">{t(`onboarding.steps.${id}`)}</p>
              </div>
              {isNext && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {acknowledgeKey && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updateSetting.isPending}
                      onClick={() => updateSetting.mutate({ key: acknowledgeKey, value: true })}
                    >
                      {t("onboarding.markDone")}
                    </Button>
                  )}
                  <Link
                    to={onboardingDestination(id, firstProjectId)}
                    className="inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] bg-brand-600 px-2.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700"
                  >
                    <Plus size={14} aria-hidden="true" />
                    {t("dashboard.setup.start")}
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-subtle/60 px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={updateSetting.isPending}
          onClick={() => updateSetting.mutate({ key: "onboardingSkipped", value: true })}
        >
          {t("onboarding.skip")}
        </Button>
        {demoLoaded ? (
          <Button
            variant="ghost"
            size="sm"
            className="!text-red-600"
            disabled={demoBusy}
            onClick={() => demo.remove.mutate()}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t("onboarding.removeDemo")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={demoBusy} onClick={() => demo.create.mutate()}>
            <FlaskConical size={14} aria-hidden="true" />
            {demo.create.isPending ? t("common.loading") : t("onboarding.loadDemo")}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * Shown instead of an all-zero dashboard when setup was skipped (or completed)
 * but the workspace still has no financial activity: one clear action, no
 * empty KPI grids or charts.
 */
export function OnboardingResumeCard({
  finished,
  demoLoaded,
}: {
  finished: boolean;
  demoLoaded: boolean;
}) {
  const { t } = useTranslation();
  const updateSetting = useUpdateSetting();
  const demo = useDemoWorkspaceMutations();
  if (finished) {
    return (
      <Card className="mx-auto mt-8 max-w-xl">
        <EmptyState
          icon={Check}
          title={t("onboarding.readyTitle")}
          description={t("onboarding.readyDescription")}
          action={
            <Link
              to="/finance/certificates"
              className="inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-control)] bg-brand-600 px-3 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
            >
              <Plus size={15} aria-hidden="true" />
              {t("dashboard.setup.certificate")}
            </Link>
          }
        />
      </Card>
    );
  }
  return (
    <Card className="mx-auto mt-8 max-w-xl">
      <EmptyState
        icon={BriefcaseBusiness}
        title={t("onboarding.skippedTitle")}
        description={t("onboarding.skippedDescription")}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={updateSetting.isPending}
              onClick={() => updateSetting.mutate({ key: "onboardingSkipped", value: false })}
            >
              {t("onboarding.resume")}
            </Button>
            {!demoLoaded && (
              <Button
                variant="ghost"
                disabled={demo.create.isPending}
                onClick={() => demo.create.mutate()}
              >
                <FlaskConical size={14} aria-hidden="true" />
                {t("onboarding.loadDemo")}
              </Button>
            )}
          </div>
        }
      />
    </Card>
  );
}
