# Automation and stewardship API

These endpoints use the signed-in session and resolve the active tenant from that session. A body `tenant` value is checked against the session slug where a create form sends it; it never selects the database tenant. Responses are private and must not be cached across users.

## Workflow lifecycle

`GET /api/v1/automations` lists tenant workflows and their current draft and published definitions. `POST /api/v1/automations` accepts `{tenant,name,definition}` and creates immutable version 1. `GET` and `PATCH /api/v1/automations/{id}` read a workflow or append a new draft version. `POST /{id}/validate` reports schema and graph issues; `POST /{id}/publish` activates the validated draft; `POST /{id}/pause` and `DELETE /{id}` pause it.

`POST /{id}/simulate` accepts `{contactId}` and evaluates the draft against that tenant contact without creating records. `POST /{id}/run` also accepts `{contactId}`, but only for an active workflow whose trigger is `manual`; it creates a durable run. `GET /{id}/runs` returns recent run state. `GET /api/v1/automation-runs/{runId}` returns steps; `PATCH` with `{action:"retry"}` retries a failed run (up to 20 explicit retries), while `{action:"cancel"}` cancels queued, waiting or running work.

A definition has a `trigger`, `startId`, an array of nodes and optional `frequencyCapHours` and `quietHours` (`start` and `end` use `HH:mm` in the tenant timezone). Triggers currently supported are `gift.recorded`, `contact.created`, `task.completed`, `manual`, and `schedule` with `intervalMinutes` from 15 to 525600. Nodes are `action`, `condition`, `wait`, or `exit`. Conditions support gift amount/kind/status, contact stage/consent/tags and task status. Actions create a task, add an internal notification, add a contact tag, update a contact stage, or create an explicitly unsent email draft. Definition graphs are acyclic and limited to 40 nodes; an invalid or unreachable edge blocks publishing. Schedule/wait dispatch and each subsequent step are written to the PostgreSQL outbox in the same transaction as their state changes. The BullMQ consumer checks the current run step and unique step ledger before applying an action, so delivery replay does not repeat the action.

For example:

```json
{
	"trigger": { "type": "gift.recorded" },
	"startId": "thanks",
	"frequencyCapHours": 24,
	"quietHours": { "start": "21:00", "end": "08:00" },
	"nodes": [
		{
			"id": "thanks",
			"type": "action",
			"action": "create_task",
			"title": "Thank donor",
			"dueInHours": 24,
			"next": "finish"
		},
		{ "id": "finish", "type": "exit" }
	]
}
```

The editor stores workflow definitions as JSON so the backend rejects unknown fields rather than silently accepting unsafe action types. Simulation only reports what would happen. External provider calls and marketing email sends are not workflow actions.

## Tasks and donor stewardship

`GET /api/v1/tasks` accepts optional `contactId`, `from`, and `to` filters. `POST` creates `{tenant,title,contactId?,dueAt?,priority?,assignedTo?,recurrence?}`. Task status and assignment changes use `PATCH /api/v1/tasks/{id}`. A due time creates an internal notification reminder; completing a recurring task schedules the next daily, weekly or monthly occurrence until its optional `until` date. Reminders and notifications are idempotent. `GET /api/v1/tasks/calendar.ics` returns a private UTC calendar file for the tasks matching the same date filters.

`GET /api/v1/notifications` lists the signed-in user's tenant inbox; `PATCH /api/v1/notifications/{id}` marks one item read. `GET /api/v1/stewardship?contactId=...` lists plans and ordered steps; `POST /api/v1/stewardship` creates or updates a plan and its steps. `GET /api/v1/proposals?contactId=...` lists proposals; `POST /api/v1/proposals` creates one and `PATCH` updates its stage, ask amount, close date, notes or owner.

These features are in progress. There is no external calendar synchronization, no automated donor email from a task or workflow, and the ICS export covers task due dates only. See [feature status](../FEATURE_STATUS.md) for remaining acceptance work.
