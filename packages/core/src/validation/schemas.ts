import { z } from "zod";
import { CURRENCIES } from "../money/currency";
import { isIsoCalendarDate } from "./date";
import { parseAttachmentsResult,parseDrawingsResult,parseMilestonesResult } from "../calc/valuation";

const minor = z.number().int().safe();
const nonNegMinor = minor.min(0);
const bp = z.number().int().min(0).max(10_000);
export const isoDate = z.string().refine(isIsoCalendarDate, "invalid_date");
const currencyCode = z.string().refine((c) => c in CURRENCIES, "invalid_currency");
const fxMicro = z.number().int().positive();

export const clientSchema = z.object({
  name: z.string().trim().min(1, "required"),
  company: z.string().trim().nullish(),
  address: z.string().trim().nullish(),
  phone: z.string().trim().nullish(),
  email: z.string().trim().email("invalid_email").nullish().or(z.literal("").transform(() => null)),
  taxNumber: z.string().trim().nullish(),
  contacts: z.string().nullish(),
  notes: z.string().nullish(),
});

export const projectSchema = z.object({
  name: z.string().trim().min(1, "required"),
  clientId: z.number().int().positive("required"),
  country: z.string().trim().nullish(),
  city: z.string().trim().nullish(),
  manager: z.string().trim().nullish(),
  discipline: z.enum(["HVAC", "PLUMBING", "FIREFIGHTING", "ELECTRICAL", "BIM", "ARCHITECTURE", "STRUCTURAL", "ID", "MULTI"]),
  projectType: z.string().trim().nullish(),
  status: z.enum(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"]),
  currency: currencyCode,
  fxRateMicro: fxMicro,
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
  progressBp: bp,
  description: z.string().nullish(),
}).refine((value)=>!value.startDate || !value.endDate || value.endDate>=value.startDate,{message:"end_before_start",path:["endDate"]});

export const contractSchema = z
  .object({
    projectId: z.number().int().positive(),
    number: z.string().trim().min(1, "required"),
    title: z.string().trim().nullish(),
    valueMinor: nonNegMinor,
    vatBp: bp,
    retentionBp: bp,
    withholdingBp: bp,
    advanceMinor: nonNegMinor,
    advanceRecoveryMethod: z.enum(["PROPORTIONAL", "MANUAL"]),
    performanceBondBp: bp,
    performanceBondBank: z.string().trim().nullish(),
    performanceBondExpiry: isoDate.nullish(),
    paymentTermsDays: z.number().int().min(0).max(3650),
    paymentTermsNotes: z.string().nullish(),
    valuationMode: z.enum(["LUMP_SUM", "MILESTONES", "DRAWINGS"]),
    milestones: z.string().nullish().refine((value)=>parseMilestonesResult(value).ok,"malformed_json"),
    drawings: z.string().nullish().refine((value)=>parseDrawingsResult(value).ok,"malformed_json"),
    attachments: z.string().nullish().refine((value)=>parseAttachmentsResult(value).ok,"malformed_json"),
    signedDate: isoDate.nullish(),
    notes: z.string().nullish(),
  })
  .refine((c) => c.advanceMinor <= c.valueMinor, {
    message: "advance_exceeds_value",
    path: ["advanceMinor"],
  });

export const certificateSchema = z
  .object({
    contractId: z.number().int().positive(),
    number: z.string().trim().min(1, "required"),
    date: isoDate,
    submissionDate: isoDate.nullish(),
    dueDateOverride: isoDate.nullish(),
    description: z.string().nullish(),
    grossMinor: nonNegMinor,
    discountMinor: nonNegMinor,
    manualAdvanceRecoveryMinor: nonNegMinor.nullish(),
    status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "PAID"]),
    dueDateConfirmed: z.boolean().optional(),
  })
  .refine((c) => c.discountMinor <= c.grossMinor, {
    message: "discount_exceeds_gross",
    path: ["discountMinor"],
  })
  .refine((c)=>!c.submissionDate || !c.dueDateOverride || c.dueDateOverride>=c.submissionDate || c.dueDateConfirmed===true,{
    message:"due_before_submission",path:["dueDateOverride"],
  });

export const paymentSchema = z.object({
  contractId: z.number().int().positive(),
  kind: z.enum(["CERTIFICATE", "ADVANCE", "RETENTION_RELEASE"]),
  number: z.string().trim().min(1, "required"),
  date: isoDate,
  amountMinor: minor.positive("required"),
  method: z.enum(["BANK_TRANSFER", "CHEQUE", "CASH"]),
  bank: z.string().trim().nullish(),
  reference: z.string().trim().nullish(),
  notes: z.string().nullish(),
});

