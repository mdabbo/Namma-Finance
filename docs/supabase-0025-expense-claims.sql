-- Apply after supabase-0023-assignment-contract-fees.sql (needs
-- supabase-0021-time-entry-capture.sql for nf_is_own_person, and the
-- namaa-documents bucket from supabase-0013-managed-documents.sql).
--
-- Phone capture, step F6 (delta C of docs/F0-MOBILE-WRITE-POLICIES-DESIGN.md):
-- expense CLAIMS. The phone files a claim (what was bought, how much, a photo of
-- the receipt); the office accepts or rejects it on the desktop, and only
-- ACCEPTING creates an expense. A claim is never an expense: it does not touch
-- profit, numbering or any report until the desktop turns it into one.
--
--  * public.expense_claims: one row per claim. There is no status column: a
--    claim with no decision is pending.
--  * ENGINEER logins may file and change THEIR OWN claims while pending, and
--    withdraw them. They can never decide one.
--  * ADMIN and ACCOUNTANT may do everything the desktop needs, including
--    recording the decision.
--  * Once decided, a claim is EVIDENCE: no login can change what it says. The
--    expense created from it was built from those exact figures, so a late edit
--    would leave the two disagreeing. Only the SQL editor / service role can.
--  * Finance logins may read every receipt in the namaa-documents bucket. Until
--    now each object could be read only by the login that uploaded it, so an
--    accountant could not open an engineer's photo.
--
-- It only ADDS a table, a trigger and one storage policy. Nothing existing is
-- read, changed or removed, and no desktop upgrade is needed to apply it (a
-- desktop without the claims feature never touches this table).
--
-- Safe to re-run.

