CREATE TABLE IF NOT EXISTS file_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_id uuid NOT NULL,
  contact_id uuid,
  original_name text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  scan_status text NOT NULL CHECK (scan_status IN ('clean','not_scanned')),
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,object_id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  FOREIGN KEY (tenant_id,uploaded_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS file_objects_tenant_contact_created_idx ON file_objects(tenant_id,contact_id,created_at DESC);
ALTER TABLE file_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY file_objects_tenant ON file_objects
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
