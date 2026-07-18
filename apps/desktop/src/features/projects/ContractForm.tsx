import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import {
  BP_SCALE,
  contractSchema,
  deriveContractFigures,
  drawingsValueMinor,
  milestoneAmounts,
  milestonesTotalBp,
  parseDrawings,
  parseMilestones,
  ratioBp,
  type Contract,
  type ContractInput,
  type ContractValuationMode,
  type DrawingLine,
  type PercentMilestone,
} from "@mep/core";
import { Button, Card, Field, Input, Modal, Select, Textarea, cx } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { bpToInput, parseToBp, useFormat } from "../../lib/format";
import { useStagesByProject } from "../../repositories/stages";

interface ContractFormProps {
  projectId: number;
  currency: string;
  initial?: Contract | null;
  onSubmit: (input: ContractInput) => void;
  onClose: () => void;
  busy?: boolean;
}

export function ContractForm({ projectId, currency, initial, onSubmit, onClose, busy }: ContractFormProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: stages = [] } = useStagesByProject(projectId);

  const [form, setForm] = useState({
    number: initial?.number ?? "",
    title: initial?.title ?? "",
    valueMinor: initial?.valueMinor ?? 0,
    vatBp: initial?.vatBp ?? 1400,
    retentionBp: initial?.retentionBp ?? 500,
    withholdingBp: initial?.withholdingBp ?? 0,
    advanceMinor: initial?.advanceMinor ?? 0,
    advanceRecoveryMethod: initial?.advanceRecoveryMethod ?? ("PROPORTIONAL" as Contract["advanceRecoveryMethod"]),
    performanceBondBp: initial?.performanceBondBp ?? 0,
    performanceBondBank: initial?.performanceBondBank ?? "",
    performanceBondExpiry: initial?.performanceBondExpiry ?? "",
    paymentTermsDays: initial?.paymentTermsDays ?? 30,
    paymentTermsNotes: initial?.paymentTermsNotes ?? "",
    valuationMode: initial?.valuationMode ?? ("LUMP_SUM" as ContractValuationMode),
    signedDate: initial?.signedDate ?? "",
    notes: initial?.notes ?? "",
  });
  const [milestones, setMilestones] = useState<PercentMilestone[]>(() => parseMilestones(initial?.milestones));
  const [drawings, setDrawings] = useState<DrawingLine[]>(() => parseDrawings(initial?.drawings));
  const [errors, setErrors] = useState<Record<string, string>>({});

  // DRAWINGS mode derives the contract value from the drawing lines.
  useEffect(() => {
    if (form.valuationMode === "DRAWINGS") {
      const derived = drawingsValueMinor(drawings);
      setForm((f) => (f.valueMinor === derived ? f : { ...f, valueMinor: derived }));
    }
  }, [form.valuationMode, drawings]);

  const figures = useMemo(
    () => deriveContractFigures({ valueMinor: form.valueMinor, vatBp: form.vatBp, retentionBp: form.retentionBp }),
    [form.valueMinor, form.vatBp, form.retentionBp],
  );

  function rateField(label: string, key: "vatBp" | "retentionBp" | "withholdingBp" | "performanceBondBp") {
    return (
      <Field label={label}>
        <Input
          dir="ltr"
          className="text-end tnum"
          value={bpToInput(form[key])}
          onChange={(e) => {
            const bp = parseToBp(e.target.value);
            if (bp !== null) setForm((f) => ({ ...f, [key]: bp }));
            else if (e.target.value.trim() === "") setForm((f) => ({ ...f, [key]: 0 }));
          }}
        />
      </Field>
    );
  }

  function submit() {
    if (form.valuationMode === "MILESTONES" && milestonesTotalBp(milestones) !== BP_SCALE) {
      setErrors({ milestones: t("contracts.milestonesMustTotal") });
      return;
    }
    const parsed = contractSchema.safeParse({
      ...form,
      projectId,
      title: form.title || null,
      performanceBondBank: form.performanceBondBank || null,
      performanceBondExpiry: form.performanceBondExpiry || null,
      paymentTermsNotes: form.paymentTermsNotes || null,
      milestones: form.valuationMode === "MILESTONES" && milestones.length > 0 ? JSON.stringify(milestones) : null,
      drawings: form.valuationMode === "DRAWINGS" && drawings.length > 0 ? JSON.stringify(drawings) : null,
      attachments: initial?.attachments ?? null,
      signedDate: form.signedDate || null,
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

  const milestoneTotalBp = milestonesTotalBp(milestones);
  const milestonePreview = milestoneAmounts(form.valueMinor, milestones);

  return (
    <Modal title={initial ? t("common.edit") : t("contracts.newContract")} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("contracts.number")} error={errors.number}>
          <Input value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} autoFocus className="tnum" />
        </Field>
        <Field label={t("contracts.contractTitle")} className="col-span-2">
          <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </Field>

        <Field label={t("contracts.valuationMode")}>
          <Select
            value={form.valuationMode}
            onChange={(e) => setForm((f) => ({ ...f, valuationMode: e.target.value as ContractValuationMode }))}
          >
            <option value="LUMP_SUM">{t("contracts.lumpSum")}</option>
            <option value="MILESTONES">{t("contracts.milestonesMode")}</option>
            <option value="DRAWINGS">{t("contracts.drawingsMode")}</option>
          </Select>
        </Field>
        <Field label={t("contracts.value")} error={errors.valueMinor}>
          <MoneyInput
            currency={currency}
            valueMinor={form.valueMinor}
            disabled={form.valuationMode === "DRAWINGS"}
            onChange={(v) => setForm((f) => ({ ...f, valueMinor: v ?? 0 }))}
          />
        </Field>
        {rateField(t("contracts.vatRate"), "vatBp")}
        {rateField(t("contracts.retentionRate"), "retentionBp")}
        {rateField(t("contracts.withholdingRate"), "withholdingBp")}

        <Field label={t("contracts.advance")} error={errors.advanceMinor}>
          <MoneyInput currency={currency} valueMinor={form.advanceMinor} onChange={(v) => setForm((f) => ({ ...f, advanceMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("contracts.advanceRecovery")}>
          <Select
            value={form.advanceRecoveryMethod}
            onChange={(e) => setForm((f) => ({ ...f, advanceRecoveryMethod: e.target.value as Contract["advanceRecoveryMethod"] }))}
          >
            <option value="PROPORTIONAL">{t("recovery.PROPORTIONAL")}</option>
            <option value="MANUAL">{t("recovery.MANUAL")}</option>
          </Select>
        </Field>

        {rateField(t("contracts.performanceBond"), "performanceBondBp")}
        <Field label={t("contracts.performanceBondBank")}>
          <Input value={form.performanceBondBank} onChange={(e) => setForm((f) => ({ ...f, performanceBondBank: e.target.value }))} />
        </Field>
        <Field label={t("contracts.performanceBondExpiry")}>
          <Input type="date" value={form.performanceBondExpiry} onChange={(e) => setForm((f) => ({ ...f, performanceBondExpiry: e.target.value }))} />
        </Field>

        <Field label={t("contracts.paymentTerms")}>
          <Input
            dir="ltr"
            type="number"
            min={0}
            className="text-end tnum"
            value={form.paymentTermsDays}
            onChange={(e) => setForm((f) => ({ ...f, paymentTermsDays: Math.max(0, Number(e.target.value) || 0) }))}
          />
        </Field>
        <Field label={t("contracts.signedDate")}>
          <Input type="date" value={form.signedDate} onChange={(e) => setForm((f) => ({ ...f, signedDate: e.target.value }))} />
        </Field>
        <Field label={t("common.notes")} className="col-span-3">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>

      {form.valuationMode === "MILESTONES" && (
        <Card className="mt-4 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">{t("contracts.milestones")}</p>
            <Button onClick={() => setMilestones((m) => [...m, { title: "", percentBp: 0 }])}>
              <Plus size={14} /> {t("contracts.addMilestone")}
            </Button>
          </div>
          <AdvanceFirstStage advanceMinor={form.advanceMinor} valueMinor={form.valueMinor} currency={currency} />
          <div className="space-y-2">
            {milestones.map((m, i) => {
              const linkedStage = stages.find((s) => s.id === m.stageId);
              const autoAchieved = linkedStage?.status === "COMPLETED";
              return (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder={t("contracts.milestoneTitle")}
                    value={m.title}
                    onChange={(e) => setMilestones((arr) => arr.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  />
                  <Input
                    dir="ltr"
                    className="!w-20 text-end tnum"
                    placeholder="%"
                    value={m.percentBp === 0 ? "" : bpToInput(m.percentBp)}
                    onChange={(e) => {
                      const bp = parseToBp(e.target.value) ?? 0;
                      setMilestones((arr) => arr.map((x, j) => (j === i ? { ...x, percentBp: bp } : x)));
                    }}
                  />
                  <Select
                    className="!w-44 !py-1 text-xs"
                    title={t("contracts.linkedStage")}
                    value={m.stageId ?? ""}
                    onChange={(e) =>
                      setMilestones((arr) =>
                        arr.map((x, j) => (j === i ? { ...x, stageId: e.target.value ? Number(e.target.value) : null } : x)),
                      )
                    }
                  >
                    <option value="">{t("contracts.linkedStage")}: —</option>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </Select>
                  <label
                    className={cx(
                      "flex w-24 items-center gap-1.5 text-xs",
                      autoAchieved ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500",
                    )}
                    title={autoAchieved ? t("contracts.achievedByStage") : t("contracts.achieved")}
                  >
                    <input
                      type="checkbox"
                      checked={autoAchieved || m.done === true}
                      disabled={autoAchieved}
                      onChange={(e) => setMilestones((arr) => arr.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))}
                    />
                    {t("contracts.achieved")}
                  </label>
                  <span className="w-28 text-end text-xs text-slate-500 tnum">
                    {fmt.money(milestonePreview[i] ?? 0, currency, { compactFraction: true })}
                  </span>
                  <button className="text-slate-300 hover:text-red-600" onClick={() => setMilestones((arr) => arr.filter((_, j) => j !== i))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className={cx("mt-3 border-t border-slate-100 pt-2 text-sm dark:border-slate-800", milestoneTotalBp === BP_SCALE ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
            {t("contracts.milestonesTotal")}: <b className="tnum">{fmt.percent(milestoneTotalBp)}</b>
            {milestoneTotalBp !== BP_SCALE && <span className="ms-2 text-xs">({t("contracts.milestonesMustTotal")})</span>}
          </div>
          {errors.milestones && <p className="mt-1 text-xs text-red-600">{errors.milestones}</p>}
        </Card>
      )}

      {form.valuationMode === "DRAWINGS" && (
        <Card className="mt-4 p-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-semibold">{t("contracts.drawingsMode")}</p>
            <Button onClick={() => setDrawings((d) => [...d, { title: "", count: 1, rateMinor: 0 }])}>
              <Plus size={14} /> {t("contracts.addDrawing")}
            </Button>
          </div>
          <p className="mb-3 text-xs text-slate-400">{t("contracts.valueFromDrawings")}</p>
          <AdvanceFirstStage advanceMinor={form.advanceMinor} valueMinor={drawingsValueMinor(drawings)} currency={currency} />
          <div className="space-y-2">
            {drawings.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="flex-1"
                  placeholder={t("contracts.milestoneTitle")}
                  value={d.title}
                  onChange={(e) => setDrawings((arr) => arr.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                />
                <Input
                  dir="ltr"
                  type="number"
                  min={0}
                  className="!w-20 text-end tnum"
                  title={t("contracts.drawingCount")}
                  value={d.count}
                  onChange={(e) => {
                    const count = Math.max(0, Math.round(Number(e.target.value) || 0));
                    setDrawings((arr) => arr.map((x, j) => (j === i ? { ...x, count } : x)));
                  }}
                />
                <MoneyInput
                  className="w-36"
                  currency={currency}
                  placeholder={t("contracts.ratePerDrawing")}
                  valueMinor={d.rateMinor || null}
                  onChange={(v) => setDrawings((arr) => arr.map((x, j) => (j === i ? { ...x, rateMinor: v ?? 0 } : x)))}
                />
                <span className="w-32 text-end text-xs text-slate-500 tnum">
                  {fmt.money(d.count * d.rateMinor, currency, { compactFraction: true })}
                </span>
                <button className="text-slate-300 hover:text-red-600" onClick={() => setDrawings((arr) => arr.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
            {t("contracts.value")}: <b className="tnum">{fmt.money(drawingsValueMinor(drawings), currency)}</b>
          </div>
        </Card>
      )}

      <Card className="mt-4 grid grid-cols-3 gap-3 bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
        <div>
          <p className="text-xs text-slate-500">{t("contracts.vatAmount")}</p>
          <p className="font-semibold tnum">{fmt.money(figures.vatMinor, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">{t("contracts.retentionAmount")}</p>
          <p className="font-semibold tnum">{fmt.money(figures.retentionMinor, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">{t("contracts.netValue")}</p>
          <p className="font-semibold tnum">{fmt.money(figures.netContractMinor, currency)}</p>
        </div>
      </Card>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}

/**
 * The down payment is ALWAYS the first payment stage of a contract (confirmed
 * rule) — shown pinned above the milestone/drawing plan. Derived from the
 * advance terms; it lives outside the 100% plan because certificates recover
 * it automatically.
 */
function AdvanceFirstStage({ advanceMinor, valueMinor, currency }: { advanceMinor: number; valueMinor: number; currency: string }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  if (advanceMinor <= 0) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm dark:border-brand-800 dark:bg-brand-900/20">
      <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">1</span>
      <span className="font-medium">{t("paymentKind.ADVANCE")}</span>
      <span className="ms-auto tnum font-semibold">{fmt.money(advanceMinor, currency, { compactFraction: true })}</span>
      {valueMinor > 0 && <span className="text-xs text-slate-400 tnum">({fmt.percent(ratioBp(advanceMinor, valueMinor))})</span>}
    </div>
  );
}
