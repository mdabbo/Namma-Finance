import { z } from "zod";
import { CURRENCIES } from "../money/currency";

const minor = z.number().int().safe();
const nonNegMinor = minor.min(0);
const bp = z.number().int().min(0).max(10_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");
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
});

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
    milestones: z.string().nullish(),
    drawings: z.string().nullish(),
    attachments: z.string().nullish(),
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
  })
  .refine((c) => c.discountMinor <= c.grossMinor, {
    message: "discount_exceeds_gross",
    path: ["discountMinor"],
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
});

export const documentSchema = z.object({
  projectId: z.number().int().positive(),
  category: z.enum(["CONTRACT", "BOQ", "PROPOSAL", "INVOICE", "DRAWING", "OTHER"]),
  title: z.string().trim().min(1, "required"),
  path: z.string().min(1, "required"),
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
  minutes: z.number().int().min(1, "required").max(24 * 60),
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
