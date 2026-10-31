import { anyOf, noneOf } from '#lib/server/db/expressions.ts';
import { ROWS_PER_STATEMENT, type Database } from '#lib/server/db/index.ts';
import { insertAll } from '#lib/server/db/insert.ts';
import { atomically } from '#lib/server/db/atomically.ts';
import { withContext } from '#lib/server/shared/context/context.ts';
import { fault, type RupeaError } from '#lib/server/shared/result/error.ts';
import { attempt, errAsync, type ResultAsync } from '#lib/server/shared/result/result.ts';
import { chunks } from '#lib/server/shared/arrays.ts';
import { byCodeUnit } from '#lib/server/shared/text.ts';
import type { Span } from '#lib/shared/dates.ts';
import { sql, type SqlBool } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { GROUP_KEYS } from '../domain/groups';
import { CURRENCIES } from '../domain/lots';
import { displayLocation } from '../domain/parser';
import { marketPrices } from '../domain/prices';
import { INDEXER } from '../domain/sync';
import { accountType, BALANCE_TYPES, parentsOf } from '../domain/taxonomy';
import {
	Feed,
	ProblemKind,
	type RupeaLedgerFile,
	type RupeaMetadata,
	type RupeaTransaction,
} from '../domain/types';
import { toSpans } from './database-queries';

export type IndexedFile = { key: string; version: string; indexer: number };

export const listIndexedFiles = (ledgerId: string): ResultAsync<IndexedFile[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('ledgerFiles')
				.select(['ledgerFiles.key', 'ledgerFiles.version', 'ledgerFiles.indexer'])
				.where('ledgerFiles.ledgerId', '=', ledgerId)
				.execute(),
		),
	);

/** Of these checksums, those in a file's metadata, unlocked or as uploaded, with each file that cites one. */
export const findImported = (
	ledgerId: string,
	checksums: string[],
): ResultAsync<{ checksum: string; file: string }[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('metadata')
				.innerJoin('ledgerFiles', 'ledgerFiles.id', 'metadata.fileId')
				.select(['metadata.value as checksum', 'ledgerFiles.key as file'])
				.distinct()
				.where('metadata.ledgerId', '=', ledgerId)
				.where('metadata.key', 'in', ['checksum', 'original-checksum'])
				.where((e) => anyOf(e.ref('metadata.value'), checksums, 'text'))
				.execute(),
		),
	);

/** The counted file holding an account's latest posting, if any. */
export const findLatestFile = (ledgerId: string, account: string): ResultAsync<string | null> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.selectFrom('postings')
				.innerJoin('accounts', 'accounts.id', 'postings.accountId')
				.innerJoin('transactions', 'transactions.id', 'postings.transactionId')
				.innerJoin('ledgerFiles', 'ledgerFiles.id', 'transactions.fileId')
				.select('ledgerFiles.key')
				.where('postings.ledgerId', '=', ledgerId)
				.where(sql<SqlBool>`lower(accounts.name) = lower(${account})`)
				.orderBy('postings.date', 'desc')
				.limit(1)
				.executeTakeFirst(),
		).map((r) => r?.key ?? null),
	);

type IndexFileOptions = {
	key: string;
	version: string;
	file: RupeaLedgerFile;
	failed: RupeaError[];
};

export type Position = { accountId: string; commodity: string };

/** What changing a file touched: the commodities whose lots it held before or holds now, the days its transactions span, what they post to, and whether any names a group. */
export type Touched = {
	commodities: string[];
	spans: Span[];
	positions: Position[];
	grouped: boolean;
};

