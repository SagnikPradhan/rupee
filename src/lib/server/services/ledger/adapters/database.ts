import { attemptWrite, violates } from '#lib/server/db/errors.ts';
import { statementChunks, type Database } from '#lib/server/db/index.ts';
import {
	disposals as disposalTable,
	ledgerFiles,
	ledgers,
	lots as lotTable,
	memberships,
	metadata as metadataTable,
	postings,
	prices as priceTable,
	storages,
	transactions as transactionTable,
} from '#lib/server/db/schema.ts';
import { withContext } from '#lib/server/shared/context/context.ts';
import { fault, type RupeeError } from '#lib/server/shared/result/error.ts';
import { attempt, err, errAsync, ok, ResultAsync } from '#lib/server/shared/result/result.ts';
import { inOrder } from '#lib/server/shared/control.ts';
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	notInArray,
	or,
	sql,
	type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { BALANCE_TYPES, EVENT_KEYS } from '../domain/events';
import type { Holding } from '../domain/holdings';
import { book, type BookedPosting, type Booking } from '../domain/lots';
import { displayLocation } from '../domain/parser';
import { marketPrices } from '../domain/prices';
import type { FileVersion } from '../domain/sync';
import {
	accountType,
	CURRENCIES,
	DisposalKind,
	PriceKind,
	PriceSource,
	toMetadata,
	type Amount,
	type Ledger,
	type LotCost,
	type Price,
	type Quantity,
	type RupeeLedgerFile,
	type RupeeMetadata,
	type RupeeParseLocation,
	type RupeeTransaction,
} from '../domain/types';

export type IndexedTransaction = RupeeTransaction & { id: string };

const files = (ledgerId: string) => (): ResultAsync<FileVersion[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.select({ key: ledgerFiles.key, version: ledgerFiles.version })
				.from(ledgerFiles)
				.where(eq(ledgerFiles.ledgerId, ledgerId)),
		),
	);

// One transaction, so readers see the old file or the new one. A description
// keeps its embedding through a reindex, so saving a file never re-embeds it.
const put =
	(ledgerId: string) =>
	(key: string, version: string | null, file: RupeeLedgerFile): ResultAsync<void> => {
		const untyped = untypedAccount(file);
		if (untyped) return errAsync(untyped);

		return withContext('db')((db) =>
			attempt(() =>
				db.transaction(async (tx) => {
					const fileId = await tx
						.insert(ledgerFiles)
						.values({ ledgerId, key, version })
						.onConflictDoUpdate({
							target: [ledgerFiles.ledgerId, ledgerFiles.key],
							set: { version },
						})
						.returning({ id: ledgerFiles.id })
						.then(([f]) => f?.id ?? Promise.reject(new Error(`${key} was not saved`)));
					const embedded = await embeddingsIn(tx, fileId);

					const indexed = file.transactions.map((t) => ({
						id: uuidv7(),
						transaction: t,
						postings: t.postings.map((p) => ({ id: uuidv7(), posting: p })),
					}));

					const transactionRows = indexed.map(({ id, transaction }) => ({
						id,
						ledgerId,
						fileId,
						line: transaction.location.line,
						date: transaction.date.toString(),
						time: transaction.time?.toString() ?? null,
						description: transaction.description,
						embedding: embedded[transaction.description]?.embedding ?? null,
						embeddingModel: embedded[transaction.description]?.embeddingModel ?? null,
					}));
					const postingRows = indexed.flatMap(({ id, postings: p }) =>
						p.flatMap(({ id: postingId, posting }, position) => {
							const type = accountType(posting.account);
							return type
								? [
										{
											id: postingId,
											ledgerId,
											transactionId: id,
											position,
											account: posting.account,
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
										},
									]
								: [];
						}),
					);
					const priceRows = marketPrices(file).map((p) => ({
						ledgerId,
						fileId,
						line: p.location.line,
						date: p.date.toString(),
						commodity: p.commodity,
						priceAmount: p.price.amount,
						priceCommodity: p.price.commodity,
						source: p.source,
					}));
					const metadataRows = [
						...ownedBy({ ledgerId, fileId }, file.metadata),
						...indexed.flatMap(({ id, transaction }) =>
							ownedBy({ ledgerId, transactionId: id }, transaction.metadata),
						),
						...indexed.flatMap(({ postings: p }) =>
							p.flatMap(({ id, posting }) =>
								ownedBy({ ledgerId, postingId: id }, posting.metadata),
							),
						),
					];

					await tx.delete(metadataTable).where(eq(metadataTable.fileId, fileId));
					await tx.delete(transactionTable).where(eq(transactionTable.fileId, fileId));
					await tx.delete(priceTable).where(eq(priceTable.fileId, fileId));
					// A transaction's statements share one connection, so they go one at a time.
					await inOrder([
						...statementChunks(transactionRows).map(
							(c) => () => tx.insert(transactionTable).values(c),
						),
						...statementChunks(postingRows).map((c) => () => tx.insert(postings).values(c)),
						...statementChunks(priceRows).map((c) => () => tx.insert(priceTable).values(c)),
						...statementChunks(metadataRows).map((c) => () => tx.insert(metadataTable).values(c)),
					]);
				}),
			),
		);
	};

