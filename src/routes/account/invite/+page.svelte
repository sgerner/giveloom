<script lang="ts">
	import { goto } from '$app/navigation';
	let { data } = $props<{ data: { token: string; signedIn: boolean } }>();
	let name = $state(''),
		password = $state(''),
		error = $state(''),
		busy = $state(false);
	async function accept() {
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/v1/identity/invites/accept', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: data.token, ...(data.signedIn ? {} : { name, password }) })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Invitation could not be accepted');
			await goto('/app/' + result.tenant + '/overview');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Invitation could not be accepted';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Workspace invitation · Donor CRM</title></svelte:head>
<main class="auth-page">
	<a class="brand" href="/">Donor CRM</a>
	<div class="auth-content">
		<span class="eyebrow">YOU’RE INVITED</span>
		<h1>Join a workspace<span class="heading-dot">.</span></h1>
		<p class="lede">
			Accept the invitation to get started. If you already have an account, sign in with the invited
			email first.
		</p>
		{#if data.token}{#if data.signedIn}<button class="primary" onclick={accept} disabled={busy}
					>{busy ? 'Joining…' : 'Accept invitation ↗'}</button
				>{:else}<form
					class="stacked-form"
					onsubmit={(e) => {
						e.preventDefault();
						accept();
					}}
				>
					<label>Your name<input autocomplete="name" required bind:value={name} /></label><label
						>Create password<input
							type="password"
							minlength="12"
							maxlength="128"
							autocomplete="new-password"
							required
							bind:value={password}
						/></label
					><button class="primary" disabled={busy}
						>{busy ? 'Joining…' : 'Create account and accept ↗'}</button
					>
				</form>{/if}{:else}<p class="banner error">
				This invitation link is missing its token.
			</p>{/if}{#if error}<p class="banner error" role="alert">{error}</p>{/if}
		<p class="auth-links"><a href="/login">Sign in</a></p>
	</div>
</main>
