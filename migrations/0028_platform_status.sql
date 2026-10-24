ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspension_reason text;
CREATE TABLE IF NOT EXISTS platform_audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES users(id),tenant_id uuid REFERENCES tenants(id),action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_operator ON platform_audit_events USING(nullif(current_setting('app.platform_operator_id',true),'') IS NOT NULL) WITH CHECK(actor_id=nullif(current_setting('app.platform_operator_id',true),'')::uuid);
CREATE INDEX IF NOT EXISTS platform_audit_recent_idx ON platform_audit_events(created_at DESC,id);
