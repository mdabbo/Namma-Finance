/**
 * Domain model. Mirrors the SQLite schema 1:1.
 *
 * Conventions:
 *  - `*Minor`  → integer amount in the currency's minor unit (piasters/cents/fils)
 *  - `*Bp`     → integer rate in basis points (14% = 1400)
 *  - `fxRateMicro` → EGP per 1 major unit of the currency × 1e6
 *  - dates     → ISO strings "YYYY-MM-DD"
 *  - derived figures (VAT, retention, net payable, balances…) are NEVER stored;
 *    they are computed by `calc/` from these source records.
 */

export type Discipline =
  | "HVAC"
  | "PLUMBING"
  | "FIREFIGHTING"
  | "ELECTRICAL"
  | "BIM"
  | "ARCHITECTURE"
  | "STRUCTURAL"
  | "ID"
  | "MULTI";

/** How a contract's value is composed. Certificates remain free-form (Phase 2 links them). */
export type ContractValuationMode = "LUMP_SUM" | "MILESTONES" | "DRAWINGS";
export type ProjectStatus = "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
export type CertificateStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "PAID";
export type PaymentMethod = "BANK_TRANSFER" | "CHEQUE" | "CASH";
export type PaymentKind = "CERTIFICATE" | "ADVANCE" | "RETENTION_RELEASE";
export type AdvanceRecoveryMethod = "PROPORTIONAL" | "MANUAL";
export type PersonType = "EMPLOYEE" | "FREELANCER";

export interface Client {
  id: number;
  name: string;
  company: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  contacts: string | null; // JSON: [{name, role, phone, email}]
  notes: string | null;
  createdAt: string;
}

export interface Project {
  id: number;
  code: string; // auto-generated PRJ-YYYY-NNN
  name: string;
  clientId: number;
  country: string | null;
  city: string | null;
  manager: string | null;
  discipline: Discipline;
  projectType: string | null;
  status: ProjectStatus;
  currency: string;
  fxRateMicro: number; // EGP per major unit ×1e6; 1_000_000 for EGP
  startDate: string | null;
  endDate: string | null;
  progressBp: number; // manual progress 0..10000
  description: string | null;
  createdAt: string;
}

export interface Contract {
  id: number;
  projectId: number;
  number: string;
  title: string | null;
  valueMinor: number; // contract value excl. VAT, in project currency
  vatBp: number;
  retentionBp: number;
  withholdingBp: number;
  advanceMinor: number; // advance/down payment amount (excl. VAT)
  advanceRecoveryMethod: AdvanceRecoveryMethod;
  performanceBondBp: number; // tracking only — never affects calculations
  performanceBondBank: string | null;
  performanceBondExpiry: string | null;
  paymentTermsDays: number; // certificate due = submission + this many days
  paymentTermsNotes: string | null;
  valuationMode: ContractValuationMode;
  milestones: string | null; // JSON PercentMilestone[] (MILESTONES mode)
  drawings: string | null; // JSON DrawingLine[] (DRAWINGS mode)
  attachments: string | null; // JSON: [path]
  signedDate: string | null;
  notes: string | null;
  createdAt: string;
}

export interface PaymentCertificate {
  id: number;
  contractId: number;
  /** Order of the certificate within its contract; drives advance-recovery threading. */
  seq: number;
  number: string;
  date: string;
  submissionDate: string | null;
  dueDateOverride: string | null;
  description: string | null;
  grossMinor: number;
  discountMinor: number;
  /** Used only when the contract's advance recovery method is MANUAL. */
  manualAdvanceRecoveryMinor: number | null;
  status: CertificateStatus;
  deletedAt: string | null;
  createdAt: string;
}

export interface Payment {
  id: number;
  contractId: number;
  kind: PaymentKind;
  number: string;
  date: string;
  amountMinor: number;
  method: PaymentMethod;
  bank: string | null;
  reference: string | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface PaymentAllocation {
  id: number;
  paymentId: number;
  certificateId: number;
  amountMinor: number;
}

export interface ExpenseCategory {
  id: number;
  nameEn: string;
  nameAr: string;
  isActive: boolean;
  sortOrder: number;
}

export interface Expense {
  id: number;
  date: string;
  categoryId: number;
  description: string;
  projectId: number | null; // null = Overhead
  supplier: string | null;
  amountMinor: number;
  currency: string;
  fxRateMicro: number;
  attachmentPath: string | null;
  createdAt: string;
}

export interface Person {
  id: number;
  type: PersonType;
  name: string;
  specialization: string | null;
  phone: string | null;
  email: string | null;
  bankAccount: string | null;
  hourlyRateMinor: number | null;
  monthlyRateMinor: number | null;
  currency: string;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface ProjectAssignment {
  id: number;
  personId: number;
  projectId: number;
  agreedMinor: number;
  currency: string;
  fxRateMicro: number;
  scope: string | null;
  progressNote: string | null;
  createdAt: string;
}

export interface PersonPayment {
  id: number;
  assignmentId: number;
  date: string;
  amountMinor: number;
  note: string | null;
  createdAt: string;
}

export type StageStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "ON_HOLD";
export type DocumentCategory = "CONTRACT" | "BOQ" | "PROPOSAL" | "INVOICE" | "DRAWING" | "OTHER";

export interface ProjectStage {
  id: number;
  projectId: number;
  name: string;
  sortOrder: number;
  startDate: string | null;
  endDate: string | null;
  status: StageStatus;
  completionBp: number;
  engineers: string | null; // comma-separated names (roles come with Phase 5)
  notes: string | null;
  createdAt: string;
}

export interface ProjectDocument {
  id: number;
  projectId: number;
  category: DocumentCategory;
  title: string;
  path: string; // managed file reference — the file stays where it is
  addedAt: string;
}

export interface RecurringExpense {
  id: number;
  name: string;
  categoryId: number;
  amountMinor: number;
  currency: string;
  fxRateMicro: number;
  dayOfMonth: number;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
}

export interface TimeEntry {
  id: number;
  personId: number;
  projectId: number;
  /** Optional project stage the hours are attributed to. */
  stageId: number | null;
  date: string;
  /** Duration in whole minutes (integer — never floating hours). */
  minutes: number;
  billable: boolean;
  note: string | null;
  createdAt: string;
}

/** The standard stage template (i18n keys under `stages.template.*`). */
export const STANDARD_STAGE_KEYS = [
  "proposal",
  "concept",
  "d30",
  "d60",
  "d90",
  "ifc",
  "shopDrawings",
  "asBuilt",
  "constructionSupport",
] as const;

/** Certificate statuses that count toward financial totals (drafts are excluded). */
export const BILLABLE_STATUSES: readonly CertificateStatus[] = ["SUBMITTED", "APPROVED", "PAID"];

export function isBillable(status: CertificateStatus): boolean {
  return BILLABLE_STATUSES.includes(status);
}
