CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, legal_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC', locale text NOT NULL DEFAULT 'en-US', currency char(3) NOT NULL DEFAULT 'USD',
  branding jsonb NOT NULL DEFAULT '{}', feature_flags jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, display_name text NOT NULL,
  password_hash text NOT NULL, email_verified_at timestamptz, disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL,
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL,
  email text, stage text NOT NULL DEFAULT 'new', tags text[] NOT NULL DEFAULT '{}', data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,email)
);
CREATE TABLE IF NOT EXISTS contact_methods (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, contact_id uuid NOT NULL, kind text NOT NULL,
  value text NOT NULL, normalized_value text NOT NULL, preferred boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL,
  goal_minor bigint NOT NULL DEFAULT 0 CHECK(goal_minor >= 0), currency char(3) NOT NULL DEFAULT 'USD', status text NOT NULL DEFAULT 'draft',
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS gifts (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), contact_id uuid,
  campaign_id uuid, amount_minor bigint NOT NULL CHECK(amount_minor > 0), currency char(3) NOT NULL,
  kind text NOT NULL DEFAULT 'one_time', status text NOT NULL DEFAULT 'recorded', occurred_at timestamptz NOT NULL DEFAULT now(),
  correction_of uuid, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id), FOREIGN KEY(tenant_id,correction_of) REFERENCES gifts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS prospects (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL,
  stage text NOT NULL DEFAULT 'discovered', score numeric(5,2), match_status text NOT NULL DEFAULT 'possible',
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS prospect_evidence (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, prospect_id uuid NOT NULL, source_name text NOT NULL,
  source_url text, evidence_type text NOT NULL, confidence text NOT NULL, observed_at timestamptz, license text,
  data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,prospect_id) REFERENCES prospects(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS workspace_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id), resource text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz, PRIMARY KEY(tenant_id,resource,id)
);
CREATE TABLE IF NOT EXISTS activities (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), contact_id uuid,
  kind text NOT NULL, summary text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), actor_id uuid,
  data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), contact_id uuid,
  title text NOT NULL, due_at timestamptz, priority text NOT NULL DEFAULT 'normal', status text NOT NULL DEFAULT 'open',
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_type text NOT NULL,
  payload jsonb NOT NULL, idempotency_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), actor_id uuid,
  action text NOT NULL, resource text NOT NULL, record_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), data jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id)
);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memberships','contacts','contact_methods','campaigns','gifts','prospects','prospect_evidence','workspace_records','activities','tasks','outbox_events','audit_log','user_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', tab);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS gifts_tenant_occurred_idx ON gifts(tenant_id,occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_email_lower_uq ON contacts(tenant_id,lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS records_tenant_resource_idx ON workspace_records(tenant_id,resource,created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(created_at) WHERE processed_at IS NULL;
CREATE OR REPLACE FUNCTION prevent_gift_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Gift events are immutable; record a correction as a new event.'; END $$;
DROP TRIGGER IF EXISTS gifts_are_immutable ON gifts;
CREATE TRIGGER gifts_are_immutable BEFORE UPDATE OR DELETE ON gifts FOR EACH ROW EXECUTE FUNCTION prevent_gift_mutation();
