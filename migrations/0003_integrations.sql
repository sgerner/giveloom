CREATE TABLE IF NOT EXISTS integration_configs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('openai','ses')),
  credential_id text NOT NULL DEFAULT 'primary',
  enabled boolean NOT NULL DEFAULT false,
  credential_envelope text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,provider,credential_id),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id)
);
ALTER TABLE integration_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_configs_tenant ON integration_configs
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider='openai'),
  model text NOT NULL,
  prompt_hash char(64) NOT NULL,
  input_chars integer NOT NULL CHECK (input_chars >= 0),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS ai_usage_tenant_created_idx ON ai_usage(tenant_id,created_at DESC);
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_tenant ON ai_usage
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
