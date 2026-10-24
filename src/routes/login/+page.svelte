<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	let email = $state(''),
		password = $state(''),
		tenant = $state(''),
		mfaChallenge = $state(''),
		mfaCode = $state(''),
		pending = $state(false),
		error = $state('');
	onMount(() => {
		tenant =
			new URLSearchParams(window.location.search).get('tenant') ||
			localStorage.getItem('crm-recent-tenant') ||
			'';
	});
	async function login() {
		pending = true;
		error = '';
		try {
			const res = await fetch('/api/v1/session', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email,
					password,
					tenant,
					...(mfaChallenge ? { mfaChallenge, mfaCode } : {})
				})
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Unable to sign in');
			if (result.mfaRequired) {
				mfaChallenge = result.challengeToken;
				return;
			}
			localStorage.setItem('crm-recent-tenant', result.tenant);
			await goto('/app/' + result.tenant + '/overview');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unable to sign in';
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head><title>Sign in · Donor CRM</title></svelte:head>
<main class="auth-page">
	<a class="brand" href="/"
		><img src="/brand/generous-dots.svg" width="36" height="36" alt="" />Donor CRM</a
	>
	<div class="auth-content">
		<span class="eyebrow">A GOOD PLACE TO PICK THINGS UP</span>
		<h1>Welcome back<span class="heading-dot">.</span></h1>
		<p class="lede">Your people. Your purpose. Your workspace.</p>
		{#if error}<p class="banner error" role="alert">{error}</p>{/if}
		<form
			class="stacked-form"
			onsubmit={(e) => {
				e.preventDefault();
				login();
			}}
		>
			{#if mfaChallenge}<label
					>Authenticator or recovery code<input
						autocomplete="one-time-code"
						required
						bind:value={mfaCode}
					/></label
				>{/if}
			<label>Email<input type="email" autocomplete="username" required bind:value={email} /></label
			><label
				>Password<input
					type="password"
					autocomplete="current-password"
					required
					bind:value={password}
				/></label
			><label
				>Workspace slug<input
					autocomplete="organization"
					required
					pattern="[a-z0-9-]+"
					bind:value={tenant}
					placeholder="your-organization"
				/></label
			><button class="primary" disabled={pending}
				>{pending ? 'Signing in…' : 'Sign in'} <span>↗</span></button
			>
		</form>
		<p class="auth-links">A new beginning? <a href="/signup">Create a workspace</a></p>
		<p class="auth-links"><a href="/account/recover">Forgot your password?</a></p>
		{#if !mfaChallenge}<p class="auth-links">
				<a href="/account/verify">Resend email confirmation</a>
			</p>{/if}
		<a class="text-button" href="/">Explore the synthetic demo →</a>
	</div>
</main>
