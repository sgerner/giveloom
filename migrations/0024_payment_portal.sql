-- Immutable checkout snapshots and portal ownership links for payments.
ALTER TABLE donation_intents
  ADD COLUMN IF NOT EXISTS fund_id uuid,
  ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fee_covered_minor bigint NOT NULL DEFAULT 0 CHECK(fee_covered_minor>=0),
  ADD COLUMN IF NOT EXISTS donor_address jsonb,
  ADD COLUMN IF NOT EXISTS tribute_data jsonb,
  ADD COLUMN IF NOT EXISTS terms_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

DO $$ BEGIN
  ALTER TABLE donation_intents ADD CONSTRAINT donation_intents_fund_fk
    FOREIGN KEY(tenant_id,fund_id) REFERENCES funds(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Preserve the campaign designation as it stood when an old checkout began.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    UPDATE donation_intents di SET fund_id=c.fund_id
      FROM campaigns c WHERE di.tenant_id=t.id AND c.tenant_id=di.tenant_id
        AND c.id=di.campaign_id AND di.fund_id IS NULL;
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS donation_intents_fund_idx ON donation_intents(tenant_id,fund_id,created_at DESC);

CREATE OR REPLACE FUNCTION immutable_donation_fund_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fund_id IS DISTINCT FROM NEW.fund_id THEN
    RAISE EXCEPTION 'Donation fund attribution is immutable; record a correcting event.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS donation_intent_fund_immutable ON donation_intents;
CREATE TRIGGER donation_intent_fund_immutable BEFORE UPDATE OF fund_id ON donation_intents
  FOR EACH ROW EXECUTE FUNCTION immutable_donation_fund_snapshot();

ALTER TABLE donation_financial_details
  ADD COLUMN IF NOT EXISTS donor_fee_minor bigint NOT NULL DEFAULT 0 CHECK(donor_fee_minor>=0);

CREATE TABLE IF NOT EXISTS recurring_status_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  donation_intent_id uuid NOT NULL,
  stripe_event_id text NOT NULL,
  stripe_account_id text NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted')),
  previous_status text NOT NULL,
  new_status text NOT NULL,
  effective_at timestamptz NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,stripe_event_id,donation_intent_id),
  FOREIGN KEY(tenant_id,donation_intent_id) REFERENCES donation_intents(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS recurring_status_history_idx
  ON recurring_status_events(tenant_id,donation_intent_id,effective_at DESC);
ALTER TABLE recurring_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_status_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON recurring_status_events;
CREATE POLICY tenant_scope ON recurring_status_events
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS contact_id uuid;
DO $$ BEGIN
  ALTER TABLE event_registrations ADD CONSTRAINT event_registrations_contact_fk
    FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    UPDATE event_registrations r SET contact_id=c.id
      FROM contacts c
      WHERE r.tenant_id=t.id AND c.tenant_id=r.tenant_id
        AND lower(c.email)=lower(r.email) AND c.archived_at IS NULL AND c.merged_into IS NULL
        AND (SELECT count(*) FROM contacts candidate WHERE candidate.tenant_id=t.id
          AND lower(candidate.email)=lower(r.email) AND candidate.archived_at IS NULL
          AND candidate.merged_into IS NULL)=1;
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS event_registrations_contact_idx
  ON event_registrations(tenant_id,contact_id,registered_at DESC) WHERE contact_id IS NOT NULL;
