<script lang="ts">
	import { formatMoney } from '$lib/money';
	let {
		values = [0, 0, 0, 0, 0, 0],
		labels = ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'],
		currency = 'USD',
		onclick = (_index: number) => {}
	} = $props<{
		values?: number[];
		labels?: string[];
		currency?: string;
		onclick?: (index: number) => void;
	}>();
	let max = $derived(Math.max(1, ...values));
</script>

<div class="chart" role="group" aria-label="Giving by month. Select a month to see gifts.">
	<div class="chart-grid" aria-hidden="true">
		<span>100%</span><span>75%</span><span>50%</span><span>25%</span>
	</div>
	<div class="chart-bars">
		{#each values as value, i}<button
				class="chart-column"
				aria-label={labels[i] + ': ' + formatMoney(value, currency)}
				onclick={() => onclick(i)}
				><span class="bar-track"
					><span class="chart-bar" style:height={Math.max(2, (value / max) * 100) + '%'}
						><span class="bar-top"></span></span
					></span
				><span class="chart-label">{labels[i]}</span></button
			>{/each}
	</div>
</div>
