import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Plus, Trash2 } from "lucide-react";
import { STANDARD_STAGE_KEYS, stageSchema, type ProjectStage, type StageInput, type StageStatus } from "@mep/core";
import { useStagesByProject, useStageMutations } from "../../repositories/stages";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea, cx } from "../../components/ui";
import { useFormat } from "../../lib/format";

const STAGE_BADGE: Record<StageStatus, string> = {
  PLANNED: "DRAFT",
  IN_PROGRESS: "SUBMITTED",
  COMPLETED: "PAID",
  ON_HOLD: "ON_HOLD",
};

export function StagesTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: stages = [] } = useStagesByProject(projectId);
  const mutations = useStageMutations();
  const [editing, setEditing] = useState<ProjectStage | "new" | null>(null);

  /** Timeline scale across all dated stages. */
  const range = useMemo(() => {
    const dates = stages.flatMap((s) => [s.startDate, s.endDate]).filter((d): d is string => !!d);
    if (dates.length < 2) return null;
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    if (min === max) return null;
    const toMs = (d: string) => new Date(d).getTime();
    return { min: toMs(min), span: toMs(max) - toMs(min), toMs };
  }, [stages]);

  return (
    <div>
      <div className="mb-3 flex justify-end gap-2">
        <Button onClick={() => mutations.addTemplate.mutate({ projectId, names: STANDARD_STAGE_KEYS.map((k) => t(`stages.template.${k}`)) })}>
          <LayoutTemplate size={15} /> {t("stages.addTemplate")}
        </Button>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={15} /> {t("stages.newStage")}
        </Button>
      </div>

      {stages.length === 0 ? (
        <EmptyState message={t("common.empty")} />
      ) : (
        <Card className="p-4">
          <div className="space-y-1.5">
            {stages.map((stage) => (
              <div
                key={stage.id}
                className="group grid grid-cols-12 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <button className="col-span-3 truncate text-start text-sm font-medium hover:text-brand-600" onClick={() => setEditing(stage)}>
                  {stage.name}
                </button>
                <div className="col-span-2 text-xs text-slate-400 tnum">
                  {stage.startDate ? fmt.date(stage.startDate) : "—"} ← {stage.endDate ? fmt.date(stage.endDate) : "—"}
                </div>
                <div className="col-span-5">
                  {range && stage.startDate && stage.endDate ? (
                    <div className="relative h-4 rounded bg-slate-100 dark:bg-slate-800">
                      <div
                        className={cx(
                          "absolute inset-y-0 rounded",
                          stage.status === "COMPLETED" ? "bg-emerald-400" : stage.status === "ON_HOLD" ? "bg-amber-300" : "bg-brand-400",
                        )}
                        style={{
                          insetInlineStart: `${((range.toMs(stage.startDate) - range.min) / range.span) * 100}%`,
                          width: `${Math.max(1.5, ((range.toMs(stage.endDate) - range.toMs(stage.startDate)) / range.span) * 100)}%`,
                        }}
                      />
                    </div>
                  ) : (
                    <div className="h-1 rounded bg-slate-100 dark:bg-slate-800" />
                  )}
                </div>
                <div className="col-span-1 text-end text-xs tnum">{fmt.percent(stage.completionBp)}</div>
                <div className="col-span-1 flex items-center justify-end gap-1">
                  <Badge value={STAGE_BADGE[stage.status]} label={t(`stageStatus.${stage.status}`)} />
                  <button className="text-slate-300 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100" onClick={() => mutations.remove.mutate(stage.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {editing !== null && (
        <StageForm
          projectId={projectId}
          initial={editing === "new" ? null : editing}
          nextOrder={stages.length}
          busy={mutations.create.isPending || mutations.update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            if (editing === "new") mutations.create.mutate(input, { onSuccess: () => setEditing(null) });
            else mutations.update.mutate({ id: editing.id, input }, { onSuccess: () => setEditing(null) });
          }}
        />
      )}
    </div>
  );
}

function StageForm({
  projectId,
  initial,
  nextOrder,
  onSubmit,
  onClose,
  busy,
}: {
  projectId: number;
  initial: ProjectStage | null;
  nextOrder: number;
  onSubmit: (input: StageInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    sortOrder: initial?.sortOrder ?? nextOrder,
    startDate: initial?.startDate ?? "",
    endDate: initial?.endDate ?? "",
    status: initial?.status ?? ("PLANNED" as StageStatus),
    completionBp: initial?.completionBp ?? 0,
    engineers: initial?.engineers ?? "",
    notes: initial?.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
    const parsed = stageSchema.safeParse({
      ...form,
      projectId,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      engineers: form.engineers || null,
      notes: form.notes || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("stages.newStage")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.name")} error={errors.name} className="col-span-2">
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
        </Field>
        <Field label={t("projects.startDate")}>
          <Input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
        </Field>
        <Field label={t("projects.endDate")}>
          <Input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
        </Field>
        <Field label={t("common.status")}>
          <Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as StageStatus }))}>
            {(["PLANNED", "IN_PROGRESS", "COMPLETED", "ON_HOLD"] as const).map((s) => (
              <option key={s} value={s}>{t(`stageStatus.${s}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("stages.completion") + " %"}>
          <Input
            dir="ltr"
            type="number"
            min={0}
            max={100}
            className="text-end tnum"
            value={form.completionBp / 100}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0 && v <= 100) setForm((f) => ({ ...f, completionBp: Math.round(v * 100) }));
            }}
          />
        </Field>
        <Field label={t("stages.engineers")} className="col-span-2">
          <Input value={form.engineers} onChange={(e) => setForm((f) => ({ ...f, engineers: e.target.value }))} />
        </Field>
        <Field label={t("common.notes")} className="col-span-2">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
