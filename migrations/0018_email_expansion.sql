ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS segment_id uuid;
ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS html_hash char(64) NOT NULL DEFAULT '';
ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS scheduled_timezone text;
ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS sandbox_mode boolean NOT NULL DEFAULT false;

ALTER TABLE email_send_batches DROP CONSTRAINT IF EXISTS email_send_batches_status_check;
ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS scheduled_timezone text;
ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS schedule_hash char(64);
ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS segment_id uuid;
ALTER TABLE email_send_batches ADD CONSTRAINT email_send_batches_status_check CHECK(status IN ('scheduled','queued','completed','completed_with_issues','failed'));

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_status_check;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS html_body text NOT NULL DEFAULT '';
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS segment_id uuid;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_status_check CHECK(status IN ('scheduled','queued','sending','accepted','delivered','bounced','complained','suppressed','uncertain','failed'));

ALTER TABLE email_provider_events DROP CONSTRAINT IF EXISTS email_provider_events_event_type_check;
ALTER TABLE email_provider_events ADD CONSTRAINT email_provider_events_event_type_check CHECK(event_type IN ('Delivery','Bounce','Complaint','Open','Click'));

CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 998),
  html_body text NOT NULL DEFAULT '' CHECK(length(html_body)<=100000),
  text_body text NOT NULL CHECK(length(text_body) BETWEEN 1 AND 95000),
  variables jsonb NOT NULL DEFAULT '[]',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,name),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY(tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id)
);

CREATE TABLE IF NOT EXISTS email_consent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  email text NOT NULL,
  token_hash char(64) NOT NULL,
  token_envelope text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','sending','sent','uncertain','confirmed','expired','cancelled')),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,token_hash),
  FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS email_consent_request_pending_idx ON email_consent_requests(tenant_id,contact_id,created_at DESC) WHERE status='pending';

CREATE TABLE IF NOT EXISTS email_preference_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,token_hash),
  FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
ALTER TABLE email_preference_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;
CREATE INDEX IF NOT EXISTS email_preference_token_expiry_idx ON email_preference_tokens(tenant_id,expires_at);

CREATE TABLE IF NOT EXISTS email_consent_request_limits (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  requester_hash char(64) NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  PRIMARY KEY(tenant_id,requester_hash)
);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['email_templates','email_consent_requests','email_preference_tokens','email_consent_request_limits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I',tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;

-- These are cumulative counters only. Open events are not reliable evidence that a person read a message.
ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS opened_count integer NOT NULL DEFAULT 0 CHECK(opened_count>=0);
ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS clicked_count integer NOT NULL DEFAULT 0 CHECK(clicked_count>=0);
