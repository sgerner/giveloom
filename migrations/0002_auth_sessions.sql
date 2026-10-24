ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  session_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx ON auth_sessions(user_id,expires_at) WHERE revoked_at IS NULL;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_membership ON users;
CREATE POLICY users_tenant_membership ON users
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id=users.id
      AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  ))
  WITH CHECK (
    id=nullif(current_setting('app.signup_user_id',true),'')::uuid
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=users.id AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  );

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_tenant ON auth_sessions
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

REVOKE ALL ON TABLE schema_migrations FROM PUBLIC;
