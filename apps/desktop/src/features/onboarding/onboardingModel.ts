export const ONBOARDING_STEPS = [
  "company",
  "currency",
  "numbering",
  "client",
  "project",
  "contract",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingInputs {
  companyName: string;
  currencyConfirmed: boolean;
  numberingConfirmed: boolean;
  clientCount: number;
  projectCount: number;
  contractCount: number;
  skipped: boolean;
}

export interface OnboardingStatus {
  steps: { id: OnboardingStepId; complete: boolean }[];
  completedCount: number;
  nextStep: OnboardingStepId | null;
  finished: boolean;
  /** The guided panel is shown until the flow finishes or the user skips it. */
  showPanel: boolean;
  skipped: boolean;
}

/**
 * Progress is derived, never stored: configuration steps complete from saved
 * settings (or an explicit acknowledgment), data steps from real records. The
 * flow therefore survives restarts and un-completes if demo data is removed.
 */
export function onboardingStatus(input: OnboardingInputs): OnboardingStatus {
  const complete: Record<OnboardingStepId, boolean> = {
    company: input.companyName.trim().length > 0,
    currency: input.currencyConfirmed,
    numbering: input.numberingConfirmed,
    client: input.clientCount > 0,
    project: input.projectCount > 0,
    contract: input.contractCount > 0,
  };
  const steps = ONBOARDING_STEPS.map((id) => ({ id, complete: complete[id] }));
  const nextStep = steps.find((step) => !step.complete)?.id ?? null;
  const finished = nextStep === null;
  return {
    steps,
    completedCount: steps.filter((step) => step.complete).length,
    nextStep,
    finished,
    showPanel: !finished && !input.skipped,
    skipped: input.skipped,
  };
}

/** Where each step's primary action leads. Contract creation needs a project. */
export function onboardingDestination(
  step: OnboardingStepId,
  firstProjectId: number | null,
): string {
  switch (step) {
    case "company":
    case "currency":
    case "numbering":
      return "/settings";
    case "client":
      return "/projects/clients";
    case "project":
      return "/projects";
    case "contract":
      return firstProjectId === null ? "/projects" : `/projects/${firstProjectId}`;
  }
}
