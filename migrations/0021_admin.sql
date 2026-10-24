CREATE TABLE IF NOT EXISTS api_tokens (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  token_prefix text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  permissions text[] NOT NULL CHECK (cardinality(permissions) > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
-- The hash-only SECURITY DEFINER lookup runs as the table owner before a tenant
-- context exists. Keep ordinary application queries protected by the policy.
ALTER TABLE api_tokens NO FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS api_tokens_active_idx ON api_tokens(tenant_id,created_at DESC) WHERE revoked_at IS NULL;

-- Bearer authentication needs a hash-only lookup before the request knows its tenant.
-- This function returns only the matching token's tenant scope and never accepts a raw credential.
CREATE OR REPLACE FUNCTION lookup_api_token(p_hash text)
RETURNS TABLE(token_id uuid,tenant_id uuid,tenant_slug text,created_by uuid,permissions text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.api_token_hash',p_hash,true);
  RETURN QUERY
  UPDATE api_tokens t SET last_used_at=now()
    FROM tenants n
    WHERE t.token_hash=p_hash AND t.tenant_id=n.id AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at>now())
    RETURNING t.id,t.tenant_id,n.slug,t.created_by,t.permissions;
END $$;
REVOKE ALL ON FUNCTION lookup_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_api_token(text) TO PUBLIC;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  target_url text NOT NULL,
  secret_envelope text NOT NULL,
  events text[] NOT NULL CHECK (cardinality(events)>0),
  enabled boolean NOT NULL DEFAULT true,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,approved_by) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_active_idx ON webhook_endpoints(tenant_id) WHERE enabled AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL,
  event_type text NOT NULL,
  event_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivering','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0,
  response_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,endpoint_id) REFERENCES webhook_endpoints(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_recent_idx ON webhook_deliveries(tenant_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_event_uq ON webhook_deliveries(tenant_id,endpoint_id,event_type,(event_payload->>'eventId'));

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number>0),
  response_status integer,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,delivery_id,attempt_number),
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES webhook_deliveries(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_retention_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  ai_retention_days integer NOT NULL DEFAULT 365 CHECK (ai_retention_days BETWEEN 30 AND 3650),
  webhook_delivery_retention_days integer NOT NULL DEFAULT 365 CHECK (webhook_delivery_retention_days BETWEEN 90 AND 3650),
  last_run_at timestamptz,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id)
);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['api_tokens','webhook_endpoints','webhook_deliveries','webhook_delivery_attempts','tenant_retention_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;

-- Authentication happens before a tenant ID is known. Allow only an exact
-- hash match during that lookup; normal tenant access remains constrained by
-- tenant_scope and the hash itself is never returned to application code.
DROP POLICY IF EXISTS api_token_hash_lookup ON api_tokens;
CREATE POLICY api_token_hash_lookup ON api_tokens
  USING(token_hash=current_setting('app.api_token_hash',true));