/** Replaces what a file indexes and what failed to parse in it, each transaction keeping its id where it can and each description its embedding, so saving a file neither moves a page nor re-embeds it. Transactions that hold what they held keep their rows, so a small edit writes little. */
export const indexFile = (
	ledgerId: string,
	{ key, version, file, failed }: IndexFileOptions,
): ResultAsync<Touched> => {
	const untyped = untypedAccount(file);
	if (untyped) return errAsync(untyped);

	return atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				const readBy = await indexerOf(tx, ledgerId, key);
				const fileId = await saveVersion(tx, { ledgerId, key, version });
				const old = await oldTransactions(tx, fileId);
				const rows = rowsOf({ ledgerId, fileId, file, matchOf: matchesFrom(old) });
				const kept = new Set(rows.transactions.map((t) => t.id));
				const unmatched = old.map((o) => o.id).filter((id) => !kept.has(id));
				const postings = await withAccounts(tx, ledgerId, rows.postings);
				const prices = await withSymbols(tx, { feed: Feed.Ledger, ledgerId }, rows.prices);
				const links = await withFeedSymbols(tx, rows.links);
				const problems = failed.map((e) => ({
					ledgerId,
					fileId,
					kind: ProblemKind.Parse,
					error: e,
				}));

				const changes = changesFrom({
					old,
					heldBefore: readBy === INDEXER ? await heldIn(tx, fileId) : () => '',
					transactions: rows.transactions,
					postings,
					metadata: rows.metadata,
				});
				const priceChanges = priceChangesFrom(
					await oldPrices(tx, fileId),
					prices,
					readBy === INDEXER,
				);
				const before = await touchedBy(tx, [...changes.moved, ...changes.stale, ...unmatched]);

				await tx.deleteFrom('metadata').where('fileId', '=', fileId).execute();
				await tx
					.deleteFrom('prices')
					.where((e) => anyOf(e.ref('id'), priceChanges.stale, 'uuid'))
					.execute();
				await tx.deleteFrom('symbolLinks').where('fileId', '=', fileId).execute();
				await tx.deleteFrom('problems').where('fileId', '=', fileId).execute();
				await deleteOwnedBy(tx, changes.stale);

				await saveTransactions(tx, changes.transactions);
				await replaceOldTransactions(tx, fileId, unmatched);
				await insertAll(tx, 'postings', changes.postings);
				await insertAll(tx, 'prices', priceChanges.added);
				await insertAll(tx, 'symbolLinks', links);
				await insertAll(tx, 'metadata', changes.metadata);
				await insertAll(tx, 'problems', problems);

				const after = await touchedBy(tx, [...changes.moved, ...changes.stale, ...changes.added]);
				return {
					commodities: [...before.commodities, ...after.commodities],
					spans: [...before.spans, ...after.spans],
					positions: [...before.positions, ...after.positions],
					grouped: before.grouped || after.grouped,
				};
			}),
		),
	);
};

export const unindexFile = (ledgerId: string, key: string): ResultAsync<Touched> =>
	atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				const file = await tx
					.selectFrom('ledgerFiles')
					.select('ledgerFiles.id')
					.where('ledgerFiles.ledgerId', '=', ledgerId)
					.where('ledgerFiles.key', '=', key)
					.executeTakeFirst();
				if (!file) return { commodities: [], spans: [], positions: [], grouped: false };

				const held = await oldTransactions(tx, file.id);
				const touched = await touchedBy(
					tx,
					held.map((t) => t.id),
				);
				await tx.deleteFrom('ledgerFiles').where('id', '=', file.id).execute();
				return touched;
			}),
		),
	);

/** A key spans no days and changes no amount or group, so a rename touches only the commodities whose lots the file holds. */
export const renameIndexedFile = (
	ledgerId: string,
	from: string,
	to: string,
): ResultAsync<Touched> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.updateTable('ledgerFiles')
				.set({ key: to })
				.where('ledgerId', '=', ledgerId)
				.where('key', '=', from)
				.returning('id')
				.executeTakeFirst()
				.then((f) => (f ? lotCommoditiesOf(db, f.id) : []))
				.then((c) => ({ commodities: c, spans: [], positions: [], grouped: false })),
		),
	);

