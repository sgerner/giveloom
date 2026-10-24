-- Stable keyset ordering for the giving ledger and graph evidence browser.
CREATE INDEX IF NOT EXISTS gifts_tenant_recent_cursor_idx
  ON gifts(tenant_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS graph_edges_tenant_recent_cursor_idx
  ON graph_edges(tenant_id, created_at DESC, id DESC);
