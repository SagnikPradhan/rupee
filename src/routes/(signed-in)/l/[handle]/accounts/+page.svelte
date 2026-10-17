<script lang="ts">
	import { getAccounts } from '#lib/endpoints/accounts.remote.ts';

	const { data } = $props();

	const response = $derived(await getAccounts(data.ledger.handle));
</script>

<h1>Accounts</h1>

{#each response.errors as error, index (index)}
	<p role="alert">
		{error.type}{'location' in error ? ` at ${error.location}` : ''}
	</p>
{/each}

<table>
	<thead>
		<tr>
			<th>Account</th><th>Units</th><th>Cost</th><th>Price</th><th>Value</th><th>Gain</th>
		</tr>
	</thead>
	<tbody>
		{#each response.data ?? [] as account (account.account)}
			<tr>
				<th scope="row" style:padding-left="{account.depth}em">{account.account}</th>
				<td colspan="3"></td>
				<td>
					{account.total}{account.unpriced > 0 ? ` (excludes ${account.unpriced} unpriced)` : ''}
				</td>
				<td></td>
			</tr>
			{#each account.holdings as holding (holding.commodity)}
				<tr>
					<td style:padding-left="{account.depth + 1}em">{holding.commodity}</td>
					<td>{holding.units}</td>
					<td>{holding.cost ?? ''}</td>
					<td>{holding.price ?? ''}</td>
					<td>{holding.value ?? 'unpriced'}</td>
					<td>{holding.gain ?? ''}</td>
				</tr>
			{/each}
		{/each}
	</tbody>
</table>
