CREATE INDEX IF NOT EXISTS workspace_records_directory_name_idx
  ON workspace_records (tenant_id, resource, lower(data->>'name'), id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS contacts_tenant_active_id_idx
  ON contacts (tenant_id, id) WHERE archived_at IS NULL AND merged_into IS NULL;