/** The parser already refuses these; checked again so no posting goes unindexed. */
const untypedAccount = (file: RupeaLedgerFile): RupeaError | null =>
	file.transactions
		.flatMap((t) =>
			t.postings
				.filter((p) => !accountType(p.account))
				.map((p) =>
					fault('ParseInvalidAccount', {
						location: displayLocation(t.location),
						account: p.account,
					}),
				),
		)
		.at(0) ?? null;

/** A file an older indexer read has all its rows written again, as that is what a new indexer is for. */
const indexerOf = (db: Database, ledgerId: string, key: string) =>
	db
		.selectFrom('ledgerFiles')
		.select('indexer')
		.where('ledgerId', '=', ledgerId)
		.where('key', '=', key)
		.executeTakeFirst()
		.then((f) => f?.indexer);

type VersionOptions = { ledgerId: string; key: string; version: string };

const saveVersion = (db: Database, { ledgerId, key, version }: VersionOptions) =>
	db
		.insertInto('ledgerFiles')
		.values({ ledgerId, key, version, indexer: INDEXER })
		.onConflict((o) => o.columns(['ledgerId', 'key']).doUpdateSet({ version, indexer: INDEXER }))
		.returning('id')
		.executeTakeFirstOrThrow()
		.then((f) => f.id);

type OldTransaction = {
	id: string;
	date: string;
	time: string | null;
	description: string;
	line: number;
	comment: string | null;
	counted: boolean;
};

const oldTransactions = (db: Database, fileId: string): Promise<OldTransaction[]> =>
	db
		.selectFrom('transactions')
		.select(['id', 'date', 'time', 'description', 'line', 'comment', 'counted'])
		.where('fileId', '=', fileId)
		.orderBy('line')
		.execute();

/** Hands out old transactions by date, time and description, in file order, so an edit or a line added above keeps them. */
const matchesFrom = (old: OldTransaction[]) => {
	const free = Object.groupBy(old, (o) => `${o.date} ${o.time} ${o.description}`);

	return (t: RupeaTransaction) => free[`${t.date} ${t.time ?? null} ${t.description}`]?.shift();
};

type PostingHeld = {
	id: string;
	transactionId: string;
	position: number;
	accountId: string;
	amount: bigint;
	commodity: string;
	priceAmount: bigint | null;
	priceCommodity: string | null;
	priceKind: string | null;
	costAmount: bigint | null;
	costCommodity: string | null;
	costDate: string | null;
	balance: bigint | null;
	comment: string | null;
};

type MetadataHeld = {
	transactionId?: string | null;
	postingId?: string | null;
	position: number;
	key: string;
	value: string;
};

/** What a transaction holds beyond its own row, as text to compare: its postings and all their metadata. */
const heldFrom = (postings: PostingHeld[], metadata: MetadataHeld[]) => {
	const entries = (rows: MetadataHeld[] = []) => rows.map((m) => [m.position, m.key, m.value]);
	const byTransaction = Object.groupBy(postings, (p) => p.transactionId);
	const onTransaction = Object.groupBy(metadata, (m) => m.transactionId ?? '');
	const onPosting = Object.groupBy(metadata, (m) => m.postingId ?? '');

	return (id: string) =>
		JSON.stringify(
			[
				entries(onTransaction[id]),
				(byTransaction[id] ?? []).map((p) => [
					p.position,
					p.accountId,
					p.amount,
					p.commodity,
					p.priceAmount,
					p.priceCommodity,
					p.priceKind,
					p.costAmount,
					p.costCommodity,
					p.costDate,
					p.balance,
					p.comment,
					entries(onPosting[p.id]),
				]),
			],
			(_, v) => (typeof v === 'bigint' ? v.toString() : v),
		);
};

