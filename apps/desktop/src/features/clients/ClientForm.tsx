import { useState } from "react";
import { useTranslation } from "react-i18next";
import { clientSchema, type Client, type ClientInput } from "@mep/core";
import { Button, Field, Input, Modal, Textarea } from "../../components/ui";

interface ClientFormProps {
  initial?: Client | null;
  onSubmit: (input: ClientInput) => void;
  onClose: () => void;
  busy?: boolean;
}

export function ClientForm({ initial, onSubmit, onClose, busy }: ClientFormProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    company: initial?.company ?? "",
    address: initial?.address ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    taxNumber: initial?.taxNumber ?? "",
    contacts: initial?.contacts ?? "",
    notes: initial?.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function submit() {
    const parsed = clientSchema.safeParse({
      ...form,
      company: form.company || null,
      address: form.address || null,
      phone: form.phone || null,
      email: form.email || null,
      taxNumber: form.taxNumber || null,
      contacts: form.contacts || null,
      notes: form.notes || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      }
      setErrors(errs);
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("clients.newClient")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.name")} error={errors.name} className="col-span-2">
          <Input value={form.name} onChange={set("name")} autoFocus />
        </Field>
        <Field label={t("clients.company")}>
          <Input value={form.company} onChange={set("company")} />
        </Field>
        <Field label={t("clients.taxNumber")}>
          <Input value={form.taxNumber} onChange={set("taxNumber")} />
        </Field>
        <Field label={t("common.phone")}>
          <Input value={form.phone} onChange={set("phone")} dir="ltr" />
        </Field>
        <Field label={t("common.email")} error={errors.email}>
          <Input value={form.email} onChange={set("email")} dir="ltr" />
        </Field>
        <Field label={t("clients.address")} className="col-span-2">
          <Input value={form.address} onChange={set("address")} />
        </Field>
        <Field label={t("clients.contacts")} className="col-span-2">
          <Textarea value={form.contacts} onChange={set("contacts")} placeholder={`${t("clients.contactName")} — ${t("clients.contactRole")} — ${t("common.phone")}`} />
        </Field>
        <Field label={t("common.notes")} className="col-span-2">
          <Textarea value={form.notes} onChange={set("notes")} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {t("common.save")}
        </Button>
      </div>
    </Modal>
  );
}
