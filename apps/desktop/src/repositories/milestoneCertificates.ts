import { isMilestoneAchieved, milestoneAmounts, parseMilestones } from "@mep/core";
import { invoke } from "@tauri-apps/api/core";
import { execute, select, selectOne } from "../lib/db";
import { todayIso } from "../lib/format";
import { withLock } from "../lib/mutex";

/**
 * Confirmed rule (feedback round 3): the moment a milestone becomes achieved
 * (its checkbox is ticked or its linked stage completes), a DRAFT payment
 * certificate is prepared automatically, waiting for the user's approval.
 *
 * Guard against over-billing: drafts are only created for the part of the
 * achieved value that is NOT already covered by billable certificates
 * (including manual ones) or by previously prepared drafts. Idempotent:
 * each milestone stores the id of the certificate it generated.
 *
 * Runs under the global reconcile lock: this is a read-modify-write of the
 * contract's milestone JSON, and concurrent invocations (mutation trigger +
 * concurrent contract/stage edits) would otherwise double-create certificates and wipe their
 * certificateId links.
 */
export function reconcileMilestoneCertificates(contractId?: number): Promise<number> {
  return withLock(() => reconcileImpl(contractId));
}

async function reconcileImpl(contractId?: number): Promise<number> {
  const { loadWorkspaceFinancials } = await import("./financials");
  const { nextCertificateSeq } = await import("./certificates");
  const { loadSettings } = await import("../lib/settings");
  const { reserveNextNumberWithinExistingLock } = await import("./numbering");
  const certificatePrefix = (await loadSettings()).certificateNumberPrefix;
  const ws = await loadWorkspaceFinancials();
  let created = 0;

  for (const state of ws.contractStates.values()) {
    const contract = state.contract;
    if (contract.valuationMode !== "MILESTONES") continue;
    if (contractId !== undefined && contract.id !== contractId) continue;
    const milestones = parseMilestones(contract.milestones);
    if (milestones.length === 0) continue;

    const completedRows = await select<{ id: number }>(
      "SELECT id FROM project_stages WHERE project_id = $1 AND status = 'COMPLETED'",
      [contract.projectId],
    );
    const completed = new Set(completedRows.map((r) => r.id));
    const amounts = milestoneAmounts(contract.valueMinor, milestones);

    // Value already covered: billable certificates + linked drafts that still exist.
    let covered = state.certifiedBaseMinor;
    const linkedIds = new Set(milestones.map((m) => m.certificateId).filter((id): id is number => !!id));
    for (const cs of state.certificates) {
      if (cs.certificate.status === "DRAFT" && linkedIds.has(cs.certificate.id)) {
        covered += cs.breakdown.baseMinor;
      }
    }

    const achieved = milestones.reduce(
      (sum, m, i) => (isMilestoneAchieved(m, completed) ? sum + (amounts[i] ?? 0) : sum),
      0,
    );
    let remaining = achieved - covered;
    const drafts: Array<{ milestoneIndex: number; number: string; date: string; description: string; grossMinor: number }> = [];

    for (let i = 0; i < milestones.length && remaining > 0; i++) {
      const milestone = milestones[i]!;
      const amount = Math.min(amounts[i] ?? 0, remaining);
      if (!isMilestoneAchieved(milestone, completed) || amount <= 0) continue;

      if (milestone.certificateId) {
        const existing = await selectOne<{ id: number }>("SELECT id FROM payment_certificates WHERE id=$1 AND deleted_at IS NULL", [milestone.certificateId]);
        if (existing) continue;
      }

      const date = todayIso();
      const number = await reserveNextNumberWithinExistingLock("CERTIFICATE", certificatePrefix, new Date(`${date}T00:00:00Z`));
      drafts.push({ milestoneIndex: i, number, date, description: milestone.title, grossMinor: amount });
      remaining -= amount;
    }

    if (drafts.length === 0) continue;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      created += await invoke<number>("create_milestone_certificates_atomic", {
        contractId: contract.id,
        drafts,
      });
    } else {
      await execute("BEGIN IMMEDIATE");
      try {
        for (const draft of drafts) {
          const duplicate = await selectOne<{ id: number }>(
            "SELECT id FROM payment_certificates WHERE contract_id=$1 AND number=$2 AND deleted_at IS NULL",
            [contract.id, draft.number],
          );
          let certificateId = duplicate?.id;
          if (!certificateId) {
            const seq = await nextCertificateSeq(contract.id);
            const result = await execute(
              `INSERT INTO payment_certificates (contract_id,seq,number,date,description,gross_minor,discount_minor,status)
               VALUES ($1,$2,$3,$4,$5,$6,0,'DRAFT')`,
              [contract.id, seq, draft.number, draft.date, draft.description, draft.grossMinor],
            );
            certificateId = result.lastInsertId ?? 0;
            created += 1;
          }
          milestones[draft.milestoneIndex]!.certificateId = certificateId;
        }
        await execute("UPDATE contracts SET milestones=$1 WHERE id=$2", [JSON.stringify(milestones), contract.id]);
        await execute("COMMIT");
      } catch (error) {
        await execute("ROLLBACK");
        throw error;
      }
    }
  }
  return created;
}
