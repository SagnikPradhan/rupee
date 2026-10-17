<script lang="ts">
	import { getLots } from '#lib/endpoints/accounts.remote.ts';
	import { page } from '$app/state';

	const { data } = $props();

	const account = $derived(page.url.searchParams.get('account') ?? '');
	const commodity = $derived(page.url.searchParams.get('commodity') ?? '');
	const response = $derived(await getLots({ handle: data.ledger.handle, account, commodity }));
</script>

<h1>{commodity} in {account}</h1>
<p><a href="/l/{data.ledger.handle}/accounts">All accounts</a></p>

{#each response.errors as error, index (index)}
	<p role="alert">
		{error.type}{'location' in error ? ` at ${error.location}` : ''}
	</p>
{/each}

{#each response.data ?? [] as lot, index (index)}
	<article aria-label="Lot of {lot.date}">
		<h2>{lot.units} {commodity} at {lot.cost} on {lot.date}</h2>
		<p>
			{lot.origin}{lot.from ? ` from ${lot.from}` : ''} at {lot.location}, {lot.remaining} left
		</p>
		{#if lot.disposals.length > 0}
			<table>
				<thead>
					<tr>
						<th>Date</th>
						<th>Kind</th>
						<th>Units</th>
						<th>Price</th>
						<th>Gain</th>
						<th>Source</th>
					</tr>
				</thead>
				<tbody>
					{#each lot.disposals as disposal, i (i)}
						<tr>
							<td>{disposal.date}</td>
							<td>{disposal.kind}</td>
							<td>{disposal.units}</td>
							<td>{disposal.price ?? ''}</td>
							<td>{disposal.gain ?? ''}</td>
							<td>{disposal.location}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</article>
{:else}
	<p>No lots of {commodity} in {account}.</p>
{/each}
