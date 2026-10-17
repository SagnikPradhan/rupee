<script lang="ts">
	const { data, children } = $props();

	const base = $derived(`/l/${data.ledger.handle}`);
</script>

<nav aria-label="Ledger">
	<a href="/">{data.ledger.name}</a> ·
	<a href="{base}/files">Files</a> ·
	<a href="{base}/accounts">Accounts</a> ·
	<a href="{base}/transactions">Transactions</a> ·
	<a href="{base}/postings">Postings</a> ·
	<a href="{base}/refine">Refine</a> ·
	<a href="{base}/import">Import a statement</a>
</nav>

<!-- Pages keep what they made for one ledger, so another ledger starts them afresh. -->
{#key data.ledger.handle}
	{@render children()}
{/key}
