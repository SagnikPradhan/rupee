<script lang="ts">
	import {
		importStatement,
		previewStatement,
		readStatement,
		recogniseStatement,
		unlockStatement,
	} from '#lib/endpoints/import.remote.ts';
	import { getSuggestions } from '#lib/endpoints/refinement.remote.ts';
	import {
		deleteSchema,
		getSchema,
		getSchemas,
		saveSchema,
	} from '#lib/endpoints/schemas.remote.ts';
	import type { RupeeError } from '#lib/server/shared/result/error.ts';
	import type { Reply } from '#lib/server/shared/result/reply.ts';
	import { goto } from '$app/navigation';

	type Preview = Awaited<ReturnType<typeof previewStatement>>;

	/** A starting point: Rupee's built-in HDFC savings schema, which the manual walks through. */
	const example = `version: v1
name: HDFC Bank savings account
match:
  - text: HDFC
account: Assets:Bank:HDFC
header:
  text: Narration
fields:
  date: { from: [header: Date], pipe: [date: dd/MM/yy] }
  description: { from: [header: Narration] }
  amount:
    - from: [header: Withdrawal Amt.]
      pipe: [number, negate]
    - from: [header: Deposit Amt.]
      pipe: [number]
  balance: { from: [header: Closing Balance], pipe: [number] }
`;

	const { data } = $props();

	const handle = $derived(data.ledger.handle);
	const schemas = $derived(await getSchemas(handle));

	const statement = $state({ key: '', grid: [] as string[][], errors: [] as RupeeError[] });
	const editor = $state({
		key: 'my-bank.yml',
		content: example,
		errors: [] as RupeeError[],
		saved: false,
	});
	const preview = $state({ ticket: 0, result: null as Preview | null });

	const locked = $derived(
		statement.errors.flatMap((e) => (e.type === 'ExtractionLocked' ? [e.path] : []))[0],
	);
	const width = $derived(Math.max(0, ...statement.grid.map((r) => r.length)));
	const columns = $derived([...Array(width).keys()].map(letter));

	function letter(index: number): string {
		const prefix = index >= 26 ? letter(Math.floor(index / 26) - 1) : '';
		return prefix + String.fromCharCode(65 + (index % 26));
	}

	const describe = (error: RupeeError) =>
		[
			error.type,
			'location' in error ? `at ${error.location}` : '',
			'field' in error ? `(${error.field})` : '',
			'reason' in error ? `: ${error.reason}` : '',
			'columns' in error ? `: ${error.columns.join(', ')}` : '',
		].join(' ');

	const sleep = (t: number) => new Promise<void>((r) => setTimeout(r, t));

	async function apply(wait: number) {
		const ticket = ++preview.ticket;
		await sleep(wait);

		if (ticket !== preview.ticket || !statement.key) return;

		const result = await previewStatement({
			handle,
			statement: statement.key,
			schema: { key: editor.key, content: editor.content },
		});
		if (ticket !== preview.ticket) return;

		preview.result = result;
		const suggested = result.data?.key;
		if (suggested && !importStatement.fields.key.value()) importStatement.fields.key.set(suggested);
	}

	async function show(result: Reply<{ key: string; grid: string[][] }> | undefined) {
		Object.assign(statement, { key: '', grid: [], errors: result?.errors ?? [] });
		if (result?.data) Object.assign(statement, { key: result.data.key, grid: result.data.grid });
		importStatement.fields.key.set('');
		if (result?.data) await recognise(result.data.key);
		await apply(0);
	}

	// A statement no schema recognises keeps the schema being written.
	async function recognise(key: string) {
		const recognised = await recogniseStatement({ handle, statement: key });
		statement.errors = recognised.errors;
		if (recognised.data)
			Object.assign(editor, {
				key: recognised.data.key,
				content: recognised.data.content,
				errors: [],
				saved: false,
			});
	}

	function edit(content: string) {
		Object.assign(editor, { content, saved: false });
		void apply(300);
	}

	async function open(key: string) {
		const schema = await getSchema({ handle, key });
		Object.assign(editor, { errors: schema.errors, saved: false });
		if (schema.data) Object.assign(editor, { key, content: schema.data.content });
		await apply(0);
	}

	function start() {
		Object.assign(editor, { key: 'my-bank.yml', content: example, errors: [], saved: false });
		void apply(0);
	}

	async function save() {
		const saved = await saveSchema({ handle, key: editor.key, content: editor.content });
		Object.assign(editor, { errors: saved.errors, saved: saved.ok });
	}

	async function remove(key: string) {
		if (!confirm(`Delete ${key}?`)) return;
		const deleted = await deleteSchema({ handle, key });
		editor.errors = deleted.errors;
		if (!deleted.ok || key !== editor.key) return;

		Object.assign(editor, { key: '', content: '', saved: false });
		preview.result = null;
	}

	// Refinement runs on every save; review its matches if it found any.
	async function review(key: string) {
		const found = await getSuggestions({ handle, file: key });
		await goto(
			found.data?.length
				? `/l/${handle}/refine?file=${encodeURIComponent(key)}`
				: `/l/${handle}/transactions`,
		);
	}
</script>

<h1>Import a statement</h1>

