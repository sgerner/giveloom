CREATE TABLE IF NOT EXISTS saved_report_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  report_key text NOT NULL CHECK(report_key IN ('giving','retention')),
  filters jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id)
);

CREATE TABLE IF NOT EXISTS saved_report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  definition_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  frequency text NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
  local_time time NOT NULL DEFAULT '09:00',
  weekday smallint CHECK(weekday BETWEEN 0 AND 6),
  timezone text NOT NULL,
  next_run_at timestamptz NOT NULL,
  approval_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,definition_id),
  FOREIGN KEY(tenant_id,definition_id) REFERENCES saved_report_definitions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id),
  CHECK((frequency='weekly' AND weekday IS NOT NULL) OR (frequency<>'weekly' AND weekday IS NULL))
);
CREATE INDEX IF NOT EXISTS saved_report_schedules_due_idx ON saved_report_schedules(tenant_id,next_run_at) WHERE status='active';

CREATE TABLE IF NOT EXISTS report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  schedule_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','cancelled')),
  report_hash char(64) NOT NULL,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,schedule_id,scheduled_for),
  FOREIGN KEY(tenant_id,schedule_id) REFERENCES saved_report_schedules(tenant_id,id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS report_deliveries_schedule_idx ON report_deliveries(tenant_id,schedule_id,created_at DESC);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['saved_report_definitions','saved_report_schedules','report_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I',tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