export const expenseSchema = z.object({
  date: isoDate,
  categoryId: z.number().int().positive("required"),
  description: z.string().trim().min(1, "required"),
  projectId: z.number().int().positive().nullish(), // null = overhead
  supplier: z.string().trim().nullish(),
  amountMinor: minor.positive("required"),
  currency: currencyCode,
  fxRateMicro: fxMicro,
  attachmentPath: z.string().nullish(),
});

export const personSchema = z.object({
  type: z.enum(["EMPLOYEE", "FREELANCER"]),
  name: z.string().trim().min(1, "required"),
  specialization: z.string().trim().nullish(),
  phone: z.string().trim().nullish(),
  email: z.string().trim().email("invalid_email").nullish().or(z.literal("").transform(() => null)),
  bankAccount: z.string().trim().nullish(),
  hourlyRateMinor: nonNegMinor.nullish(),
  monthlyRateMinor: nonNegMinor.nullish(),
  currency: currencyCode,
  notes: z.string().nullish(),
  isActive: z.boolean(),
});

export const assignmentSchema = z.object({
  personId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  agreedMinor: nonNegMinor,
  currency: currencyCode,
  fxRateMicro: fxMicro,
  scope: z.string().nullish(),
  progressNote: z.string().nullish(),
});

export const personPaymentSchema = z.object({
  assignmentId: z.number().int().positive(),
  date: isoDate,
  amountMinor: minor.positive("required"),
  note: z.string().nullish(),
});

export const stageSchema = z.object({
  projectId: z.number().int().positive(),
  name: z.string().trim().min(1, "required"),
  sortOrder: z.number().int().min(0),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
  status: z.enum(["PLANNED", "IN_PROGRESS", "COMPLETED", "ON_HOLD"]),
  completionBp: bp,
  engineers: z.string().nullish(),
  notes: z.string().nullish(),
}).refine((value)=>!value.startDate || !value.endDate || value.endDate>=value.startDate,{message:"end_before_start",path:["endDate"]});

export const documentSchema = z.object({
  projectId: z.number().int().positive(),
  category: z.enum(["CONTRACT", "BOQ", "PROPOSAL", "INVOICE", "DRAWING", "OTHER"]),
  title: z.string().trim().min(1, "required"),
  documentUuid: z.string().uuid(),
  originalFilename: z.string().trim().min(1, "required"),
  extension: z.string().nullish(),
  mimeType: z.string().trim().min(1, "required"),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageProvider: z.enum(["LOCAL_ONLY", "SUPABASE", "LEGACY_LOCAL"]),
  cloudStorageKey: z.string().nullish(),
  localCachePath: z.string().nullish(),
  versionNumber: z.number().int().positive(),
  uploadedAt: z.string().nullish(),
  uploadedBy: z.string().nullish(),
  isAvailableOffline: z.boolean(),
});

export const recurringExpenseSchema = z.object({
  name: z.string().trim().min(1, "required"),
  categoryId: z.number().int().positive("required"),
  amountMinor: minor.positive("required"),
  currency: currencyCode,
  fxRateMicro: fxMicro,
  dayOfMonth: z.number().int().min(1).max(31),
  isActive: z.boolean(),
  notes: z.string().nullish(),
});

export const timeEntrySchema = z.object({
  personId: z.number().int().positive("required"),
  projectId: z.number().int().positive("required"),
  stageId: z.number().int().positive().nullish(),
  date: isoDate,
  minutes: z.number().int().min(1, "required").max(60_000, "max_hours"), // up to 1000 h per entry
  billable: z.boolean(),
  note: z.string().nullish(),
});
export type TimeEntryInput = z.infer<typeof timeEntrySchema>;

export type StageInput = z.infer<typeof stageSchema>;
export type DocumentInput = z.infer<typeof documentSchema>;
export type RecurringExpenseInput = z.infer<typeof recurringExpenseSchema>;

export type ClientInput = z.infer<typeof clientSchema>;
export type ProjectInput = z.infer<typeof projectSchema>;
export type ContractInput = z.infer<typeof contractSchema>;
export type CertificateInput = z.infer<typeof certificateSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
export type PersonInput = z.infer<typeof personSchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type PersonPaymentInput = z.infer<typeof personPaymentSchema>;
