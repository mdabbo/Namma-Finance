import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { projectSchema, type Project, type ProjectInput, CURRENCIES } from "@mep/core";
import { useClients } from "../../repositories/clients";
import { useCurrencyRates } from "../../repositories/currencies";
import { Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";

const DISCIPLINES = ["HVAC", "PLUMBING", "FIREFIGHTING", "ELECTRICAL", "BIM", "ARCHITECTURE", "STRUCTURAL", "ID", "MULTI"] as const;
const STATUSES = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;

interface ProjectFormProps {
  initial?: Project | null;
  nextCode?: string;
  onSubmit: (input: ProjectInput) => void;
  onClose: () => void;
  busy?: boolean;
}

export function ProjectForm({ initial, nextCode, onSubmit, onClose, busy }: ProjectFormProps) {
  const { t } = useTranslation();
  const { data: clients = [] } = useClients();
  const { data: rates = [] } = useCurrencyRates();

  const [form, setForm] = useState({
    name: initial?.name ?? "",
    clientId: initial?.clientId ?? 0,
    country: initial?.country ?? "",
    city: initial?.city ?? "",
    manager: initial?.manager ?? "",
    discipline: initial?.discipline ?? ("MULTI" as Project["discipline"]),
    projectType: initial?.projectType ?? "",
    status: initial?.status ?? ("ACTIVE" as Project["status"]),
    currency: initial?.currency ?? "EGP",
    fxRateMicro: initial?.fxRateMicro ?? 1_000_000,
    startDate: initial?.startDate ?? "",
    endDate: initial?.endDate ?? "",
    progressBp: initial?.progressBp ?? 0,
    description: initial?.description ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // default the FX rate from the currency table when currency changes
  useEffect(() => {
    if (initial && form.currency === initial.currency) return;
    const rate = rates.find((r) => r.code === form.currency);
    if (rate) setForm((f) => ({ ...f, fxRateMicro: rate.fxRateMicro }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.currency, rates.length]);

  function submit() {
    const parsed = projectSchema.safeParse({
      ...form,
      clientId: Number(form.clientId),
      country: form.country || null,
      city: form.city || null,
      manager: form.manager || null,
      projectType: form.projectType || null,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      description: form.description || null,
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
    <Modal title={initial ? t("common.edit") : t("projects.newProject")} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("projects.code")}>
          <Input value={initial?.code ?? nextCode ?? ""} disabled className="tnum" />
        </Field>
        <Field label={t("common.name")} error={errors.name} className="col-span-2">
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
        </Field>
        <Field label={t("projects.client")} error={errors.clientId}>
          <Select value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: Number(e.target.value) }))}>
            <option value={0}>—</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("projects.discipline")}>
          <Select value={form.discipline} onChange={(e) => setForm((f) => ({ ...f, discipline: e.target.value as Project["discipline"] }))}>
            {DISCIPLINES.map((d) => (
              <option key={d} value={d}>{t(`discipline.${d}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("common.status")}>
          <Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as Project["status"] }))}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{t(`status.${s}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("projects.country")}>
          <Input value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
        </Field>
        <Field label={t("projects.city")}>
          <Input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
        </Field>
        <Field label={t("projects.manager")}>
          <Input value={form.manager} onChange={(e) => setForm((f) => ({ ...f, manager: e.target.value }))} />
        </Field>
        <Field label={t("projects.type")}>
          <Input value={form.projectType} onChange={(e) => setForm((f) => ({ ...f, projectType: e.target.value }))} />
        </Field>
        <Field label={t("common.currency")}>
          <Select value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}>
            {Object.keys(CURRENCIES).map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("projects.fxRate")}>
          <Input
            dir="ltr"
            className="text-end tnum"
            disabled={form.currency === "EGP"}
            value={form.currency === "EGP" ? "1" : String(form.fxRateMicro / 1_000_000)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setForm((f) => ({ ...f, fxRateMicro: Math.round(v * 1_000_000) }));
            }}
          />
        </Field>
        <Field label={t("projects.progress") + " %"}>
          <Input
            dir="ltr"
            type="number"
            min={0}
            max={100}
            className="text-end tnum"
            value={form.progressBp / 100}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0 && v <= 100) setForm((f) => ({ ...f, progressBp: Math.round(v * 100) }));
            }}
          />
        </Field>
        <Field label={t("projects.startDate")}>
          <Input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
        </Field>
        <Field label={t("projects.endDate")}>
          <Input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
        </Field>
        <Field label={t("common.description")} className="col-span-3">
          <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
