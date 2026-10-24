-- Tenant-scoped, single-use identity tokens and MFA material.
CREATE TABLE IF NOT EXISTS identity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid,
  actor_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('verify_email','password_reset','invite')),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_envelope text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sent','uncertain')),
  sent_at timestamptz,
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
);
ALTER TABLE identity_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_tokens_tenant ON identity_tokens;
CREATE POLICY identity_tokens_tenant ON identity_tokens
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX IF NOT EXISTS identity_tokens_user_purpose_idx ON identity_tokens(tenant_id,user_id,purpose,expires_at DESC);

CREATE TABLE IF NOT EXISTS identity_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  secret_envelope text,
  pending_secret_envelope text,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  enabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identity_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_mfa FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_mfa_tenant ON identity_mfa;
CREATE POLICY identity_mfa_tenant ON identity_mfa
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=identity_mfa.user_id AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND m.status='active'))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=identity_mfa.user_id AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND m.status='active'));

CREATE TABLE IF NOT EXISTS identity_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  challenge_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
ALTER TABLE identity_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_mfa_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_mfa_challenges_tenant ON identity_mfa_challenges;
CREATE POLICY identity_mfa_challenges_tenant ON identity_mfa_challenges
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

REVOKE ALL ON TABLE identity_tokens,identity_mfa,identity_mfa_challenges FROM PUBLIC;
