import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectStage, StageInput, StageStatus } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";

interface StageRow {
  id: number;
  project_id: number;
  name: string;
  sort_order: number;
  start_date: string | null;
  end_date: string | null;
  status: StageStatus;
  completion_bp: number;
  engineers: string | null;
  notes: string | null;
  created_at: string;
}

function mapStage(r: StageRow): ProjectStage {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    sortOrder: r.sort_order,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    completionBp: r.completion_bp,
    engineers: r.engineers,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export async function listStagesByProject(projectId: number): Promise<ProjectStage[]> {
  const rows = await select<StageRow>(
    "SELECT * FROM project_stages WHERE project_id = $1 ORDER BY sort_order, id",
    [projectId],
  );
  return rows.map(mapStage);
}

export async function createStage(input: StageInput): Promise<number> {
  const r = await execute(
    `INSERT INTO project_stages (project_id, name, sort_order, start_date, end_date, status, completion_bp, engineers, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.projectId, input.name, input.sortOrder, input.startDate ?? null, input.endDate ?? null,
     input.status, input.completionBp, input.engineers ?? null, input.notes ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateStage(id: number, input: StageInput): Promise<void> {
  await execute(
    `UPDATE project_stages SET name=$1, sort_order=$2, start_date=$3, end_date=$4, status=$5,
        completion_bp=$6, engineers=$7, notes=$8
     WHERE id=$9`,
    [input.name, input.sortOrder, input.startDate ?? null, input.endDate ?? null, input.status,
     input.completionBp, input.engineers ?? null, input.notes ?? null, id],
  );
}

export async function deleteStage(id: number): Promise<void> {
  await execute("DELETE FROM project_stages WHERE id = $1", [id]);
}

/** Insert the standard template after the project's existing stages. */
export async function addTemplateStages(projectId: number, names: string[]): Promise<void> {
  const row = await selectOne<{ max_order: number | null }>(
    "SELECT MAX(sort_order) AS max_order FROM project_stages WHERE project_id = $1",
    [projectId],
  );
  let order = (row?.max_order ?? -1) + 1;
  for (const name of names) {
    await execute(
      "INSERT INTO project_stages (project_id, name, sort_order) VALUES ($1, $2, $3)",
      [projectId, name, order],
    );
    order += 1;
  }
}

export function useStagesByProject(projectId: number) {
  return useQuery({ queryKey: ["stages", projectId], queryFn: () => listStagesByProject(projectId) });
}

export function useStageMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["stages"] });
    // stage completion can achieve linked milestones → ready-to-collect changes
    void qc.invalidateQueries({ queryKey: ["financials"] });
    void qc.invalidateQueries({ queryKey: ["certificates"] });
  };
  // completing a stage can achieve linked milestones → prepare their draft certificates
  const reconcileProject = async (projectId: number) => {
    const { reconcileMilestoneCertificates } = await import("./milestoneCertificates");
    const { select: sel } = await import("../lib/db");
    const contracts = await sel<{ id: number }>(
      "SELECT id FROM contracts WHERE project_id = $1 AND valuation_mode = 'MILESTONES'",
      [projectId],
    );
    for (const c of contracts) await reconcileMilestoneCertificates(c.id);
  };
  return {
    create: useMutation({ mutationFn: createStage, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: async (v: { id: number; input: StageInput }) => {
        await updateStage(v.id, v.input);
        if (v.input.status === "COMPLETED") await reconcileProject(v.input.projectId);
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteStage, onSuccess: invalidate }),
    addTemplate: useMutation({
      mutationFn: (v: { projectId: number; names: string[] }) => addTemplateStages(v.projectId, v.names),
      onSuccess: invalidate,
    }),
  };
}
