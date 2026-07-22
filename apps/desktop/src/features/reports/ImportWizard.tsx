import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, Check } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { parseWorkbook } from "../../lib/export";
import { parseToMinor } from "../../lib/format";
import { selectOne, execute } from "../../lib/db";
import { nextProjectCode } from "../../repositories/projects";
import { nextCertificateSeq } from "../../repositories/certificates";
import { loadSettings } from "../../lib/settings";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, Field, Select, cx } from "../../components/ui";

type Entity = "clients" | "projects" | "contracts" | "certificates" | "payments";
type FieldKind = "text" | "money" | "date" | "percent" | "number";

interface FieldDef {
  field: string;
  labelKey: string;
  required?: boolean;
  kind: FieldKind;
}

const FIELDS: Record<Entity, FieldDef[]> = {
  clients: [
    { field: "name", labelKey: "common.name", required: true, kind: "text" },
    { field: "company", labelKey: "clients.company", kind: "text" },
    { field: "phone", labelKey: "common.phone", kind: "text" },
    { field: "email", labelKey: "common.email", kind: "text" },
    { field: "taxNumber", labelKey: "clients.taxNumber", kind: "text" },
    { field: "address", labelKey: "clients.address", kind: "text" },
    { field: "notes", labelKey: "common.notes", kind: "text" },
  ],
  projects: [
    { field: "name", labelKey: "common.name", required: true, kind: "text" },
    { field: "clientName", labelKey: "projects.client", required: true, kind: "text" },
    { field: "code", labelKey: "projects.code", kind: "text" },
    { field: "discipline", labelKey: "projects.discipline", kind: "text" },
    { field: "status", labelKey: "common.status", kind: "text" },
    { field: "currency", labelKey: "common.currency", kind: "text" },
    { field: "city", labelKey: "projects.city", kind: "text" },
    { field: "country", labelKey: "projects.country", kind: "text" },
  ],
  contracts: [
    { field: "projectCode", labelKey: "projects.code", required: true, kind: "text" },
    { field: "number", labelKey: "contracts.number", required: true, kind: "text" },
    { field: "value", labelKey: "contracts.value", required: true, kind: "money" },
    { field: "vat", labelKey: "contracts.vatRate", kind: "percent" },
    { field: "retention", labelKey: "contracts.retentionRate", kind: "percent" },
    { field: "advance", labelKey: "contracts.advance", kind: "money" },
    { field: "paymentTermsDays", labelKey: "contracts.paymentTerms", kind: "number" },
    { field: "title", labelKey: "contracts.contractTitle", kind: "text" },
  ],
  certificates: [
    { field: "contractNumber", labelKey: "contracts.number", required: true, kind: "text" },
    { field: "number", labelKey: "certificates.number", required: true, kind: "text" },
    { field: "date", labelKey: "common.date", required: true, kind: "date" },
    { field: "gross", labelKey: "certificates.gross", required: true, kind: "money" },
    { field: "discount", labelKey: "certificates.discount", kind: "money" },
    { field: "status", labelKey: "common.status", kind: "text" },
    { field: "submissionDate", labelKey: "certificates.submissionDate", kind: "date" },
  ],
  payments: [
    { field: "contractNumber", labelKey: "contracts.number", required: true, kind: "text" },
    { field: "number", labelKey: "payments.number", required: true, kind: "text" },
    { field: "date", labelKey: "common.date", required: true, kind: "date" },
    { field: "amount", labelKey: "common.amount", required: true, kind: "money" },
    { field: "method", labelKey: "payments.method", kind: "text" },
    { field: "reference", labelKey: "payments.reference", kind: "text" },
  ],
};

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy
    if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  if (typeof value === "number" && value > 20000 && value < 60000) {
    // Excel serial date
    const ms = Math.round((value - 25569) * 86_400_000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}

function parseValue(kind: FieldKind, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (kind) {
    case "text":
      return String(raw).trim() || null;
    case "money": {
      const minor = parseToMinor(String(raw));
      return minor !== null && minor >= 0 ? minor : null;
    }
    case "percent": {
      const v = Number(String(raw).replace(/[%\s,]/g, ""));
      return Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 100) : null;
    }
    case "number": {
      const v = Number(raw);
      return Number.isFinite(v) ? Math.round(v) : null;
    }
    case "date":
      return toIsoDate(raw);
  }
}

const DISCIPLINES = ["HVAC", "PLUMBING", "FIREFIGHTING", "ELECTRICAL", "BIM", "ARCHITECTURE", "STRUCTURAL", "ID", "MULTI"];
const CERT_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED"];
const METHODS = ["BANK_TRANSFER", "CHEQUE", "CASH"];

