import { anyOf, before, containing, distance, noneOf } from '#lib/server/db/expressions.ts';
import { ROWS_PER_STATEMENT, vectorText, type Database } from '#lib/server/db/index.ts';
import { readOnly } from '#lib/server/db/read-only.ts';
import type { Tables } from '#lib/server/db/tables.ts';
import { atomically } from '#lib/server/db/atomically.ts';
import { chunks } from '#lib/server/shared/arrays.ts';
import { withContext } from '#lib/server/shared/context/context.ts';
import { attempt, okAsync, ResultAsync } from '#lib/server/shared/result/result.ts';
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Amount } from '../domain/amounts';
import { GROUP_KEYS } from '../domain/groups';
import { toMetadata } from '../domain/nodes';
import type { Neighbour } from '../domain/prediction';
import { BALANCE_TYPES } from '../domain/taxonomy';
import type { Filled, Unembedded } from '../domain/text';
import type { RupeaMetadata, RupeaTransaction } from '../domain/types';
import { touchedBy, type Touched } from './database-files';
import { listingKey, newestFirst, toCost, toPrice, underAccount } from './database-queries';

// Transactions searched near each line; the domain keeps the best few postings.
const NEAREST = 50;

// Candidates the index keeps while searching; at least `NEAREST`.
const SEARCHED = 200;

export type IndexedTransaction = RupeaTransaction & { id: string };

export type CountedTransaction = IndexedTransaction & { counted: boolean };

/** What a list is narrowed to; a null side is left open. */
export type ListFilter = {
	from: Temporal.PlainDate;
	to: Temporal.PlainDate;
	account: string | null;
	description: string | null;
};

/** Where a page of transactions starts: just past this one, newest first. */
export type Cursor = { date: string; time: string; id: string };

export type Page<T, C> = { rows: T[]; next: C | null };

export type PageOptions<C> = { filter: ListFilter; after: C | null; limit: number };

export const findTransactions = (
	ledgerId: string,
	ids: string[],
): ResultAsync<IndexedTransaction[]> =>
	ResultAsync.combine(
		chunks(ids, ROWS_PER_STATEMENT).map((c) =>
			readWhere(ledgerId, (e) => e('transactions.id', 'in', c)),
		),
	).map((r) => r.flat());

export const findFirstDay = (ledgerId: string): ResultAsync<Temporal.PlainDate | null> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('transactions')
				.select((e) => e.fn.min('transactions.date').as('date'))
				.where('transactions.ledgerId', '=', ledgerId)
				.executeTakeFirst(),
		).map((r) => (r?.date ? Temporal.PlainDate.from(r.date) : null)),
	);

// The cursor compares as one tuple, so a page reads on as one range of the
// order index.
export const listTransactions = (
	ledgerId: string,
	{ filter, after, limit }: PageOptions<Cursor>,
): ResultAsync<Page<CountedTransaction, Cursor>> =>
	readOnly(async (db) => {
		const keys = await db
			.selectFrom('transactions as t')
			.select(['t.id', 't.date', 't.sortTime as time', 't.counted'])
			.where('t.ledgerId', '=', ledgerId)
			.where('t.date', '>=', filter.from.toString())
			.where('t.date', '<=', filter.to.toString())
			.where((e) => containing(e.ref('t.description'), filter.description))
			.where((e) =>
				filter.account !== null
					? e.exists(
							e
								.selectFrom('postings as p')
								.innerJoin('accounts as a', 'a.id', 'p.accountId')
								.select(sql.lit(1).as('one'))
								.whereRef('p.transactionId', '=', 't.id')
								.where((x) => underAccount(x.ref('a.name'), filter.account)),
						)
					: e.lit(true),
			)
			.where(() => before(listingKey('t'), after && [after.date, after.time, after.id]))
			.orderBy(newestFirst('t'))
			.limit(limit)
			.execute();
		const found =
			keys.length === 0
				? []
				: await readIn(db, (eb) =>
						eb(
							'transactions.id',
							'in',
							keys.map((k) => k.id),
						),
					);

		const byId = Object.fromEntries(found.map((t) => [t.id, t]));
		const last = keys.length === limit ? keys.at(-1) : undefined;
		return {
			rows: keys.flatMap((k) => {
				const transaction = byId[k.id];
				return transaction ? [{ ...transaction, counted: k.counted }] : [];
			}),
			next: last ? { date: last.date, time: last.time, id: last.id } : null,
		};
	});

