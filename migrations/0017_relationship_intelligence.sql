-- F08/F09: evidence-backed relationship graph and explicit introduction history.
CREATE TABLE IF NOT EXISTS graph_edges (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  edge_type text NOT NULL CHECK (edge_type IN ('serves_on_board','works_at','trustee_of','grant_to','attended_with','known_by','introduced_by','family_relationship','donor_confirmed_connection','affiliation')),
  evidence_type text NOT NULL CHECK (evidence_type IN ('public_filing','organization_page','tenant_note','donor_confirmed','other')),
  provenance_url text,
  provenance_label text NOT NULL,
  observed_at timestamptz,
  confidence text NOT NULL CHECK (confidence IN ('confirmed','high','medium','low','possible')),
  privacy_scope text NOT NULL DEFAULT 'tenant' CHECK (privacy_scope IN ('public_source','tenant','restricted')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','disputed','stale')),
  last_verified_at timestamptz,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  CHECK (from_id <> to_id),
  CHECK (provenance_url IS NULL OR provenance_url ~ '^https://')
);
CREATE INDEX IF NOT EXISTS graph_edges_from_idx ON graph_edges(tenant_id,from_id,edge_type);
CREATE INDEX IF NOT EXISTS graph_edges_to_idx ON graph_edges(tenant_id,to_id,edge_type);

CREATE TABLE IF NOT EXISTS introduction_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  introduction_id uuid NOT NULL,
  from_stage text NOT NULL,
  to_stage text NOT NULL CHECK (to_stage IN ('proposed','internal_review','donor_asked','donor_consented','draft_prepared','sent_by_donor','meeting','qualified','donated','closed')),
  actor_id uuid,
  consent_status text CHECK (consent_status IN ('yes','no','unsure')),
  consent_evidence text,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id),
  CHECK (to_stage <> 'donor_consented' OR (consent_status='yes' AND length(trim(consent_evidence)) >= 3))
);
CREATE INDEX IF NOT EXISTS introduction_events_history_idx ON introduction_events(tenant_id,introduction_id,created_at);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['graph_edges','introduction_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', tab);
  END LOOP;
END $$;