<section>
	<h2>Schemas</h2>
	{#each schemas.errors as error, index (index)}
		<p role="alert">{describe(error)}</p>
	{/each}
	<ul>
		{#each schemas.data ?? [] as schema (schema.key)}
			<li>
				<button onclick={() => open(schema.key)}>{schema.key}</button>
				<button onclick={() => remove(schema.key)} aria-label="Delete {schema.key}">Delete</button>
			</li>
		{/each}
	</ul>
	<button onclick={start}>New schema</button>
</section>

<section>
	<h2>Statement</h2>
	<form
		enctype="multipart/form-data"
		{...readStatement.enhance(async (form) => {
			await form.submit();
			await show(form.result);
		})}
	>
		<input {...readStatement.fields.handle.as('hidden', handle)} />
		<label>
			Statement (.csv, .xls, .xlsx, .pdf)
			<input
				{...readStatement.fields.file.as('file')}
				accept=".csv,.xls,.xlsx,.pdf"
				onchange={(e) => e.currentTarget.form?.requestSubmit()}
				required
			/>
		</label>
		<button disabled={readStatement.pending > 0}>Read again</button>
	</form>

	{#each statement.errors as error, index (index)}
		<p role="alert">{describe(error)}</p>
	{/each}

	{#if locked}
		<form
			{...unlockStatement.enhance(async (form) => {
				await form.submit();
				await show(form.result);
			})}
		>
			<input {...unlockStatement.fields.handle.as('hidden', handle)} />
			<input {...unlockStatement.fields.statement.as('hidden', locked)} />
			<label>
				Password for {locked}
				<input {...unlockStatement.fields.password.as('password')} autocomplete="off" required />
			</label>
			<button disabled={unlockStatement.pending > 0}>Unlock</button>
		</form>
	{/if}

	{#if statement.grid.length > 0}
		<div class="sheet">
			<table aria-label="Grid">
				<thead>
					<tr>
						<th></th>
						{#each columns as column (column)}
							<th>{column}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each statement.grid as row, index (index)}
						<tr>
							<th>{index + 1}</th>
							{#each columns as column, at (column)}
								<td>{row[at] ?? ''}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<section>
	<h2>Schema</h2>
	<label>
		Name
		<input bind:value={editor.key} required />
	</label>
	<label>
		Schema
		<textarea
			value={editor.content}
			oninput={(e) => edit(e.currentTarget.value)}
			rows="24"
			cols="80"
			spellcheck="false"></textarea>
	</label>
	<button onclick={save} disabled={saveSchema.pending > 0}>Save schema</button>

	{#if editor.saved}
		<p>Saved.</p>
	{/if}
	{#each editor.errors as error, index (index)}
		<p role="alert">{describe(error)}</p>
	{/each}
</section>

{#if statement.key}
	<section>
		<h2>Draft</h2>
		<form
			{...importStatement.enhance(async (form) => {
				await form.submit();
				const result = form.result;
				if (result?.ok && result.data) await review(result.data.key);
			})}
		>
			<input {...importStatement.fields.handle.as('hidden', handle)} />
			<input {...importStatement.fields.statement.as('hidden', statement.key)} />
			<input {...importStatement.fields.schema.key.as('hidden', editor.key)} />
			<input {...importStatement.fields.schema.content.as('hidden', editor.content)} />
			{#if preview.result}
				{#each preview.result.errors as error, index (index)}
					<p role="alert">{describe(error)}</p>
				{/each}
				<p>{preview.result.data?.transactions.length ?? 0} transactions</p>
				<div class="sheet">
					<table aria-label="Draft">
						<thead>
							<tr><th>Line</th><th>Date</th><th>Description</th><th>Postings</th></tr>
						</thead>
						<tbody>
							{#each preview.result.data?.transactions ?? [] as transaction (transaction.line)}
								<tr>
									<td>{transaction.line}</td>
									<td>{transaction.date} {transaction.time ?? ''}</td>
									<td>{transaction.description}</td>
									<td>
										{#each transaction.postings as posting, index (index)}
											<div>
												{posting.account}
												{posting.amount}{posting.cost ? ` ${posting.cost}` : ''}{posting.price
													? ` ${posting.price}`
													: ''}
											</div>
										{/each}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<label>
				Save as
				<input {...importStatement.fields.key.as('text')} required />
			</label>
			{#each importStatement.fields.allIssues() ?? [] as issue (issue.message)}
				<p role="alert">{issue.message}</p>
			{/each}
			{#each importStatement.result?.errors ?? [] as error, index (index)}
				<p role="alert">{describe(error)}</p>
			{/each}
			<button disabled={importStatement.pending > 0}>Save</button>
		</form>
	</section>
{/if}

<style>
	.sheet {
		max-height: 60vh;
		overflow: auto;
		border: 1px solid var(--color-border);
	}

	.sheet table {
		border-collapse: collapse;
		font-family: var(--font-mono);
		font-size: var(--font-size-0);
	}

	.sheet th,
	.sheet td {
		padding: var(--size-0) var(--size-1);
		border: 1px solid var(--color-border);
		text-align: left;
		vertical-align: top;
	}

	.sheet td,
	.sheet thead th:not(:first-child) {
		width: 14ch;
		min-width: 14ch;
		max-width: 14ch;
		overflow-wrap: anywhere;
	}

	.sheet th {
		position: sticky;
		background: var(--color-light-gray);
		font-weight: 400;
	}

	.sheet thead th {
		top: 0;
	}

	.sheet tbody th {
		left: 0;
		text-align: right;
	}

	.sheet thead th:first-child {
		left: 0;
		z-index: 1;
	}
</style>