/** Marks these transactions and their postings uncounted and every other counted, writing only the rows that change, and returns what those rows touch. */
export const recount = (ledgerId: string, uncounted: string[]): ResultAsync<Touched> =>
	atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				const counting = await tx
					.updateTable('transactions')
					.set({ counted: true })
					.where('ledgerId', '=', ledgerId)
					.where('counted', '=', false)
					.where((e) => noneOf(e.ref('id'), uncounted, 'uuid'))
					.returning('id')
					.execute();
				const uncounting = await tx
					.updateTable('transactions')
					.set({ counted: false })
					.where('ledgerId', '=', ledgerId)
					.where('counted', '=', true)
					.where((e) => anyOf(e.ref('id'), uncounted, 'uuid'))
					.returning('id')
					.execute();
				const changed = [...counting, ...uncounting].map((t) => t.id);
				if (changed.length === 0)
					return { commodities: [], spans: [], positions: [], grouped: false };

				await tx
					.updateTable('postings')
					.from('transactions')
					.set((e) => ({ counted: e.ref('transactions.counted') }))
					.whereRef('postings.transactionId', '=', 'transactions.id')
					.where((e) => anyOf(e.ref('transactions.id'), changed, 'uuid'))
					.execute();

				return touchedBy(tx, changed);
			}),
		),
	);

export type CandidatePair = { ours: string; theirs: string };

// Same date, amount and balance account, in another file; the other side goes
// through the `(account_id, commodity, amount)` index.
export const listCandidates = (ledgerId: string, key: string): ResultAsync<CandidatePair[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('ledgerFiles as ourFile')
				.innerJoin('transactions as ourTransaction', 'ourTransaction.fileId', 'ourFile.id')
				.innerJoin('postings as ourPosting', 'ourPosting.transactionId', 'ourTransaction.id')
				.innerJoin('postings as theirPosting', (join) =>
					join
						.onRef('theirPosting.accountId', '=', 'ourPosting.accountId')
						.onRef('theirPosting.commodity', '=', 'ourPosting.commodity')
						.onRef('theirPosting.amount', '=', 'ourPosting.amount'),
				)
				.innerJoin('transactions as theirTransaction', (join) =>
					join
						.onRef('theirTransaction.id', '=', 'theirPosting.transactionId')
						.onRef('theirTransaction.date', '=', 'ourTransaction.date')
						.onRef('theirTransaction.fileId', '!=', 'ourFile.id'),
				)
				.where('ourFile.ledgerId', '=', ledgerId)
				.where('ourFile.key', '=', key)
				.where('ourPosting.accountType', 'in', BALANCE_TYPES)
				.select(['ourTransaction.id as ours', 'theirTransaction.id as theirs'])
				.distinct()
				.execute(),
		),
	);

// Only transactions in a group, through the metadata `(ledger_id, key, value)` index.
export const listGroupTransactions = (ledgerId: string): ResultAsync<IndexedTransaction[]> =>
	readWhere(ledgerId, (eb) =>
		eb(
			'transactions.id',
			'in',
			eb
				.selectFrom('metadata')
				.select('metadata.transactionId')
				.where('metadata.ledgerId', '=', ledgerId)
				.where('metadata.key', 'in', GROUP_KEYS),
		),
	);

// Every member of every group a transaction in the file belongs to.
export const listGroupsInFile = (
	ledgerId: string,
	key: string,
): ResultAsync<IndexedTransaction[]> =>
	readWhere(ledgerId, (eb) =>
		eb(
			'transactions.id',
			'in',
			eb
				.selectFrom('metadata')
				.select('metadata.transactionId')
				.where('metadata.ledgerId', '=', ledgerId)
				.where('metadata.key', 'in', GROUP_KEYS)
				.where('metadata.value', 'in', groupsOfFile(eb, ledgerId, key)),
		),
	);

export const listGroupMembers = (
	ledgerId: string,
	group: string,
): ResultAsync<IndexedTransaction[]> =>
	readWhere(ledgerId, (eb) =>
		eb(
			'transactions.id',
			'in',
			eb
				.selectFrom('metadata')
				.select('metadata.transactionId')
				.where('metadata.ledgerId', '=', ledgerId)
				.where('metadata.key', 'in', GROUP_KEYS)
				.where('metadata.value', '=', group),
		),
	);

export const isGroupIdTaken = (ledgerId: string, id: string): ResultAsync<boolean> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('metadata')
				.select('metadata.id')
				.where('metadata.ledgerId', '=', ledgerId)
				.where('metadata.key', 'in', GROUP_KEYS)
				.where('metadata.value', '=', id)
				.limit(1)
				.executeTakeFirst(),
		).map((r) => r !== undefined),
	);