DO $$
BEGIN
  IF to_regprocedure('public.nf_lww_guard()') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: nf_lww_guard() does not exist (apply supabase-schema.sql first)';
  END IF;
  IF to_regprocedure('public.nf_is_member()') IS NULL OR to_regprocedure('public.nf_can_manage_finance()') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: role helpers do not exist (apply supabase-security-hardening.sql first)';
  END IF;
  IF to_regprocedure('public.nf_is_own_person(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: nf_is_own_person() does not exist (apply supabase-0021-time-entry-capture.sql first)';
  END IF;
  IF to_regprocedure('public.nf_capture_parse_date(text)') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: nf_capture_parse_date() does not exist (apply supabase-0021-time-entry-capture.sql first)';
  END IF;
  IF to_regclass('public.people') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.expense_categories') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: people, projects or expense_categories does not exist (apply supabase-schema.sql first)';
  END IF;
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: storage.objects does not exist';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.expense_claims (
  uuid uuid PRIMARY KEY,
  -- who is claiming; claims are kept even if the person later leaves
  person_id uuid NOT NULL REFERENCES public.people(uuid) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(uuid) ON DELETE SET NULL,
  -- the accountant may set or change it when accepting
  category_id uuid REFERENCES public.expense_categories(uuid) ON DELETE SET NULL,
  date text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description text NOT NULL CHECK (btrim(description) <> ''),
  supplier text,
  receipt_storage_key text,
  receipt_sha256 text,
  submitted_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('ACCEPTED', 'REJECTED')),
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  created_at text,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  -- A receipt is a file AND its fingerprint, or neither.
  CONSTRAINT expense_claims_receipt_pair CHECK ((receipt_storage_key IS NULL) = (receipt_sha256 IS NULL)),
  CONSTRAINT expense_claims_receipt_sha CHECK (receipt_sha256 IS NULL OR receipt_sha256 ~ '^[0-9a-f]{64}$'),
  -- A claim with no decision has none of the decision fields; a decided one has
  -- its time, and a rejection says why.
  CONSTRAINT expense_claims_decision_shape CHECK (
    (decision IS NULL AND decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL)
    OR (decision IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT expense_claims_rejection_reason CHECK (
    decision IS DISTINCT FROM 'REJECTED' OR (decision_reason IS NOT NULL AND btrim(decision_reason) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_expense_claims_updated ON public.expense_claims (updated_at);
CREATE INDEX IF NOT EXISTS idx_expense_claims_person ON public.expense_claims (person_id);

-- ─── who may do what ───────────────────────────────────────────────────────
-- Permissive policies combine with OR, so finance logins keep full access and
-- an engineer additionally gets the two own-claim policies. There is no DELETE
-- policy for engineers: withdrawing is a soft delete (an UPDATE of deleted_at)
-- that the desktops can pull.

ALTER TABLE public.expense_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS namaa_member_read ON public.expense_claims;
CREATE POLICY namaa_member_read ON public.expense_claims
  FOR SELECT TO authenticated USING (public.nf_is_member());

DROP POLICY IF EXISTS namaa_finance_write ON public.expense_claims;
CREATE POLICY namaa_finance_write ON public.expense_claims
  FOR ALL TO authenticated
  USING (public.nf_can_manage_finance()) WITH CHECK (public.nf_can_manage_finance());

DROP POLICY IF EXISTS namaa_self_claim_insert ON public.expense_claims;
CREATE POLICY namaa_self_claim_insert ON public.expense_claims
  FOR INSERT TO authenticated
  WITH CHECK (public.nf_is_own_person(person_id));

DROP POLICY IF EXISTS namaa_self_claim_update ON public.expense_claims;
CREATE POLICY namaa_self_claim_update ON public.expense_claims
  FOR UPDATE TO authenticated
  USING (public.nf_is_own_person(person_id))
  WITH CHECK (public.nf_is_own_person(person_id));

-- ─── the guard ─────────────────────────────────────────────────────────────
-- The policies above are the security boundary for engineers; this trigger
-- adds the rules RLS cannot express, with named errors the phone can show.
-- The SQL editor and the service role (auth.uid() is null) are untouched.

CREATE OR REPLACE FUNCTION public.nf_expense_claim_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_finance boolean := public.nf_can_manage_finance();
  v_date date;
  v_today date := (now() AT TIME ZONE 'utc')::date;
  v_content_changed boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- A decided claim is evidence: nothing it says may change, for any login.
  -- Withdrawing it later (deleted_at) stays a finance decision.
  IF TG_OP = 'UPDATE' AND OLD.decision IS NOT NULL THEN
    v_content_changed :=
         NEW.uuid IS DISTINCT FROM OLD.uuid
      OR NEW.person_id IS DISTINCT FROM OLD.person_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.category_id IS DISTINCT FROM OLD.category_id
      OR NEW.date IS DISTINCT FROM OLD.date
      OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.supplier IS DISTINCT FROM OLD.supplier
      OR NEW.receipt_storage_key IS DISTINCT FROM OLD.receipt_storage_key
      OR NEW.receipt_sha256 IS DISTINCT FROM OLD.receipt_sha256
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.decision IS DISTINCT FROM OLD.decision
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
      OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason;
    IF v_content_changed THEN
      RAISE EXCEPTION 'CLAIM_DECIDED_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NOT v_finance THEN
      RAISE EXCEPTION 'CLAIM_DECIDED_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- From here the claim is new or still pending.
  IF NOT v_finance THEN
    IF NOT public.nf_is_own_person(NEW.person_id) THEN
      RAISE EXCEPTION 'CLAIM_NOT_OWN' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NOT public.nf_is_own_person(OLD.person_id) THEN
        RAISE EXCEPTION 'CLAIM_NOT_OWN' USING ERRCODE = '42501';
      END IF;
      IF NEW.uuid IS DISTINCT FROM OLD.uuid
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
         OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
        RAISE EXCEPTION 'CLAIM_IMMUTABLE_FIELD';
      END IF;
    END IF;
    -- Deciding is the office's job.
    IF NEW.decision IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.decided_by IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN
      RAISE EXCEPTION 'CLAIM_DECISION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_date := public.nf_capture_parse_date(NEW.date);
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'CLAIM_INVALID_DATE';
  END IF;
  -- A receipt cannot be from the future; one day of slack covers an office
  -- ahead of UTC. Old receipts are fine: people claim late.
  IF v_date > v_today + 1 THEN
    RAISE EXCEPTION 'CLAIM_INVALID_DATE';
  END IF;

  -- The receipt file must be the one named for THIS claim, so a claim cannot
  -- point at someone else's photo. An engineer may only point into their own
  -- folder, the one the storage policy lets them write.
  IF NEW.receipt_storage_key IS NOT NULL THEN
    IF NEW.receipt_storage_key !~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/claims/' || NEW.uuid::text || '\.jpg$') THEN
      RAISE EXCEPTION 'CLAIM_INVALID_RECEIPT';
    END IF;
    IF NOT v_finance AND split_part(NEW.receipt_storage_key, '/', 1) <> auth.uid()::text THEN
      RAISE EXCEPTION 'CLAIM_INVALID_RECEIPT' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    IF NEW.project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.projects WHERE uuid = NEW.project_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'CLAIM_PROJECT_UNAVAILABLE';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    IF NEW.category_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE uuid = NEW.category_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'CLAIM_CATEGORY_UNAVAILABLE';
    END IF;
  END IF;

  -- An engineer's writes are stamped by the server, so a phone with a slow clock
  -- cannot write a row the desktops' "updated_at > cursor" pull would skip.
  -- Finance logins stamp their own (the desktop does); the phone's outbox asks
  -- the cloud for the time first.
  IF NOT v_finance THEN
    IF TG_OP = 'INSERT' THEN
      NEW.updated_at := date_trunc('milliseconds', clock_timestamp());
    ELSE
      NEW.updated_at := greatest(date_trunc('milliseconds', clock_timestamp()), OLD.updated_at + interval '1 millisecond');
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- BEFORE triggers fire in name order: "capture_guard" runs before "lww", so the
-- last-write-wins guard sees the server-stamped updated_at.
DROP TRIGGER IF EXISTS trg_expense_claims_capture_guard ON public.expense_claims;
CREATE TRIGGER trg_expense_claims_capture_guard
  BEFORE INSERT OR UPDATE ON public.expense_claims
  FOR EACH ROW EXECUTE FUNCTION public.nf_expense_claim_guard();

DROP TRIGGER IF EXISTS trg_expense_claims_lww ON public.expense_claims;
CREATE TRIGGER trg_expense_claims_lww
  BEFORE UPDATE ON public.expense_claims
  FOR EACH ROW EXECUTE FUNCTION public.nf_lww_guard();

-- ─── receipts ──────────────────────────────────────────────────────────────
-- The bucket's existing policies let each login read and write only its own
-- folder, so an accountant could not open an engineer's receipt photo. Finance
-- logins may read every object in the bucket (read only).

DROP POLICY IF EXISTS namaa_documents_finance_read ON storage.objects;
CREATE POLICY namaa_documents_finance_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'namaa-documents' AND public.nf_can_manage_finance());

-- Make the new table visible to the API straight away.
NOTIFY pgrst, 'reload schema';
