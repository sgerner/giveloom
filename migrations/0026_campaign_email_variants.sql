ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS campaign_id uuid;
ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS campaign_variant_snapshot jsonb;
ALTER TABLE email_send_previews ADD COLUMN IF NOT EXISTS campaign_variant_hash char(64);
DO $$ BEGIN
  ALTER TABLE email_send_previews ADD CONSTRAINT email_send_previews_campaign_fk
    FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE email_send_batches ADD COLUMN IF NOT EXISTS campaign_id uuid;
DO $$ BEGIN
  ALTER TABLE email_send_batches ADD CONSTRAINT email_send_batches_campaign_fk
    FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS campaign_id uuid;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS campaign_variant text CHECK(campaign_variant IN ('A','B'));
DO $$ BEGIN
  ALTER TABLE email_messages ADD CONSTRAINT email_messages_campaign_fk
    FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS email_messages_campaign_variant_idx
  ON email_messages(tenant_id,campaign_id,campaign_variant,status) WHERE campaign_id IS NOT NULL;