export const listUnembedded = (
	ledgerId: string,
	model: string,
	limit: number,
): ResultAsync<Unembedded[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('transactions')
				.select(['transactions.id', 'transactions.description'])
				.where('transactions.ledgerId', '=', ledgerId)
				.where('transactions.embeddingModel', 'is distinct from', model)
				.orderBy('transactions.date', 'desc')
				.limit(limit)
				.execute(),
		),
	);

// A transaction's statements share one connection, so they go one at a time.
export const saveEmbeddings = (
	ledgerId: string,
	model: string,
	rows: Filled[],
): ResultAsync<void> =>
	atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				for (const chunk of chunks(rows, ROWS_PER_STATEMENT))
					await embeddingsUpdate(tx, ledgerId, model, chunk).execute();
			}),
		),
	);

// The index covers every ledger, so it keeps scanning until enough rows are
// this ledger's; relaxed order is fine, as the domain sorts them again.
export const findNearest = (
	ledgerId: string,
	model: string,
	vectors: Float32Array[],
): ResultAsync<Neighbour[][]> => {
	if (vectors.length === 0) return okAsync([]);

	return atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				await sql`set local hnsw.iterative_scan = relaxed_order`.execute(tx);
				await sql.raw(`set local hnsw.ef_search = ${SEARCHED}`).execute(tx);
				return nearestQuery(tx, ledgerId, model, vectors).execute();
			}),
		).map((r) => byQuery(vectors.length, r)),
	);
};

// The group ids the file's transactions name, through the metadata index.
const groupsOfFile = (
	eb: ExpressionBuilder<Tables, 'transactions'>,
	ledgerId: string,
	key: string,
) =>
	eb
		.selectFrom('metadata')
		.innerJoin('transactions', 'transactions.id', 'metadata.transactionId')
		.innerJoin('ledgerFiles', 'ledgerFiles.id', 'transactions.fileId')
		.select('metadata.value')
		.where('metadata.ledgerId', '=', ledgerId)
		.where('ledgerFiles.key', '=', key)
		.where('metadata.key', 'in', GROUP_KEYS);

type Where = (eb: ExpressionBuilder<Tables, 'transactions'>) => Expression<SqlBool>;

// `n` narrows the ledger's transactions. One snapshot, so the metadata
// read always belongs to the transactions read.
const readWhere = (l: string, n: Where): ResultAsync<IndexedTransaction[]> =>
	readOnly((t) => readIn(t, (e) => e.and([e('transactions.ledgerId', '=', l), n(e)])));

const readIn = async (db: Database, where: Where): Promise<IndexedTransaction[]> => {
	const rows = await db
		.selectFrom('transactions')
		.innerJoin('ledgerFiles', 'ledgerFiles.id', 'transactions.fileId')
		.leftJoin('postings', 'postings.transactionId', 'transactions.id')
		.leftJoin('accounts', 'accounts.id', 'postings.accountId')
		.select([
			'ledgerFiles.key',
			'transactions.id',
			'transactions.line',
			'transactions.date',
			'transactions.time',
			'transactions.description',
			'transactions.comment',
			'postings.id as postingId',
			'accounts.name as account',
			'postings.amount',
			'postings.commodity',
			'postings.priceAmount',
			'postings.priceCommodity',
			'postings.priceKind',
			'postings.costAmount',
			'postings.costCommodity',
			'postings.costDate',
			'postings.balance',
			'postings.comment as postingComment',
		])
		.where(where)
		.orderBy('transactions.id')
		.orderBy('postings.position')
		.execute();

	// A transaction's statements share one connection, so they go one at a time.
	const ofTransactions = await db
		.selectFrom('metadata')
		.innerJoin('transactions', 'transactions.id', 'metadata.transactionId')
		.select(['metadata.transactionId as owner', 'metadata.key', 'metadata.value'])
		.where(where)
		.orderBy('metadata.position')
		.execute();
	const ofPostings = await db
		.selectFrom('metadata')
		.innerJoin('postings', 'postings.id', 'metadata.postingId')
		.innerJoin('transactions', 'transactions.id', 'postings.transactionId')
		.select(['metadata.postingId as owner', 'metadata.key', 'metadata.value'])
		.where(where)
		.orderBy('metadata.position')
		.execute();
	const owned = byOwner([...ofTransactions, ...ofPostings]);

	return [...Map.groupBy(rows, (r) => r.id).values()]
		.flatMap(([head, ...tail]) => (head ? [{ head, rows: [head, ...tail] }] : []))
		.map(({ head, rows: group }) => ({
			id: head.id,
			location: { file: head.key, line: head.line },
			date: Temporal.PlainDate.from(head.date),
			time: head.time === null ? null : Temporal.PlainTime.from(head.time),
			description: head.description,
			metadata: owned[head.id] ?? {},
			comment: head.comment,
			postings: group.flatMap((r) =>
				r.postingId === null || r.account === null || r.amount === null || r.commodity === null
					? []
					: [
							{
								account: r.account,
								amount: r.amount as Amount,
								commodity: r.commodity,
								price: toPrice(r),
								cost: toCost(r),
								balance: r.balance as Amount | null,
								metadata: owned[r.postingId] ?? {},
								comment: r.postingComment,
							},
						],
			),
		}))
		.sort(
			(a, b) =>
				Temporal.PlainDate.compare(a.date, b.date) ||
				compareTimes(a.time, b.time) ||
				a.location.file.localeCompare(b.location.file) ||
				a.location.line - b.location.line,
		);
};

