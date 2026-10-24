ALTER TABLE contacts ADD COLUMN IF NOT EXISTS merged_into uuid;
DO $$ BEGIN
  ALTER TABLE contacts ADD CONSTRAINT contacts_merged_into_tenant_fk
    FOREIGN KEY (tenant_id,merged_into) REFERENCES contacts(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS contacts_merged_into_idx ON contacts(tenant_id,merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_merge_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_contact_id uuid NOT NULL,
  target_contact_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  source_before jsonb NOT NULL,
  target_before jsonb NOT NULL,
  target_after_updated_at timestamptz NOT NULL,
  references_before jsonb NOT NULL DEFAULT '{}',
  references_after jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  CHECK (source_contact_id <> target_contact_id),
  FOREIGN KEY (tenant_id,source_contact_id) REFERENCES contacts(tenant_id,id),
  FOREIGN KEY (tenant_id,target_contact_id) REFERENCES contacts(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
);
ALTER TABLE contact_merge_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_merge_history FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_merge_history_tenant ON contact_merge_history
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
