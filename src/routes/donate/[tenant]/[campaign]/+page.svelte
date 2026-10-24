<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import {
		loadStripe,
		type Stripe,
		type StripeElements,
		type StripePaymentElement
	} from '@stripe/stripe-js';
	import { ArrowRight, Heart, LockKeyhole, CheckCircle2, ArrowLeft, Leaf } from 'lucide-svelte';
	import { currencyExponent, formatMoney, majorToMinor, minorToMajor } from '$lib/money';
	let { data } = $props();
	const suggestedAmounts = $derived(
		(data.campaign.formConfig?.suggestedAmounts || [2500, 5000, 10000, 25000]).map(
			(minor: number) => minorToMajor(minor, data.currency)
		)
	);
	const frequencies = $derived(data.campaign.formConfig?.frequencies || ['once']);
	let amount = $state(
			untrack(() =>
				minorToMajor(data.campaign.formConfig?.suggestedAmounts?.[1] || 5000, data.currency)
			)
		),
		frequency = $state('once'),
		donorName = $state(''),
		donorEmail = $state(''),
		anonymous = $state(false),
		feeCoverage = $state(false),
		includeTribute = $state(false),
		tributeKind = $state<'honor' | 'memory'>('honor'),
		honoree = $state(''),
		notifyName = $state(''),
		notifyEmail = $state(''),
		designationFundId = $state(''),
		address = $state({ line1: '', line2: '', city: '', region: '', postalCode: '', country: 'US' }),
		terms = $state(false),
		pending = $state(false),
		error = $state(''),
		phase = $state<'details' | 'payment' | 'processing' | 'success'>('details'),
		celebrate = $state(false);
	let paymentMount = $state<HTMLDivElement>();
	let stripe: Stripe | null = null,
		elements: StripeElements | undefined,
		payment: StripePaymentElement | undefined,
		checkoutToken = '',
		requestKey = '';
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	const money = (minor: number) => formatMoney(minor, data.currency);
	const amountStep = $derived(10 ** -currencyExponent(data.currency));
	const amountMin = $derived(minorToMajor(50, data.currency));
	const amountMax = $derived(minorToMajor(25_000_000, data.currency));
	const giftAmountMinor = $derived.by(() => {
		try {
			return majorToMinor(amount, data.currency);
		} catch {
			return 0;
		}
	});
	function feeCoverageMinor(baseMinor: number) {
		const config = data.campaign.formConfig;
		const rate = Number(config?.feeCoverageBasisPoints || 0) / 10_000;
		const fixed = Number(config?.feeCoverageFixedMinor || 0);
		return Math.ceil((baseMinor * rate + fixed) / (1 - rate));
	}
	const feeCoverageAmountMinor = $derived(
		giftAmountMinor > 0 ? feeCoverageMinor(giftAmountMinor) : 0
	);
	const coveredFeeMinor = $derived(feeCoverage ? feeCoverageAmountMinor : 0);
	const totalAmountMinor = $derived(giftAmountMinor + coveredFeeMinor);
	const storageKey = () => 'donor-checkout:' + page.params.tenant + ':' + page.params.campaign;
	onMount(() => {
		const stored = sessionStorage.getItem(storageKey());
		if (stored) {
			checkoutToken = stored;
			phase = 'processing';
			void poll();
		}
		if (page.url.searchParams.has('payment_intent_client_secret'))
			history.replaceState(null, '', page.url.pathname);
	});
	onDestroy(() => {
		payment?.destroy();
		if (pollTimer) clearTimeout(pollTimer);
	});
	async function prepare() {
		pending = true;
		error = '';
		try {
			requestKey = requestKey || crypto.randomUUID();
			const res = await fetch('/api/v1/donation-intents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					tenant: page.params.tenant,
					campaignId: data.campaign.id,
					fundraiserId: data.fundraiserId || undefined,
					campaignLinkCode: data.campaignLinkCode || undefined,
					requestKey,
					amountMinor: giftAmountMinor,
					frequency,
					donorName,
					donorEmail,
					termsAccepted: terms,
					anonymous,
					feeCoverage,
					utm: {
						source: page.url.searchParams.get('utm_source') || undefined,
						medium: page.url.searchParams.get('utm_medium') || undefined,
						campaign: page.url.searchParams.get('utm_campaign') || undefined,
						content: page.url.searchParams.get('utm_content') || undefined,
						term: page.url.searchParams.get('utm_term') || undefined
					},
					designationFundId: designationFundId || undefined,
					address: data.campaign.formConfig?.askForAddress ? address : undefined,
					tribute: includeTribute
						? {
								kind: tributeKind,
								honoree,
								notifyName: notifyName || undefined,
								notifyEmail: notifyEmail || undefined
							}
						: undefined
				})
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || 'Unable to prepare payment');
			checkoutToken = body.checkoutToken;
			sessionStorage.setItem(storageKey(), checkoutToken);
			stripe = await loadStripe(body.publishableKey, { stripeAccount: body.connectedAccountId });
			if (!stripe) throw new Error('Secure payment fields could not be loaded.');
			const dark = document.documentElement.classList.contains('dark');
			elements = stripe.elements({
				clientSecret: body.clientSecret,
				appearance: {
					theme: dark ? 'night' : 'stripe',
					variables: {
						colorPrimary: '#244e3d',
						borderRadius: '0px',
						fontFamily: 'Arial, sans-serif'
					}
				}
			});
			phase = 'payment';
			await tick();
			payment = elements.create('payment');
			payment.mount(paymentMount!);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Payment unavailable';
		} finally {
			pending = false;
		}
	}
	async function pay() {
		if (!stripe || !elements) return;
		pending = true;
		error = '';
		try {
			const result = await stripe.confirmPayment({
				elements,
				confirmParams: {
					return_url: page.url.origin + page.url.pathname,
					payment_method_data: { billing_details: { name: donorName, email: donorEmail } }
				},
				redirect: 'if_required'
			});
			if (result.error) throw new Error(result.error.message || 'Payment could not be completed.');
			phase = 'processing';
			await poll();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Payment could not be completed';
		} finally {
			pending = false;
		}
	}
	async function poll() {
		try {
			const res = await fetch('/api/v1/donation-intents/status', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ checkoutToken })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || 'Unable to confirm payment');
			if (['paid', 'succeeded', 'recorded'].includes(body.status)) {
				phase = 'success';
				const conversionKey = 'converted:' + checkoutToken;
				if (data.campaign.variant?.id && !sessionStorage.getItem(conversionKey)) {
					void fetch(
						`/api/v1/campaigns/public/${encodeURIComponent(page.params.tenant || '')}/${encodeURIComponent(data.campaign.id)}/conversion`,
						{
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								campaignId: data.campaign.id,
								variantId: data.campaign.variant.id
							})
						}
					)
						.then((response) => {
							if (response.ok) sessionStorage.setItem(conversionKey, 'yes');
						})
						.catch(() => {});
				}
				const celebrationKey = 'celebrated:' + checkoutToken;
				if (!sessionStorage.getItem(celebrationKey)) {
					celebrate = true;
					sessionStorage.setItem(celebrationKey, 'yes');
				}
				sessionStorage.removeItem(storageKey());
				return;
			}
			if (['failed', 'canceled', 'refunded', 'disputed', 'ended'].includes(body.status)) {
				error = 'Payment status: ' + body.status + '. Please contact the organization for help.';
				return;
			}
			pollTimer = setTimeout(poll, 3000);
		} catch (e) {
			error =
				e instanceof Error
					? e.message
					: 'Confirmation is temporarily unavailable. Your gift has not been marked successful.';
		}
	}
