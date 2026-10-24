-- F08/F09 lifecycle controls, tenant research queues, and source-use metadata.
ALTER TABLE graph_edges
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS stale_after timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS graph_edges_active_idx ON graph_edges(tenant_id,from_id,to_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS graph_edge_events (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), edge_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('verified','disputed','corrected','archived','marked_stale')),
 actor_id uuid, before_data jsonb NOT NULL DEFAULT '{}', after_data jsonb NOT NULL DEFAULT '{}', note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS graph_edge_events_history_idx ON graph_edge_events(tenant_id,edge_id,created_at);

CREATE TABLE IF NOT EXISTS research_sources (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL,
 source_type text NOT NULL CHECK(source_type IN ('public_filing','licensed_provider','manual','other')),
 source_url text, license_label text NOT NULL, permitted_uses text[] NOT NULL DEFAULT '{}',
 export_allowed boolean NOT NULL DEFAULT false, outreach_allowed boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true, notes text NOT NULL DEFAULT '', created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
 CHECK(source_url IS NULL OR source_url ~ '^https://')
);
CREATE UNIQUE INDEX IF NOT EXISTS research_sources_name_idx ON research_sources(tenant_id,lower(name));

CREATE TABLE IF NOT EXISTS research_queue (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), title text NOT NULL,
 criteria jsonb NOT NULL DEFAULT '{}', source_ids uuid[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','in_progress','ready_for_review','completed','cancelled')),
 budget_cap_minor bigint NOT NULL DEFAULT 0 CHECK(budget_cap_minor>=0), currency char(3) NOT NULL DEFAULT 'USD',
 assigned_to uuid, created_by uuid NOT NULL, due_at timestamptz, outcome jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,assigned_to) REFERENCES memberships(tenant_id,user_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);

CREATE TABLE IF NOT EXISTS prospect_research_controls (
 tenant_id uuid NOT NULL REFERENCES tenants(id), prospect_id uuid NOT NULL, excluded boolean NOT NULL DEFAULT false,
 opted_out boolean NOT NULL DEFAULT false, reason text NOT NULL DEFAULT '', updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,prospect_id), FOREIGN KEY(tenant_id,prospect_id) REFERENCES prospects(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS research_preferences (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), weights jsonb NOT NULL DEFAULT '{"affinity":35,"philanthropy":25,"connection":20,"recency":10,"geography":10}', updated_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id),
 CHECK(jsonb_typeof(weights)='object')
);

-- Immutable source history lets a later amended filing supersede an earlier
-- import without rewriting the evidence that informed previous decisions.
CREATE TABLE IF NOT EXISTS research_filing_versions (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 prospect_id uuid NOT NULL, filing_key text NOT NULL, source_fingerprint text NOT NULL,
 source_version text NOT NULL, source_url text NOT NULL CHECK(source_url ~ '^https://'),
 filing_year text NOT NULL, filing_status text NOT NULL CHECK(filing_status IN ('original','amended','corrected','unknown')),
 received_at timestamptz NOT NULL, supersedes_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,prospect_id,source_version),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES prospects(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,supersedes_id) REFERENCES research_filing_versions(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS research_filing_history_idx ON research_filing_versions(tenant_id,filing_key,received_at DESC);

DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['graph_edge_events','research_sources','research_queue','prospect_research_controls','research_preferences','research_filing_versions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
END LOOP; END $$;
