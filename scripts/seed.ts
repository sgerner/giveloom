import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { demoWorkspaces } from '../src/lib/server/demo-data';

if (!process.env.DATABASE_URL) {
	const file = process.env.DEMO_DATA_PATH || '.data/giveloom-demo.json';
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		JSON.stringify({ tenants: demoWorkspaces, audit: [], outbox: [] }, null, 2),
		{ mode: 0o600 }
	);
	console.log(`Seeded clearly synthetic demo workspaces at ${file}`);
} else {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	const client = await pool.connect();
	try {
		for (const workspace of Object.values(demoWorkspaces)) {
			const t = workspace.tenant;
			await client.query(
				'INSERT INTO tenants(id,slug,legal_name,timezone,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT(slug) DO NOTHING',
				[t.id, t.slug, t.name, t.timeZone, t.currency]
			);
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.id]);
			for (const campaign of workspace.campaigns)
				await client.query(
					'INSERT INTO campaigns(tenant_id,id,name,goal_minor,currency,status,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
					[
						t.id,
						campaign.id,
						campaign.name,
						campaign.goalMinor,
						campaign.currency,
						campaign.status,
						campaign
					]
				);
			for (const contact of workspace.contacts)
				await client.query(
					'INSERT INTO contacts(tenant_id,id,name,email,stage,tags,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
					[t.id, contact.id, contact.name, contact.email, contact.stage, contact.tags, contact]
				);
			for (const gift of workspace.gifts)
				await client.query(
					'INSERT INTO gifts(tenant_id,id,contact_id,campaign_id,amount_minor,currency,kind,status,occurred_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',
					[
						t.id,
						gift.id,
						gift.contactId,
						gift.campaignId,
						gift.amountMinor,
						gift.currency,
						gift.kind,
						gift.status,
						gift.occurredAt,
						gift
					]
				);
			for (const task of workspace.tasks)
				await client.query(
					'INSERT INTO tasks(tenant_id,id,title,contact_id,due_at,priority,status,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
					[
						t.id,
						task.id,
						task.title,
						task.contactId || null,
						task.dueAt,
						task.priority,
						task.status,
						task
					]
				);
			for (const prospect of workspace.prospects)
				await client.query(
					'INSERT INTO prospects(tenant_id,id,name,stage,score,match_status,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
					[
						t.id,
						prospect.id,
						prospect.name,
						prospect.stage,
						prospect.score,
						prospect.matchStatus || 'possible',
						prospect
					]
				);
			for (const resource of [
				'introductions',
				'emails',
				'automations',
				'activities',
				'relationships'
			] as const)
				for (const item of workspace[resource])
					await client.query(
						'INSERT INTO workspace_records(tenant_id,resource,id,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
						[t.id, resource, item.id, item]
					);
			await client.query('COMMIT');
		}
		console.log('Seeded two explicitly synthetic demo tenants. No integrations were enabled.');
	} finally {
		client.release();
		await pool.end();
	}
}
