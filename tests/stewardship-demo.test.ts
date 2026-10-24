import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('synthetic demo stewardship storage', () => {
	let directory: string | undefined;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});
	it('lists, creates, and updates demo tasks without initializing PostgreSQL', async () => {
		directory = await mkdtemp(join(tmpdir(), 'giveloom-demo-stewardship-'));
		const oldData = process.env.DEMO_DATA_PATH,
			oldExtensions = process.env.DEMO_EXTENSIONS_PATH;
		process.env.DEMO_DATA_PATH = join(directory, 'demo.json');
		process.env.DEMO_EXTENSIONS_PATH = join(directory, 'extensions.json');
		try {
			const [
				{ getWorkspace },
				{ listTasks, listTaskAssignees, createTask, updateTask, listNotifications }
			] = await Promise.all([
				import('../src/lib/server/store'),
				import('../src/lib/server/stewardship')
			]);
			const session = {
				userId: 'demo:riverstone',
				tenantSlug: 'riverstone',
				role: 'owner',
				demo: true
			};
			const workspace = await getWorkspace('riverstone');
			expect(workspace).toBeTruthy();
			const created = await createTask(session, {
				title: 'Review the donor thank-you',
				contactId: workspace!.contacts[0]!.id,
				dueAt: '2026-10-25T17:00:00.000Z'
			});
			const id = String(created.task.id);
			expect((await listTasks(session)).tasks.some((task) => task.id === id)).toBe(true);
			expect(await listTaskAssignees(session)).toEqual({ assignees: [] });
			expect(await listNotifications(session)).toEqual({ notifications: [] });
			const updated = await updateTask(session, id, { status: 'completed' });
			expect(updated.task.status).toBe('completed');
		} finally {
			if (oldData === undefined) delete process.env.DEMO_DATA_PATH;
			else process.env.DEMO_DATA_PATH = oldData;
			if (oldExtensions === undefined) delete process.env.DEMO_EXTENSIONS_PATH;
			else process.env.DEMO_EXTENSIONS_PATH = oldExtensions;
		}
	});
});
