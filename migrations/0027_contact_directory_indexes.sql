-- Support bounded alphabetical contact pages and keyset cursors at larger tenant sizes.
CREATE INDEX IF NOT EXISTS contacts_active_directory_cursor_idx
  ON contacts(tenant_id,name,id)
  WHERE archived_at IS NULL AND merged_into IS NULL;

CREATE INDEX IF NOT EXISTS contacts_active_name_prefix_idx
  ON contacts(tenant_id,lower(name) text_pattern_ops)
  WHERE archived_at IS NULL AND merged_into IS NULL;

CREATE INDEX IF NOT EXISTS contacts_active_email_prefix_idx
  ON contacts(tenant_id,lower(email) text_pattern_ops)
  WHERE archived_at IS NULL AND merged_into IS NULL AND email IS NOT NULL;

CREATE INDEX IF NOT EXISTS gifts_tenant_currency_recent_idx
  ON gifts(tenant_id,currency,occurred_at DESC,id DESC);
