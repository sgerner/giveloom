CREATE TABLE IF NOT EXISTS stripe_accounts (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  connected_account_id text NOT NULL,
  livemode boolean NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  connected_by uuid NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  FOREIGN KEY (tenant_id,connected_by) REFERENCES memberships(tenant_id,user_id),
  UNIQUE (connected_account_id)
);
ALTER TABLE stripe_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_accounts_tenant ON stripe_accounts
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS stripe_oauth_states (
  state_hash char(64) PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
ALTER TABLE stripe_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_oauth_states_tenant ON stripe_oauth_states
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS donation_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  campaign_id uuid,
  contact_id uuid,
  stripe_account_id text NOT NULL,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  stripe_customer_id text,
  stripe_invoice_id text,
  request_key_hash char(64) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('once','monthly','annual')),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','requires_payment_method','requires_action','processing','succeeded','failed','canceled','incomplete','active','past_due','ended')),
  donor_name text NOT NULL,
  donor_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  UNIQUE (tenant_id,request_key_hash),
  UNIQUE (stripe_account_id,stripe_payment_intent_id),
  UNIQUE (stripe_account_id,stripe_subscription_id),
  UNIQUE (stripe_account_id,stripe_invoice_id)
);
CREATE INDEX IF NOT EXISTS donation_intents_status_idx ON donation_intents(tenant_id,status,created_at DESC);
ALTER TABLE donation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE donation_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY donation_intents_tenant ON donation_intents
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS stripe_invoice_payments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  stripe_account_id text NOT NULL,
  stripe_invoice_id text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  donation_intent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,stripe_invoice_id),
  UNIQUE (stripe_account_id,stripe_payment_intent_id),
  FOREIGN KEY (tenant_id,donation_intent_id) REFERENCES donation_intents(tenant_id,id)
);
ALTER TABLE stripe_invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_invoice_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_invoice_payments_tenant ON stripe_invoice_payments
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE IF NOT EXISTS stripe_event_ingress (
  event_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  stripe_account_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
ALTER TABLE stripe_event_ingress ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_event_ingress FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_event_ingress_tenant ON stripe_event_ingress
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE gifts ADD COLUMN IF NOT EXISTS external_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS gifts_external_event_id_uq ON gifts(tenant_id,external_event_id) WHERE external_event_id IS NOT NULL;