const heldIn = async (db: Database, fileId: string) => {
	const owners = db.selectFrom('transactions').select('id').where('fileId', '=', fileId);
	const owned = db.selectFrom('postings').select('id').where('transactionId', 'in', owners);

	const postings = await db
		.selectFrom('postings')
		.select([
			'id',
			'transactionId',
			'position',
			'accountId',
			'amount',
			'commodity',
			'priceAmount',
			'priceCommodity',
			'priceKind',
			'costAmount',
			'costCommodity',
			'costDate',
			'balance',
			'comment',
		])
		.where('transactionId', 'in', owners)
		.orderBy('position')
		.execute();
	const onTransactions = await db
		.selectFrom('metadata')
		.select(['transactionId', 'postingId', 'position', 'key', 'value'])
		.where('transactionId', 'in', owners)
		.orderBy('position')
		.execute();
	const onPostings = await db
		.selectFrom('metadata')
		.select(['transactionId', 'postingId', 'position', 'key', 'value'])
		.where('postingId', 'in', owned)
		.orderBy('position')
		.execute();

	return heldFrom(postings, [...onTransactions, ...onPostings]);
};

type PriceHeld = {
	symbolId: string;
	line: number | null;
	date: string;
	priceAmount: bigint;
	priceCommodity: string;
	source: string;
};

const oldPrices = (db: Database, fileId: string) =>
	db
		.selectFrom('prices')
		.select(['id', 'symbolId', 'line', 'date', 'priceAmount', 'priceCommodity', 'source'])
		.where('fileId', '=', fileId)
		.execute();

const priceKey = (p: PriceHeld) =>
	`${p.symbolId} ${p.line} ${p.date} ${p.priceAmount} ${p.priceCommodity} ${p.source}`;

/** Of a file's prices, those to delete and those to add; all of them when an older indexer read it. */
const priceChangesFrom = <P extends PriceHeld>(
	old: (PriceHeld & { id: string })[],
	prices: P[],
	current: boolean,
) => {
	if (!current) return { stale: old.map((o) => o.id), added: prices };

	const free = Object.groupBy(old, priceKey);
	const added = prices.filter((p) => !free[priceKey(p)]?.shift());

	return { stale: Object.values(free).flatMap((g) => (g ?? []).map((o) => o.id)), added };
};

type ChangesOptions<P, M> = {
	old: OldTransaction[];
	heldBefore: (id: string) => string;
	transactions: TransactionRow[];
	postings: P[];
	metadata: M[];
};

/** Of a file's rows, only those to write: a transaction's own when new or on another line, and what it holds when that differs. Moved are those whose order changed, which lots and assertions depend on. */
const changesFrom = <P extends PostingHeld, M extends MetadataHeld>({
	old,
	heldBefore,
	transactions,
	postings,
	metadata,
}: ChangesOptions<P, M>) => {
	const heldNow = heldFrom(postings, metadata);
	const before = Object.fromEntries(old.map((o) => [o.id, o]));

	const added = transactions.filter((t) => !before[t.id]).map((t) => t.id);
	const stale = transactions
		.filter((t) => before[t.id] && heldBefore(t.id) !== heldNow(t.id))
		.map((t) => t.id);
	const rewritten = new Set([...added, ...stale]);
	const written = postings.filter((p) => rewritten.has(p.transactionId));
	const posted = new Set(written.map((p) => p.id));
	const kept = transactions.filter((t) => before[t.id]);
	const keptIds = new Set(kept.map((t) => t.id));
	const keptBefore = old.filter((o) => keptIds.has(o.id));

	return {
		added,
		stale,
		moved: kept.filter((t, i) => keptBefore[i]?.id !== t.id).map((t) => t.id),
		transactions: transactions.filter((t) => {
			const o = before[t.id];
			return !o || o.line !== t.line || o.comment !== t.comment;
		}),
		postings: written,
		metadata: metadata.filter((m) => {
			if (m.postingId) return posted.has(m.postingId);
			if (m.transactionId) return rewritten.has(m.transactionId);
			return true;
		}),
	};
};

