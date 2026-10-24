CREATE TABLE IF NOT EXISTS email_suppressions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('unsubscribe','bounce','complaint','manual')),
  source text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,email),
  FOREIGN KEY (tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
  CHECK (email = lower(email))
);
CREATE INDEX IF NOT EXISTS email_suppressions_tenant_created_idx ON email_suppressions(tenant_id,created_at DESC);
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY email_suppressions_tenant ON email_suppressions
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS email_tenant_rate_limits (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  next_send_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE email_tenant_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_tenant_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY email_tenant_rate_limits_tenant ON email_tenant_rate_limits
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS email_send_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email_resource text NOT NULL DEFAULT 'emails' CHECK (email_resource='emails'),
  email_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  content_hash char(64) NOT NULL,
  recipients jsonb NOT NULL,
  recipient_count integer NOT NULL CHECK (recipient_count > 0),
  from_address text NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,email_resource,email_id) REFERENCES workspace_records(tenant_id,resource,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS email_send_previews_tenant_expiry_idx ON email_send_previews(tenant_id,expires_at);
ALTER TABLE email_send_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_send_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY email_send_previews_tenant ON email_send_previews
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS email_send_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email_resource text NOT NULL DEFAULT 'emails' CHECK (email_resource='emails'),
  email_id uuid NOT NULL,
  preview_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('queued','completed','completed_with_issues')),
  recipient_count integer NOT NULL CHECK (recipient_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,email_resource,email_id) REFERENCES workspace_records(tenant_id,resource,id),
  FOREIGN KEY (tenant_id,approved_by) REFERENCES memberships(tenant_id,user_id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,preview_id)
);
ALTER TABLE email_send_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_send_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY email_send_batches_tenant ON email_send_batches
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email_resource text NOT NULL DEFAULT 'emails' CHECK (email_resource='emails'),
  batch_id uuid NOT NULL,
  email_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  to_address text NOT NULL,
  to_name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  from_address text NOT NULL,
  idempotency_key text NOT NULL,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','delivered','bounced','complained','suppressed','uncertain','failed')),
  suppression_reason text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES email_send_batches(tenant_id,id),
  FOREIGN KEY (tenant_id,email_resource,email_id) REFERENCES workspace_records(tenant_id,resource,id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  UNIQUE (tenant_id,provider_message_id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,id,batch_id)
);
CREATE INDEX IF NOT EXISTS email_messages_tenant_batch_idx ON email_messages(tenant_id,batch_id,created_at);
CREATE INDEX IF NOT EXISTS email_messages_provider_message_idx ON email_messages(tenant_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY email_messages_tenant ON email_messages
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS transactional_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  to_address text NOT NULL,
  to_name text NOT NULL,
  subject text NOT NULL,
  body_envelope text NOT NULL,
  from_address text NOT NULL,
  idempotency_key text NOT NULL,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','bounced','complained','uncertain','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  UNIQUE (tenant_id,provider_message_id)
);
CREATE INDEX IF NOT EXISTS transactional_email_provider_message_idx ON transactional_email_messages(tenant_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
ALTER TABLE transactional_email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactional_email_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY transactional_email_messages_tenant ON transactional_email_messages
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS transactional_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sns_message_id text NOT NULL,
  provider_message_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('Delivery','Bounce','Complaint')),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,sns_message_id),
  FOREIGN KEY (tenant_id,provider_message_id) REFERENCES transactional_email_messages(tenant_id,provider_message_id)
);
ALTER TABLE transactional_email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactional_email_events FORCE ROW LEVEL SECURITY;
CREATE POLICY transactional_email_events_tenant ON transactional_email_events
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS email_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sns_message_id text NOT NULL,
  provider_message_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('Delivery','Bounce','Complaint')),
  event_payload jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,sns_message_id),
  FOREIGN KEY (tenant_id,provider_message_id) REFERENCES email_messages(tenant_id,provider_message_id)
);
ALTER TABLE email_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_provider_events FORCE ROW LEVEL SECURITY;
CREATE POLICY email_provider_events_tenant ON email_provider_events
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  message_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (tenant_id,message_id),
  FOREIGN KEY (tenant_id,message_id) REFERENCES email_messages(tenant_id,id)
);
ALTER TABLE email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_unsubscribe_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY email_unsubscribe_tokens_tenant ON email_unsubscribe_tokens
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