// The parser already refuses these; checked again so no posting goes unindexed.
const untypedAccount = (file: RupeeLedgerFile): RupeeError | null =>
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

type Embedded = { embedding: number[] | null; embeddingModel: string | null };

const embeddingsIn = (db: Database, fileId: string): Promise<Record<string, Embedded>> =>
	db
		.selectDistinctOn([transactionTable.description], {
			description: transactionTable.description,
			embedding: transactionTable.embedding,
			embeddingModel: transactionTable.embeddingModel,
		})
		.from(transactionTable)
		.where(and(eq(transactionTable.fileId, fileId), isNotNull(transactionTable.embedding)))
		.then((l) => Object.fromEntries(l.map((r) => [r.description, r])));

type MetadataOwner = { ledgerId: string } & (
	{ fileId: string } | { transactionId: string } | { postingId: string }
);

const ownedBy = (o: MetadataOwner, m: RupeeMetadata) =>
	Object.entries(m)
		.flatMap(([key, values]) => values.map((v) => ({ key, value: v })))
		.map((e, i) => ({ ...o, position: i, ...e }));

const remove =
	(ledgerId: string) =>
	(key: string): ResultAsync<void> =>
		withContext('db')((db) =>
			attempt(() =>
				db
					.delete(ledgerFiles)
					.where(and(eq(ledgerFiles.ledgerId, ledgerId), eq(ledgerFiles.key, key)))
					.then(() => undefined),
			),
		);

const rename =
	(ledgerId: string) =>
	(from: string, to: string): ResultAsync<void> =>
		withContext('db')((db) =>
			attempt(() =>
				db
					.update(ledgerFiles)
					.set({ key: to })
					.where(and(eq(ledgerFiles.ledgerId, ledgerId), eq(ledgerFiles.key, from)))
					.then(() => undefined),
			),
		);

const compareTimes = (a: Temporal.PlainTime | null, b: Temporal.PlainTime | null) =>
	a && b ? Temporal.PlainTime.compare(a, b) : Number(a !== null) - Number(b !== null);

const transactions = (l: string) => (): ResultAsync<IndexedTransaction[]> => read(l, undefined);

// Only transactions in an event, through the metadata `(ledger_id, key, value)` index.
const eventMembers = (ledgerId: string) => (): ResultAsync<IndexedTransaction[]> =>
	withContext('db')((db) =>
		read(
			ledgerId,
			inArray(
				transactionTable.id,
				db
					.select({ id: metadataTable.transactionId })
					.from(metadataTable)
					.where(and(eq(metadataTable.ledgerId, ledgerId), inArray(metadataTable.key, EVENT_KEYS))),
			),
		),
	);

// `narrow` picks among the ledger's transactions. One snapshot, so the
// metadata read always belongs to the transactions read.
const read = (ledgerId: string, narrow: SQL | undefined): ResultAsync<IndexedTransaction[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db.transaction((t) => readIn(t, and(eq(transactionTable.ledgerId, ledgerId), narrow)), {
				isolationLevel: 'repeatable read',
				accessMode: 'read only',
			}),
		),
	);