const compareTimes = (a: Temporal.PlainTime | null, b: Temporal.PlainTime | null) =>
	a && b ? Temporal.PlainTime.compare(a, b) : Number(a !== null) - Number(b !== null);

type MetadataRow = { owner: string | null; key: string; value: string };

// Rows come in written order, which `toMetadata` keeps.
const byOwner = (rows: MetadataRow[]): Record<string, RupeaMetadata> =>
	Object.fromEntries(
		Object.entries(Object.groupBy(rows, (r) => r.owner ?? '')).map(([owner, group = []]) => [
			owner,
			toMetadata(group.map((r) => [r.key, r.value])),
		]),
	);

const embeddingsUpdate = (tx: Database, ledgerId: string, model: string, rows: Filled[]) =>
	tx
		.updateTable('transactions')
		.from(
			sql<{ id: string; embedding: string | null }>`(
				select * from unnest(
					${rows.map((r) => r.id)}::uuid[],
					${rows.map((r) => (r.vector ? vectorText(r.vector) : null))}::text[]
				) as x(id, embedding)
			)`.as('f'),
		)
		.set((e) => ({
			embedding: sql<number[]>`${e.ref('f.embedding')}::vector`,
			embeddingModel: model,
		}))
		.whereRef('transactions.id', '=', 'f.id')
		.where('transactions.ledgerId', '=', ledgerId);

type NeighbourRow = {
	query: string;
	account: string;
	amount: bigint;
	date: string;
	similarity: number;
};

// Nearest by cosine distance for each vector in turn, the index finding them.
const nearestQuery = (tx: Database, ledgerId: string, model: string, vectors: Float32Array[]) =>
	tx
		.selectFrom(
			sql<{ v: string; i: string }>`(
				select v, i from unnest(${vectors.map(vectorText)}::text[]::vector[]) with ordinality as x(v, i)
			)`.as('q'),
		)
		.innerJoinLateral(
			(e) =>
				e
					.selectFrom('transactions')
					.select((x) => [
						'transactions.id',
						'transactions.date',
						sql<number>`1 - (${distance(x.ref('transactions.embedding'), x.ref('q.v'))})`.as(
							'similarity',
						),
					])
					.where('transactions.ledgerId', '=', ledgerId)
					.where('transactions.embeddingModel', '=', model)
					.where('transactions.embedding', 'is not', null)
					.orderBy((x) => distance(x.ref('transactions.embedding'), x.ref('q.v')))
					.limit(NEAREST)
					.as('n'),
			(j) => j.onTrue(),
		)
		.innerJoin('postings', 'postings.transactionId', 'n.id')
		.innerJoin('accounts', 'accounts.id', 'postings.accountId')
		.select((e) => [
			e.cast<string>(e.ref('q.i'), 'text').as('query'),
			'accounts.name as account',
			'postings.amount',
			'n.date',
			'n.similarity',
		]);

// `query` counts from 1, as `with ordinality` does.
const byQuery = (count: number, rows: NeighbourRow[]): Neighbour[][] => {
	const grouped = Object.groupBy(rows, (r) => r.query);
	return Array.from({ length: count }, (_, i) =>
		(grouped[String(i + 1)] ?? []).map((r) => ({
			account: r.account,
			amount: r.amount as Amount,
			date: Temporal.PlainDate.from(r.date),
			similarity: r.similarity,
		})),
	);
};
