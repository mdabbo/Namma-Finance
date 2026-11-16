-- Apply after supabase-0020-stage-progress-log.sql.
-- Requires supabase-roles.sql and supabase-security-hardening.sql. Run
-- supabase-0021-preflight.sql first; it is read-only and says whether this
-- project is ready.
--
-- Phone capture, step F0 delta A: lets an ENGINEER login add and edit ITS OWN
-- time entries, and nothing else. See docs/F0-MOBILE-WRITE-POLICIES-DESIGN.md.
--
--  * user_roles.person_id links a login to one people row (cloud only; the
--    desktop schema does not change and no desktop upgrade is needed).
--  * nf_admin_set_user() lets an admin give a login a role and a person.
--  * Two policies let a login insert/update time entries of its own person.
--  * A guard trigger validates those writes, limits them to entries dated in
--    the last 14 days, and stamps updated_at on the server.
--
-- Finance roles (ADMIN, ACCOUNTANT), the SQL editor and the service role are
-- not affected: the guard returns at its first line for them.
--
-- Safe to re-run.
--
-- To link the first engineer by hand from the SQL editor (the function below
-- needs a signed-in admin, which the SQL editor is not):
--
--   insert into public.user_roles (user_id, email, role, person_id)
--   select u.id, u.email, 'ENGINEER', p.uuid
--   from auth.users u, public.people p
--   where lower(u.email) = lower('engineer@example.com')
--     and p.uuid = '00000000-0000-0000-0000-000000000000'
--   on conflict (user_id) do update
--     set role = excluded.role, person_id = excluded.person_id, updated_at = now();

DO $$
BEGIN
  IF to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: apply supabase-roles.sql first';
  END IF;
  IF to_regclass('public.time_entries') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: apply supabase-0007-time-entries.sql first';
  END IF;
  IF to_regprocedure('public.nf_can_manage_finance()') IS NULL
     OR to_regprocedure('public.nf_is_admin()') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: apply supabase-security-hardening.sql first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'time_entries' AND policyname = 'office_all'
  ) THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: time_entries still has the open office_all policy; re-apply supabase-security-hardening.sql';
  END IF;
END $$;

-- ─── the link from a login to a person ─────────────────────────────────────

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.people(uuid) ON DELETE SET NULL;

-- One login per person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles_person
  ON public.user_roles (person_id) WHERE person_id IS NOT NULL;

