import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectInput } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import type { RevisionMetadata } from "./contracts";

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  client_id: number;
  country: string | null;
  city: string | null;
  manager: string | null;
  discipline: Project["discipline"];
  project_type: string | null;
  status: Project["status"];
  currency: string;
  fx_rate_micro: number;
  start_date: string | null;
  end_date: string | null;
  progress_bp: number;
  description: string | null;
  created_at: string;
  archived_at: string | null;
  client_name?: string;
}

export type ProjectListItem = Project & { clientName: string; archivedAt: string | null };

export function mapProject(r: ProjectRow): ProjectListItem {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    clientId: r.client_id,
    country: r.country,
    city: r.city,
    manager: r.manager,
    discipline: r.discipline,
    projectType: r.project_type,
    status: r.status,
    currency: r.currency,
    fxRateMicro: r.fx_rate_micro,
    startDate: r.start_date,
    endDate: r.end_date,
    progressBp: r.progress_bp,
    description: r.description,
    createdAt: r.created_at,
    clientName: r.client_name ?? "",
    archivedAt: r.archived_at,
  };
}

const LIST_SQL = `SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id`;

export async function listProjects(includeArchived = false) {
  const rows = await select<ProjectRow>(`${LIST_SQL} ${includeArchived ? "" : "WHERE p.archived_at IS NULL"} ORDER BY p.created_at DESC, p.id DESC`);
  return rows.map(mapProject);
}

export async function listProjectsByClient(clientId: number) {
  const rows = await select<ProjectRow>(`${LIST_SQL} WHERE p.client_id = $1 AND p.archived_at IS NULL ORDER BY p.created_at DESC`, [clientId]);
  return rows.map(mapProject);
}

export async function getProject(id: number) {
  const row = await selectOne<ProjectRow>(`${LIST_SQL} WHERE p.id=$1 AND p.archived_at IS NULL`, [id]);
  return row ? mapProject(row) : null;
}

/** Next code in the confirmed PRJ-YYYY-NNN format, resetting each year. */
export async function nextProjectCode(prefix: string): Promise<string> {
  const { reserveNextNumber } = await import("./numbering");
  return reserveNextNumber("PROJECT", prefix);
}

export async function createProject(code: string, input: ProjectInput): Promise<number> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return invoke<number>("create_project_atomic", { requestedCode: code, input });
  }
  await execute("BEGIN IMMEDIATE");
  try {
  const r = await execute(
    `INSERT INTO projects (code, name, client_id, country, city, manager, discipline, project_type,
        status, currency, fx_rate_micro, start_date, end_date, progress_bp, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [code, input.name, input.clientId, input.country ?? null, input.city ?? null, input.manager ?? null,
     input.discipline, input.projectType ?? null, input.status, input.currency, input.fxRateMicro,
     input.startDate ?? null, input.endDate ?? null, input.progressBp, input.description ?? null],
  );
    await execute("COMMIT");
    return r.lastInsertId ?? 0;
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}

export async function updateProject(id: number, input: ProjectInput, revision?: RevisionMetadata): Promise<void> {
  const current = await selectOne<{ currency: string; fxRateMicro: number }>(
    "SELECT currency,fx_rate_micro AS fxRateMicro FROM projects WHERE id=$1 AND archived_at IS NULL", [id],
  );
  if (!current) throw new Error("PROJECT_NOT_FOUND");
  const currencyChanged = current.currency !== input.currency || current.fxRateMicro !== input.fxRateMicro;
  if (currencyChanged && (!revision?.effectiveDate || !revision.reason.trim())) throw new Error("CONTRACT_REVISION_REQUIRED");
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke("update_project_atomic", { projectId: id, input, revision: revision ?? null });
    return;
  }
  await execute("BEGIN IMMEDIATE");
  try {
    await execute(
    `UPDATE projects SET name=$1, client_id=$2, country=$3, city=$4, manager=$5, discipline=$6,
        project_type=$7, status=$8, currency=$9, fx_rate_micro=$10, start_date=$11, end_date=$12,
        progress_bp=$13, description=$14
     WHERE id=$15 AND archived_at IS NULL`,
    [input.name, input.clientId, input.country ?? null, input.city ?? null, input.manager ?? null,
     input.discipline, input.projectType ?? null, input.status, input.currency, input.fxRateMicro,
     input.startDate ?? null, input.endDate ?? null, input.progressBp, input.description ?? null, id],
    );
    if (currencyChanged) {
      const contracts = await select<{ id: number }>("SELECT id FROM contracts WHERE project_id=$1 AND archived_at IS NULL", [id]);
      for (const contract of contracts) {
        await execute(
          `INSERT INTO contract_revisions (
             contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,
             withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,
             fx_rate_micro,reason,approved_at)
           SELECT c.id,COALESCE(MAX(r.revision_number),0)+1,$1,c.value_minor,c.vat_bp,c.retention_bp,
             c.withholding_bp,c.advance_minor,c.advance_recovery_method,c.payment_terms_days,$2,$3,$4,datetime('now')
           FROM contracts c LEFT JOIN contract_revisions r ON r.contract_id=c.id
           WHERE c.id=$5 GROUP BY c.id`,
          [revision!.effectiveDate, input.currency, input.fxRateMicro, revision!.reason.trim(), contract.id],
        );
      }
    }
    await execute("COMMIT");
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}

export async function projectCascadeInfo(id: number) {
  const row = await selectOne<{ contracts: number; certificates: number; payments: number; expenses: number }>(
    `SELECT
       (SELECT COUNT(*) FROM contracts WHERE project_id=$1) AS contracts,
       (SELECT COUNT(*) FROM payment_certificates WHERE contract_id IN (SELECT id FROM contracts WHERE project_id=$1)) AS certificates,
       (SELECT COUNT(*) FROM payments WHERE contract_id IN (SELECT id FROM contracts WHERE project_id=$1)) AS payments,
       (SELECT COUNT(*) FROM expenses WHERE project_id=$1) AS expenses`,
    [id],
  );
  return row ?? { contracts: 0, certificates: 0, payments: 0, expenses: 0 };
}

export async function deleteProject(id: number): Promise<void> {
  const result = await execute("UPDATE projects SET archived_at=datetime('now'), archive_reason='Archived by user' WHERE id=$1 AND archived_at IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("PROJECT_NOT_FOUND_OR_ARCHIVED");
}

export function useProjects(includeArchived = false) {
  return useQuery({ queryKey: ["projects", includeArchived], queryFn: () => listProjects(includeArchived) });
}
export function useProjectsByClient(clientId: number) {
  return useQuery({ queryKey: ["projects", "client", clientId], queryFn: () => listProjectsByClient(clientId) });
}
export function useProject(id: number) {
  return useQuery({ queryKey: ["projects", id], queryFn: () => getProject(id) });
}

export function useProjectMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["clients"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({
      mutationFn: (v: { code: string; input: ProjectInput }) => createProject(v.code, v.input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { id: number; input: ProjectInput; revision?: RevisionMetadata }) => updateProject(v.id, v.input, v.revision),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteProject, onSuccess: invalidate }),
  };
}
