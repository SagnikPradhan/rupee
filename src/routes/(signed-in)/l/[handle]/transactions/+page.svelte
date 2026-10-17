<script lang="ts">
	import { getTransactions } from '#lib/endpoints/transactions.remote.ts';
	import type { RupeeError } from '#lib/server/shared/result/error.ts';

	const { data } = $props();

	const response = $derived(await getTransactions(data.ledger.handle));

	// Assertions only check the ledger; nothing is wrong with the data they point at.
	const isWarning = (e: RupeeError) =>
		e.type === 'BalanceAssertionFailed' || e.type === 'BalanceAssertionAmbiguous';
	const problems = $derived(response.errors.filter((e) => !isWarning(e)));
	const warnings = $derived(response.errors.filter(isWarning));

	const describe = (error: RupeeError) =>
		[
			error.type,
			'location' in error ? ` at ${error.location}` : '',
			'account' in error && 'expected' in error
				? `: ${error.account} expected ${error.expected}, got ${error.actual}`
				: '',
			'unordered' in error
				? `: ${error.account} could be either side of ${error.unordered}; add a time to order them`
				: '',
		].join('');
</script>

<h1>Transactions</h1>

{#each problems as error, index (index)}
	<p role="alert">{describe(error)}</p>
{/each}

{#if warnings.length > 0}
	<section aria-label="Warnings">
		<h2>Warnings</h2>
		{#each warnings as warning, index (index)}
			<p role="status">{describe(warning)}</p>
		{/each}
	</section>
{/if}

<table>
	<thead>
		<tr><th>Date</th><th>Description</th><th>Postings</th><th>Source</th></tr>
	</thead>
	<tbody>
		{#each response.data ?? [] as transaction (transaction.id)}
			<tr style:opacity={transaction.counted ? 1 : 0.5}>
				<td>{transaction.date} {transaction.time ?? ''}</td>
				<td>{transaction.description}{transaction.counted ? '' : ' (evidence, not counted)'}</td>
				<td>
					{#each transaction.postings as posting, index (index)}
						<div>
							{posting.account}
							{posting.quantity}
						</div>
					{/each}
				</td>
				<td>{transaction.file}:{transaction.line}</td>
			</tr>
		{/each}
	</tbody>
</table>
