-- Typed graph inventory, source-linked research, audit events, and funnel history.
CREATE TABLE IF NOT EXISTS graph_nodes (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 entity_id uuid NOT NULL, node_type text NOT NULL CHECK(node_type IN ('person','household','organization','employer','nonprofit','foundation','school','board','event')),
 display_name text NOT NULL, source_resource text NOT NULL CHECK(source_resource IN ('contacts','prospects','organizations','households','events')),
 privacy_scope text NOT NULL DEFAULT 'tenant' CHECK(privacy_scope IN ('public_source','tenant','restricted')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,entity_id)
);
CREATE INDEX IF NOT EXISTS graph_nodes_type_name_idx ON graph_nodes(tenant_id,node_type,lower(display_name));
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_source_fk FOREIGN KEY(tenant_id,source_id) REFERENCES research_sources(tenant_id,id);

ALTER TABLE prospect_evidence ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE prospect_evidence ADD CONSTRAINT prospect_evidence_source_fk FOREIGN KEY(tenant_id,source_id) REFERENCES research_sources(tenant_id,id);
CREATE INDEX IF NOT EXISTS prospect_evidence_source_idx ON prospect_evidence(tenant_id,source_id,prospect_id);
ALTER TABLE research_filing_versions ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE research_filing_versions ADD CONSTRAINT research_filing_source_fk FOREIGN KEY(tenant_id,source_id) REFERENCES research_sources(tenant_id,id);
CREATE TABLE IF NOT EXISTS research_import_batches (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), source_id uuid NOT NULL,
 imported_by uuid NOT NULL, source_version text NOT NULL, records_seen integer NOT NULL, records_imported integer NOT NULL,
 duplicates integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES research_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,imported_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS research_import_batch_idx ON research_import_batches(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS prospect_review_events (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), prospect_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('accepted','rejected','merged','split','stage_changed')),
 reason text NOT NULL, related_prospect_id uuid, actor_id uuid NOT NULL, before_data jsonb NOT NULL DEFAULT '{}', after_data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES prospects(tenant_id,id),
 FOREIGN KEY(tenant_id,related_prospect_id) REFERENCES prospects(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS prospect_review_history_idx ON prospect_review_events(tenant_id,prospect_id,created_at DESC);

ALTER TABLE introduction_events ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE introduction_events ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE introduction_events ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT '';
ALTER TABLE introduction_events ADD CONSTRAINT introduction_events_owner_fk FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id);

CREATE TABLE IF NOT EXISTS prospect_stage_events (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), prospect_id uuid NOT NULL,
 from_stage text NOT NULL, to_stage text NOT NULL, reason text NOT NULL DEFAULT '', actor_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES prospects(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS prospect_stage_funnel_idx ON prospect_stage_events(tenant_id,occurred_at,to_stage);

DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['graph_nodes','prospect_review_events','prospect_stage_events','research_import_batches'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
END LOOP; END $$;
