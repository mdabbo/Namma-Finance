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
  parseAttachmentsResult,
  parseDrawingsResult,
  parseMilestonesResult,
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
import { nextContractNumber } from "../../repositories/contracts";
import type { RevisionMetadata } from "../../repositories/contracts";
import { useProject } from "../../repositories/projects";
import { useSettings } from "../../lib/settings";

interface ContractFormProps {
  projectId: number;
  currency: string;
  initial?: Contract | null;
  onSubmit: (input: ContractInput, revision?: RevisionMetadata) => void;
  onClose: () => void;
  busy?: boolean;
}

export function ContractForm({ projectId, currency, initial, onSubmit, onClose, busy }: ContractFormProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: stages = [] } = useStagesByProject(projectId);
  const { data: project } = useProject(projectId);
  const { data: settings } = useSettings();

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
  const milestoneParse=parseMilestonesResult(initial?.milestones);
  const drawingParse=parseDrawingsResult(initial?.drawings);
  const attachmentParse=parseAttachmentsResult(initial?.attachments);
  const [milestones, setMilestones] = useState<PercentMilestone[]>(() => milestoneParse.ok?milestoneParse.value:[]);
  const [drawings, setDrawings] = useState<DrawingLine[]>(() => drawingParse.ok?drawingParse.value:[]);
  const [attachmentsRaw,setAttachmentsRaw]=useState<string|null>(()=>attachmentParse.ok?(initial?.attachments??null):null);
  const [corruptFields,setCorruptFields]=useState<string[]>(()=>[
    ...(!milestoneParse.ok?["milestones"]:[]),...(!drawingParse.ok?["drawings"]:[]),...(!attachmentParse.ok?["attachments"]:[]),
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revisionReason, setRevisionReason] = useState("");
  const [revisionEffectiveDate, setRevisionEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));

  // New contract: auto-generate the number (project code + per-project counter)
  // and default the title to the project name; both stay editable.
  useEffect(() => {
    if (initial || !project) return;
    let cancelled = false;
    void nextContractNumber(projectId, settings?.contractNumberPrefix ?? "CON").then((number) => {
      if (cancelled) return;
      setForm((f) => ({
        ...f,
        number: f.number || number,
        title: f.title || project.name,
      }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, initial, settings?.contractNumberPrefix]);

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
    if(corruptFields.length){setErrors({structured:t("validation.malformed_json")});return;}
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
      attachments: attachmentsRaw,
      signedDate: form.signedDate || null,
      notes: form.notes || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    onSubmit(parsed.data, initial ? { reason: revisionReason, effectiveDate: revisionEffectiveDate } : undefined);
  }

  const milestoneTotalBp = milestonesTotalBp(milestones);
  const milestonePreview = milestoneAmounts(form.valueMinor, milestones);

  return (
    <Modal title={initial ? t("common.edit") : t("contracts.newContract")} onClose={onClose} wide>
      {corruptFields.length>0&&<Card className="mb-3 border-red-300 bg-red-50 p-3 text-sm text-red-700">
        <p>{t("validation.malformed_json")} ({corruptFields.join(", ")})</p>
        <Button className="mt-2" onClick={()=>{setCorruptFields([]);if(!attachmentParse.ok)setAttachmentsRaw(null);setErrors((current)=>({...current,structured:""}));}}>{t("validation.repair_structured")}</Button>
      </Card>}
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("contracts.number")} error={errors.number}>
          <Input value={form.number} readOnly className="tnum" />
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
        {initial && (
          <>
            <Field label={t("contracts.revisionEffectiveDate")}>
              <Input type="date" value={revisionEffectiveDate} onChange={(e) => setRevisionEffectiveDate(e.target.value)} />
            </Field>
            <Field label={t("contracts.revisionReason")} className="col-span-2">
              <Input value={revisionReason} placeholder={t("contracts.revisionReasonHint")} onChange={(e) => setRevisionReason(e.target.value)} />
            </Field>
          </>
        )}
      </div>

      {form.valuationMode === "MILESTONES" && (
        <Card className="mt-4 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">{t("contracts.milestones")}</p>
            <Button onClick={() => setMilestones((m) => [...m, { title: "", percentBp: 0 }])}>
              <Plus size={14} /> {t("contracts.addMilestone")}
            </Button>
          </div>
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
          <p className="text-xs text-slate-500">{t("cash.contractValueIncludingVat")}</p>
          <p className="font-semibold tnum">{fmt.money(figures.contractValueIncludingVatMinor, currency)}</p>
        </div>
      </Card>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
