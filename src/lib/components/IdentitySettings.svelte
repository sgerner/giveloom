<script lang="ts">
	type Member = { id: string; name: string; email: string; role: string; joinedAt: string };
	type Invite = {
		id: string;
		email: string;
		role: string;
		expiresAt: string;
		deliveryStatus: string;
	};
	type StaffSession = {
		id: string;
		createdAt: string;
		lastSeenAt: string;
		expiresAt: string;
		current: boolean;
	};
	const roles = [
		'admin',
		'finance_manager',
		'fundraiser',
		'marketer',
		'finance',
		'donor',
		'analyst',
		'volunteer',
		'board_member',
		'read_only'
	];
	let user = $state<{ id: string; email: string; name: string; role: string } | null>(null),
		tenant = $state<{ slug: string; name: string } | null>(null);
	let members = $state<Member[]>([]),
		invites = $state<Invite[]>([]),
		sessions = $state<StaffSession[]>([]);
	let mfaEnabled = $state(false);
	let name = $state(''),
		email = $state(''),
		role = $state('fundraiser'),
		code = $state(''),
		mfaCode = $state(''),
		enrollment = $state<{ secret: string; otpauthUri: string } | null>(null),
		recoveryCodes = $state<string[]>([]);
	let busy = $state(false),
		error = $state(''),
		notice = $state('');
	async function request(url: string, method = 'GET', body?: unknown) {
		const response = await fetch(url, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || 'Request failed');
		return data;
	}
	async function load() {
		error = '';
		try {
			const me = await request('/api/v1/session');
			if (!me.user) {
				user = null;
				tenant = me.tenant;
				error =
					'Staff access management is available after signing in with an organization account.';
				return;
			}
			user = me.user;
			tenant = me.tenant;
			const [sessionData, mfaData] = await Promise.all([
				request('/api/v1/identity/sessions'),
				request('/api/v1/identity/mfa')
			]);
			sessions = sessionData.sessions;
			mfaEnabled = mfaData.enabled;
			if (['owner', 'admin'].includes(me.user.role)) {
				const [memberData, inviteData] = await Promise.all([
					request('/api/v1/identity/members'),
					request('/api/v1/identity/invites')
				]);
				members = memberData.members;
				invites = inviteData.invites;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load account settings';
		}
	}
	async function invite() {
		busy = true;
		error = '';
		notice = '';
		try {
			await request('/api/v1/identity/invites', 'POST', { name, email, role });
			notice = 'Invitation queued for delivery.';
			email = '';
			name = '';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Invitation could not be created';
		} finally {
			busy = false;
		}
	}
	async function changeRole(member: Member) {
		error = '';
		try {
			await request(`/api/v1/identity/members/${member.id}`, 'PATCH', { role: member.role });
			notice = `Updated ${member.name}’s role.`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Role could not be changed';
			await load();
		}
	}
	async function revokeInvite(inviteId: string) {
		try {
			await request(`/api/v1/identity/invites/${inviteId}`, 'DELETE');
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Invitation could not be revoked';
		}
	}
	async function revokeSession(session: StaffSession) {
		try {
			await request(`/api/v1/identity/sessions/${session.id}`, 'DELETE');
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Session could not be revoked';
		}
	}
	async function setupMfa() {
		try {
			enrollment = await request('/api/v1/identity/mfa/setup', 'POST');
			recoveryCodes = [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'MFA setup failed';
		}
	}
	async function confirmMfa() {
		try {
			const result = await request('/api/v1/identity/mfa/confirm', 'POST', { code });
			recoveryCodes = result.recoveryCodes;
			enrollment = null;
			code = '';
			notice = 'MFA is enabled. Save these recovery codes now; they will not be shown again.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'MFA could not be enabled';
		}
	}
	async function disableMfa() {
		try {
			await request('/api/v1/identity/mfa/disable', 'POST', { code: mfaCode });
			mfaCode = '';
			notice = 'MFA has been disabled.';
			recoveryCodes = [];
			mfaEnabled = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'MFA could not be disabled';
		}
	}
	$effect(() => {
		void load();
	});
</script>

<section class="identity-settings" aria-labelledby="identity-title">
	<header>
		<span class="eyebrow">WORKSPACE ACCESS</span>
		<h2 id="identity-title">People and security</h2>
		<p>Manage who can enter this workspace and how staff accounts stay protected.</p>
	</header>
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}{#if notice}<p
			class="banner"
			role="status"
		>
			{notice}
		</p>{/if}
	{#if user}<div class="identity-account">
			<div><strong>{user.name}</strong><span>{user.email}</span></div>
			<span class="identity-role">{user.role.replaceAll('_', ' ')}</span>
		</div>{/if}
	{#if user?.role === 'owner' || user?.role === 'admin'}
		<section class="identity-card">
			<h3>Workspace members</h3>
			<p>Only workspace owners and admins can view or change member access.</p>
			{#if members.length}<div class="identity-list">
					{#each members as member (member.id)}<div class="identity-row">
							<div><strong>{member.name}</strong><span>{member.email}</span></div>
							{#if member.role === 'owner'}<span class="identity-role">owner</span>{:else}<select
									aria-label={`Role for ${member.name}`}
									bind:value={member.role}
									onchange={() => changeRole(member)}
									>{#each roles as item}<option value={item}>{item.replaceAll('_', ' ')}</option
										>{/each}</select
								>{/if}
						</div>{/each}
				</div>{:else}<p>No active members found.</p>{/if}
		</section>
		<section class="identity-card">
			<h3>Invite a teammate</h3>
			<form
				class="identity-form"
				onsubmit={(e) => {
					e.preventDefault();
					invite();
				}}
			>
				<label>Name<input required maxlength="120" autocomplete="name" bind:value={name} /></label
				><label
					>Email<input
						type="email"
						required
						maxlength="254"
						autocomplete="email"
						bind:value={email}
					/></label
				><label
					>Role<select bind:value={role}
						>{#each roles as item}<option value={item}>{item.replaceAll('_', ' ')}</option
							>{/each}</select
					></label
				><button class="primary" disabled={busy}>{busy ? 'Queueing…' : 'Send invitation ↗'}</button>
			</form>
			{#if invites.length}<h4>Pending invitations</h4>
				<div class="identity-list">
					{#each invites as invite (invite.id)}<div class="identity-row">
							<div>
								<strong>{invite.email}</strong><span
									>{invite.role.replaceAll('_', ' ')} · {invite.deliveryStatus}</span
								>
							</div>
							<button class="text-button" onclick={() => revokeInvite(invite.id)}>Revoke</button>
						</div>{/each}
				</div>{/if}
		</section>
	{/if}
	<section class="identity-card">
		<h3>Two-factor authentication</h3>
		<p>Require an authenticator code or one-use recovery code at sign-in.</p>
		{#if recoveryCodes.length}<div class="identity-recovery">
				<strong>Save these recovery codes now</strong><code>{recoveryCodes.join('\n')}</code>
			</div>{:else if enrollment}<p>
				Scan this setup URI with your authenticator app, or enter the secret manually:
			</p>
			<code class="identity-secret">{enrollment.secret}</code>
			<details>
				<summary>Authenticator setup URI</summary><code class="identity-secret"
					>{enrollment.otpauthUri}</code
				>
			</details>
			<form
				class="identity-inline"
				onsubmit={(e) => {
					e.preventDefault();
					confirmMfa();
				}}
			>
				<label
					>Six-digit code<input
						inputmode="numeric"
						autocomplete="one-time-code"
						maxlength="6"
						bind:value={code}
					/></label
				><button class="primary">Enable MFA</button>
			</form>{:else if mfaEnabled}<p>MFA is enabled for this staff account.</p>{:else}<button
				class="secondary"
				onclick={setupMfa}>Set up authenticator</button
			>{/if}{#if mfaEnabled}<div class="identity-inline">
				<label
					>Disable with authenticator or recovery code<input
						autocomplete="one-time-code"
						bind:value={mfaCode}
					/></label
				><button class="text-button" onclick={disableMfa}>Disable MFA</button>
			</div>{/if}
	</section>
	<section class="identity-card">
		<h3>Signed-in sessions</h3>
		<p>Revoke a session to sign that device out immediately.</p>
		{#if sessions.length}<div class="identity-list">
				{#each sessions as session (session.id)}<div class="identity-row">
						<div>
							<strong>{session.current ? 'This session' : 'Staff session'}</strong><span
								>Last active {new Date(session.lastSeenAt).toLocaleString()} · expires {new Date(
									session.expiresAt
								).toLocaleString()}</span
							>
						</div>
						<button class="text-button" onclick={() => revokeSession(session)}
							>{session.current ? 'Sign out' : 'Revoke'}</button
						>
					</div>{/each}
			</div>{:else}<p>No active sessions.</p>{/if}
	</section>
</section>

<style>
	.identity-settings {
		display: grid;
		gap: 1.1rem;
		max-width: 900px;
	}
	.identity-settings header h2 {
		margin: 0.2rem 0;
	}
	.identity-settings header p,
	.identity-card > p {
		color: var(--muted, #667085);
	}
	.identity-account,
	.identity-card {
		padding: 1rem 1.2rem;
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 1rem;
		background: var(--surface, #fff);
	}
	.identity-account,
	.identity-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.identity-account > div,
	.identity-row > div {
		display: grid;
		gap: 0.2rem;
	}
	.identity-account span,
	.identity-row span {
		color: var(--muted, #667085);
		font-size: 0.9rem;
	}
	.identity-role {
		padding: 0.3rem 0.6rem;
		border-radius: 99px;
		background: #f1f5f9;
		text-transform: capitalize;
	}
	.identity-card h3 {
		margin: 0.1rem 0 0.4rem;
	}
	.identity-card h4 {
		margin: 1rem 0 0.5rem;
	}
	.identity-list {
		display: grid;
		gap: 0.5rem;
		margin-top: 0.8rem;
	}
	.identity-row {
		padding: 0.65rem 0;
		border-top: 1px solid var(--border, #e5e7eb);
	}
	.identity-row select {
		min-width: 10rem;
	}
	.identity-form {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.7rem;
		align-items: end;
	}
	.identity-form label,
	.identity-inline label {
		display: grid;
		gap: 0.35rem;
	}
	.identity-form input,
	.identity-form select,
	.identity-inline input,
	.identity-row select {
		min-height: 2.6rem;
		border: 1px solid var(--border, #d0d5dd);
		border-radius: 0.6rem;
		padding: 0.45rem 0.6rem;
		background: #fff;
	}
	.identity-inline {
		display: flex;
		align-items: end;
		gap: 0.7rem;
		margin-top: 1rem;
	}
	.identity-secret,
	.identity-recovery code {
		display: block;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 0.8rem;
		border-radius: 0.6rem;
		background: #f5f7f6;
		margin: 0.5rem 0;
	}
	.identity-recovery {
		padding: 1rem;
		border: 1px solid #e0bd78;
		border-radius: 0.8rem;
		background: #fff8e9;
	}
	.identity-recovery code {
		font-size: 1rem;
	}
	.identity-settings .primary,
	.identity-settings .secondary,
	.identity-settings .text-button {
		cursor: pointer;
	}
	@media (max-width: 640px) {
		.identity-row {
			align-items: flex-start;
			flex-direction: column;
		}
		.identity-inline {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
