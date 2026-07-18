import type { CertificateStatus } from "../domain/types";
import { allocate, assertMinor, ratioBp } from "../money/money";
import type { ContractState } from "./contract";
import { milestoneAmounts, parseMilestones } from "./valuation";

/**
 * Team payout schedule (confirmed rule): every person assigned to a project
 * follows the SAME payment stages as the project's contract. The agreed fee is
 * split across the stages by the same value shares, and a stage becomes
 * payable to the person the moment its certificate is PAID by the client.
 *
 * Everything here is derived — nothing is copied onto the assignment, so the
 * schedule always mirrors the contract even after milestones are edited.
 *
 *  - MILESTONES contracts: stages = the contract milestones; each one is
 *    released when the certificate it generated (milestone.certificateId)
 *    is PAID.
 *  - LUMP_SUM / DRAWINGS contracts: stages = the contract's certificates
 *    (each certificate is a payment stage), released when PAID; contract
 *    value not yet certified appears as a single PENDING remainder stage.
 *
 * Person payments cover released stages in schedule order (FIFO), mirroring
 * how client payments are allocated to certificates.
 */

export type TeamStageKind = "MILESTONE" | "CERTIFICATE" | "REMAINDER";

export type TeamStageStatus =
  | "PENDING" // stage not certified / certificate not paid yet, nothing to do
  | "AWAITING_COLLECTION" // certificate exists but the client has not paid it
  | "PAYABLE" // client paid — the person is owed this stage now
  | "PAID_OUT"; // fully covered by person payments

export interface TeamStage {
  kind: TeamStageKind;
  /** Milestone title / certificate description or number. Empty for REMAINDER. */
  title: string;
  contractNumber: string;
  /** Stage weight in contract value minor units (drives the fee split). */
  weightMinor: number;
  /** The person's share of this stage (exact largest-remainder allocation). */
  amountMinor: number;
  certificateStatus: CertificateStatus | null;
  released: boolean;
  paidOutMinor: number;
  status: TeamStageStatus;
}

export interface TeamPayoutState {
  stages: TeamStage[];
  /** Σ stage amounts whose certificate is PAID. */
  releasedMinor: number;
  /** Σ person payments on the assignment. */
  paidOutMinor: number;
  /** released − paid, floored at 0 — what should be paid to the person NOW. */
  dueMinor: number;
  dueRatioBp: number;
  /** Titles of the released stages not fully paid out (for notifications). */
  dueTitles: string[];
}

interface StageDraft {
  kind: TeamStageKind;
  title: string;
  contractNumber: string;
  weightMinor: number;
  certificateStatus: CertificateStatus | null;
}

/**
 * Derive the payout schedule of one assignment from the financial state of
 * the project's contracts.
 */
export function computeTeamPayout(
  agreedMinor: number,
  contractStates: ContractState[],
  personPaidMinor: number,
): TeamPayoutState {
  assertMinor(agreedMinor, "agreedMinor");
  assertMinor(personPaidMinor, "personPaidMinor");

  const drafts: StageDraft[] = [];
  const states = [...contractStates].sort((a, b) => a.contract.id - b.contract.id);

  for (const state of states) {
    const contract = state.contract;
    const statusById = new Map<number, CertificateStatus>();
    for (const cs of state.certificates) statusById.set(cs.certificate.id, cs.certificate.status);

    const milestones = contract.valuationMode === "MILESTONES" ? parseMilestones(contract.milestones) : [];
    if (milestones.length > 0) {
      const weights = milestoneAmounts(contract.valueMinor, milestones);
      milestones.forEach((m, i) => {
        drafts.push({
          kind: "MILESTONE",
          title: m.title,
          contractNumber: contract.number,
          weightMinor: weights[i] ?? 0,
          certificateStatus: m.certificateId != null ? (statusById.get(m.certificateId) ?? null) : null,
        });
      });
    } else {
      let scheduled = 0;
      for (const cs of state.certificates) {
        drafts.push({
          kind: "CERTIFICATE",
          title: cs.certificate.description || cs.certificate.number,
          contractNumber: contract.number,
          weightMinor: cs.breakdown.baseMinor,
          certificateStatus: cs.certificate.status,
        });
        scheduled += cs.breakdown.baseMinor;
      }
      if (contract.valueMinor > scheduled) {
        drafts.push({
          kind: "REMAINDER",
          title: "",
          contractNumber: contract.number,
          weightMinor: contract.valueMinor - scheduled,
          certificateStatus: null,
        });
      }
    }
  }

  const amounts = allocate(agreedMinor, drafts.map((d) => d.weightMinor));

  let releasedMinor = 0;
  let cover = personPaidMinor;
  const dueTitles: string[] = [];
  const stages: TeamStage[] = drafts.map((draft, i) => {
    const amountMinor = amounts[i] ?? 0;
    const released = draft.certificateStatus === "PAID";
    let paidOut = 0;
    if (released) {
      releasedMinor += amountMinor;
      paidOut = Math.min(amountMinor, cover);
      cover -= paidOut;
    }
    const status: TeamStageStatus = released
      ? paidOut >= amountMinor
        ? "PAID_OUT"
        : "PAYABLE"
      : draft.certificateStatus !== null
        ? "AWAITING_COLLECTION"
        : "PENDING";
    if (status === "PAYABLE" && amountMinor > 0) dueTitles.push(draft.title);
    return { ...draft, amountMinor, released, paidOutMinor: paidOut, status };
  });

  const dueMinor = Math.max(0, releasedMinor - personPaidMinor);
  return {
    stages,
    releasedMinor,
    paidOutMinor: personPaidMinor,
    dueMinor,
    dueRatioBp: ratioBp(dueMinor, agreedMinor),
    dueTitles,
  };
}
