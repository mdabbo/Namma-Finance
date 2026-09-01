-- Optional v0.7.1 sync peer compatibility metadata.
--
-- Apply after supabase-0017-allocation-integrity-trigger-safe.sql. This table
-- does not hold business data; it advertises the client/schema/financial-sync
-- protocol a device is running so newer clients can refuse unsafe financial
-- sync with peers below the supported protocol.

CREATE TABLE IF NOT EXISTS public.sync_peers (
  uuid text PRIMARY KEY,
  application_version text,
  schema_version integer,
  financial_protocol_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE public.sync_peers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_peers_all ON public.sync_peers;
CREATE POLICY sync_peers_all ON public.sync_peers
FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sync_peers TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