-- SECURITY DEFINER for the same reason as nf_is_admin(): these read
-- user_roles, whose own policies would otherwise hide the row or recurse.
CREATE OR REPLACE FUNCTION public.nf_my_person_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT person_id FROM user_roles WHERE user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.nf_is_own_person(p uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT p IS NOT NULL AND EXISTS (
     SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND person_id = p
   ) $$;

-- ─── giving a login a role (admin only) ────────────────────────────────────
-- The login itself is created in the dashboard (Authentication -> Users).
-- Until this function existed, a second login could not get a user_roles row
-- through the app at all.

CREATE OR REPLACE FUNCTION public.nf_admin_set_user(p_email text, p_role text, p_person uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
  v_email text;
  v_matches int;
BEGIN
  IF NOT nf_is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('ADMIN', 'ACCOUNTANT', 'ENGINEER') THEN
    RAISE EXCEPTION 'INVALID_ROLE';
  END IF;

  SELECT count(*) INTO v_matches FROM auth.users WHERE lower(email) = lower(btrim(p_email));
  IF v_matches = 0 THEN
    RAISE EXCEPTION 'LOGIN_NOT_FOUND';
  ELSIF v_matches > 1 THEN
    RAISE EXCEPTION 'LOGIN_AMBIGUOUS';
  END IF;
  SELECT id, email INTO v_user, v_email FROM auth.users WHERE lower(email) = lower(btrim(p_email));

  -- An admin who demotes their own login can leave the office with no admin.
  IF v_user = auth.uid() AND p_role <> 'ADMIN' THEN
    RAISE EXCEPTION 'CANNOT_DEMOTE_SELF';
  END IF;

  IF p_person IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM people WHERE uuid = p_person AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'PERSON_NOT_FOUND';
    END IF;
    IF EXISTS (SELECT 1 FROM user_roles WHERE person_id = p_person AND user_id <> v_user) THEN
      RAISE EXCEPTION 'PERSON_ALREADY_LINKED';
    END IF;
  END IF;

  INSERT INTO user_roles (user_id, email, role, person_id, updated_at)
  VALUES (v_user, v_email, p_role, p_person, now())
  ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email, role = EXCLUDED.role,
        person_id = EXCLUDED.person_id, updated_at = now();
  RETURN v_user;
END $$;

REVOKE ALL ON FUNCTION public.nf_admin_set_user(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nf_admin_set_user(text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.nf_admin_set_user(text, text, uuid) TO authenticated;

-- ─── own time entries ──────────────────────────────────────────────────────
-- Added beside namaa_member_read and namaa_finance_write. Permissive policies
-- combine with OR, so finance roles keep exactly the access they had.
-- There is deliberately no DELETE policy: removing an entry is a soft delete
-- (an UPDATE of deleted_at), which the desktops can pull. A hard delete would
-- vanish without any desktop hearing of it.

DROP POLICY IF EXISTS namaa_self_time_insert ON public.time_entries;
CREATE POLICY namaa_self_time_insert ON public.time_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.nf_is_own_person(person_id));

DROP POLICY IF EXISTS namaa_self_time_update ON public.time_entries;
CREATE POLICY namaa_self_time_update ON public.time_entries
  FOR UPDATE TO authenticated
  USING (public.nf_is_own_person(person_id))
  WITH CHECK (public.nf_is_own_person(person_id));

-- The date a YYYY-MM-DD text holds, or NULL when it is not a real calendar
-- date in exactly that form (2026-02-30, 1/2/2026, ...).
CREATE OR REPLACE FUNCTION public.nf_capture_parse_date(p_date text) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_date IS NULL OR p_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN make_date(substr(p_date, 1, 4)::int, substr(p_date, 6, 2)::int, substr(p_date, 9, 2)::int);
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- True when a time entry's date is from 14 days before today (UTC) to one day
-- after it. The extra day covers offices ahead of UTC, where "today" is
-- already tomorrow's date on the server for a few hours.
CREATE OR REPLACE FUNCTION public.nf_capture_date_open(p_date text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    public.nf_capture_parse_date(p_date)
      BETWEEN (now() AT TIME ZONE 'utc')::date - 14 AND (now() AT TIME ZONE 'utc')::date + 1,
    false)
$$;

-- The policies above are the security boundary. This guard exists so that a
-- refused write carries a reason the phone can show, and so that the write's
-- updated_at comes from the server: desktops pull by "updated_at > cursor",
-- and a phone with a slow clock would otherwise write rows they never see.
CREATE OR REPLACE FUNCTION public.nf_time_entry_capture_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
  -- Desktop sync (finance roles), the SQL editor and the service role:
  -- untouched.
  IF auth.uid() IS NULL OR nf_can_manage_finance() THEN
    RETURN NEW;
  END IF;

  IF NOT nf_is_own_person(NEW.person_id) THEN
    RAISE EXCEPTION 'TIME_ENTRY_NOT_OWN' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NOT nf_is_own_person(OLD.person_id) THEN
      RAISE EXCEPTION 'TIME_ENTRY_NOT_OWN' USING ERRCODE = '42501';
    END IF;
    IF NEW.uuid IS DISTINCT FROM OLD.uuid
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'TIME_ENTRY_IMMUTABLE_FIELD';
    END IF;
    -- The stored date is checked too, so a locked entry cannot be edited by
    -- moving it into the open window.
    IF NOT nf_capture_date_open(OLD.date) THEN
      RAISE EXCEPTION 'TIME_ENTRY_LOCKED';
    END IF;
  END IF;

  IF nf_capture_parse_date(NEW.date) IS NULL THEN
    RAISE EXCEPTION 'TIME_ENTRY_INVALID_DATE';
  END IF;
  IF NOT nf_capture_date_open(NEW.date) THEN
    RAISE EXCEPTION 'TIME_ENTRY_LOCKED';
  END IF;

  -- Same bounds as timeEntrySchema in @mep/core.
  IF NEW.minutes IS NULL OR NEW.minutes < 1 OR NEW.minutes > 60000 THEN
    RAISE EXCEPTION 'TIME_ENTRY_INVALID_MINUTES';
  END IF;
  IF NEW.billable IS NULL OR NEW.billable NOT IN (0, 1) THEN
    RAISE EXCEPTION 'TIME_ENTRY_INVALID_BILLABLE';
  END IF;

  -- Checked on insert and when the reference changes, so an entry can still be
  -- corrected or withdrawn after its project or stage was removed.
  IF TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    IF NOT EXISTS (SELECT 1 FROM projects WHERE uuid = NEW.project_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'TIME_ENTRY_PROJECT_UNAVAILABLE';
    END IF;
  END IF;
  IF NEW.stage_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
          OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM project_stages
      WHERE uuid = NEW.stage_id AND project_id = NEW.project_id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'TIME_ENTRY_STAGE_MISMATCH';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := v_now;
  ELSE
    NEW.updated_at := greatest(v_now, OLD.updated_at + interval '1 millisecond');
  END IF;
  RETURN NEW;
END $$;

-- BEFORE triggers fire in name order: "capture_guard" runs before "lww", so
-- the last-write-wins guard sees the server-stamped updated_at.
DROP TRIGGER IF EXISTS trg_time_entries_capture_guard ON public.time_entries;
CREATE TRIGGER trg_time_entries_capture_guard
  BEFORE INSERT OR UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.nf_time_entry_capture_guard();

NOTIFY pgrst, 'reload schema';
