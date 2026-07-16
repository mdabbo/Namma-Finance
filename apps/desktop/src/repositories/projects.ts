import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectInput } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";

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
  client_name?: string;
}

export function mapProject(r: ProjectRow): Project & { clientName: string } {
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
  };
}

const LIST_SQL = `SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id`;

export async function listProjects() {
  const rows = await select<ProjectRow>(`${LIST_SQL} ORDER BY p.created_at DESC, p.id DESC`);
  return rows.map(mapProject);
}

export async function listProjectsByClient(clientId: number) {
  const rows = await select<ProjectRow>(`${LIST_SQL} WHERE p.client_id = $1 ORDER BY p.created_at DESC`, [clientId]);
  return rows.map(mapProject);
}

export async function getProject(id: number) {
  const row = await selectOne<ProjectRow>(`${LIST_SQL} WHERE p.id = $1`, [id]);
  return row ? mapProject(row) : null;
}

/** Next code in the confirmed PRJ-YYYY-NNN format, resetting each year. */
export async function nextProjectCode(prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const row = await selectOne<{ max_seq: number | null }>(
    `SELECT MAX(CAST(substr(code, length($1) + 7) AS INTEGER)) AS max_seq
     FROM projects WHERE code LIKE $2`,
    [prefix, like],
  );
  const next = (row?.max_seq ?? 0) + 1;
  return `${prefix}-${year}-${String(next).padStart(3, "0")}`;
}

export async function createProject(code: string, input: ProjectInput): Promise<number> {
  const r = await execute(
    `INSERT INTO projects (code, name, client_id, country, city, manager, discipline, project_type,
        status, currency, fx_rate_micro, start_date, end_date, progress_bp, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [code, input.name, input.clientId, input.country ?? null, input.city ?? null, input.manager ?? null,
     input.discipline, input.projectType ?? null, input.status, input.currency, input.fxRateMicro,
     input.startDate ?? null, input.endDate ?? null, input.progressBp, input.description ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateProject(id: number, input: ProjectInput): Promise<void> {
  await execute(
    `UPDATE projects SET name=$1, client_id=$2, country=$3, city=$4, manager=$5, discipline=$6,
        project_type=$7, status=$8, currency=$9, fx_rate_micro=$10, start_date=$11, end_date=$12,
        progress_bp=$13, description=$14
     WHERE id=$15`,
    [input.name, input.clientId, input.country ?? null, input.city ?? null, input.manager ?? null,
     input.discipline, input.projectType ?? null, input.status, input.currency, input.fxRateMicro,
     input.startDate ?? null, input.endDate ?? null, input.progressBp, input.description ?? null, id],
  );
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
  await execute("DELETE FROM projects WHERE id = $1", [id]);
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: listProjects });
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
      mutationFn: (v: { id: number; input: ProjectInput }) => updateProject(v.id, v.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteProject, onSuccess: invalidate }),
  };
}
