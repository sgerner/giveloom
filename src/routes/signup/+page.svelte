<script lang="ts">
	let email = $state(''),
		password = $state(''),
		name = $state(''),
		organizationName = $state(''),
		tenantSlug = $state(''),
		createdSlug = $state(''),
		verificationQueued = $state(false),
		pending = $state(false),
		error = $state('');
	async function signup() {
		pending = true;
		error = '';
		try {
			const res = await fetch('/api/v1/signup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email,
					password,
					name,
					organizationName,
					...(tenantSlug ? { tenantSlug } : {})
				})
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Unable to create workspace');
			verificationQueued = true;
			createdSlug = result.tenant.slug || tenantSlug;
			password = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unable to create workspace';
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head><title>Create your workspace · Donor CRM</title></svelte:head>
<main class="auth-page">
	<a class="brand" href="/"
		><img src="/brand/generous-dots.svg" width="36" height="36" alt="" />Donor CRM</a
	>
	<div class="auth-content">
		<span class="eyebrow">GOOD GROWS FROM HERE</span>
		<h1>Make room for possibility<span class="heading-dot">.</span></h1>
		<p class="lede">Create a private workspace for your organization.</p>
		{#if verificationQueued}<p class="banner">
				Your workspace <strong>{createdSlug}</strong> is ready. Confirm your email before signing in.
				A verification message has been queued for delivery; it may take a short time to arrive.
			</p>
			<p>
				<a href={`/login?tenant=${encodeURIComponent(createdSlug)}`}>Continue to sign in ↗</a>
			</p>{/if}
		{#if error}<p class="banner error" role="alert">{error}</p>{/if}
		{#if !verificationQueued}<form
				class="stacked-form"
				onsubmit={(e) => {
					e.preventDefault();
					signup();
				}}
			>
				<label
					>Your name<input required maxlength="180" autocomplete="name" bind:value={name} /></label
				><label
					>Organization<input
						required
						maxlength="180"
						autocomplete="organization"
						bind:value={organizationName}
					/></label
				><label
					>Workspace slug<input
						pattern="[a-z0-9-]+"
						minlength="3"
						bind:value={tenantSlug}
						placeholder="riverstone-fund"
					/></label
				><label>Email<input type="email" autocomplete="email" required bind:value={email} /></label
				><label
					>Password <span class="muted">(at least 12 characters)</span><input
						type="password"
						minlength="12"
						maxlength="128"
						autocomplete="new-password"
						required
						bind:value={password}
					/></label
				><button class="primary" disabled={pending}
					>{pending ? 'Creating your workspace…' : 'Create workspace'} ↗</button
				>
			</form>
		{/if}
		<p class="auth-links">Already growing good? <a href="/login">Sign in</a></p>
	</div>
</main>