</script>

<svelte:head
	><title>{data.campaign.name} · {data.organization}</title><meta
		name="description"
		content={data.campaign.description}
	/><meta name="robots" content="noindex" /></svelte:head
>
<main class="donation-page" data-theme={data.branding?.theme}>
	<header>
		<a class="brand" href="/"
			>{#if data.branding?.logoUrl}<img
					src={data.branding.logoUrl}
					width="38"
					height="38"
					alt={data.organization + ' logo'}
				/>{:else}<img
					src="/brand/generous-dots.svg"
					width="38"
					height="38"
					alt=""
				/>{/if}{data.organization}</a
		><span class="donation-private"><LockKeyhole size={14} />A secure little act of good</span>
	</header>
	<div class="donation-layout">
		<section class="donation-story">
			<span class="eyebrow"
				>{data.demo
					? 'SYNTHETIC CAMPAIGN PREVIEW'
					: 'A LITTLE GENEROSITY. A LASTING DIFFERENCE.'}</span
			>
			<h1>
				{data.campaign.variant?.headline || data.campaign.name}<span class="heading-dot">.</span>
			</h1>
			{#if data.campaign.heroImageUrl}<img
					class="campaign-hero"
					src={data.campaign.heroImageUrl}
					alt=""
				/>{/if}
			<div class="donation-illustration" aria-hidden="true">
				<div class="sprout"><span></span><span></span><span></span></div>
				<span>Good<br /><em>takes root.</em></span>
				<div>✳</div>
			</div>
			<p>
				{data.campaign.variant?.description ||
					data.campaign.story ||
					data.campaign.description ||
					'A little generosity becomes a little more possibility for our community.'}
			</p>
			<p class="small muted">
				Your support goes to {data.organization}. Any tax-deductibility statement must be confirmed
				by the organization. No donor identity is published.
			</p>
		</section>
		<section class="donation-form-area" aria-labelledby="gift-heading">
			{#if phase === 'success'}<div class="donation-success">
					<CheckCircle2 size={44} /><span class="eyebrow">RECEIVED WITH GRATITUDE</span>
					<h2>You made a little<br />more possible.</h2>
					<p>
						Your gift has been confirmed by the payment webhook. Thank you for helping good grow.
					</p>
					{#if celebrate}<div class="gift-celebration" aria-hidden="true">
							{#each Array(12) as _, i}<span style:--i={i}>✦</span>{/each}
						</div>{/if}
				</div>
			{:else if phase === 'processing'}<div class="donation-success" aria-live="polite">
					<Leaf size={35} />
					<h2>A little moment to confirm.</h2>
					<p>
						We’re waiting for the trusted payment event. This page will update when the gift is
						recorded.
					</p>
					<button class="secondary" onclick={poll}>Check payment status</button>
				</div>
			{:else}<h2 id="gift-heading">Be part of the good.</h2>
				<p class="muted small">Choose a little possibility.</p>
				{#if !data.canAcceptPayments}<div class="banner neutral">
						This {data.demo ? 'synthetic preview' : 'campaign'} cannot accept payments. Stripe is not
						connected. No money will be processed.
					</div>{/if}
				{#if phase === 'details'}<form
						class="stacked-form"
						onsubmit={(e) => {
							e.preventDefault();
							prepare();
						}}
					>
						<div class="donation-frequency" role="group" aria-label="Gift frequency">
							{#each [{ value: 'once', label: 'One time' }, { value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annually' }].filter( (option) => frequencies.includes(option.value) ) as option}<button
									type="button"
									class:chosen={frequency === option.value}
									aria-pressed={frequency === option.value}
									onclick={() => (frequency = option.value)}>{option.label}</button
								>{/each}
						</div>
						<div class="amount-options" role="group" aria-label="Suggested gift amounts">
							{#each suggestedAmounts as option}<button
									type="button"
									class:chosen={amount === option}
									aria-pressed={amount === option}
									onclick={() => (amount = option)}
									>{money(majorToMinor(option, data.currency))}</button
								>{/each}
						</div>
						<label
							>Your amount ({data.currency})<input
								type="number"
								min={amountMin}
								max={amountMax}
								step={amountStep}
								required
								readonly={!data.campaign.formConfig?.allowCustomAmount}
								bind:value={amount}
							/></label
						>
						<label
							>Your name<input
								autocomplete="name"
								required
								maxlength="120"
								bind:value={donorName}
							/></label
						>
						<label
							>Email for your confirmation<input
								type="email"
								autocomplete="email"
								required
								maxlength="254"
								bind:value={donorEmail}
							/></label
						>
						{#if data.designations && data.designations.length > 0}<label
								>Designate this gift<select bind:value={designationFundId}
									><option value="">Campaign’s default fund</option
									>{#each data.designations as fund}<option value={fund.id}>{fund.name}</option
										>{/each}</select
								></label
							>{/if}
						{#if data.campaign.formConfig?.allowAnonymous}<label class="checkbox-label"
								><input type="checkbox" bind:checked={anonymous} />Keep my name private in donor
								recognition</label
							>{/if}
						{#if data.campaign.formConfig?.allowFeeCoverage && (data.campaign.formConfig?.feeCoverageBasisPoints || data.campaign.formConfig?.feeCoverageFixedMinor)}<label
								class="checkbox-label"
								><input type="checkbox" bind:checked={feeCoverage} />Add {money(
									feeCoverageAmountMinor
								)} to help cover payment fees</label
							>{/if}
						{#if data.campaign.formConfig?.allowTribute}<label class="checkbox-label"
								><input type="checkbox" bind:checked={includeTribute} />Make this gift in honor or
								memory of someone</label
							>{#if includeTribute}<div class="tribute-fields">
									<label
										>Tribute type<select bind:value={tributeKind}
											><option value="honor">In honor of</option><option value="memory"
												>In memory of</option
											></select
										></label
									><label
										>Honoree name<input
											required
											minlength="2"
											maxlength="120"
											bind:value={honoree}
										/></label
									><label
										>Notify someone (optional)<input
											maxlength="120"
											bind:value={notifyName}
											placeholder="Name"
										/></label
									><label
										>Notification email (optional)<input
											type="email"
											maxlength="254"
											bind:value={notifyEmail}
										/></label
									>
								</div>{/if}{/if}
						{#if data.campaign.formConfig?.askForAddress}<fieldset class="address-fields">
								<legend>Mailing address</legend><label
									>Street address<input
										autocomplete="address-line1"
										required
										maxlength="120"
										bind:value={address.line1}
									/></label
								><label
									>Apartment or unit<input
										autocomplete="address-line2"
										maxlength="120"
										bind:value={address.line2}
									/></label
								><label
									>City<input
										autocomplete="address-level2"
										required
										maxlength="100"
										bind:value={address.city}
									/></label
								><label
									>State or region<input
										autocomplete="address-level1"
										required
										maxlength="100"
										bind:value={address.region}
									/></label
								><label
									>Postal code<input
										autocomplete="postal-code"
										required
										maxlength="24"
										bind:value={address.postalCode}
									/></label
								><label
									>Country code<input
										autocomplete="country"
										required
										minlength="2"
										maxlength="2"
										pattern="[A-Za-z]{2}"
										bind:value={address.country}
									/></label
								>
							</fieldset>{/if}
						<label class="checkbox-label"
							><input type="checkbox" required bind:checked={terms} />{data.campaign.formConfig
								?.terms ||
								`I authorize this ${frequency === 'once' ? 'one-time' : frequency === 'monthly' ? 'monthly recurring' : 'annual recurring'} gift of ${money(giftAmountMinor)}.`}</label
						>
						{#if data.campaign.formConfig?.privacyUrl}<p class="small muted">
								See the <a
									class="privacy-link"
									href={data.campaign.formConfig.privacyUrl}
									target="_blank"
									rel="noopener noreferrer">privacy policy</a
								>.
							</p>{/if}
						<p class="muted small">
							You are charged {money(totalAmountMinor)}{frequency === 'monthly'
								? ' each month until canceled'
								: frequency === 'annual'
									? ' each year until canceled'
									: ''}{coveredFeeMinor
								? `, including ${money(coveredFeeMinor)} to help cover payment fees`
								: ''}.
						</p>
						<button class="primary" disabled={pending || !data.canAcceptPayments}
							>{pending ? 'Preparing secure payment…' : 'Continue to secure payment'}<ArrowRight
								size={17}
							/></button
						>
					</form>
				{:else}<div class="gift-review">
						<span
							>{frequency === 'once'
								? 'One-time gift'
								: frequency === 'monthly'
									? 'Monthly gift'
									: 'Annual gift'}</span
						><strong>{money(totalAmountMinor)}</strong>
						<p class="muted small">{donorName} · {donorEmail}</p>
					</div>
					<div bind:this={paymentMount}></div>
					<button class="primary payment-submit" disabled={pending} onclick={pay}
						>{pending ? 'Confirming…' : 'Give ' + money(totalAmountMinor)}<Heart
							size={17}
						/></button
					>
					<p class="small muted">
						Card details stay in Stripe-hosted secure fields. Your gift is recorded only after
						webhook confirmation.
					</p>{/if}
			{/if}
			{#if error}<p class="banner error" role="alert">{error}</p>{/if}
		</section>
	</div>
	<footer>
		<img src="/brand/generous-dots.svg" width="22" height="22" alt="" />A little connection. A
		lasting difference.
	</footer>
</main>
