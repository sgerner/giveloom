CREATE TABLE IF NOT EXISTS gift_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  gift_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,gift_id),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,gift_id) REFERENCES gifts(tenant_id,id)
);
ALTER TABLE gift_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY gift_receipts_tenant ON gift_receipts
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX IF NOT EXISTS gift_receipts_contact_idx ON gift_receipts(tenant_id,created_at DESC);
CREATE OR REPLACE FUNCTION prevent_gift_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Gift receipt snapshots are immutable.'; END $$;
DROP TRIGGER IF EXISTS gift_receipts_are_immutable ON gift_receipts;
CREATE TRIGGER gift_receipts_are_immutable BEFORE UPDATE OR DELETE ON gift_receipts FOR EACH ROW EXECUTE FUNCTION prevent_gift_receipt_mutation();
