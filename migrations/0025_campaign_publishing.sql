ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS budget_minor bigint NOT NULL DEFAULT 0 CHECK(budget_minor>=0),
  ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS audience_segments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS utm_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS utm_medium text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS utm_campaign text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS hero_file_id uuid,
  ADD COLUMN IF NOT EXISTS receipt_template jsonb NOT NULL DEFAULT '{"thankYouMessage":"Thank you for supporting our work.","disclaimer":"Donation acknowledgment only. This is not tax advice or a determination of deductibility."}'::jsonb;

ALTER TABLE donation_intents ADD COLUMN IF NOT EXISTS attribution_snapshot jsonb NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION immutable_donation_attribution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.attribution_snapshot IS DISTINCT FROM NEW.attribution_snapshot THEN
    RAISE EXCEPTION 'Donation attribution is immutable; record a correcting event.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS donation_intent_attribution_immutable ON donation_intents;
CREATE TRIGGER donation_intent_attribution_immutable BEFORE UPDATE OF attribution_snapshot ON donation_intents
  FOR EACH ROW EXECUTE FUNCTION immutable_donation_attribution_snapshot();

CREATE UNIQUE INDEX IF NOT EXISTS file_objects_tenant_id_uq ON file_objects(tenant_id,id);
DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_hero_file_fk
    FOREIGN KEY(tenant_id,hero_file_id) REFERENCES file_objects(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS campaigns_public_schedule_idx
  ON campaigns(tenant_id,status,starts_at,ends_at) WHERE status IN ('published','scheduled','paused');
