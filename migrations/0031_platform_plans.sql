ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_label text NOT NULL DEFAULT 'Self hosted';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'self_hosted' CHECK(subscription_status IN ('self_hosted','trial','active','past_due','canceled'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_updated_at timestamptz;
