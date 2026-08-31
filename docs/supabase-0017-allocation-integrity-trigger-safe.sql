-- Forward-only, trigger-safe replacement for
-- supabase-0011-payment-allocation-integrity.sql on an existing cloud database.
-- No allocation is created, deleted, or repriced. Duplicate active links are
-- retained and explicitly marked as legacy integrity exceptions.

BEGIN;

ALTER TABLE public.payment_certificate_allocations
  ADD COLUMN IF NOT EXISTS integrity_exception boolean NOT NULL DEFAULT false;

-- A non-positive allocation is invalid financial data and requires explicit
-- review. Abort atomically instead of hiding or changing it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payment_certificate_allocations
    WHERE amount_minor <= 0
  ) THEN
    RAISE EXCEPTION 'NON_POSITIVE_PAYMENT_ALLOCATION_REQUIRES_REVIEW';
  END IF;
END $$;

-- Preserve every business timestamp while classifying pre-existing duplicate
-- active links. nf_lww_guard() would otherwise suppress this schema backfill.
ALTER TABLE public.payment_certificate_allocations
  DISABLE TRIGGER trg_payment_certificate_allocations_lww;

WITH ranked AS (
  SELECT
    uuid,
    row_number() OVER (
      PARTITION BY payment_id, certificate_id
      ORDER BY updated_at, uuid
    ) AS occurrence
  FROM public.payment_certificate_allocations
  WHERE deleted_at IS NULL
)
UPDATE public.payment_certificate_allocations AS allocation
SET integrity_exception = true
FROM ranked
WHERE ranked.uuid = allocation.uuid
  AND ranked.occurrence > 1
  AND NOT allocation.integrity_exception;

ALTER TABLE public.payment_certificate_allocations
  ENABLE TRIGGER trg_payment_certificate_allocations_lww;

-- Replace a partially-created legacy index if necessary. Soft-deleted cloud
-- tombstones must not block a future active allocation for the same pair.
DROP INDEX IF EXISTS public.payment_certificate_allocations_payment_certificate_key;
CREATE UNIQUE INDEX payment_certificate_allocations_payment_certificate_key
  ON public.payment_certificate_allocations(payment_id, certificate_id)
  WHERE NOT integrity_exception AND deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.payment_certificate_allocations'::regclass
      AND conname = 'payment_certificate_allocations_amount_positive'
  ) THEN
    ALTER TABLE public.payment_certificate_allocations
      ADD CONSTRAINT payment_certificate_allocations_amount_positive
      CHECK (amount_minor > 0);
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
