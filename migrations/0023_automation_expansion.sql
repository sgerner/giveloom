-- F07 workflow expansions: pending human review for any workflow-generated
-- outbound draft. Workflow execution itself never sends marketing email.
CREATE TABLE IF NOT EXISTS automation_action_approvals (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_number integer NOT NULL CHECK(step_number BETWEEN 1 AND 100),
  contact_id uuid NOT NULL,
  action_type text NOT NULL CHECK(action_type IN ('email','ai_draft')),
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
  requested_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 days'),
  decided_at timestamptz,
  draft_id uuid,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,run_id,step_number),
  FOREIGN KEY(tenant_id,automation_id) REFERENCES automation_definitions(tenant_id,id),
  FOREIGN KEY(tenant_id,run_id) REFERENCES automation_runs(tenant_id,id),
  FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  FOREIGN KEY(tenant_id,requested_by) REFERENCES memberships(tenant_id,user_id),
  FOREIGN KEY(tenant_id,decided_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS automation_action_approvals_pending_idx
  ON automation_action_approvals(tenant_id,created_at DESC) WHERE status='pending';
DO $$ BEGIN
  ALTER TABLE automation_action_approvals ENABLE ROW LEVEL SECURITY;
  ALTER TABLE automation_action_approvals FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON automation_action_approvals;
  CREATE POLICY tenant_isolation ON automation_action_approvals
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
END $$;