/** Deleting a posting takes its metadata, lots and disposals with it by cascade. */
const deleteOwnedBy = async (db: Database, transactions: string[]) => {
	await db
		.deleteFrom('metadata')
		.where((e) => anyOf(e.ref('transactionId').$notNull(), transactions, 'uuid'))
		.execute();
	await db
		.deleteFrom('postings')
		.where((e) => anyOf(e.ref('transactionId'), transactions, 'uuid'))
		.execute();
};

type TransactionRow = {
	id: string;
	ledgerId: string;
	fileId: string;
	line: number;
	date: string;
	time: string | null;
	description: string;
	comment: string | null;
	counted: boolean;
};

/** A kept transaction keeps whether it counts, which settling decides, and its embedding. */
const saveTransactions = async (db: Database, rows: TransactionRow[]) => {
	for (const chunk of chunks(rows, ROWS_PER_STATEMENT))
		await db // NOSONAR -- a transaction's statements share one connection, so they run in turn
			.insertInto('transactions')
			.values(chunk)
			.onConflict((o) =>
				o.column('id').doUpdateSet((e) => ({
					line: e.ref('excluded.line'),
					comment: e.ref('excluded.comment'),
				})),
			)
			.execute();
};

type RowsOptions = {
	ledgerId: string;
	fileId: string;
	file: RupeaLedgerFile;
	matchOf: (t: RupeaTransaction) => OldTransaction | undefined;
};

/** Each table's rows for a parsed file, its prices and links still to be put on their symbols. */
const rowsOf = ({ ledgerId, fileId, file, matchOf }: RowsOptions) => {
	const indexed = file.transactions.map((t) => {
		const match = matchOf(t);

		return {
			id: match?.id ?? uuidv7(),
			counted: match?.counted ?? true,
			transaction: t,
			postings: t.postings.map((p) => ({ id: uuidv7(), posting: p })),
		};
	});

	const transactions = indexed.map(({ id, counted, transaction }) => ({
		id,
		counted,
		ledgerId,
		fileId,
		line: transaction.location.line,
		date: transaction.date.toString(),
		time: transaction.time?.toString() ?? null,
		description: transaction.description,
		comment: transaction.comment,
	}));
	const postings = indexed.flatMap(({ id, counted, transaction, postings: p }) =>
		p.flatMap(({ id: postingId, posting }, position) => {
			const type = accountType(posting.account);
			return type
				? [
						{
							account: posting.account,
							row: {
								id: postingId,
								ledgerId,
								transactionId: id,
								counted,
								date: transaction.date.toString(),
								position,
								accountType: type,
								amount: posting.amount,
								commodity: posting.commodity,
								priceAmount: posting.price?.amount ?? null,
								priceCommodity: posting.price?.commodity ?? null,
								priceKind: posting.price?.kind ?? null,
								costAmount: posting.cost?.amount ?? null,
								costCommodity: posting.cost?.commodity ?? null,
								costDate: posting.cost?.date?.toString() ?? null,
								balance: posting.balance,
								comment: posting.comment,
							},
						},
					]
				: [];
		}),
	);
	const prices = marketPrices(file).map((p) => ({
		symbol: p.commodity,
		row: {
			fileId,
			line: p.location.line,
			date: p.date.toString(),
			priceAmount: p.price.amount,
			priceCommodity: p.price.commodity,
			source: p.source,
		},
	}));
	const links = file.links.map((l) => ({
		feed: l.feed,
		symbol: l.symbol,
		row: {
			ledgerId,
			alias: l.commodity,
			since: l.since?.toString() ?? null,
			fileId,
			line: l.location.line,
		},
	}));
	const metadata = [
		...ownedBy({ ledgerId, fileId }, file.metadata),
		...indexed.flatMap(({ id, transaction }) =>
			ownedBy({ ledgerId, transactionId: id }, transaction.metadata),
		),
		...indexed.flatMap(({ postings: p }) =>
			p.flatMap(({ id, posting }) => ownedBy({ ledgerId, postingId: id }, posting.metadata)),
		),
	];

	return { transactions, postings, prices, links, metadata };
};

