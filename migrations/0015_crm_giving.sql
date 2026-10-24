CREATE TABLE IF NOT EXISTS addresses(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),contact_id uuid NOT NULL,
 label text NOT NULL DEFAULT 'home',line1 text NOT NULL,line2 text NOT NULL DEFAULT '',city text NOT NULL DEFAULT '',region text NOT NULL DEFAULT '',postal_code text NOT NULL DEFAULT '',country char(2) NOT NULL DEFAULT 'US',preferred boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS consents(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),contact_id uuid NOT NULL,channel text NOT NULL,purpose text NOT NULL,status text NOT NULL CHECK(status IN ('granted','withdrawn','unknown')),source text NOT NULL,lawful_basis text NOT NULL DEFAULT 'consent',recorded_at timestamptz NOT NULL DEFAULT now(),actor_id uuid,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS custom_field_definitions(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),name text NOT NULL,kind text NOT NULL CHECK(kind IN ('text','number','date','boolean','choice')),choices jsonb NOT NULL DEFAULT '[]',sensitive boolean NOT NULL DEFAULT false,required boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,name)
);
CREATE TABLE IF NOT EXISTS custom_field_values(
 tenant_id uuid NOT NULL,contact_id uuid NOT NULL,field_id uuid NOT NULL,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,contact_id,field_id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),FOREIGN KEY(tenant_id,field_id) REFERENCES custom_field_definitions(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS notes(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),contact_id uuid NOT NULL,body text NOT NULL,sensitive boolean NOT NULL DEFAULT false,actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS contact_import_batches(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,fingerprint text NOT NULL,contact_ids uuid[] NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),rolled_back_at timestamptz,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS saved_filters(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),user_id uuid NOT NULL,name text NOT NULL,resource text NOT NULL,definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS pledges(
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL DEFAULT gen_random_uuid(),contact_id uuid NOT NULL,campaign_id uuid,amount_minor bigint NOT NULL CHECK(amount_minor>0),currency char(3) NOT NULL,status text NOT NULL DEFAULT 'active',due_at timestamptz,description text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS pledge_installments(
 tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),pledge_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),due_at timestamptz NOT NULL,gift_id uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,pledge_id) REFERENCES pledges(tenant_id,id),FOREIGN KEY(tenant_id,gift_id) REFERENCES gifts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS soft_credits(
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),gift_id uuid NOT NULL,contact_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,gift_id,contact_id),FOREIGN KEY(tenant_id,gift_id) REFERENCES gifts(tenant_id,id),FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tributes(
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),gift_id uuid NOT NULL,honoree text NOT NULL,kind text NOT NULL CHECK(kind IN ('honor','memory')),notify_name text,notify_email text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,gift_id) REFERENCES gifts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS matching_gifts(
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),gift_id uuid NOT NULL,organization text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),status text NOT NULL DEFAULT 'expected',matched_gift_id uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,gift_id) REFERENCES gifts(tenant_id,id),FOREIGN KEY(tenant_id,matched_gift_id) REFERENCES gifts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS donation_financial_details(
 tenant_id uuid NOT NULL,gift_id uuid NOT NULL,fee_minor bigint NOT NULL DEFAULT 0 CHECK(fee_minor>=0),settlement_minor bigint,method text NOT NULL DEFAULT 'offline',check_reference text,designation text,restricted boolean NOT NULL DEFAULT false,in_kind_description text,anonymous boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,gift_id),FOREIGN KEY(tenant_id,gift_id) REFERENCES gifts(tenant_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['addresses','consents','custom_field_definitions','custom_field_values','notes','contact_import_batches','saved_filters','pledges','pledge_installments','soft_credits','tributes','matching_gifts','donation_financial_details'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS methods_contact_idx ON contact_methods(tenant_id,contact_id);
CREATE INDEX IF NOT EXISTS addresses_contact_idx ON addresses(tenant_id,contact_id);
CREATE INDEX IF NOT EXISTS consent_contact_idx ON consents(tenant_id,contact_id,recorded_at DESC);
CREATE INDEX IF NOT EXISTS notes_contact_idx ON notes(tenant_id,contact_id,created_at DESC);
CREATE INDEX IF NOT EXISTS pledges_due_idx ON pledges(tenant_id,status,due_at);
CREATE OR REPLACE FUNCTION immutable_finance_detail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Financial attribution is immutable; record an explicit correcting event.'; END $$;
CREATE TRIGGER immutable_soft_credit BEFORE UPDATE OR DELETE ON soft_credits FOR EACH ROW EXECUTE FUNCTION immutable_finance_detail();
CREATE TRIGGER immutable_financial_detail BEFORE UPDATE OR DELETE ON donation_financial_details FOR EACH ROW EXECUTE FUNCTION immutable_finance_detail();
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS fund_id uuid;
ALTER TABLE gifts ADD CONSTRAINT gifts_fund_tenant_fk FOREIGN KEY(tenant_id,fund_id) REFERENCES funds(tenant_id,id);
CREATE INDEX IF NOT EXISTS gifts_contact_idx ON gifts(tenant_id,contact_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS gifts_fund_idx ON gifts(tenant_id,fund_id,occurred_at DESC);
