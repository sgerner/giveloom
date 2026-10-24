<script lang="ts">
	let { data } = $props<{ data: { token: string } }>();
	let email = $state(''),
		password = $state(''),
		message = $state(''),
		error = $state(''),
		busy = $state(false);
	async function act() {
		busy = true;
		error = '';
		message = '';
		try {
			const res = await fetch(
				data.token ? '/api/v1/identity/password/consume' : '/api/v1/identity/password/request',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(data.token ? { token: data.token, password } : { email })
				}
			);
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Request failed');
			message = data.token
				? 'Password changed. Sign in with your new password.'
				: 'If the address belongs to an account, a recovery message has been queued for delivery.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Request failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Password recovery · Donor CRM</title></svelte:head>
<main class="auth-page">
	<a class="brand" href="/">Donor CRM</a>
	<div class="auth-content">
		<span class="eyebrow">ACCOUNT SECURITY</span>
		<h1>Recover access<span class="heading-dot">.</span></h1>
		{#if data.token}<p class="lede">Choose a new password for your account.</p>
			<form
				class="stacked-form"
				onsubmit={(e) => {
					e.preventDefault();
					act();
				}}
			>
				<label
					>New password<input
						type="password"
						minlength="12"
						maxlength="128"
						autocomplete="new-password"
						required
						bind:value={password}
					/></label
				><button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Set new password ↗'}</button>
			</form>
		{:else}<p class="lede">
				Enter your account email. The response does not reveal whether an account exists.
			</p>
			<form
				class="stacked-form"
				onsubmit={(e) => {
					e.preventDefault();
					act();
				}}
			>
				<label>Email<input type="email" autocomplete="email" required bind:value={email} /></label
				><button class="primary" disabled={busy}
					>{busy ? 'Requesting…' : 'Request recovery link ↗'}</button
				>
			</form>{/if}
		{#if message}<p class="banner">{message}</p>{/if}{#if error}<p
				class="banner error"
				role="alert"
			>
				{error}
			</p>{/if}
		<p class="auth-links"><a href="/login">Return to sign in</a></p>
	</div>
</main>