/**
 * Deletes a file's transactions that no new row kept, by id, and rows without an embedding take their description's.
 * The select still sees the deleted rows, as Postgres runs a statement on one snapshot, so the update keeps to the others.
 */
const replaceOldTransactions = (db: Database, fileId: string, unmatched: string[]) =>
	db
		.with('deleted', (db) =>
			db
				.deleteFrom('transactions')
				.where((e) => anyOf(e.ref('transactions.id'), unmatched, 'uuid')),
		)
		.with('embedded', (db) =>
			db
				.selectFrom('transactions')
				.select(['description', 'embedding', 'embeddingModel'])
				.distinctOn('description')
				.where('fileId', '=', fileId)
				.where('embedding', 'is not', null),
		)
		.updateTable('transactions')
		.from('embedded')
		.set((e) => ({
			embedding: e.ref('embedded.embedding'),
			embeddingModel: e.ref('embedded.embeddingModel'),
		}))
		.where('transactions.fileId', '=', fileId)
		.where('transactions.embedding', 'is', null)
		.whereRef('transactions.description', '=', 'embedded.description')
		.where((e) => noneOf(e.ref('transactions.id'), unmatched, 'uuid'))
		.execute();

type MetadataOwner = { ledgerId: string } & (
	{ fileId: string } | { transactionId: string } | { postingId: string }
);

const ownedBy = (o: MetadataOwner, m: RupeaMetadata) =>
	Object.entries(m)
		.flatMap(([key, values]) => values.map((v) => ({ key, value: v })))
		.map((e, i) => ({ ...o, position: i, ...e }));

/**
 * Puts each row on its ledger's account of that name, whatever its case, made with every account
 * above it the first time it is named. New accounts go in sorted, as symbols do, and each finds its
 * parent by name once all are in.
 */