const readIn = async (db: Database, where: SQL | undefined): Promise<IndexedTransaction[]> => {
	const rows = await db
		.select({
			key: ledgerFiles.key,
			id: transactionTable.id,
			line: transactionTable.line,
			date: transactionTable.date,
			time: transactionTable.time,
			description: transactionTable.description,
			postingId: postings.id,
			account: postings.account,
			amount: postings.amount,
			commodity: postings.commodity,
			priceAmount: postings.priceAmount,
			priceCommodity: postings.priceCommodity,
			priceKind: postings.priceKind,
			costAmount: postings.costAmount,
			costCommodity: postings.costCommodity,
			costDate: postings.costDate,
			balance: postings.balance,
		})
		.from(transactionTable)
		.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
		.leftJoin(postings, eq(postings.transactionId, transactionTable.id))
		.where(where)
		.orderBy(asc(transactionTable.id), asc(postings.position));

	const owned = byOwner([
		...(await db
			.select({
				owner: metadataTable.transactionId,
				key: metadataTable.key,
				value: metadataTable.value,
			})
			.from(metadataTable)
			.innerJoin(transactionTable, eq(transactionTable.id, metadataTable.transactionId))
			.where(where)
			.orderBy(asc(metadataTable.position))),
		...(await db
			.select({
				owner: metadataTable.postingId,
				key: metadataTable.key,
				value: metadataTable.value,
			})
			.from(metadataTable)
			.innerJoin(postings, eq(postings.id, metadataTable.postingId))
			.innerJoin(transactionTable, eq(transactionTable.id, postings.transactionId))
			.where(where)
			.orderBy(asc(metadataTable.position))),
	]);

	return [...Map.groupBy(rows, (r) => r.id).values()]
		.flatMap(([head, ...tail]) => (head ? [{ head, rows: [head, ...tail] }] : []))
		.map(({ head, rows: group }) => ({
			id: head.id,
			location: { file: head.key, line: head.line },
			date: Temporal.PlainDate.from(head.date),
			time: head.time === null ? null : Temporal.PlainTime.from(head.time),
			description: head.description,
			metadata: owned[head.id] ?? {},
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

type PriceColumns = {
	priceAmount: bigint | null;
	priceCommodity: string | null;
	priceKind: PriceKind | null;
};

const toPrice = ({ priceAmount, priceCommodity, priceKind }: PriceColumns): Price | null =>
	priceAmount === null || priceCommodity === null || priceKind === null
		? null
		: {
				amount: priceAmount as Amount,
				commodity: priceCommodity,
				kind: priceKind,
			};

type CostColumns = {
	costAmount: bigint | null;
	costCommodity: string | null;
	costDate: string | null;
};

const toCost = ({ costAmount, costCommodity, costDate }: CostColumns): LotCost | null =>
	costAmount === null || costCommodity === null
		? null
		: {
				amount: costAmount as Amount,
				commodity: costCommodity,
				date: costDate === null ? null : Temporal.PlainDate.from(costDate),
			};

const byIds =
	(ledgerId: string) =>
	(l: string[]): ResultAsync<IndexedTransaction[]> =>
		ResultAsync.combine(
			statementChunks(l).map((c) => read(ledgerId, inArray(transactionTable.id, c))),
		).map((r) => r.flat());

export type CandidatePair = { ours: string; theirs: string };

const ourFile = alias(ledgerFiles, 'our_file');
const ourTransaction = alias(transactionTable, 'our_transaction');
const ourPosting = alias(postings, 'our_posting');

const theirTransaction = alias(transactionTable, 'their_transaction');
const theirPosting = alias(postings, 'their_posting');

// Same date, amount and balance account, in another file; the other side goes
// through the `(ledger_id, account, commodity, amount)` index.
const candidates =
	(ledgerId: string) =>
	(key: string): ResultAsync<CandidatePair[]> =>
		withContext('db')((db) =>
			attempt(() =>
				db
					.selectDistinct({ ours: ourTransaction.id, theirs: theirTransaction.id })
					.from(ourFile)
					.innerJoin(ourTransaction, eq(ourTransaction.fileId, ourFile.id))
					.innerJoin(ourPosting, eq(ourPosting.transactionId, ourTransaction.id))
					.innerJoin(
						theirPosting,
						and(
							eq(theirPosting.ledgerId, ledgerId),
							eq(theirPosting.account, ourPosting.account),
							eq(theirPosting.commodity, ourPosting.commodity),
							eq(theirPosting.amount, ourPosting.amount),
						),
					)
					.innerJoin(
						theirTransaction,
						and(
							eq(theirTransaction.id, theirPosting.transactionId),
							eq(theirTransaction.date, ourTransaction.date),
							ne(theirTransaction.fileId, ourFile.id),
						),
					)
					.where(
						and(
							eq(ourFile.ledgerId, ledgerId),
							eq(ourFile.key, key),
							inArray(ourPosting.accountType, BALANCE_TYPES),
						),
					),
			),
		);

// The event ids the file's transactions name, through the metadata index.
const eventsOfFile = (db: Database, ledgerId: string, key: string) =>
	db
		.select({ value: metadataTable.value })
		.from(metadataTable)
		.innerJoin(transactionTable, eq(transactionTable.id, metadataTable.transactionId))
		.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
		.where(
			and(
				eq(metadataTable.ledgerId, ledgerId),
				eq(ledgerFiles.key, key),
				inArray(metadataTable.key, EVENT_KEYS),
			),
		);

// Every member of every event a transaction in the file belongs to.
const eventsIn =
	(ledgerId: string) =>
	(key: string): ResultAsync<IndexedTransaction[]> =>
		withContext('db')((db) =>
			read(
				ledgerId,
				inArray(
					transactionTable.id,
					db
						.select({ id: metadataTable.transactionId })
						.from(metadataTable)
						.where(
							and(
								eq(metadataTable.ledgerId, ledgerId),
								inArray(metadataTable.key, EVENT_KEYS),
								inArray(metadataTable.value, eventsOfFile(db, ledgerId, key)),
							),
						),
				),
			),
		);

const membersOf =
	(ledgerId: string) =>
	(event: string): ResultAsync<IndexedTransaction[]> =>
		withContext('db')((db) =>
			read(
				ledgerId,
				inArray(
					transactionTable.id,
					db
						.select({ id: metadataTable.transactionId })
						.from(metadataTable)
						.where(
							and(
								eq(metadataTable.ledgerId, ledgerId),
								inArray(metadataTable.key, EVENT_KEYS),
								eq(metadataTable.value, event),
							),
						),
				),
			),
		);

const eventIdTaken =
	(ledgerId: string) =>
	(id: string): ResultAsync<boolean> =>
		withContext('db')((db) =>
			attempt(() =>
				db
					.select({ id: metadataTable.id })
					.from(metadataTable)
					.where(
						and(
							eq(metadataTable.ledgerId, ledgerId),
							inArray(metadataTable.key, EVENT_KEYS),
							eq(metadataTable.value, id),
						),
					)
					.limit(1),
			).map((r) => r.length > 0),
		);

// `unordered` holds postings that could fall either side of the assertion.
export type BalanceCheck = {
	location: RupeeParseLocation;
	account: string;
	commodity: string;
	expected: Amount;
	actual: Amount;
	unordered: string[];
};

type BalanceRow = {
	file: string;
	line: number;
	account: string;
	commodity: string;
	expected: string;
	actual: string;
	unordered: string[];
};

// An assertion is a point in time on its account: every counted posting before
// it, in any file. A file is a sequence, so its own postings that day are
// ordered by line; another file's are ordered only when both sides have a time.
const balanceChecks =
	(ledgerId: string) =>
	(evidence: string[]): ResultAsync<BalanceCheck[]> =>
		withContext('db')((db) =>
			attempt(() =>
				db.execute<BalanceRow>(sql`
					with asserted as (
						select distinct p.account, p.commodity
						from ${postings} p
						where p.ledger_id = ${ledgerId} and p.balance is not null
					),
					entries as (
						select f.key as file, t.line, t.date, t.time, p.position, p.account, p.commodity, p.amount, p.balance,
							t.id <> all(${sql.param(evidence)}::uuid[]) as counted
						from ${postings} p
						join ${transactionTable} t on t.id = p.transaction_id
						join ${ledgerFiles} f on f.id = t.file_id
						where p.ledger_id = ${ledgerId} and (p.account, p.commodity) in (select account, commodity from asserted)
					),
					days as (
						select account, commodity, date, sum(case when counted then amount else 0 end) as total
						from entries
						group by account, commodity, date
					),
					openings as (
						select account, commodity, date, sum(total) over (partition by account, commodity order by date) - total as opening
						from days
					),
					checks as (
						select a.file, a.line, a.account, a.commodity, a.balance,
							o.opening + coalesce(sum(e.amount) filter (where
								(e.file = a.file and (e.line < a.line or (e.line = a.line and e.position <= a.position)))
								or (e.file != a.file and e.time < a.time)
							), 0) as actual,
							coalesce(array_agg(distinct e.file || ':' || e.line) filter (where
								e.file != a.file and (e.time is null or a.time is null or e.time = a.time)
							), '{}') as unordered
						from entries a
						join openings o on o.account = a.account and o.commodity = a.commodity and o.date = a.date
						left join entries e on e.account = a.account and e.commodity = a.commodity and e.date = a.date and e.counted
						where a.balance is not null
						group by a.file, a.line, a.position, a.account, a.commodity, a.balance, o.opening
					)
					select file, line, account, commodity, balance::text as expected, actual::text as actual, unordered
					from checks
					where balance != actual or cardinality(unordered) > 0
					order by file, line
				`),
			).map((r) =>
				r.rows.map((c) => ({
					location: { file: c.file, line: c.line },
					account: c.account,
					commodity: c.commodity,
					expected: BigInt(c.expected) as Amount,
					actual: BigInt(c.actual) as Amount,
					unordered: c.unordered,
				})),
			),
		);

// Currencies are money, so they have no lots.
const lotCommodities =
	(ledgerId: string) =>
	(keys: string[]): ResultAsync<string[]> =>
		withContext('db')((db) =>
			attempt(() =>
				db
					.selectDistinct({ commodity: postings.commodity })
					.from(postings)
					.innerJoin(transactionTable, eq(transactionTable.id, postings.transactionId))
					.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
					.where(
						and(
							eq(postings.ledgerId, ledgerId),
							inArray(ledgerFiles.key, keys),
							inArray(postings.accountType, BALANCE_TYPES),
							notInArray(postings.commodity, CURRENCIES),
						),
					)
					.then((r) => r.map((c) => c.commodity)),
			),
		);

// A commodity's lots are booked again from every counted posting in it, and
// replace what was there in one transaction.
const rebook =
	(ledgerId: string) =>
	(commodity: string, evidence: string[]): ResultAsync<void> =>
		withContext('db')((db) =>
			attempt(() =>
				db.transaction(async (tx) => {
					const booking = book(await bookedPostings(tx, { ledgerId, commodity, evidence }));
					await replaceLots(tx, { ledgerId, commodity }, booking);
				}),
			),
		);

type BookedQuery = { ledgerId: string; commodity: string; evidence: string[] };

const bookedPostings = (db: Database, q: BookedQuery): Promise<BookedPosting[]> =>
	db
		.select({
			id: postings.id,
			transactionId: postings.transactionId,
			account: postings.account,
			accountType: postings.accountType,
			date: transactionTable.date,
			amount: postings.amount,
			priceAmount: postings.priceAmount,
			priceCommodity: postings.priceCommodity,
			priceKind: postings.priceKind,
			costAmount: postings.costAmount,
			costCommodity: postings.costCommodity,
			costDate: postings.costDate,
		})
		.from(postings)
		.innerJoin(transactionTable, eq(transactionTable.id, postings.transactionId))
		.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
		.where(
			and(
				eq(postings.ledgerId, q.ledgerId),
				eq(postings.commodity, q.commodity),
				notInArray(transactionTable.id, q.evidence),
			),
		)
		.orderBy(
			asc(transactionTable.date),
			sql`${transactionTable.time} asc nulls first`,
			asc(ledgerFiles.key),
			asc(transactionTable.line),
			asc(postings.position),
		)
		.then((rows) =>
			rows.map((r) => ({
				id: r.id,
				transaction: r.transactionId,
				account: r.account,
				held: BALANCE_TYPES.some((t) => t === r.accountType),
				date: Temporal.PlainDate.from(r.date),
				amount: r.amount as Amount,
				price: toPrice(r),
				cost: toCost(r),
			})),
		);

type LotOwner = { ledgerId: string; commodity: string };

const replaceLots = async (db: Database, o: LotOwner, booking: Booking) => {
	const stored = booking.lots.map((l) => ({ lot: l, id: uuidv7() }));
	const idOf = (k: number | null) => (k === null ? null : (stored[k]?.id ?? null));

	const lotRows = stored.map(({ lot, id }) => ({
		...o,
		id,
		postingId: lot.posting,
		sourceId: idOf(lot.source),
		account: lot.account,
		origin: lot.origin,
		date: lot.date.toString(),
		units: lot.units,
		remaining: lot.remaining,
		costAmount: lot.cost.amount,
		costCommodity: lot.cost.commodity,
	}));
	const disposalRows = booking.disposals.map((d) => ({
		...o,
		lotId: idOf(d.lot),
		postingId: d.posting,
		kind: d.kind,
		units: d.units,
		priceAmount: d.price?.amount ?? null,
		priceCommodity: d.price?.commodity ?? null,
	}));

	await db
		.delete(disposalTable)
		.where(and(eq(disposalTable.ledgerId, o.ledgerId), eq(disposalTable.commodity, o.commodity)));
	await db
		.delete(lotTable)
		.where(and(eq(lotTable.ledgerId, o.ledgerId), eq(lotTable.commodity, o.commodity)));
	await inOrder([
		...statementChunks(lotRows).map((c) => () => db.insert(lotTable).values(c)),
		...statementChunks(disposalRows).map((c) => () => db.insert(disposalTable).values(c)),
	]);
};

export type UnmatchedDisposal = {
	location: RupeeParseLocation;
	account: string;
	commodity: string;
	kind: DisposalKind;
	units: Amount;
	named: boolean;
};

const unmatched = (ledgerId: string) => (): ResultAsync<UnmatchedDisposal[]> =>
	withContext('db')((db) =>
		attempt(() =>
			db
				.select({
					file: ledgerFiles.key,
					line: transactionTable.line,
					account: postings.account,
					commodity: disposalTable.commodity,
					kind: disposalTable.kind,
					units: disposalTable.units,
					costAmount: postings.costAmount,
				})
				.from(disposalTable)
				.innerJoin(postings, eq(postings.id, disposalTable.postingId))
				.innerJoin(transactionTable, eq(transactionTable.id, postings.transactionId))
				.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
				.where(and(eq(disposalTable.ledgerId, ledgerId), isNull(disposalTable.lotId)))
				.orderBy(asc(ledgerFiles.key), asc(transactionTable.line)),
		).map((rows) =>
			rows.map((r) => ({
				location: { file: r.file, line: r.line },
				account: r.account,
				commodity: r.commodity,
				kind: r.kind,
				units: r.units as Amount,
				named: r.costAmount !== null,
			})),
		),
	);

// What every balance account holds now, counting no evidence. A holding's
// cost is only known when all its open lots cost the same commodity.
const holdings =
	(ledgerId: string) =>
	(evidence: string[]): ResultAsync<Holding[]> =>
		withContext('db')((db) => {
			const held = db
				.select({
					account: postings.account,
					commodity: postings.commodity,
					units: sql<string>`sum(${postings.amount})::text`.as('units'),
				})
				.from(postings)
				.where(
					and(
						eq(postings.ledgerId, ledgerId),
						inArray(postings.accountType, BALANCE_TYPES),
						notInArray(postings.transactionId, evidence),
					),
				)
				.groupBy(postings.account, postings.commodity)
				.having(sql`sum(${postings.amount}) <> 0`)
				.as('held');
			const costs = db
				.select({
					account: lotTable.account,
					commodity: lotTable.commodity,
					amount:
						sql<string>`round(sum(${lotTable.remaining}::numeric * ${lotTable.costAmount} / 1000000))::text`.as(
							'amount',
						),
					currency: sql<
						string | null
					>`case when count(distinct ${lotTable.costCommodity}) = 1 then min(${lotTable.costCommodity}) end`.as(
						'currency',
					),
				})
				.from(lotTable)
				.where(and(eq(lotTable.ledgerId, ledgerId), ne(lotTable.remaining, 0n)))
				.groupBy(lotTable.account, lotTable.commodity)
				.as('costs');

			return attempt(() =>
				db
					.select({
						account: held.account,
						commodity: held.commodity,
						units: held.units,
						cost: costs.amount,
						currency: costs.currency,
					})
					.from(held)
					.leftJoin(
						costs,
						and(eq(costs.account, held.account), eq(costs.commodity, held.commodity)),
					)
					.orderBy(asc(held.account), asc(held.commodity)),
			).map((rows) =>
				rows.map((r) => ({
					account: r.account,
					commodity: r.commodity,
					units: BigInt(r.units) as Amount,
					cost:
						r.cost === null || r.currency === null
							? null
							: { amount: BigInt(r.cost) as Amount, commodity: r.currency },
				})),
			);
		});

type LatestPriceRow = { commodity: string; amount: string; currency: string };

// The latest price of each commodity on or before a day; that day, a `P` line beats an `@`.
const latestPrices =
	(ledgerId: string) =>
	(commodities: string[], day: Temporal.PlainDate): ResultAsync<Record<string, Quantity>> =>
		withContext('db')((db) =>
			attempt(() =>
				db.execute<LatestPriceRow>(sql`
					select c.commodity, p.price_amount::text as amount, p.price_commodity as currency
					from unnest(${sql.param(commodities)}::text[]) as c(commodity)
					cross join lateral (
						select price_amount, price_commodity
						from ${priceTable}
						where ledger_id = ${ledgerId} and commodity = c.commodity and date <= ${day.toString()}
						order by date desc, source = ${PriceSource.Line} desc, line desc
						limit 1
					) p
				`),
			).map((r) =>
				Object.fromEntries(
					r.rows.map((p) => [
						p.commodity,
						{ amount: BigInt(p.amount) as Amount, commodity: p.currency },
					]),
				),
			),
		);

const sourceLot = alias(lotTable, 'source_lot');

// Every lot an account has held of a commodity, open or not, with what was taken from it.
const lotsIn = (ledgerId: string) => (account: string, commodity: string) =>
	withContext('db')((db) =>
		attempt(async () => {
			const lots = await db
				.select({
					id: lotTable.id,
					file: ledgerFiles.key,
					line: transactionTable.line,
					date: lotTable.date,
					origin: lotTable.origin,
					from: sourceLot.account,
					units: lotTable.units,
					remaining: lotTable.remaining,
					costAmount: lotTable.costAmount,
					costCommodity: lotTable.costCommodity,
				})
				.from(lotTable)
				.innerJoin(postings, eq(postings.id, lotTable.postingId))
				.innerJoin(transactionTable, eq(transactionTable.id, postings.transactionId))
				.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
				.leftJoin(sourceLot, eq(sourceLot.id, lotTable.sourceId))
				.where(
					and(
						eq(lotTable.ledgerId, ledgerId),
						eq(lotTable.account, account),
						eq(lotTable.commodity, commodity),
					),
				)
				.orderBy(asc(lotTable.date), asc(ledgerFiles.key), asc(transactionTable.line));
			const taken = await db
				.select({
					lot: disposalTable.lotId,
					file: ledgerFiles.key,
					line: transactionTable.line,
					date: transactionTable.date,
					kind: disposalTable.kind,
					units: disposalTable.units,
					priceAmount: disposalTable.priceAmount,
					priceCommodity: disposalTable.priceCommodity,
				})
				.from(disposalTable)
				.innerJoin(postings, eq(postings.id, disposalTable.postingId))
				.innerJoin(transactionTable, eq(transactionTable.id, postings.transactionId))
				.innerJoin(ledgerFiles, eq(ledgerFiles.id, transactionTable.fileId))
				.where(
					inArray(
						disposalTable.lotId,
						lots.map((l) => l.id),
					),
				)
				.orderBy(asc(transactionTable.date), asc(ledgerFiles.key), asc(transactionTable.line));

			return lots.map((l) => ({
				location: { file: l.file, line: l.line },
				date: Temporal.PlainDate.from(l.date),
				origin: l.origin,
				from: l.from,
				units: l.units as Amount,
				remaining: l.remaining as Amount,
				cost: { amount: l.costAmount as Amount, commodity: l.costCommodity },
				disposals: taken
					.filter((d) => d.lot === l.id)
					.map((d) => ({
						location: { file: d.file, line: d.line },
						date: Temporal.PlainDate.from(d.date),
						kind: d.kind,
						units: d.units as Amount,
						price: toQuantity(d.priceAmount, d.priceCommodity),
					})),
			}));
		}),
	);

const toQuantity = (a: bigint | null, c: string | null): Quantity | null =>
	a === null || c === null ? null : { amount: a as Amount, commodity: c };

type MetadataRow = { owner: string | null; key: string; value: string };

// Rows come in written order, which `toMetadata` keeps.
const byOwner = (rows: MetadataRow[]): Record<string, RupeeMetadata> =>
	Object.fromEntries(
		Object.entries(Object.groupBy(rows, (r) => r.owner ?? '')).map(([owner, group = []]) => [
			owner,
			toMetadata(group.map((r) => [r.key, r.value])),
		]),
	);

export const index = (ledgerId: string) => ({
	files: files(ledgerId),
	put: put(ledgerId),
	remove: remove(ledgerId),
	rename: rename(ledgerId),
	eventMembers: eventMembers(ledgerId),
	byIds: byIds(ledgerId),
	candidates: candidates(ledgerId),
	eventIdTaken: eventIdTaken(ledgerId),
	eventsIn: eventsIn(ledgerId),
	membersOf: membersOf(ledgerId),
	balanceChecks: balanceChecks(ledgerId),
	lotCommodities: lotCommodities(ledgerId),
	rebook: rebook(ledgerId),
	holdings: holdings(ledgerId),
	latestPrices: latestPrices(ledgerId),
	lotsIn: lotsIn(ledgerId),
	unmatched: unmatched(ledgerId),
	transactions: transactions(ledgerId),
});

const ledgerColumns = {
	id: ledgers.id,
	handle: ledgers.handle,
	name: ledgers.name,
	owner: storages.userId,
};

// A user reaches the ledgers in their storage and those they are a member of.
const reachable = (db: Database, userId: string, where: SQL | undefined) =>
	db
		.select(ledgerColumns)
		.from(ledgers)
		.innerJoin(storages, eq(storages.id, ledgers.storageId))
		.leftJoin(
			memberships,
			and(eq(memberships.ledgerId, ledgers.id), eq(memberships.userId, userId)),
		)
		.where(and(where, or(eq(storages.userId, userId), isNotNull(memberships.id))))
		.orderBy(asc(ledgers.createdAt));

export const findLedger = (userId: string, handle: string): ResultAsync<Ledger> =>
	withContext('db')((db) =>
		attempt(() => reachable(db, userId, eq(ledgers.handle, handle)).limit(1)).andThen(([f]) =>
			f ? ok(f) : err(fault('LedgerNotFound', { handle })),
		),
	);

export const findLedgers = (u: string): ResultAsync<Ledger[]> =>
	withContext('db')((db) => attempt(() => reachable(db, u, undefined)));

type InsertLedgerOptions = {
	storage: string;
	owner: string;
	handle: string;
	name: string;
};

export const insertLedger = (options: InsertLedgerOptions): ResultAsync<Ledger> => {
	const { storage, owner, handle, name } = options;
	return withContext('db')((db) =>
		attemptWrite(() =>
			db
				.insert(ledgers)
				.values({ storageId: storage, handle, name })
				.returning({ id: ledgers.id })
				.then(([i]) => i ?? Promise.reject(new Error(`${handle} was not saved`)))
				.then((i) => ({ id: i.id, handle, name, owner })),
		).mapErr((e) =>
			violates(e, 'ledgers_handle_unique') ? fault('NameTaken', { name: handle }) : e,
		),
	);
};
