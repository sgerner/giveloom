-- F10: tenant-scoped assistant settings, audit trail, conversations and confirmations.
-- Rates are configured by each tenant from its own OpenAI billing agreement; no
-- vendor price is embedded here. Dollar values are integer micro-USD.
ALTER TABLE ai_usage
  ADD COLUMN IF NOT EXISTS reserved_input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_output_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_micro_usd bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_cost_micro_usd bigint;

CREATE TABLE IF NOT EXISTS ai_assistant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  model text,
  input_usd_per_million numeric(16,6),
  output_usd_per_million numeric(16,6),
  requests_per_day integer NOT NULL DEFAULT 20 CHECK (requests_per_day BETWEEN 1 AND 10000),
  tokens_per_day integer NOT NULL DEFAULT 100000 CHECK (tokens_per_day BETWEEN 1 AND 10000000),
  cost_micro_usd_per_day bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd_per_day >= 0),
  max_output_tokens integer NOT NULL DEFAULT 800 CHECK (max_output_tokens BETWEEN 64 AND 4000),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id),
  CHECK ((input_usd_per_million IS NULL) = (output_usd_per_million IS NULL)),
  CHECK (input_usd_per_million IS NULL OR input_usd_per_million >= 0),
  CHECK (output_usd_per_million IS NULL OR output_usd_per_million >= 0),
  CHECK (NOT enabled OR (model IS NOT NULL AND input_usd_per_million IS NOT NULL AND output_usd_per_million IS NOT NULL AND cost_micro_usd_per_day > 0))
);

CREATE TABLE IF NOT EXISTS ai_user_limits (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  requests_per_day integer NOT NULL CHECK (requests_per_day BETWEEN 1 AND 10000),
  tokens_per_day integer NOT NULL CHECK (tokens_per_day BETWEEN 1 AND 10000000),
  cost_micro_usd_per_day bigint NOT NULL CHECK (cost_micro_usd_per_day >= 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id)
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'New assistant conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS ai_conversations_user_idx
  ON ai_conversations(tenant_id,user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content_redacted text NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES ai_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx
  ON ai_messages(tenant_id,conversation_id,created_at);

CREATE TABLE IF NOT EXISTS ai_tool_audit (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id uuid,
  tool_name text NOT NULL,
  execution_kind text NOT NULL CHECK (execution_kind IN ('read','proposed','confirmed','rejected')),
  arguments_hash char(64) NOT NULL,
  redacted_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES ai_conversations(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_action_confirmations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id uuid,
  token_hash char(64) NOT NULL,
  action jsonb NOT NULL,
  expected_snapshot_hash char(64),
  expected_updated_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,token_hash),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES ai_conversations(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_action_confirmations_expiry_idx
  ON ai_action_confirmations(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_provider_circuit (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  open_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY[
    'ai_assistant_settings','ai_user_limits','ai_conversations','ai_messages',
    'ai_tool_audit','ai_action_confirmations','ai_provider_circuit'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', tab);
  END LOOP;
END $$;

-- Only an active member can read assistant data; the normal memberships/users
-- RLS policies remain the authoritative membership check.
CREATE OR REPLACE FUNCTION ai_prune_expired(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  DELETE FROM ai_messages WHERE tenant_id=p_tenant AND retention_until < now();
  DELETE FROM ai_tool_audit WHERE tenant_id=p_tenant AND retention_until < now();
  DELETE FROM ai_conversations WHERE tenant_id=p_tenant AND retention_until < now();
  DELETE FROM ai_action_confirmations WHERE tenant_id=p_tenant AND expires_at < now();
END;
$$;
