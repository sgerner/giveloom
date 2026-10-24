CREATE TABLE IF NOT EXISTS automation_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','archived')),
  current_version integer NOT NULL DEFAULT 1 CHECK(current_version > 0),
  published_version integer,
  next_schedule_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);

CREATE TABLE IF NOT EXISTS automation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  automation_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  definition jsonb NOT NULL,
  validation jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,automation_id,version),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,automation_id) REFERENCES automation_definitions(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  automation_id uuid NOT NULL,
  version integer NOT NULL,
  contact_id uuid,
  trigger_type text NOT NULL,
  trigger_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting','completed','failed','cancelled')),
  context jsonb NOT NULL DEFAULT '{}',
  next_step_id text,
  step_number integer NOT NULL DEFAULT 0 CHECK(step_number BETWEEN 0 AND 100),
  retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 20),
  next_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,automation_id,trigger_key),
  FOREIGN KEY (tenant_id,automation_id) REFERENCES automation_definitions(tenant_id,id),
  FOREIGN KEY (tenant_id,automation_id,version) REFERENCES automation_versions(tenant_id,automation_id,version),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS automation_runs_queue_idx ON automation_runs(tenant_id,state,next_at,created_at);
CREATE INDEX IF NOT EXISTS automation_runs_contact_idx ON automation_runs(tenant_id,contact_id,created_at DESC);

CREATE TABLE IF NOT EXISTS automation_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL,
  step_number integer NOT NULL CHECK(step_number BETWEEN 1 AND 100),
  node_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('running','completed','skipped','failed')),
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb NOT NULL DEFAULT '{}',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id,run_id,step_number),
  FOREIGN KEY (tenant_id,run_id) REFERENCES automation_runs(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS task_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  remind_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','queued','delivered','cancelled')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,task_id) REFERENCES tasks(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS task_reminders_due_idx ON task_reminders(tenant_id,remind_at) WHERE state='scheduled';

CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  task_id uuid,
  contact_id uuid,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  body text NOT NULL DEFAULT '' CHECK(length(body) <= 4000),
  kind text NOT NULL DEFAULT 'task_reminder' CHECK(kind IN ('task_reminder','automation','stewardship')),
  idempotency_key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,task_id) REFERENCES tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS user_notifications_inbox_idx ON user_notifications(tenant_id,user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS stewardship_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  owner_id uuid REFERENCES users(id),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  goal text NOT NULL DEFAULT '' CHECK(length(goal) <= 4000),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  review_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS stewardship_plans_contact_idx ON stewardship_plans(tenant_id,contact_id,status);

CREATE TABLE IF NOT EXISTS stewardship_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL,
  position integer NOT NULL CHECK(position > 0),
  kind text NOT NULL CHECK(kind IN ('call','meeting','email_draft','proposal','research','note','other')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','skipped')),
  outcome text NOT NULL DEFAULT '' CHECK(length(outcome) <= 4000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,plan_id,position),
  FOREIGN KEY (tenant_id,plan_id) REFERENCES stewardship_plans(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contact_id uuid NOT NULL,
  owner_id uuid REFERENCES users(id),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  stage text NOT NULL DEFAULT 'discovery' CHECK(stage IN ('discovery','drafting','submitted','negotiation','won','lost')),
  ask_minor bigint NOT NULL CHECK(ask_minor >= 0),
  currency char(3) NOT NULL,
  expected_close_at date,
  notes text NOT NULL DEFAULT '' CHECK(length(notes) <= 8000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS proposals_contact_idx ON proposals(tenant_id,contact_id,updated_at DESC);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS tasks_assigned_due_idx ON tasks(tenant_id,assigned_to,due_at) WHERE status IN ('open','in_progress');

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['automation_definitions','automation_versions','automation_runs','automation_run_steps','task_reminders','user_notifications','stewardship_plans','stewardship_steps','proposals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', tab);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION prevent_automation_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published workflow versions are immutable.'; END $$;
DROP TRIGGER IF EXISTS automation_versions_are_immutable ON automation_versions;
CREATE TRIGGER automation_versions_are_immutable BEFORE UPDATE OR DELETE ON automation_versions FOR EACH ROW EXECUTE FUNCTION prevent_automation_version_mutation();
