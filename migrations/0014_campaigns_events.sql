-- Campaign publishing, fundraising pages, event registration, and volunteer/sponsor records.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS public_slug text,
  ADD COLUMN IF NOT EXISTS story text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS form_config jsonb NOT NULL DEFAULT '{"frequencies":["once"],"suggestedAmounts":[2500,5000,10000,25000],"allowCustomAmount":true,"askForAddress":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS fund_id uuid,
  ADD COLUMN IF NOT EXISTS appeal_id uuid,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_public_slug_uq ON campaigns(tenant_id,public_slug) WHERE public_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS funds (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, slug text NOT NULL, code text, description text NOT NULL DEFAULT '',
  restricted boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug), UNIQUE(tenant_id,code)
);
CREATE TABLE IF NOT EXISTS appeals (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  fund_id uuid, name text NOT NULL, slug text NOT NULL, description text NOT NULL DEFAULT '',
  starts_at timestamptz, ends_at timestamptz, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug),
  FOREIGN KEY(tenant_id,fund_id) REFERENCES funds(tenant_id,id)
);
DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_fund_fk FOREIGN KEY(tenant_id,fund_id) REFERENCES funds(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_appeal_fk FOREIGN KEY(tenant_id,appeal_id) REFERENCES appeals(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS campaign_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  campaign_id uuid NOT NULL, version integer NOT NULL, snapshot jsonb NOT NULL, actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,campaign_id,version),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS campaign_drafts (
  tenant_id uuid NOT NULL REFERENCES tenants(id), campaign_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1, snapshot jsonb NOT NULL, actor_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,campaign_id),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    UPDATE campaigns SET public_slug=coalesce(public_slug,'campaign-'||substr(replace(id::text,'-',''),1,12)),
      form_config=CASE WHEN form_config ? 'terms' THEN form_config ELSE form_config||'{"terms":"I authorize this gift to the organization."}'::jsonb END
      WHERE tenant_id=t.id;
    INSERT INTO campaign_drafts(tenant_id,campaign_id,version,snapshot)
    SELECT tenant_id,id,version,jsonb_build_object(
      'name',name,'publicSlug',public_slug,'description',coalesce(data->>'description','Support our community campaign.'),
      'story',CASE WHEN length(story)>=40 THEN story ELSE 'Every gift helps our community grow stronger. Thank you for making this work possible.' END,
      'goalMinor',goal_minor,'currency',trim(currency),'fundId',fund_id,'appealId',appeal_id,
      'formConfig',form_config,'acceptsOnlineGifts',coalesce((data->>'acceptsOnlineGifts')::boolean,true)
    ) FROM campaigns WHERE tenant_id=t.id ON CONFLICT(tenant_id,campaign_id) DO NOTHING;
    INSERT INTO campaign_versions(tenant_id,campaign_id,version,snapshot)
      SELECT tenant_id,campaign_id,version,snapshot FROM campaign_drafts WHERE tenant_id=t.id
      ON CONFLICT(tenant_id,campaign_id,version) DO NOTHING;
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS campaign_variants (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), campaign_id uuid NOT NULL,
  name text NOT NULL, weight integer NOT NULL DEFAULT 50 CHECK(weight BETWEEN 1 AND 99),
  content jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
  impressions bigint NOT NULL DEFAULT 0, conversions bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,campaign_id,name), UNIQUE(tenant_id,campaign_id,id),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS campaign_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), campaign_id uuid NOT NULL,
  code text NOT NULL, label text NOT NULL DEFAULT '', variant_id uuid, fundraiser_id uuid,
  clicks bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,code),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id),
  FOREIGN KEY(tenant_id,campaign_id,variant_id) REFERENCES campaign_variants(tenant_id,campaign_id,id)
);
CREATE TABLE IF NOT EXISTS fundraising_pages (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), campaign_id uuid NOT NULL,
  slug text NOT NULL, page_type text NOT NULL CHECK(page_type IN ('individual','team')),
  name text NOT NULL, story text NOT NULL DEFAULT '', goal_minor bigint NOT NULL DEFAULT 0 CHECK(goal_minor>=0),
  contact_id uuid, parent_page_id uuid, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug), UNIQUE(tenant_id,campaign_id,id),
  FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id),
  FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  FOREIGN KEY(tenant_id,parent_page_id) REFERENCES fundraising_pages(tenant_id,id)
);
DO $$ BEGIN
  ALTER TABLE fundraising_pages ADD CONSTRAINT fundraising_pages_parent_campaign_fk
    FOREIGN KEY(tenant_id,campaign_id,parent_page_id) REFERENCES fundraising_pages(tenant_id,campaign_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE campaign_links ADD CONSTRAINT campaign_links_fundraiser_fk FOREIGN KEY(tenant_id,campaign_id,fundraiser_id) REFERENCES fundraising_pages(tenant_id,campaign_id,id);
ALTER TABLE donation_intents ADD COLUMN IF NOT EXISTS fundraising_page_id uuid;
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS fundraising_page_id uuid;
DO $$ BEGIN
  ALTER TABLE donation_intents ADD CONSTRAINT donation_intents_fundraiser_fk FOREIGN KEY(tenant_id,fundraising_page_id) REFERENCES fundraising_pages(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE gifts ADD CONSTRAINT gifts_fundraiser_fk FOREIGN KEY(tenant_id,fundraising_page_id) REFERENCES fundraising_pages(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS events (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, public_slug text, description text NOT NULL DEFAULT '', starts_at timestamptz NOT NULL,
  ends_at timestamptz, timezone text NOT NULL DEFAULT 'UTC', venue text NOT NULL DEFAULT '',
  capacity integer CHECK(capacity IS NULL OR capacity>0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','cancelled','completed')),
  registration_config jsonb NOT NULL DEFAULT '{"requireName":true,"requireEmail":true}'::jsonb,
  published_at timestamptz, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,public_slug)
);
CREATE TABLE IF NOT EXISTS event_ticket_types (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL,
  name text NOT NULL, description text NOT NULL DEFAULT '', price_minor bigint NOT NULL DEFAULT 0 CHECK(price_minor>=0),
  currency char(3) NOT NULL DEFAULT 'USD', capacity integer CHECK(capacity IS NULL OR capacity>0),
  active boolean NOT NULL DEFAULT true, sales_start timestamptz, sales_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_id,name),
  UNIQUE(tenant_id,event_id,id), FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS event_registrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL,
  ticket_type_id uuid NOT NULL, full_name text NOT NULL, email text NOT NULL, quantity integer NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 12),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK(amount_minor>=0), currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL CHECK(status IN ('pending_payment','registered','payment_failed','cancelled','checked_in')),
  request_key text NOT NULL, public_ref_hash text NOT NULL, stripe_account_id text, stripe_payment_intent_id text,
  registered_at timestamptz NOT NULL DEFAULT now(), checked_in_at timestamptz,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_id,request_key), UNIQUE(tenant_id,event_id,public_ref_hash),
  FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id),
  FOREIGN KEY(tenant_id,event_id,ticket_type_id) REFERENCES event_ticket_types(tenant_id,event_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_registrations_payment_intent_uq ON event_registrations(stripe_account_id,stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_registrations_event_status_idx ON event_registrations(tenant_id,event_id,status);
CREATE TABLE IF NOT EXISTS event_sponsors (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL,
  organization_name text NOT NULL, contact_name text NOT NULL DEFAULT '', contact_email text NOT NULL DEFAULT '',
  tier text NOT NULL DEFAULT 'supporter', amount_minor bigint NOT NULL DEFAULT 0 CHECK(amount_minor>=0),
  status text NOT NULL DEFAULT 'prospect' CHECK(status IN ('prospect','committed','paid','declined')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS event_volunteer_opportunities (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL,
  name text NOT NULL, description text NOT NULL DEFAULT '', starts_at timestamptz, ends_at timestamptz,
  capacity integer NOT NULL DEFAULT 1 CHECK(capacity>0), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_id,id),
  FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS event_volunteer_signups (
  id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL,
  opportunity_id uuid NOT NULL, full_name text NOT NULL, email text NOT NULL, status text NOT NULL DEFAULT 'signed_up' CHECK(status IN ('signed_up','cancelled','attended')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,event_id,opportunity_id) REFERENCES event_volunteer_opportunities(tenant_id,event_id,id)
);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['funds','appeals','campaign_versions','campaign_drafts','campaign_variants','campaign_links','fundraising_pages','events','event_ticket_types','event_registrations','event_sponsors','event_volunteer_opportunities','event_volunteer_signups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', tab);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS funds_tenant_active_idx ON funds(tenant_id,active,name);
CREATE INDEX IF NOT EXISTS appeals_tenant_active_idx ON appeals(tenant_id,active,name);
CREATE INDEX IF NOT EXISTS campaign_versions_history_idx ON campaign_versions(tenant_id,campaign_id,version DESC);
CREATE INDEX IF NOT EXISTS fundraisers_public_idx ON fundraising_pages(tenant_id,slug) WHERE status='published';
CREATE INDEX IF NOT EXISTS events_public_idx ON events(tenant_id,public_slug) WHERE status='published';
CREATE INDEX IF NOT EXISTS event_ticket_active_idx ON event_ticket_types(tenant_id,event_id,active);