const withAccounts = async <R>(
	db: Database,
	ledgerId: string,
	rows: { account: string; row: R }[],
) => {
	const named = [...new Set(rows.flatMap((r) => parentsOf(r.account)))].toSorted(byCodeUnit);
	const names = named.filter((n, i) => named.findIndex((m) => same(m, n)) === i);
	const accounts = names.flatMap((n) => {
		const type = accountType(n);
		return type ? [{ ledgerId, name: n, type }] : [];
	});

	if (accounts.length > 0)
		await db
			.insertInto('accounts')
			.values(accounts)
			.onConflict((c) => c.doNothing())
			.execute();
	await db
		.updateTable('accounts as c')
		.from('accounts as p')
		.set((e) => ({ parentId: e.ref('p.id') }))
		.where('c.ledgerId', '=', ledgerId)
		.where('c.parentId', 'is', null)
		.whereRef('p.ledgerId', '=', 'c.ledgerId')
		.where(sql<SqlBool>`position(':' in c.name) > 0`)
		.where(sql<SqlBool>`lower(p.name) = lower(regexp_replace(c.name, ':[^:]*$', ''))`)
		.execute();
	const known = await db
		.selectFrom('accounts')
		.select(['accounts.id', sql<string>`lower(accounts.name)`.as('key')])
		.where('accounts.ledgerId', '=', ledgerId)
		.where((e) =>
			anyOf(
				sql`lower(${e.ref('accounts.name')})`,
				names.map((n) => n.toLowerCase()),
				'text',
			),
		)
		.execute();

	const ids = Object.fromEntries(known.map((k) => [k.key, k.id]));
	return rows.map((r) => ({ ...r.row, accountId: ids[r.account.toLowerCase()] ?? '' }));
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Owner = { feed: Feed; ledgerId: string | null };

/**
 * Puts each row on its owner's symbol of that name, made the first time it is named. New symbols
 * go in sorted, so two syncs making the same ones take their locks in one order, and one another
 * sync made meanwhile is updated in place so that it is still returned.
 */
const withSymbols = async <R>(db: Database, owner: Owner, rows: { symbol: string; row: R }[]) => {
	const bySymbol = Object.groupBy(rows, (r) => r.symbol);
	const names = Object.keys(bySymbol).toSorted(byCodeUnit);

	const known = names.length
		? await db
				.selectFrom('symbols')
				.select(['symbols.id', 'symbols.symbol'])
				.where('symbols.feed', '=', owner.feed)
				.where('symbols.ledgerId', owner.ledgerId ? '=' : 'is', owner.ledgerId)
				.where('symbols.symbol', 'in', names)
				.execute()
		: [];
	const seen = new Set(known.map((k) => k.symbol));
	const missing = names.filter((n) => !seen.has(n));
	const made = missing.length
		? await db
				.insertInto('symbols')
				.values(missing.map((n) => ({ ...owner, symbol: n })))
				.onConflict((oc) =>
					oc
						.columns(['feed', 'ledgerId', 'symbol'])
						.doUpdateSet((e) => ({ symbol: e.ref('excluded.symbol') })),
				)
				.returning(['symbols.id', 'symbols.symbol'])
				.execute()
		: [];

	return [...known, ...made].flatMap((s) =>
		(bySymbol[s.symbol] ?? []).map((r) => ({ ...r.row, symbolId: s.id })),
	);
};

/** Puts each link on its feed's symbol, which every ledger shares; one feed at a time, in order. */
const withFeedSymbols = async <R>(db: Database, rows: { feed: Feed; symbol: string; row: R }[]) => {
	const byFeed = Object.groupBy(rows, (r) => r.feed);
	const feeds = Object.values(Feed).filter((f) => byFeed[f]);
	const linked = [];
	for (const f of feeds)
		linked.push(...(await withSymbols(db, { feed: f, ledgerId: null }, byFeed[f] ?? [])));
	return linked;
};

/** What these transactions touch: the commodities whose lots they hold, the days they span, what they post to, and whether any names a group. */
export const touchedBy = async (db: Database, ids: string[]): Promise<Touched> => {
	const positions = await db
		.selectFrom('postings')
		.select(['accountId', 'commodity', 'accountType'])
		.distinct()
		.where((e) => anyOf(e.ref('transactionId'), ids, 'uuid'))
		.execute();
	const group = await db
		.selectFrom('metadata')
		.select('id')
		.where((e) => anyOf(e.ref('transactionId').$notNull(), ids, 'uuid'))
		.where('key', 'in', GROUP_KEYS)
		.limit(1)
		.executeTakeFirst();
	const days = await db
		.selectFrom('transactions')
		.select((e) => [
			e.fn.min<string | null>('date').as('from'),
			e.fn.max<string | null>('date').as('to'),
		])
		.where((e) => anyOf(e.ref('id'), ids, 'uuid'))
		.executeTakeFirstOrThrow();

	return {
		commodities: positions
			.filter((p) => BALANCE_TYPES.includes(p.accountType) && !CURRENCIES.includes(p.commodity))
			.map((p) => p.commodity),
		spans: toSpans(days),
		positions: positions.map((p) => ({ accountId: p.accountId, commodity: p.commodity })),
		grouped: group !== undefined,
	};
};

const lotCommoditiesOf = (db: Database, fileId: string): Promise<string[]> =>
	db
		.selectFrom('postings')
		.innerJoin('transactions', 'transactions.id', 'postings.transactionId')
		.select('postings.commodity')
		.distinct()
		.where('transactions.fileId', '=', fileId)
		.where('postings.accountType', 'in', BALANCE_TYPES)
		.where((e) => noneOf(e.ref('postings.commodity'), CURRENCIES, 'text'))
		.execute()
		.then((r) => r.map((c) => c.commodity));
