<script lang="ts">
	let { data } = $props();
	const amount = $derived(
		new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: data.receipt.currency
		}).format(data.receipt.amountMinor / 100)
	);
</script>

<svelte:head
	><title>Donation acknowledgment · {data.receipt.organization}</title><meta
		name="robots"
		content="noindex,nofollow"
	/></svelte:head
>
<main>
	<a class="brand" href="/portal">Donor CRM · Donor portal</a>
	<article>
		<p class="eyebrow">DONATION ACKNOWLEDGMENT</p>
		<h1>Thank you, {data.receipt.donorName}.</h1>
		<p class="organization">{data.receipt.organization}</p>
		<div class="amount">{amount}</div>
		<dl>
			<div>
				<dt>Date</dt>
				<dd>{new Date(data.receipt.occurredAt).toLocaleDateString()}</dd>
			</div>
			<div>
				<dt>Campaign</dt>
				<dd>{data.receipt.campaignName || 'General support'}</dd>
			</div>
			<div>
				<dt>Reference</dt>
				<dd>{data.receipt.receiptNumber}</dd>
			</div>
		</dl>
		<p class="disclaimer">{data.receipt.disclaimer}</p>
		<button onclick={() => window.print()}>Print acknowledgment</button>
	</article>
</main>

<style>
	main {
		max-width: 720px;
		margin: 0 auto;
		padding: 48px 24px;
		color: #17231f;
	}
	.brand {
		font-weight: 800;
		color: #176b52;
		text-decoration: none;
	}
	article {
		margin: 58px auto 0;
		max-width: 560px;
		border: 1px solid #e3e9e5;
		border-radius: 20px;
		padding: 40px;
		background: #fff;
	}
	.eyebrow {
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		color: #397c65;
	}
	h1 {
		font-size: 2.6rem;
		line-height: 1.05;
		letter-spacing: -0.055em;
		margin: 0.6rem 0;
	}
	.organization {
		color: #728078;
	}
	.amount {
		font-size: 2.4rem;
		font-weight: 800;
		letter-spacing: -0.05em;
		margin: 32px 0;
	}
	dl {
		border-top: 1px solid #e6ece8;
		border-bottom: 1px solid #e6ece8;
		padding: 8px 0;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		padding: 10px 0;
		gap: 20px;
	}
	dt {
		color: #728078;
	}
	dd {
		margin: 0;
		text-align: right;
	}
	.disclaimer {
		font-size: 0.83rem;
		color: #728078;
		line-height: 1.5;
		margin: 24px 0;
	}
	button {
		border: 0;
		border-radius: 10px;
		background: #176b52;
		color: white;
		padding: 12px 18px;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	@media print {
		main {
			padding: 0;
		}
		article {
			border: 0;
			box-shadow: none;
			margin: 0 auto;
			max-width: none;
		}
		button,
		.brand {
			display: none;
		}
	}
</style>
