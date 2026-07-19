import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { laborCostMinor, minutesToHours, timeEntrySchema, type TimeEntryInput } from "@mep/core";
import { useTimeEntries, useTimeEntryMutations, type TimeEntryListItem } from "../../repositories/timeEntries";
import { useProjects } from "../../repositories/projects";
import { usePeople } from "../../repositories/people";
import { useStagesByProject } from "../../repositories/stages";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Badge, Button, Field, Input, Modal, Select } from "../../components/ui";
import { todayIso, useFormat } from "../../lib/format";

/** Parse a decimal-hours string into whole minutes. "1.5" → 90. */
function hoursToMinutes(text: string): number | null {
  const v = Number(text.replace(/[,\s]/g, ""));
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 60);
}

export function TimePage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: entries = [], isLoading } = useTimeEntries();
  const mutations = useTimeEntryMutations();

  const [editing, setEditing] = useState<TimeEntryListItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<TimeEntryListItem | null>(null);

  const totalHours = useMemo(() => entries.reduce((s, e) => s + e.minutes, 0) / 60, [entries]);

  const columns: Column<TimeEntryListItem>[] = [
    { key: "date", header: t("common.date"), value: (e) => e.date, render: (e) => <span className="tnum">{fmt.date(e.date)}</span>, width: "110px" },
    { key: "person", header: t("time.person"), value: (e) => e.personName },
    {
      key: "project",
      header: t("projects.single"),
      value: (e) => `${e.projectCode} ${e.projectName}`,
      render: (e) => (
        <div>
          <p>{e.projectName}</p>
          <p className="text-xs text-slate-400 tnum">{e.projectCode}{e.stageName ? ` · ${e.stageName}` : ""}</p>
        </div>
      ),
    },
    { key: "note", header: t("common.notes"), value: (e) => e.note },
    {
      key: "hours",
      header: t("time.hours"),
      value: (e) => e.minutes,
      render: (e) => <span className="tnum">{minutesToHours(e.minutes)}{t("time.hoursShort")}</span>,
      align: "end",
    },
    {
      key: "cost",
      header: t("time.laborCost"),
      value: (e) => laborCostMinor(e.minutes, e.hourlyRateMinor),
      render: (e) => (
        <span className="tnum text-slate-500">
          {e.hourlyRateMinor ? fmt.money(laborCostMinor(e.minutes, e.hourlyRateMinor), e.personCurrency) : "—"}
        </span>
      ),
      align: "end",
    },
    {
      key: "billable",
      header: "",
      sortable: false,
      render: (e) => (e.billable ? <Badge value="APPROVED" label={t("time.billable")} /> : <Badge value="DRAFT" label={t("time.nonBillable")} />),
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "120px",
      render: (e) => (
        <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
          <Button variant="ghost" onClick={() => setEditing(e)}>{t("common.edit")}</Button>
          <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(e)}>{t("common.delete")}</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("time.title")}</h1>
          <p className="text-xs text-slate-400">
            {t("time.totalHours")}: <span className="tnum">{Math.round(totalHours * 10) / 10}{t("time.hoursShort")}</span>
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> {t("time.newEntry")}
        </Button>
      </div>

      <DataTable
        rows={entries}
        columns={columns}
        rowKey={(e) => e.id}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
      />

      {editing !== null && (
        <TimeEntryForm
          initial={editing === "new" ? null : editing}
          busy={mutations.create.isPending || mutations.update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            if (editing === "new") mutations.create.mutate(input, { onSuccess: () => setEditing(null) });
            else mutations.update.mutate({ id: editing.id, input }, { onSuccess: () => setEditing(null) });
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          message={`${t("common.confirmDeleteMessage")} ${deleting.personName} · ${minutesToHours(deleting.minutes)}${t("time.hoursShort")}`}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}

/** Reusable log-time form. `lockProjectId` fixes the project (used in the project tab). */
export function TimeEntryForm({
  initial,
  lockProjectId,
  onSubmit,
  onClose,
  busy,
}: {
  initial: TimeEntryListItem | null;
  lockProjectId?: number;
  onSubmit: (input: TimeEntryInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const { data: projects = [] } = useProjects();
  const { data: people = [] } = usePeople();

  const [form, setForm] = useState({
    personId: initial?.personId ?? 0,
    projectId: initial?.projectId ?? lockProjectId ?? 0,
    stageId: initial?.stageId ?? null as number | null,
    date: initial?.date ?? todayIso(),
    hours: initial ? String(minutesToHours(initial.minutes)) : "",
    billable: initial?.billable ?? true,
    note: initial?.note ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { data: stages = [] } = useStagesByProject(form.projectId);

  function submit() {
    const minutes = hoursToMinutes(form.hours);
    const parsed = timeEntrySchema.safeParse({
      personId: form.personId,
      projectId: form.projectId,
      stageId: form.stageId,
      date: form.date,
      minutes: minutes ?? 0,
      billable: form.billable,
      note: form.note || null,
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
    <Modal title={initial ? t("common.edit") : t("time.newEntry")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("time.person")} error={errors.personId}>
          <Select value={form.personId} onChange={(e) => setForm((f) => ({ ...f, personId: Number(e.target.value) }))}>
            <option value={0}>—</option>
            {people.filter((p) => p.isActive).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("common.date")}>
          <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("projects.single")} error={errors.projectId}>
          <Select
            value={form.projectId}
            disabled={lockProjectId !== undefined}
            onChange={(e) => setForm((f) => ({ ...f, projectId: Number(e.target.value), stageId: null }))}
          >
            <option value={0}>—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("time.stage")}>
          <Select value={form.stageId ?? ""} onChange={(e) => setForm((f) => ({ ...f, stageId: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">{t("time.noStage")}</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("time.hours")} error={errors.minutes}>
          <Input dir="ltr" inputMode="decimal" className="text-end tnum" placeholder="1.5" value={form.hours} onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))} />
        </Field>
        <Field label={t("time.billable")}>
          <Select value={form.billable ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, billable: e.target.value === "1" }))}>
            <option value="1">{t("time.billable")}</option>
            <option value="0">{t("time.nonBillable")}</option>
          </Select>
        </Field>
        <Field label={t("common.notes")} className="col-span-2">
          <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </Field>
      </div>
      <p className="mt-2 text-xs text-slate-400">{t("time.quickHint")}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
