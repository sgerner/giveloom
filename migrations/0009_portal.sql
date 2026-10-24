-- Donor portal authentication is separate from staff CRM sessions.
CREATE TABLE IF NOT EXISTS portal_magic_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  token_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  sent_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','sending','sent','uncertain','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS portal_magic_links_contact_idx ON portal_magic_links(tenant_id,contact_id,created_at DESC);
ALTER TABLE portal_magic_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_magic_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_magic_links_tenant ON portal_magic_links;
CREATE POLICY portal_magic_links_tenant ON portal_magic_links
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS portal_sessions_contact_idx ON portal_sessions(tenant_id,contact_id,expires_at DESC);
ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_sessions_tenant ON portal_sessions;
CREATE POLICY portal_sessions_tenant ON portal_sessions
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS portal_preferences (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  receipt_emails boolean NOT NULL DEFAULT true,
  newsletter_opt_in boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,contact_id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
ALTER TABLE portal_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_preferences_tenant ON portal_preferences;
CREATE POLICY portal_preferences_tenant ON portal_preferences
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
