/**
 * Declarative sync registry. Order matters: parents before children, so
 * pulls can resolve FK uuids to local ids in a single pass (contract
 * milestone JSON refs are the one exception — they get a fix-up pass).
 *
 * Local rows keep their integer ids; identity across devices is sync_uuid.
 * FK columns hold integers locally and uuids remotely.
 */

export interface SyncTableSpec {
  name: string;
  /** Local data columns synced verbatim (besides id / sync_uuid / updated_at). */
  columns: string[];
  /** FK columns: local integer id ↔ remote uuid of `parent`. */
  fks: { column: string; parent: string }[];
  /** Local column → different remote name (the app's own soft delete). */
  remoteRenames?: Record<string, string>;
  /** This table's milestones JSON carries certificateId/stageId refs. */
  hasMilestoneRefs?: boolean;
}

export const SYNC_TABLES: SyncTableSpec[] = [
  {
    name: "clients",
    columns: ["name", "company", "address", "phone", "email", "tax_number", "contacts", "notes", "created_at", "archived_at", "archived_by", "archive_reason"],
    fks: [],
  },
  {
    name: "people",
    columns: ["type", "name", "specialization", "phone", "email", "bank_account", "hourly_rate_minor",
      "monthly_rate_minor", "currency", "notes", "is_active", "created_at", "archived_at", "archived_by", "archive_reason"],
    fks: [],
  },
  {
    name: "expense_categories",
    columns: ["name_en", "name_ar", "is_active", "sort_order"],
    fks: [],
  },
  {
    name: "projects",
    columns: ["code", "name", "client_id", "country", "city", "manager", "discipline", "project_type",
      "status", "currency", "fx_rate_micro", "start_date", "end_date", "progress_bp", "description", "created_at", "archived_at", "archived_by", "archive_reason"],
    fks: [{ column: "client_id", parent: "clients" }],
  },
  {
    name: "contracts",
    columns: ["project_id", "number", "title", "value_minor", "vat_bp", "retention_bp", "withholding_bp",
      "advance_minor", "advance_recovery_method", "performance_bond_bp", "performance_bond_bank",
      "performance_bond_expiry", "payment_terms_days", "payment_terms_notes", "valuation_mode",
      "milestones", "drawings", "signed_date", "notes", "created_at", "archived_at", "archived_by", "archive_reason"],
    fks: [{ column: "project_id", parent: "projects" }],
    hasMilestoneRefs: true,
  },
  {
    name: "project_stages",
    columns: ["project_id", "name", "sort_order", "start_date", "end_date", "status", "completion_bp",
      "engineers", "notes", "created_at"],
    fks: [{ column: "project_id", parent: "projects" }],
  },
  {
    name: "contract_revisions",
    columns: ["contract_id", "revision_number", "effective_date", "contract_value_minor", "vat_bp",
      "retention_bp", "withholding_bp", "advance_minor", "advance_recovery_method", "payment_terms_days",
      "currency", "fx_rate_micro", "reason", "created_at", "created_by", "approved_at"],
    fks: [{ column: "contract_id", parent: "contracts" }],
  },
  {
    name: "variation_orders",
    columns: ["contract_id", "revision_id", "number", "description", "value_delta_minor", "approved_at", "created_at", "created_by"],
    fks: [
      { column: "contract_id", parent: "contracts" },
      { column: "revision_id", parent: "contract_revisions" },
    ],
  },
  {
    name: "documents",
    // local_cache_path/path/is_available_offline are intentionally device-local.
    columns: ["project_id", "category", "title", "document_uuid", "original_filename", "extension", "mime_type",
      "size_bytes", "sha256", "storage_provider", "cloud_storage_key", "version_number", "uploaded_at", "uploaded_by",
      "archived_at", "added_at"],
    fks: [{ column: "project_id", parent: "projects" }],
  },
  {
    name: "time_entries",
    columns: ["person_id", "project_id", "stage_id", "date", "minutes", "billable", "note", "created_at"],
    fks: [
      { column: "person_id", parent: "people" },
      { column: "project_id", parent: "projects" },
      { column: "stage_id", parent: "project_stages" },
    ],
  },
  {
    name: "project_assignments",
    columns: ["person_id", "project_id", "agreed_minor", "currency", "fx_rate_micro", "scope",
      "progress_note", "created_at", "archived_at", "archived_by", "archive_reason"],
    fks: [
      { column: "person_id", parent: "people" },
      { column: "project_id", parent: "projects" },
    ],
  },
  {
    name: "payment_certificates",
    columns: ["contract_id", "seq", "number", "date", "submission_date", "due_date_override", "due_date_confirmed_at", "description",
      "gross_minor", "discount_minor", "manual_advance_recovery_minor", "status", "deleted_at", "created_at",
      "archived_at", "archived_by", "archive_reason", "voided_at", "voided_by", "void_reason", "reversal_of_id",
      "contract_revision_id", "contract_value_minor_snapshot", "vat_bp_snapshot", "retention_bp_snapshot",
      "withholding_bp_snapshot", "advance_minor_snapshot", "advance_method_snapshot", "payment_terms_days_snapshot",
      "currency_snapshot", "fx_rate_micro_snapshot"],
    fks: [
      { column: "contract_id", parent: "contracts" },
      { column: "reversal_of_id", parent: "payment_certificates" },
      { column: "contract_revision_id", parent: "contract_revisions" },
    ],
    remoteRenames: { deleted_at: "app_deleted_at" },
  },
  {
    name: "payments",
    columns: ["contract_id", "kind", "number", "date", "amount_minor", "method", "bank", "reference",
      "notes", "deleted_at", "created_at", "voided_at", "voided_by", "void_reason", "reversal_of_id"],
    fks: [
      { column: "contract_id", parent: "contracts" },
      { column: "reversal_of_id", parent: "payments" },
    ],
    remoteRenames: { deleted_at: "app_deleted_at" },
  },
  {
    name: "payment_certificate_allocations",
    columns: ["payment_id", "certificate_id", "amount_minor"],
    fks: [
      { column: "payment_id", parent: "payments" },
      { column: "certificate_id", parent: "payment_certificates" },
    ],
  },
  {
    name: "person_payments",
    columns: ["assignment_id", "date", "amount_minor", "note", "created_at", "voided_at", "voided_by", "void_reason", "reversal_of_id"],
    fks: [
      { column: "assignment_id", parent: "project_assignments" },
      { column: "reversal_of_id", parent: "person_payments" },
    ],
  },
  {
    name: "expenses",
    columns: ["number", "date", "category_id", "description", "project_id", "supplier", "amount_minor", "currency",
      "fx_rate_micro", "person_payment_id", "created_at", "archived_at", "archived_by", "archive_reason",
      "voided_at", "voided_by", "void_reason", "reversal_of_id"],
    fks: [
      { column: "category_id", parent: "expense_categories" },
      { column: "project_id", parent: "projects" },
      { column: "person_payment_id", parent: "person_payments" },
      { column: "reversal_of_id", parent: "expenses" },
    ],
  },
  {
    name: "recurring_expenses",
    columns: ["name", "category_id", "amount_minor", "currency", "fx_rate_micro", "day_of_month",
      "is_active", "notes", "created_at"],
    fks: [{ column: "category_id", parent: "expense_categories" }],
  },
];

/** Financial facts which must never use silent last-write-wins. */
export const CONFLICT_PROTECTED_TABLES = new Set([
  "contracts", "contract_revisions", "payment_certificates", "payments",
  "payment_certificate_allocations", "expenses", "person_payments",
]);

export const NUMBER_COLLISION_TABLES = new Set([
  "projects", "contracts", "payment_certificates", "payments", "expenses",
]);
