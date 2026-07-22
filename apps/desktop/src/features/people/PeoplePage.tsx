import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { personSchema, type Person, type PersonInput, CURRENCIES } from "@mep/core";
import { usePeople, usePeopleMutations, type PersonListItem } from "../../repositories/people";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Badge, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { useFormat } from "../../lib/format";

export function PeoplePage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: people = [], isLoading } = usePeople(includeArchived);
  const mutations = usePeopleMutations();

  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [deleting, setDeleting] = useState<PersonListItem | null>(null);

  const filtered = people.filter((p) => !typeFilter || p.type === typeFilter);

  const columns: Column<PersonListItem>[] = [
    { key: "name", header: t("common.name"), value: (p) => p.name, render: (p) => <span className="font-medium">{p.name}</span> },
    { key: "type", header: t("payments.kind"), value: (p) => p.type, render: (p) => <Badge value={p.type === "EMPLOYEE" ? "APPROVED" : "SUBMITTED"} label={t(`personType.${p.type}`)} /> },
    { key: "specialization", header: t("people.specialization"), value: (p) => p.specialization },
    { key: "phone", header: t("common.phone"), value: (p) => p.phone, render: (p) => <span className="tnum">{p.phone}</span> },
    {
      key: "monthly",
      header: t("people.monthlyRate"),
      value: (p) => p.monthlyRateMinor ?? 0,
      render: (p) => <span className="tnum">{p.monthlyRateMinor != null ? fmt.money(p.monthlyRateMinor, p.currency, { compactFraction: true }) : "—"}</span>,
      align: "end",
    },
    {
      key: "hourly",
      header: t("people.hourlyRate"),
      value: (p) => p.hourlyRateMinor ?? 0,
      render: (p) => <span className="tnum">{p.hourlyRateMinor != null ? fmt.money(p.hourlyRateMinor, p.currency) : "—"}</span>,
      align: "end",
    },
    {
      key: "active",
      header: t("common.status"),
      value: (p) => (p.isActive ? 1 : 0),
      render: (p) => <Badge value={p.isActive ? "ACTIVE" : "CANCELLED"} label={p.isActive ? t("people.active") : t("people.inactive")} />,
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "120px",
      render: (p) => p.archivedAt ? <Badge value="CANCELLED" label={t("lifecycle.archived")} /> : (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" onClick={() => setEditing(p)}>{t("common.edit")}</Button>
          <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(p)}>{t("common.delete")}</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("people.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> {t("people.newPerson")}
        </Button>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(p) => p.id}
        onRowClick={(p) => { if (!p.archivedAt) navigate(`/people/${p.id}`); }}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
        initialSort={{ key: "name", dir: "asc" }}
        toolbar={<>
          <Select className="!w-40" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">{t("common.all")}</option>
            <option value="EMPLOYEE">{t("personType.EMPLOYEE")}</option>
            <option value="FREELANCER">{t("personType.FREELANCER")}</option>
          </Select>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            {t("lifecycle.includeArchived")}
          </label>
        </>}
      />

      {editing !== null && (
        <PersonForm
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
          message={`${t("common.confirmDeleteMessage")} ${deleting.name}`}
          details={[t("people.assignments"), t("people.payments")]}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}

export function PersonForm({
  initial,
  onSubmit,
  onClose,
  busy,
}: {
  initial: Person | null;
  onSubmit: (input: PersonInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    type: initial?.type ?? ("FREELANCER" as Person["type"]),
    name: initial?.name ?? "",
    specialization: initial?.specialization ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    bankAccount: initial?.bankAccount ?? "",
    hourlyRateMinor: initial?.hourlyRateMinor ?? null,
    monthlyRateMinor: initial?.monthlyRateMinor ?? null,
    currency: initial?.currency ?? "EGP",
    notes: initial?.notes ?? "",
    isActive: initial?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
    const parsed = personSchema.safeParse({
      ...form,
      specialization: form.specialization || null,
      phone: form.phone || null,
      email: form.email || null,
      bankAccount: form.bankAccount || null,
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
    <Modal title={initial ? t("common.edit") : t("people.newPerson")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.name")} error={errors.name}>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
        </Field>
        <Field label={t("payments.kind")}>
          <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as Person["type"] }))}>
            <option value="FREELANCER">{t("personType.FREELANCER")}</option>
            <option value="EMPLOYEE">{t("personType.EMPLOYEE")}</option>
          </Select>
        </Field>
        <Field label={t("people.specialization")}>
          <Input value={form.specialization} onChange={(e) => setForm((f) => ({ ...f, specialization: e.target.value }))} />
        </Field>
        <Field label={t("common.phone")}>
          <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} dir="ltr" />
        </Field>
        <Field label={t("common.email")} error={errors.email}>
          <Input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} dir="ltr" />
        </Field>
        <Field label={t("people.bankAccount")}>
          <Input value={form.bankAccount} onChange={(e) => setForm((f) => ({ ...f, bankAccount: e.target.value }))} dir="ltr" />
        </Field>
        <Field label={t("common.currency")}>
          <Select value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}>
            {Object.keys(CURRENCIES).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("people.hourlyRate")}>
          <MoneyInput currency={form.currency} valueMinor={form.hourlyRateMinor} onChange={(v) => setForm((f) => ({ ...f, hourlyRateMinor: v }))} />
        </Field>
        <Field label={t("people.monthlyRate")}>
          <MoneyInput currency={form.currency} valueMinor={form.monthlyRateMinor} onChange={(v) => setForm((f) => ({ ...f, monthlyRateMinor: v }))} />
        </Field>
        <Field label={t("common.status")}>
          <Select value={form.isActive ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "1" }))}>
            <option value="1">{t("people.active")}</option>
            <option value="0">{t("people.inactive")}</option>
          </Select>
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
