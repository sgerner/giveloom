ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tax_id text;

CREATE TABLE IF NOT EXISTS tenant_branding_logos (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 3145728),
  scan_status text NOT NULL CHECK (scan_status IN ('clean','not_scanned')),
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,object_id),
  FOREIGN KEY (tenant_id,uploaded_by) REFERENCES memberships(tenant_id,user_id)
);
ALTER TABLE tenant_branding_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding_logos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branding_logos_tenant ON tenant_branding_logos;
CREATE POLICY tenant_branding_logos_tenant ON tenant_branding_logos
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX IF NOT EXISTS tenant_branding_logos_tenant_created_idx ON tenant_branding_logos(tenant_id,created_at DESC);