export function ImportWizard() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [fileName, setFileName] = useState("");
  const [workbook, setWorkbook] = useState<ReturnType<typeof parseWorkbook> | null>(null);
  const [sheet, setSheet] = useState("");
  const [entity, setEntity] = useState<Entity>("clients");
  const [mapping, setMapping] = useState<Record<string, string>>({}); // field -> excel column
  const [result, setResult] = useState<{ imported: number; errors: string[] } | null>(null);
  const [running, setRunning] = useState(false);

  const rows = useMemo(() => (workbook && sheet ? workbook.read(sheet) : []), [workbook, sheet]);
  const columns = useMemo(() => (rows[0] ? Object.keys(rows[0]) : []), [rows]);
  const fields = FIELDS[entity];

  /** Auto-map columns whose header loosely matches the field label/name. */
  function autoMap(cols: string[], ent: Entity) {
    const map: Record<string, string> = {};
    for (const def of FIELDS[ent]) {
      const label = t(def.labelKey).toLowerCase();
      const hit = cols.find((c) => {
        const lc = c.toLowerCase();
        return lc === def.field.toLowerCase() || lc === label || lc.includes(def.field.toLowerCase());
      });
      if (hit) map[def.field] = hit;
    }
    return map;
  }

  const parsedRows = useMemo(() => {
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const def of fields) {
        const col = mapping[def.field];
        const value = col ? parseValue(def.kind, row[col]) : null;
        out[def.field] = value;
        if (def.required && (value === null || value === "")) errors.push(def.field);
      }
      return { values: out, errors };
    });
  }, [rows, mapping, fields]);

  const validCount = parsedRows.filter((r) => r.errors.length === 0).length;
  const requiredUnmapped = fields.filter((f) => f.required && !mapping[f.field]);

  async function runImport() {
    setRunning(true);
    const errors: string[] = [];
    let imported = 0;
    const settings = await loadSettings();

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const validRows = parsedRows.filter((row) => row.errors.length === 0).map((row) => row.values);
      try {
        imported = await invoke<number>("import_rows_atomic", {
          entity,
          rows: validRows,
          projectCodePrefix: settings.projectCodePrefix,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      await qc.invalidateQueries();
      setResult({ imported, errors });
      setRunning(false);
      return;
    }

    await execute("BEGIN IMMEDIATE");
    try {
    for (let i = 0; i < parsedRows.length; i++) {
      const { values, errors: rowErrors } = parsedRows[i]!;
      if (rowErrors.length > 0) continue;
      try {
        if (entity === "clients") {
          await execute(
            "INSERT INTO clients (name, company, phone, email, tax_number, address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [values.name, values.company, values.phone, values.email, values.taxNumber, values.address, values.notes],
          );
        } else if (entity === "projects") {
          let client = await selectOne<{ id: number }>("SELECT id FROM clients WHERE name = $1", [values.clientName]);
          if (!client) {
            const r = await execute("INSERT INTO clients (name) VALUES ($1)", [values.clientName]);
            client = { id: r.lastInsertId ?? 0 };
          }
          const code = (values.code as string | null) ?? (await nextProjectCode(settings.projectCodePrefix));
          const discipline = DISCIPLINES.includes(String(values.discipline).toUpperCase()) ? String(values.discipline).toUpperCase() : "MULTI";
          const status = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"].includes(String(values.status).toUpperCase()) ? String(values.status).toUpperCase() : "ACTIVE";
          const currency = String(values.currency ?? "EGP").toUpperCase();
          const rate = await selectOne<{ fx_rate_micro: number }>("SELECT fx_rate_micro FROM currencies WHERE code = $1", [currency]);
          await execute(
            `INSERT INTO projects (code, name, client_id, discipline, status, currency, fx_rate_micro, city, country)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [code, values.name, client.id, discipline, status, rate ? currency : "EGP", rate?.fx_rate_micro ?? 1_000_000, values.city, values.country],
          );
        } else if (entity === "contracts") {
          const project = await selectOne<{ id: number }>("SELECT id FROM projects WHERE code = $1", [values.projectCode]);
          if (!project) throw new Error(`project ${values.projectCode}?`);
          await execute(
            `INSERT INTO contracts (project_id, number, title, value_minor, vat_bp, retention_bp, advance_minor, payment_terms_days)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [project.id, values.number, values.title, values.value, values.vat ?? 1400, values.retention ?? 0,
             values.advance ?? 0, values.paymentTermsDays ?? 30],
          );
        } else if (entity === "certificates") {
          const contract = await selectOne<{ id: number }>("SELECT id FROM contracts WHERE number = $1", [values.contractNumber]);
          if (!contract) throw new Error(`contract ${values.contractNumber}?`);
          const requestedStatus = String(values.status).toUpperCase();
          if (requestedStatus === "PAID") throw new Error(t("importer.paidRequiresPayment"));
          const status = CERT_STATUSES.includes(requestedStatus) ? requestedStatus : "APPROVED";
          const seq = await nextCertificateSeq(contract.id);
          await execute(
            `INSERT INTO payment_certificates (contract_id, seq, number, date, submission_date, gross_minor, discount_minor, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [contract.id, seq, values.number, values.date, values.submissionDate ?? values.date, values.gross, values.discount ?? 0, status],
          );
        } else if (entity === "payments") {
          const contract = await selectOne<{ id: number }>("SELECT id FROM contracts WHERE number = $1", [values.contractNumber]);
          if (!contract) throw new Error(`contract ${values.contractNumber}?`);
          const method = METHODS.includes(String(values.method).toUpperCase().replace(" ", "_")) ? String(values.method).toUpperCase().replace(" ", "_") : "BANK_TRANSFER";
          // Imported cash remains explicitly unallocated. The user must link it
          // to certificates after reviewing the imported evidence.
          await execute(
            "INSERT INTO payments (contract_id,kind,number,date,amount_minor,method,reference) VALUES ($1,'CERTIFICATE',$2,$3,$4,$5,$6)",
            [contract.id, values.number, values.date, values.amount, method, values.reference],
          );
        }
        imported += 1;
      } catch (err) {
        throw new Error(`Row ${i + 2}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
      await execute("COMMIT");
    } catch (error) {
      await execute("ROLLBACK");
      imported = 0;
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const { reconcileCertificateStatuses } = await import("../../repositories/payments");
    await reconcileCertificateStatuses();
    await qc.invalidateQueries();
    setResult({ imported, errors });
    setRunning(false);
  }

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-xs text-slate-400">{t("importer.hintNumbers")}</p>
      <p className="text-xs text-slate-400">{t("importer.matchBy")}</p>

      <div className="flex flex-wrap items-end gap-3">
        <Button
          variant="primary"
          onClick={async () => {
            const path = await open({ multiple: false, filters: [{ name: "Excel", extensions: ["xlsx", "xls", "csv"] }] });
            if (typeof path !== "string") return;
            const data = await readFile(path);
            const book = parseWorkbook(data);
            setWorkbook(book);
            setFileName(path.split(/[\\/]/).pop() ?? path);
            const first = book.sheets[0] ?? "";
            setSheet(first);
            setResult(null);
            const cols = first ? Object.keys(book.read(first)[0] ?? {}) : [];
            setMapping(autoMap(cols, entity));
          }}
        >
          <FileUp size={15} /> {t("importer.chooseFile")}
        </Button>
        {fileName && <span className="text-sm text-slate-500" dir="ltr">{fileName}</span>}

        <Field label={t("importer.entity")}>
          <Select
            className="!w-52"
            value={entity}
            onChange={(e) => {
              const ent = e.target.value as Entity;
              setEntity(ent);
              setMapping(autoMap(columns, ent));
              setResult(null);
            }}
          >
            {(Object.keys(FIELDS) as Entity[]).map((ent) => (
              <option key={ent} value={ent}>{t(`importer.entity${ent.charAt(0).toUpperCase()}${ent.slice(1)}`)}</option>
            ))}
          </Select>
        </Field>

        {workbook && workbook.sheets.length > 1 && (
          <Field label={t("importer.sheet")}>
            <Select className="!w-40" value={sheet} onChange={(e) => setSheet(e.target.value)}>
              {workbook.sheets.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {rows.length > 0 && (
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">{t("importer.mapColumns")}</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2">
            {fields.map((def) => (
              <div key={def.field} className="flex items-center gap-3 text-sm">
                <span className={cx("w-44", def.required && "font-medium")}>
                  {t(def.labelKey)}
                  {def.required && <span className="text-red-500"> *</span>}
                </span>
                <Select
                  className="flex-1"
                  value={mapping[def.field] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [def.field]: e.target.value }))}
                >
                  <option value="">{t("importer.skip")}</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
            <div className="text-sm">
              {requiredUnmapped.length > 0 ? (
                <span className="text-red-600">
                  {t("importer.requiredMissing", { field: t(requiredUnmapped[0]!.labelKey) })}
                </span>
              ) : (
                <span className="text-slate-500">{t("importer.rowsValid", { valid: validCount, total: rows.length })}</span>
              )}
            </div>
            <Button variant="primary" disabled={running || requiredUnmapped.length > 0 || validCount === 0} onClick={() => void runImport()}>
              {t("importer.run")}
            </Button>
          </div>
        </Card>
      )}

      {result && (
        <Card className="p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
            <Check size={15} /> {t("importer.done", { count: result.imported })}
          </p>
          {result.errors.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-red-600">
              {result.errors.map((e) => (
                <li key={e} dir="ltr">{e}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {rows.length === 0 && workbook && <EmptyState message={t("common.noResults")} />}
    </div>
  );
}
