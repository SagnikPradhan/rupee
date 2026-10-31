import type { Database } from '#lib/server/db/index.ts';
import { provide } from '#lib/server/shared/context/context.ts';
import { EMBEDDING_DIMENSIONS } from '#lib/server/shared/onnx/models.ts';
import { fault } from '#lib/server/shared/result/error.ts';
import { errAsync, ok, ResultAsync } from '#lib/server/shared/result/result.ts';
import { byUser } from '#lib/server/shared/storage/storage.ts';
import { listJobs, runJob } from '#services/jobs/application/jobs.ts';
import { syncLedger } from '#services/ledger/adapters/jobs.ts';
import { MODEL } from '#services/ledger/adapters/prediction-model2vec.ts';
import * as Files from '#services/ledger/application/files.ts';
import type { Ledger } from '#services/ledger/application/ledger.ts';
import * as Sync from '#services/ledger/application/sync.ts';
import * as Transactions from '#services/ledger/application/transactions.ts';
import { INDEXER } from '#services/ledger/domain/sync.ts';
import { Feed, PriceSource } from '#services/ledger/domain/types.ts';
import { broken, hashed } from '#tests/shared/embedding.ts';
import { createLedger } from '#tests/shared/seed.ts';
import { it } from '#tests/shared/vitest.ts';
import { count } from '#tests/shared/count.ts';
import { drift, months } from './fixtures/deltas';
import { sql } from 'kysely';
import { describe, expect } from 'vitest';
import {
	everything,
	groceries,
	issues,
	listAllTransactions,
	listed,
	put,
	salary,
	stored,
	summary,
} from './fixtures/files';

const vector = `[${Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;

const annotated = [
	'- statement: hdfc-oct.pdf',
	'',
	'2026-08-29 Groceries',
	'\t- ref: a',
	'\t- note: weekly shop',
	'\t- ref: b',
	'\tExpenses:Food 100.5',
	'\t\t- tags: weekly',
	'\tAssets:Bank',
	'',
].join('\n');

const problemIds = async (db: Database, ledgerId: string) =>
	(await db.selectFrom('problems').select('id').where('ledgerId', '=', ledgerId).execute()).map(
		(p) => p.id,
	);

const fileMetadata = async (db: Database, ledgerId: string) =>
	(
		await db
			.selectFrom('metadata')
			.innerJoin('ledgerFiles', 'ledgerFiles.id', 'metadata.fileId')
			.select(['metadata.key', 'metadata.value'])
			.where('ledgerFiles.ledgerId', '=', ledgerId)
			.orderBy('metadata.position')
			.execute()
	).map((r) => [r.key, r.value]);

describe('syncing the ledger', () => {
	it('indexes new files, ordered by date', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);
			await put(storage, ledger, 'b/c.rupea', salary);
			await put(storage, ledger, 'notes.txt', 'not a ledger file');

			expect(await issues(ledger)).toEqual(ok([]));
			expect(await summary(ledger.id)).toEqual(['b/c.rupea:1 Salary', 'a.rupea:1 Groceries']);
		}));

	it('indexes metadata of the file, its transactions and their postings', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', annotated);
			await Sync.syncIndex(ledger);

			const [indexed] = (await listAllTransactions(ledger.id))._unsafeUnwrap();
			expect(indexed?.metadata).toEqual({ ref: ['a', 'b'], note: ['weekly shop'] });
			expect(indexed?.postings.map((p) => p.metadata)).toEqual([{ tags: ['weekly'] }, {}]);
			expect(await fileMetadata(db, ledger.id)).toEqual([['statement', 'hdfc-oct.pdf']]);
		}));

	it('leaves no metadata behind when a file changes or goes', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			// Other tests share the database, so count only what this one adds.
			const all = () => count(db.selectFrom('metadata'));
			const before = await all();
			await put(storage, ledger, 'a.rupea', annotated);
			await Sync.syncIndex(ledger);
			expect(await all()).toBe(before + 5);

			await put(storage, ledger, 'a.rupea', `- statement: other.pdf\n\n${groceries}`);
			await Sync.syncIndex(ledger);
			expect(await all()).toBe(before + 1);

			await stored(storage, ledger).delete('a.rupea');
			await Sync.syncIndex(ledger);
			expect(await all()).toBe(before);
		}));

	it('indexes market prices, replacing them when the file changes', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const bought = '2026-10-01 Buy INFY\n\tAssets:Zerodha 10 INFY @ 1500\n\tAssets:Bank\n';
			const indexed = () =>
				db
					.selectFrom('prices')
					.innerJoin('symbols', 'symbols.id', 'prices.symbolId')
					.select(['symbols.symbol as commodity', 'prices.priceAmount as amount', 'prices.source'])
					.where('symbols.ledgerId', '=', ledger.id)
					.orderBy('prices.line')
					.execute();

			await put(storage, ledger, 'a.rupea', `${bought}\nP 2026-10-17 INFY 1820\n`);
			await Sync.syncIndex(ledger);
			expect(await indexed()).toEqual([
				{ commodity: 'INFY', amount: 1500_0000000000n, source: PriceSource.Posting },
				{ commodity: 'INFY', amount: 1820_0000000000n, source: PriceSource.Line },
			]);

			await put(storage, ledger, 'a.rupea', 'P 2026-10-18 INFY 1830\nP 2026-10-18 TCS 4100\n');
			await Sync.syncIndex(ledger);
			expect(await indexed()).toEqual([
				{ commodity: 'INFY', amount: 1830_0000000000n, source: PriceSource.Line },
				{ commodity: 'TCS', amount: 4100_0000000000n, source: PriceSource.Line },
			]);
		}));

	it('prices a commodity on one symbol across files, kept through a reindex', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const own = () =>
				db
					.selectFrom('symbols')
					.select(['id', 'symbol'])
					.where('ledgerId', '=', ledger.id)
					.orderBy('symbol')
					.execute();

			await put(storage, ledger, 'a.rupea', 'P 2026-10-17 INFY 1820\n');
			await put(storage, ledger, 'b.rupea', 'P 2026-10-18 INFY 1830\nP 2026-10-18 TCS 4100\n');
			await Sync.syncIndex(ledger);
			const made = await own();

			await put(storage, ledger, 'a.rupea', 'P 2026-10-19 INFY 1840\n');
			await Sync.syncIndex(ledger);
			expect(made.map((s) => s.symbol)).toEqual(['INFY', 'TCS']);
			expect(await own()).toEqual(made);
		}));

	it('indexes links onto symbols every ledger shares, replacing them when the file changes', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const one = await createLedger(db);
			const two = await createLedger(db);
			const linked = (l: { id: string }) =>
				db
					.selectFrom('symbolLinks as l')
					.innerJoin('symbols as s', 's.id', 'l.symbolId')
					.select(['l.alias', 'l.since', 's.feed', 's.symbol', 's.ledgerId as owner', 'l.line'])
					.where('l.ledgerId', '=', l.id)
					.orderBy('l.line')
					.execute();
			const links = 'P * HNFI mfapi:300001\nP 2026-01-01 HNFI yahoo:SHARED.NS\n';

			await put(storage, one, 'a.rupea', links);
			await put(storage, two, 'a.rupea', links);
			await Sync.syncIndex(one);
			await Sync.syncIndex(two);
			const first = await linked(one);
			const second = await linked(two);
			const shared = await count(db.selectFrom('symbols').where('symbol', '=', 'SHARED.NS'));

			await put(storage, one, 'a.rupea', 'P * NIFTY yahoo:SHARED.NS\n');
			await Sync.syncIndex(one);

			expect(first).toEqual([
				{ alias: 'HNFI', since: null, feed: Feed.Mfapi, symbol: '300001', owner: null, line: 1 },
				{
					alias: 'HNFI',
					since: '2026-01-01',
					feed: Feed.Yahoo,
					symbol: 'SHARED.NS',
					owner: null,
					line: 2,
				},
			]);
			expect(second).toEqual(first);
			expect(shared).toBe(1);
			expect(await linked(one)).toEqual([
				{
					alias: 'NIFTY',
					since: null,
					feed: Feed.Yahoo,
					symbol: 'SHARED.NS',
					owner: null,
					line: 1,
				},
			]);
		}));

	it('warns of a commodity linked twice from one day, across files', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(
				storage,
				ledger,
				'a.rupea',
				'P * HNFI mfapi:300002\nP 2026-01-01 HNFI yahoo:A.NS\n',
			);
			await put(storage, ledger, 'b.rupea', 'P * HNFI yahoo:B.NS\n');

			expect(await issues(ledger)).toEqual(
				ok([fault('LinkRepeated', { location: 'a.rupea:1, b.rupea:1', commodity: 'HNFI' })]),
			);
		}));

	it('indexes a lot cost and reads it back', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const sale = [
				'2026-10-01 Sell INFY',
				'\tAssets:Zerodha -4 INFY {1500, 2024-06-03} @ 1700',
				'\tAssets:Bank 6800',
				'\tIncome:Gains',
				'',
			].join('\n');
			await put(storage, ledger, 'a.rupea', sale);
			await Sync.syncIndex(ledger);

			const [indexed] = (await listAllTransactions(ledger.id))._unsafeUnwrap();
			expect(indexed?.postings.map((p) => p.cost)).toEqual([
				{
					amount: 1500_0000000000n,
					commodity: 'INR',
					date: Temporal.PlainDate.from('2024-06-03'),
				},
				null,
				null,
			]);
		}));

	it('re-indexes changed files and drops deleted ones', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);
			await put(storage, ledger, 'b.rupea', salary);
			await Sync.syncIndex(ledger);

			await put(storage, ledger, 'a.rupea', `${salary}${groceries}`);
			await stored(storage, ledger).delete('b.rupea');
			await Sync.syncIndex(ledger);

			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Salary', 'a.rupea:4 Groceries']);
		}));

	it('re-indexes an unchanged file an older indexer indexed', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);
			await Sync.syncIndex(ledger);

			await db.deleteFrom('transactions').where('ledgerId', '=', ledger.id).execute();
			await Sync.syncIndex(ledger);
			expect(await summary(ledger.id)).toEqual([]);

			await db
				.updateTable('ledgerFiles')
				.set({ indexer: INDEXER - 1 })
				.where('ledgerId', '=', ledger.id)
				.execute();
			await Sync.syncIndex(ledger);
			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Groceries']);
		}));

	it('queues another sync until a large ledger is embedded', ({ context, db }) =>
		provide({ ...context, models: hashed(context.models) }, async () => {
			const ledger = await createLedger(db);
			const shops = Array.from(
				{ length: 501 },
				(_, i) => `2026-01-01 Shop ${i}\n\tExpenses:Food 1\n\tAssets:Bank\n`,
			);
			const queued = async () =>
				(
					await listJobs({ userId: ledger.owner, name: syncLedger.name, payload: {}, limit: 10 })
				)._unsafeUnwrap();
			await Files.createFile({ ledger, key: 'a.rupea', content: shops.join('\n') });

			await Sync.syncIndex(ledger);
			expect(await queued()).toHaveLength(1);

			await db.deleteFrom('jobs').where('userId', '=', ledger.owner).execute();
			await Sync.syncIndex(ledger);
			expect(await queued()).toEqual([]);
		}));

	it('keeps transaction ids through an edit, and a new one for what is new', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const twice = '2026-08-29 Tea\n\tExpenses:Food 1\n\tAssets:Bank\n';
			const ids = async () =>
				db
					.selectFrom('transactions')
					.select(['id', 'line', 'description'])
					.where('ledgerId', '=', ledger.id)
					.orderBy('line')
					.execute();

			await put(storage, ledger, 'a.rupea', `${twice}\n${twice}\n${groceries}`);
			await Sync.syncIndex(ledger);
			const [first, second, third] = await ids();

			const edited = groceries.replace('Expenses:Food', '; bought\n\tExpenses:Food');
			await put(storage, ledger, 'a.rupea', `${salary}\n${twice}\n${twice}\n${edited}`);
			await Sync.syncIndex(ledger);
			const after = await ids();

			expect(after.map((t) => t.description)).toEqual(['Salary', 'Tea', 'Tea', 'Groceries']);
			expect(after.slice(1).map((t) => t.id)).toEqual([first?.id, second?.id, third?.id]);
			expect(await count(db.selectFrom('postings').where('ledgerId', '=', ledger.id))).toBe(8);
		}));

	it('rewrites only the postings of a transaction that changed', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const rent = '2026-01-01 Rent\n\tExpenses:Home 10\n\tAssets:Bank\n';
			const food = (n: number) => `2026-01-02 Food\n\tExpenses:Food ${n}\n\tAssets:Bank\n`;
			const posted = () =>
				db
					.selectFrom('postings as p')
					.innerJoin('transactions as t', 't.id', 'p.transactionId')
					.select(['p.id', 'p.amount', 't.line'])
					.where('t.ledgerId', '=', ledger.id)
					.orderBy('t.date')
					.orderBy('p.position')
					.execute();

			await put(storage, ledger, 'a.rupea', `${rent}\n${food(5)}`);
			await Sync.syncIndex(ledger);
			const before = await posted();

			await put(storage, ledger, 'a.rupea', `\n\n${rent}\n${food(7)}`);
			await Sync.syncIndex(ledger);
			const after = await posted();

			expect(after.slice(0, 2).map((p) => p.id)).toEqual(before.slice(0, 2).map((p) => p.id));
			expect(after[0]?.line).toBe((before[0]?.line ?? 0) + 2);
			expect(after[2]?.id).not.toBe(before[2]?.id);
			expect(after[2]?.amount).toBe(70_000_000_000n);
		}));

	it('writes metadata again when only metadata changed', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const rent = (ref: string) =>
				`2026-01-01 Rent\n\t- ref: ${ref}\n\tExpenses:Home 10\n\t\t- ref: ${ref}\n\tAssets:Bank\n`;
			const refs = () =>
				db
					.selectFrom('metadata')
					.select('value')
					.where('ledgerId', '=', ledger.id)
					.where('key', '=', 'ref')
					.execute()
					.then((r) => r.map((m) => m.value));

			await put(storage, ledger, 'a.rupea', rent('one'));
			await Sync.syncIndex(ledger);
			expect(await refs()).toEqual(['one', 'one']);

			await put(storage, ledger, 'a.rupea', rent('two'));
			await Sync.syncIndex(ledger);
			expect(await refs()).toEqual(['two', 'two']);
		}));

	it('keeps evidence and its postings uncounted when its postings change', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const tea = (n: number, role: string) =>
				`2026-08-29 Tea\n\t- ${role}: tea\n\tExpenses:Food ${n}\n\tAssets:Bank\n`;
			const counted = () =>
				db
					.selectFrom('postings as p')
					.innerJoin('transactions as t', 't.id', 'p.transactionId')
					.select(['p.counted as posting', 't.counted as transaction'])
					.distinct()
					.where('p.ledgerId', '=', ledger.id)
					.orderBy('p.counted')
					.execute();

			await put(storage, ledger, 'a.rupea', tea(1, 'group'));
			await put(storage, ledger, 'b.rupea', tea(1, 'same-as'));
			await Sync.syncIndex(ledger);

			await put(
				storage,
				ledger,
				'b.rupea',
				tea(1, 'same-as').replace('Assets:Bank', 'Assets:Card'),
			);
			await Sync.syncIndex(ledger);

			expect(await counted()).toEqual([
				{ posting: false, transaction: false },
				{ posting: true, transaction: true },
			]);
		}));

	describe('transactions whose lines did not change', () => {
		const tea = '2026-08-29 Tea\n\tExpenses:Food 1\n\tAssets:Bank\n';

		const rows = (db: Database, ledgerId: string) =>
			db
				.selectFrom('transactions')
				.select(['id', 'line', 'description', 'comment', 'hash'])
				.where('ledgerId', '=', ledgerId)
				.orderBy('line')
				.execute();
		const amounts = async (db: Database, ledgerId: string) =>
			(
				await db
					.selectFrom('postings')
					.select('amount')
					.where('ledgerId', '=', ledgerId)
					.where('amount', '>', 0n)
					.orderBy('date')
					.execute()
			).map((p) => p.amount);

		it('are not read again, however far their lines move', ({ context, db, storage }) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				await put(storage, ledger, 'a.rupea', tea);
				await Sync.syncIndex(ledger);
				const [before] = await rows(db, ledger.id);
				await db
					.updateTable('postings')
					.set({ amount: 7n })
					.where('ledgerId', '=', ledger.id)
					.where('amount', '>', 0n)
					.execute();

				await put(storage, ledger, 'a.rupea', `${salary}\n${tea}`);
				await Sync.syncIndex(ledger);

				const [, after] = await rows(db, ledger.id);
				expect(after?.id).toBe(before?.id);
				expect(after?.line).toBeGreaterThan(before?.line ?? 0);
				expect(await amounts(db, ledger.id)).toContain(7n);
			}));

		it('are read when any of their lines changes, even only a comment', ({
			context,
			db,
			storage,
		}) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				await put(storage, ledger, 'a.rupea', tea);
				await Sync.syncIndex(ledger);
				const [before] = await rows(db, ledger.id);
				const posted = () =>
					db
						.selectFrom('postings')
						.select('id')
						.where('ledgerId', '=', ledger.id)
						.orderBy('id')
						.execute();
				const postedBefore = await posted();

				const commented = tea.replace('\tExpenses', '\t; hot\n\tExpenses');
				await put(storage, ledger, 'a.rupea', commented);
				await Sync.syncIndex(ledger);

				const [after] = await rows(db, ledger.id);
				expect(after?.id).toBe(before?.id);
				expect(after?.comment).toBe('hot');
				expect(after?.hash).not.toBe(before?.hash);
				expect(await posted()).toEqual(postedBefore);
			}));

		it('leave the same rows after any edits as reading the last file from scratch', ({
			context,
			db,
			storage,
		}) =>
			provide(context, async () => {
				const coffee = '2026-08-30 Coffee\n\tAssets:Cash -5 = -5\n\t- ref: a\n\tExpenses:Coffee\n';
				const buy = '2026-08-31 Buy\n\tAssets:Zerodha 10 INFY @ 1500\n\tAssets:Bank\n';
				const sell = '2026-08-31 Sell\n\tAssets:Zerodha -4 INFY {1500} @ 1700\n\tAssets:Bank\n';
				const edits = [
					`${tea}\n${coffee}\n${buy}\n${sell}`,
					`${salary}\n${tea}\n${coffee}\n${buy}\n${sell}`,
					`${sell}\n${tea}\n${tea}\n${buy}\n${coffee}`,
					`nonsense\n\n${tea}\n${buy}`,
					`${buy}\n${coffee.replace('-5 = -5', '-6 = -6')}\n${tea}\n${sell}`,
					`- statement: a.pdf\n\n${coffee}\n; note\n\n${buy}\n${tea.replace('Tea', 'Chai')}\n${sell}`,
				];

				const held = async (ledgerId: string) => ({
					transactions: await db
						.selectFrom('transactions')
						.select(['line', 'date', 'time', 'description', 'comment', 'counted', 'hash'])
						.where('ledgerId', '=', ledgerId)
						.orderBy('line')
						.execute(),
					postings: await db
						.selectFrom('postings')
						.innerJoin('accounts', 'accounts.id', 'postings.accountId')
						.innerJoin('transactions', 'transactions.id', 'postings.transactionId')
						.select([
							'transactions.line',
							'postings.position',
							'accounts.name',
							'postings.amount',
							'postings.commodity',
							'postings.balance',
							'postings.actual',
							'postings.counted',
						])
						.where('postings.ledgerId', '=', ledgerId)
						.orderBy(['transactions.line', 'postings.position'])
						.execute(),
					accounts: await db
						.selectFrom('accounts')
						.select('name')
						.where('ledgerId', '=', ledgerId)
						.orderBy('name')
						.execute(),
				});

				const edited = await createLedger(db);
				for (const content of edits) {
					await put(storage, edited, 'a.rupea', content);
					await Sync.syncIndex(edited);
				}
				const fresh = await createLedger(db);
				await put(storage, fresh, 'a.rupea', edits.at(-1) ?? '');
				await Sync.syncIndex(fresh);

				expect(await held(edited.id)).toEqual(await held(fresh.id));
			}));

		it('do not count as moved when one above them changes', ({ context, db, storage }) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				const coffee = '2026-08-30 Coffee\n\tAssets:Cash -5 = -5\n\tExpenses:Coffee\n';
				await put(storage, ledger, 'a.rupea', `${tea}\n${coffee}`);
				await Sync.syncIndex(ledger);
				await db
					.updateTable('postings')
					.set({ actual: 999n })
					.where('ledgerId', '=', ledger.id)
					.where('balance', 'is not', null)
					.execute();

				const commented = tea.replace('\tExpenses', '\t; hot\n\tExpenses');
				await put(storage, ledger, 'a.rupea', `${commented}\n${coffee}`);
				await Sync.syncIndex(ledger);

				const asserted = await db
					.selectFrom('postings')
					.select('actual')
					.where('ledgerId', '=', ledger.id)
					.where('balance', 'is not', null)
					.executeTakeFirst();
				expect(asserted?.actual).toBe(999n);
			}));

		it('reads a copy of one held once as new', ({ context, db, storage }) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				await put(storage, ledger, 'a.rupea', tea);
				await Sync.syncIndex(ledger);

				await put(storage, ledger, 'a.rupea', `${tea}\n${tea}`);
				await Sync.syncIndex(ledger);

				expect(await rows(db, ledger.id)).toHaveLength(2);
				expect(await count(db.selectFrom('postings').where('ledgerId', '=', ledger.id))).toBe(4);
			}));

		it('drops one copy of two when one goes, keeping the first', ({ context, db, storage }) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				await put(storage, ledger, 'a.rupea', `${tea}\n${tea}`);
				await Sync.syncIndex(ledger);
				const [first] = await rows(db, ledger.id);

				await put(storage, ledger, 'a.rupea', tea);
				await Sync.syncIndex(ledger);

				expect((await rows(db, ledger.id)).map((t) => t.id)).toEqual([first?.id]);
				expect(await count(db.selectFrom('postings').where('ledgerId', '=', ledger.id))).toBe(2);
			}));

		it('go when a bad header above stops the file being read, and return with it fixed', ({
			context,
			db,
			storage,
		}) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				await put(storage, ledger, 'a.rupea', `${salary}\n${tea}`);
				await Sync.syncIndex(ledger);

				await put(storage, ledger, 'a.rupea', `not a header\n\n${tea}`);
				const failed = (await Sync.syncIndex(ledger))._unsafeUnwrap();
				expect(failed).toHaveLength(1);
				expect(await rows(db, ledger.id)).toEqual([]);

				await put(storage, ledger, 'a.rupea', `${salary}\n${tea}`);
				expect((await Sync.syncIndex(ledger))._unsafeUnwrap()).toEqual([]);
				expect((await rows(db, ledger.id)).map((t) => t.description)).toEqual(['Salary', 'Tea']);
			}));

		it('are read again when an older indexer read them, and hold a hash after', ({
			context,
			db,
			storage,
		}) =>
			provide(context, async () => {
				const ledger = await createLedger(db);
				await put(storage, ledger, 'a.rupea', tea);
				await Sync.syncIndex(ledger);
				await db
					.updateTable('postings')
					.set({ amount: 7n })
					.where('ledgerId', '=', ledger.id)
					.where('amount', '>', 0n)
					.execute();
				await db
					.updateTable('transactions')
					.set({ hash: null })
					.where('ledgerId', '=', ledger.id)
					.execute();
				await db
					.updateTable('ledgerFiles')
					.set({ indexer: INDEXER - 1 })
					.where('ledgerId', '=', ledger.id)
					.execute();

				await Sync.syncIndex(ledger);

				const [row] = await rows(db, ledger.id);
				expect(row?.hash).toEqual(expect.any(String));
				expect(await amounts(db, ledger.id)).not.toContain(7n);
			}));
	});

	it('rewrites every posting of a file an older indexer read', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const posted = () =>
				db
					.selectFrom('postings')
					.select('id')
					.where('ledgerId', '=', ledger.id)
					.orderBy('position')
					.execute();

			await put(storage, ledger, 'a.rupea', groceries);
			await Sync.syncIndex(ledger);
			const before = await posted();

			await db
				.updateTable('ledgerFiles')
				.set({ indexer: INDEXER - 1 })
				.execute();
			await Sync.syncIndex(ledger);

			expect((await posted()).map((p) => p.id)).not.toEqual(before.map((p) => p.id));
		}));

	it('books lots again when same-day entries swap lines', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const buy = '2026-10-01 Buy\n\tAssets:Zerodha 10 INFY @ 1500\n\tAssets:Bank\n';
			const sell = '2026-10-01 Sell\n\tAssets:Zerodha -4 INFY {1500} @ 1700\n\tAssets:Bank\n';
			const unmatched = async () => (await Sync.checkLots(ledger))._unsafeUnwrap().length;

			await put(storage, ledger, 'a.rupea', `${sell}\n${buy}`);
			await Sync.syncIndex(ledger);
			expect(await unmatched()).toBe(1);

			await put(storage, ledger, 'a.rupea', `${buy}\n${sell}`);
			await Sync.syncIndex(ledger);
			expect(await unmatched()).toBe(0);
		}));

	it('leaves lots alone when an edit touches none of them', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const buy = '2026-10-01 Buy\n\tAssets:Zerodha 10 INFY @ 1500\n\tAssets:Bank\n';
			const rent = (n: number) => `2026-10-02 Rent\n\tExpenses:Home ${n}\n\tAssets:Bank\n`;
			const lots = () =>
				db.selectFrom('lots').select('id').where('ledgerId', '=', ledger.id).execute();

			await put(storage, ledger, 'a.rupea', `${buy}\n${rent(1)}`);
			await Sync.syncIndex(ledger);
			const before = await lots();
			expect(before).toHaveLength(1);

			await put(storage, ledger, 'a.rupea', `${buy}\n${rent(2)}`);
			await Sync.syncIndex(ledger);
			expect(await lots()).toEqual(before);
		}));

	it('writes only the prices that changed', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const stored = () =>
				db
					.selectFrom('prices as p')
					.innerJoin('ledgerFiles as f', 'f.id', 'p.fileId')
					.select(['p.id', 'p.priceAmount'])
					.where('f.ledgerId', '=', ledger.id)
					.orderBy('p.line')
					.execute();
			const lines = (n: number) =>
				`P 2026-10-17 INFY 1820\nP 2026-10-18 INFY ${n}\nP 2026-10-18 INFY ${n}\n`;

			await put(storage, ledger, 'a.rupea', lines(1830));
			await Sync.syncIndex(ledger);
			const before = await stored();

			await put(storage, ledger, 'a.rupea', lines(1840));
			await Sync.syncIndex(ledger);
			const after = await stored();

			expect(after[0]?.id).toBe(before[0]?.id);
			expect(after.slice(1).map((p) => p.priceAmount)).toEqual([
				1840_0000000000n,
				1840_0000000000n,
			]);
			expect(after[1]?.id).not.toBe(before[1]?.id);
		}));

	it('rewrites the prices of a file an older indexer read', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const stored = () =>
				db
					.selectFrom('prices as p')
					.innerJoin('ledgerFiles as f', 'f.id', 'p.fileId')
					.select('p.id')
					.where('f.ledgerId', '=', ledger.id)
					.execute();

			await put(storage, ledger, 'a.rupea', 'P 2026-10-17 INFY 1820\n');
			await Sync.syncIndex(ledger);
			const before = await stored();

			await db
				.updateTable('ledgerFiles')
				.set({ indexer: INDEXER - 1 })
				.execute();
			await Sync.syncIndex(ledger);
			const after = await stored();

			expect(after).toHaveLength(1);
			expect(after).not.toEqual(before);
		}));

	it('keeps the id of a transaction with a time', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const timed = groceries.replace('2026-08-29', '2026-08-29 18:45');
			const id = async () =>
				(
					await db
						.selectFrom('transactions')
						.select('id')
						.where('ledgerId', '=', ledger.id)
						.execute()
				)[0]?.id;

			await put(storage, ledger, 'a.rupea', timed);
			await Sync.syncIndex(ledger);
			const before = await id();

			await put(storage, ledger, 'a.rupea', `\n${timed}`);
			await Sync.syncIndex(ledger);
			expect(await id()).toBe(before);
		}));

	it('keeps evidence uncounted through an edit, and counts it once its group is gone', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const tea = '2026-08-29 Tea\n\tExpenses:Food 1\n\tAssets:Bank\n';
			const member = (role: string) => tea.replace('\n', `\n\t- ${role}: tea\n`);
			const counted = async () => (await listed(ledger)).map((t) => t.counted).sort();

			await put(storage, ledger, 'a.rupea', member('group'));
			await put(storage, ledger, 'b.rupea', member('same-as'));
			await Sync.syncIndex(ledger);
			expect(await counted()).toEqual([false, true]);

			await put(storage, ledger, 'b.rupea', `${salary}\n${member('same-as')}`);
			await Sync.syncIndex(ledger);
			expect(await counted()).toEqual([false, true, true]);

			await put(storage, ledger, 'a.rupea', tea);
			await put(storage, ledger, 'b.rupea', tea);
			await Sync.syncIndex(ledger);
			expect(await counted()).toEqual([true, true]);
		}));

	it('pages across a re-index without skipping a transaction', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const shops = Array.from(
				{ length: 150 },
				(_, i) => `2026-01-01 Shop ${i}\n\tExpenses:Food 1\n\tAssets:Bank\n`,
			).join('\n');
			await put(storage, ledger, 'a.rupea', shops);
			await Sync.syncIndex(ledger);

			const page = async (after: Transactions.Cursor | null) =>
				(
					await Transactions.listTransactions({ ledger, filter: everything, after })
				)._unsafeUnwrap();
			const first = await page(null);
			await put(storage, ledger, 'a.rupea', `${salary}\n${shops}`);
			await Sync.syncIndex(ledger);
			const second = await page(first.next);

			const seen = [...first.rows, ...second.rows].map((r) => r.description);
			expect(new Set(seen.filter((d) => d.startsWith('Shop'))).size).toBe(150);
		}));

	it('keeps a description embedded through a re-index', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);
			await Sync.syncIndex(ledger);
			await db
				.updateTable('transactions')
				.set({ embedding: sql<number[]>`${vector}::vector` })
				.where('ledgerId', '=', ledger.id)
				.execute();

			await put(storage, ledger, 'a.rupea', `${salary}${groceries}`);
			await Sync.syncIndex(ledger);

			const rows = await db
				.selectFrom('transactions')
				.select([
					'description',
					sql<string>`${sql.ref('embedding')}::text`.as('embedding'),
					'embeddingModel as model',
				])
				.where('ledgerId', '=', ledger.id)
				.orderBy('line')
				.execute();
			expect(rows).toEqual([
				{ description: 'Salary', embedding: expect.any(String), model: MODEL },
				{ description: 'Groceries', embedding: vector, model: MODEL },
			]);
		}));

	it('carries an embedding to every new row of its description', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const created = await Files.createFile({
				ledger,
				key: 'a.rupea',
				content: `${groceries}${groceries}`,
			});

			await db
				.updateTable('transactions')
				.set({ embedding: sql<number[]>`${vector}::vector`, embeddingModel: MODEL })
				.where('ledgerId', '=', ledger.id)
				.where('line', '=', 1)
				.execute();

			await Files.editFile({
				ledger,
				key: 'a.rupea',
				content: `${salary}${groceries}${groceries}`,
				version: created._unsafeUnwrap().version,
			});

			const rows = await db
				.selectFrom('transactions')
				.select(['description', sql<string | null>`${sql.ref('embedding')}::text`.as('embedding')])
				.where('ledgerId', '=', ledger.id)
				.orderBy('line')
				.execute();
			expect(rows).toEqual([
				{ description: 'Salary', embedding: null },
				{ description: 'Groceries', embedding: vector },
				{ description: 'Groceries', embedding: vector },
			]);
		}));

	it('reports parse errors on every sync until the file is fixed', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', `${groceries}2026-08-30 Bad\n\tbad posting x\n`);

			const problem = {
				type: 'ParseInvalidPosting',
				location: 'a.rupea:5',
			};
			expect(await issues(ledger)).toEqual(ok([problem]));
			expect(await issues(ledger)).toEqual(ok([problem]));
			// What did parse is indexed meanwhile.
			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Groceries']);

			await put(storage, ledger, 'a.rupea', groceries);
			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('syncs as a job, run as the owner', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);

			const ran = await runJob([syncLedger], {
				id: '',
				userId: ledger.owner,
				name: syncLedger.name,
				version: syncLedger.version,
				payload: { ledger: ledger.handle },
				attempts: 1,
			});

			expect(ran).toEqual(ok());
			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Groceries']);
		}));

	it('keeps a file with errors at its version, so it is not parsed again', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', `${groceries}2026-08-30 Bad\n\tbad posting x\n`);

			await Sync.syncIndex(ledger);
			const first = await problemIds(db, ledger.id);
			await Sync.syncIndex(ledger);

			expect(first).toHaveLength(1);
			expect(await problemIds(db, ledger.id)).toEqual(first);
		}));

	it('drops the problems of a file that goes', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', '2026-08-30 Bad\n\tbad posting x\n');
			await Sync.syncIndex(ledger);

			await stored(storage, ledger).delete('a.rupea');

			expect(await issues(ledger)).toEqual(ok([]));
			expect(await problemIds(db, ledger.id)).toEqual([]);
		}));

	it('orders a day by time, untimed first', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const body = '\tExpenses:Food 1\n\tAssets:Bank\n';
			await put(
				storage,
				ledger,
				'a.rupea',
				[
					`29 Aug 2026 9:15 pm Dinner\n${body}`,
					`29/08/2026 08:00 Breakfast\n${body}`,
					`2026-08-29 Untimed\n${body}`,
				].join('\n'),
			);
			await Sync.syncIndex(ledger);

			expect(await summary(ledger.id)).toEqual([
				'a.rupea:9 Untimed',
				'a.rupea:5 Breakfast',
				'a.rupea:1 Dinner',
			]);
		}));

	it('keeps ledgers apart', ({ context, db, storage }) =>
		provide(context, async () => {
			const one = await createLedger(db);
			const two = await createLedger(db);
			await put(storage, one, 'a.rupea', groceries);
			await Sync.syncIndex(one);
			await Sync.syncIndex(two);

			expect(await summary(two.id)).toEqual([]);
		}));
});

describe('groups across files', () => {
	const transfer = (role: string, amount: string) =>
		[
			'2026-10-03 NEFT IBKR',
			`\t- ${role}: 2026-10-03-ibkr-otter`,
			`\tAssets:IBKR ${amount}`,
			'\tAssets:HDFC',
			'',
		].join('\n');

	it('counts a group once, keeping its evidence', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'hdfc.rupea', content: transfer('group', '1000') });
			await Files.createFile({ ledger, key: 'ibkr.rupea', content: transfer('same-as', '1000') });
			await Files.createFile({ ledger, key: 'a.rupea', content: groceries });

			expect(await issues(ledger)).toEqual(ok([]));
			expect((await listed(ledger)).map((t) => [t.location.file, t.counted])).toEqual([
				['ibkr.rupea', false],
				['hdfc.rupea', true],
				['a.rupea', true],
			]);
		}));

	it('reports a broken group on every sync and counts all of it', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'hdfc.rupea', content: transfer('same-as', '1000') });
			await Files.createFile({ ledger, key: 'ibkr.rupea', content: transfer('same-as', '1000') });

			const problem = {
				type: 'GroupWithoutPrimary',
				group: '2026-10-03-ibkr-otter',
				location: 'hdfc.rupea:1, ibkr.rupea:1',
			};
			expect(await issues(ledger)).toEqual(ok([problem]));
			expect(await issues(ledger)).toEqual(ok([problem]));
			expect((await listed(ledger)).every((t) => t.counted)).toBe(true);
		}));

	it('reports evidence that disagrees with its primary', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'hdfc.rupea', content: transfer('group', '1000') });
			await Files.createFile({ ledger, key: 'ibkr.rupea', content: transfer('same-as', '999') });

			expect((await issues(ledger))._unsafeUnwrap()).toMatchObject([
				{ type: 'GroupDisagreement', location: 'ibkr.rupea:1', account: 'Assets:IBKR' },
				{ type: 'GroupDisagreement', location: 'ibkr.rupea:1', account: 'Assets:HDFC' },
			]);
		}));
});

describe('counting after an edit', () => {
	const member = (link: string) => `2026-10-03 NEFT\n${link}\tAssets:IBKR 1000\n\tAssets:HDFC\n`;
	const primary = '\t- group: neft\n';
	const evidence = '\t- same-as: neft\n';
	const save = async (ledger: Ledger, key: string, content: string) => {
		const found = await Files.readFile({ ledger, key });
		if (found.isErr()) return Files.createFile({ ledger, key, content });

		return Files.editFile({ ledger, key, content, version: found.value.version });
	};
	const countedIn = async (ledger: Ledger) =>
		(await listed(ledger)).map((t) => [t.location.file, t.counted]).sort();

	it('leaves evidence uncounted when an edit touches no group', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await save(ledger, 'a.rupea', member(primary));
			await save(ledger, 'b.rupea', member(evidence));
			await save(ledger, 'c.rupea', groceries);
			await save(ledger, 'c.rupea', groceries.replace('Groceries', 'Market'));

			expect(await countedIn(ledger)).toEqual([
				['a.rupea', true],
				['b.rupea', false],
				['c.rupea', true],
			]);
		}));

	it('uncounts a transaction an edit links as evidence, and counts it once unlinked', ({
		context,
		db,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await save(ledger, 'a.rupea', member(primary));
			await save(ledger, 'b.rupea', member(''));
			expect(await countedIn(ledger)).toEqual([
				['a.rupea', true],
				['b.rupea', true],
			]);

			await save(ledger, 'b.rupea', member(evidence));
			expect(await countedIn(ledger)).toEqual([
				['a.rupea', true],
				['b.rupea', false],
			]);

			await save(ledger, 'b.rupea', member(''));
			expect(await countedIn(ledger)).toEqual([
				['a.rupea', true],
				['b.rupea', true],
			]);
		}));

	it('counts evidence in another file once an edit takes its primary away', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await save(ledger, 'a.rupea', member(primary));
			await save(ledger, 'b.rupea', member(evidence));

			await save(ledger, 'a.rupea', member(''));

			expect(await countedIn(ledger)).toEqual([
				['a.rupea', true],
				['b.rupea', true],
			]);
		}));

	it('counts evidence in another file once the file with its primary goes', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await save(ledger, 'a.rupea', member(primary));
			await save(ledger, 'b.rupea', member(evidence));

			await Files.deleteFiles({ ledger, keys: ['a.rupea'] });

			expect(await countedIn(ledger)).toEqual([['b.rupea', true]]);
		}));
});

describe('positions an edit touches', () => {
	const paid = (account: string) => `2026-07-01 Paid\n\t${account} -100\n\tExpenses:Food\n`;
	const asserted = '2026-08-01 Salary\n\tAssets:Bank 1000 = 900\n\tIncome:Salary\n';
	const failed = async (ledger: Ledger) =>
		(await issues(ledger))._unsafeUnwrap().map((f) => f.type);

	it('checks an assertion again when an edit moves a posting off its account', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const created = await Files.createFile({
				ledger,
				key: 'a.rupea',
				content: paid('Assets:Bank'),
			});
			await Files.createFile({ ledger, key: 'b.rupea', content: asserted });
			expect(await failed(ledger)).toEqual([]);

			await Files.editFile({
				ledger,
				key: 'a.rupea',
				content: paid('Assets:Card'),
				version: created._unsafeUnwrap().version,
			});

			expect(await failed(ledger)).toEqual(['BalanceAssertionFailed']);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('checks an assertion again when an edit moves a posting onto its account', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const created = await Files.createFile({
				ledger,
				key: 'a.rupea',
				content: paid('Assets:Card'),
			});
			await Files.createFile({ ledger, key: 'b.rupea', content: asserted });
			expect(await failed(ledger)).toEqual(['BalanceAssertionFailed']);

			await Files.editFile({
				ledger,
				key: 'a.rupea',
				content: paid('Assets:Bank'),
				version: created._unsafeUnwrap().version,
			});

			expect(await failed(ledger)).toEqual([]);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('checks an assertion again when the file before it goes', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: paid('Assets:Bank') });
			await Files.createFile({ ledger, key: 'b.rupea', content: asserted });

			await Files.deleteFiles({ ledger, keys: ['a.rupea'] });

			expect(await failed(ledger)).toEqual(['BalanceAssertionFailed']);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('checks an assertion again when another file stops a posting counting', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const member = (role: string, account: string) =>
				`2026-07-01 Paid\n\t- ${role}: paid\n\t${account} -100\n\tExpenses:Food\n`;
			await Files.createFile({
				ledger,
				key: 'a.rupea',
				content: member('same-as', 'Assets:Bank'),
			});
			await Files.createFile({ ledger, key: 'b.rupea', content: asserted });
			expect(await failed(ledger)).toEqual(['GroupWithoutPrimary']);

			await Files.createFile({
				ledger,
				key: 'c.rupea',
				content: member('group', 'Assets:Card'),
			});

			expect(await failed(ledger)).toEqual(['BalanceAssertionFailed']);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('leaves other positions as they were', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: paid('Assets:Bank') });
			await Files.createFile({ ledger, key: 'b.rupea', content: asserted });
			const before = await months(db, ledger.id);

			await Files.createFile({
				ledger,
				key: 'c.rupea',
				content: '2026-07-02 Coffee\n\tAssets:Cash -5\n\tExpenses:Coffee\n',
			});

			expect((await months(db, ledger.id)).toSorted()).toEqual(
				[...before, 'Assets:Cash INR 2026-07-01 -5', 'Expenses:Coffee INR 2026-07-01 5'].toSorted(),
			);
			expect(await failed(ledger)).toEqual([]);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('drops an account an edit leaves unused, and those above it, keeping the rest', ({
		context,
		db,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const names = async () =>
				(
					await db
						.selectFrom('accounts')
						.select('name')
						.where('ledgerId', '=', ledger.id)
						.orderBy('name')
						.execute()
				).map((a) => a.name);
			const created = await Files.createFile({
				ledger,
				key: 'a.rupea',
				content: paid('Assets:Bank:Old:Savings'),
			});
			await Files.createFile({ ledger, key: 'b.rupea', content: paid('Assets:Bank:Main') });

			await Files.editFile({
				ledger,
				key: 'a.rupea',
				content: paid('Assets:Bank:Main'),
				version: created._unsafeUnwrap().version,
			});

			expect(await names()).toEqual([
				'Assets',
				'Assets:Bank',
				'Assets:Bank:Main',
				'Expenses',
				'Expenses:Food',
			]);
		}));
});

describe('balance assertions', () => {
	const opening = '2026-08-01 Opening\n\tAssets:Bank 1000\n\tEquity:Opening\n';
	const statement = [
		'2026-08-02 TEA',
		'\tAssets:Bank -100 = 900',
		'\tExpenses:Food',
		'',
		'2026-08-02 BOOKS',
		'\tAssets:Bank -50 = 850',
		'\tExpenses:Books',
		'',
		'2026-08-03 REFUND',
		'\tAssets:Bank 200 = 1050',
		'\tIncome:Refunds',
		'',
	].join('\n');

	it('checks the running balance across days and files', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({ ledger, key: 'hdfc.rupea', content: statement });

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('reports an assertion that does not hold, on every sync', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: statement.replace('= 850', '= 800'),
			});

			const problem = {
				type: 'BalanceAssertionFailed',
				location: 'hdfc.rupea:5',
				account: 'Assets:Bank',
				expected: '800.00',
				actual: '850.00',
			};
			expect(await issues(ledger)).toEqual(ok([problem]));
			expect(await issues(ledger)).toEqual(ok([problem]));
		}));

	it('orders another file by time, and warns when it cannot', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({ ledger, key: 'hdfc.rupea', content: statement });
			await Files.createFile({
				ledger,
				key: 'cash.rupea',
				content: '2026-08-02 ATM\n\tAssets:Bank -10\n\tAssets:Cash\n',
			});

			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				{
					type: 'BalanceAssertionAmbiguous',
					location: 'hdfc.rupea:1',
					account: 'Assets:Bank',
					unordered: 'cash.rupea:1',
				},
				expect.objectContaining({ type: 'BalanceAssertionAmbiguous', location: 'hdfc.rupea:5' }),
				expect.objectContaining({ type: 'BalanceAssertionFailed', location: 'hdfc.rupea:9' }),
			]);
		}));

	it('places a group at its primary', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: statement
					.replace('2026-08-02 TEA', '2026-08-02 09:00 TEA')
					.replace('2026-08-02 BOOKS\n', '2026-08-02 10:05 BOOKS\n\t- same-as: books\n'),
			});
			await Files.createFile({
				ledger,
				key: 'amazon.rupea',
				content: [
					'2026-08-02 10:00 Amazon order',
					'\t- group: books',
					'\tAssets:Bank -50',
					'\tExpenses:Books 30',
					'\tExpenses:Stationery 20',
					'',
				].join('\n'),
			});

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('checks each commodity of an account on its own', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const ibkr = (aapl: string) =>
				[
					'2026-10-01 Fund',
					'\tAssets:IBKR 1000 USD @ 83',
					'\tAssets:HDFC',
					'',
					'2026-10-02 Buy',
					`\tAssets:IBKR 2 AAPL @ 200 USD = ${aapl} AAPL`,
					'\tAssets:IBKR -400 USD = 600 USD',
					'',
				].join('\n');
			await Files.createFile({ ledger, key: 'ibkr.rupea', content: ibkr('2') });
			expect(await issues(ledger)).toEqual(ok([]));

			await Files.deleteFiles({ ledger, keys: ['ibkr.rupea'] });
			await Files.createFile({ ledger, key: 'ibkr.rupea', content: ibkr('3') });
			expect(await issues(ledger)).toEqual(
				ok([
					{
						type: 'BalanceAssertionFailed',
						location: 'ibkr.rupea:5',
						account: 'Assets:IBKR',
						expected: '3.00 AAPL',
						actual: '2.00 AAPL',
					},
				]),
			);
		}));

	it('checks an assertion on a day only evidence falls on', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content:
					'2026-08-02 BOOKS\n\t- same-as: books\n\tAssets:Bank -50 = 900\n\tExpenses:Books\n',
			});
			await Files.createFile({
				ledger,
				key: 'amazon.rupea',
				content: '2026-08-03 Amazon order\n\t- group: books\n\tAssets:Bank -50\n\tExpenses:Books\n',
			});

			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ type: 'BalanceAssertionFailed', location: 'hdfc.rupea:1' }),
			]);
		}));

	it('leaves evidence on an earlier day out of the opening', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: [
					'2026-08-02 BOOKS',
					'\t- same-as: books',
					'\tAssets:Bank -50',
					'\tExpenses:Books',
					'',
					'2026-08-04 TEA',
					'\tAssets:Bank -100 = 850',
					'\tExpenses:Food',
					'',
				].join('\n'),
			});
			await Files.createFile({
				ledger,
				key: 'amazon.rupea',
				content: '2026-08-03 Amazon order\n\t- group: books\n\tAssets:Bank -50\n\tExpenses:Books\n',
			});

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('orders postings in one transaction by position', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: [
					'2026-08-02 Transfer',
					'\tAssets:Bank -100 = 900',
					'\tAssets:Bank 40 = 940',
					'\tExpenses:Fees',
					'',
				].join('\n'),
			});

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('counts another file up to the time of the assertion', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: '2026-08-02 09:00 TEA\n\tAssets:Bank -100 = 890\n\tExpenses:Food\n',
			});
			await Files.createFile({
				ledger,
				key: 'cash.rupea',
				content: [
					'2026-08-02 08:00 ATM',
					'\tAssets:Bank -10',
					'\tAssets:Cash',
					'',
					'2026-08-02 10:00 ATM',
					'\tAssets:Bank -20',
					'\tAssets:Cash',
					'',
				].join('\n'),
			});

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('checks an assertion on the first posting of its account', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({
				ledger,
				key: 'opening.rupea',
				content: '2026-08-01 Opening\n\tAssets:Bank 1000 = 1000\n\tEquity:Opening\n',
			});

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('opens with the months before and the days of its month before it', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const months = ['2026-05-10', '2026-06-30', '2026-09-03']
				.map((d) => `${d} Salary\n\tAssets:Bank 100\n\tIncome:Salary\n`)
				.join('\n');
			await Files.createFile({ ledger, key: 'salary.rupea', content: months });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: [
					'2026-09-01 TEA',
					'\tAssets:Bank -10 = 190',
					'\tExpenses:Food',
					'',
					'2026-09-20 TEA',
					'\tAssets:Bank -10 = 280',
					'\tExpenses:Food',
					'',
				].join('\n'),
			});

			expect(await issues(ledger)).toEqual(ok([]));
		}));

	it('keeps whether a posting counts in step with its transaction', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const counted = () =>
				db
					.selectFrom('postings as p')
					.innerJoin('transactions as t', 't.id', 'p.transactionId')
					.select(['p.counted as posting', 't.counted as transaction'])
					.distinct()
					.where('p.ledgerId', '=', ledger.id)
					.orderBy('p.counted')
					.execute();
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: '2026-08-02 BOOKS\n\t- same-as: books\n\tAssets:Bank -50\n\tExpenses:Books\n',
			});
			await Files.createFile({
				ledger,
				key: 'amazon.rupea',
				content: '2026-08-02 Amazon order\n\t- group: books\n\tAssets:Bank -50\n\tExpenses:Books\n',
			});
			expect(await counted()).toEqual([
				{ posting: false, transaction: false },
				{ posting: true, transaction: true },
			]);

			await Files.deleteFiles({ ledger, keys: ['amazon.rupea'] });
			expect(await counted()).toEqual([{ posting: true, transaction: true }]);
		}));

	it('reports where an account goes off, not every assertion after', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const content = statement.replace('-100 = 900', '-150 = 900').replace('= 1050', '= 1100');
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({ ledger, key: 'hdfc.rupea', content });

			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ location: 'hdfc.rupea:1', expected: '900.00', actual: '850.00' }),
				expect.objectContaining({
					location: 'hdfc.rupea:9',
					expected: '1100.00',
					actual: '1000.00',
				}),
			]);
		}));

	it('reports nothing after an account comes back', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const content = statement.replace('-100 = 900', '-150 = 900').replace('-50 = 850', '0 = 850');
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({ ledger, key: 'hdfc.rupea', content });

			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ type: 'BalanceAssertionFailed', location: 'hdfc.rupea:1' }),
			]);
		}));

	it('checks again from an earlier file that changed, keeping what came before', ({
		context,
		db,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const july = (a: string) => `2026-07-01 Opening\n\tAssets:Bank ${a}\n\tEquity:Opening\n`;
			await Files.createFile({
				ledger,
				key: 'june.rupea',
				content: '2026-06-01 Cash\n\tAssets:Cash 10 = 20\n\tEquity:Opening\n',
			});
			const created = await Files.createFile({ ledger, key: 'july.rupea', content: july('1000') });
			await Files.createFile({ ledger, key: 'hdfc.rupea', content: statement });
			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ location: 'june.rupea:1' }),
			]);

			await Files.editFile({
				ledger,
				key: 'july.rupea',
				content: july('900'),
				version: created._unsafeUnwrap().version,
			});
			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ location: 'hdfc.rupea:1', expected: '900.00', actual: '800.00' }),
				expect.objectContaining({ location: 'june.rupea:1' }),
			]);
		}));

	it('names a transaction it cannot order by its file as it is now', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'opening.rupea', content: opening });
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: '2026-08-02 TEA\n\tAssets:Bank -100 = 900\n\tExpenses:Food\n',
			});
			await Files.createFile({
				ledger,
				key: 'cash.rupea',
				content: '2026-08-02 ATM\n\tAssets:Bank -10\n\tAssets:Cash\n',
			});
			await Files.renameFiles({ ledger, moves: [{ from: 'cash.rupea', to: 'atm.rupea' }] });

			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ location: 'hdfc.rupea:1', unordered: 'atm.rupea:1' }),
			]);
		}));
});

describe('lots', () => {
	const bought = ['2024-01-02 Buy', '\tAssets:Zerodha 10 INFY @ 1500', '\tAssets:Bank', ''].join(
		'\n',
	);

	const sold = (posting: string) =>
		['2025-03-01 Sell', posting, '\tAssets:Bank 6800', '\tIncome:Gains', ''].join('\n');

	const held = (db: Database, ledgerId: string) =>
		db
			.selectFrom('lots as l')
			.innerJoin('accounts as a', 'a.id', 'l.accountId')
			.select(['a.name as account', 'l.remaining', 'l.origin'])
			.where('l.ledgerId', '=', ledgerId)
			.orderBy('l.date')
			.orderBy('a.name')
			.execute();

	it('books lots across files, and what a sale takes from them', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: bought });
			await Files.createFile({
				ledger,
				key: 'b.rupea',
				content: sold('\tAssets:Zerodha -4 INFY {1500} @ 1700'),
			});

			expect(await issues(ledger)).toEqual(ok([]));
			expect(await held(db, ledger.id)).toEqual([
				{ account: 'Assets:Zerodha', remaining: 6_0000000000n, origin: 'buy' },
			]);
		}));

	it('books again when only the file with the buy changes', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: bought });
			await Files.createFile({
				ledger,
				key: 'b.rupea',
				content: sold('\tAssets:Zerodha -4 INFY {1500} @ 1700'),
			});

			const file = (await Files.readFile({ ledger, key: 'a.rupea' }))._unsafeUnwrap();
			await Files.editFile({
				ledger,
				key: 'a.rupea',
				content: bought.replace('@ 1500', '@ 1400'),
				version: file.version,
			});

			expect(await issues(ledger)).toEqual(
				ok([
					{
						type: 'LotNotOpen',
						location: 'b.rupea:1',
						account: 'Assets:Zerodha',
						units: '4.00 INFY',
					},
				]),
			);
		}));

	it('reports a sale that names no lot, and a named lot that went with its file', ({
		context,
		db,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: bought });
			await Files.createFile({
				ledger,
				key: 'b.rupea',
				content: sold('\tAssets:Zerodha -4 INFY @ 1700'),
			});
			await Files.createFile({
				ledger,
				key: 'c.rupea',
				content: sold('\tAssets:Zerodha -4 INFY {1500} @ 1700'),
			});
			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				{ type: 'LotCostMissing', location: 'b.rupea:1', account: 'Assets:Zerodha' },
			]);

			await Files.deleteFiles({ ledger, keys: ['a.rupea'] });
			expect((await issues(ledger))._unsafeUnwrap()).toEqual([
				{
					type: 'LotNotOpen',
					location: 'c.rupea:1',
					account: 'Assets:Zerodha',
					units: '4.00 INFY',
				},
			]);
		}));

	it('opens no lot for a buy that is evidence of another', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const buy = (role: string) =>
				bought.replace('Buy\n', `Buy\n\t- ${role}: 2024-01-02-infy-otter\n`);
			await Files.createFile({ ledger, key: 'a.rupea', content: buy('group') });
			await Files.createFile({ ledger, key: 'b.rupea', content: buy('same-as') });

			expect(await issues(ledger)).toEqual(ok([]));
			expect(await held(db, ledger.id)).toHaveLength(1);
		}));

	it('books again when a group stops counting the buy', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({
				ledger,
				key: 'b.rupea',
				content: bought.replace('Buy\n', 'Buy\n\t- same-as: 2024-01-02-infy-otter\n'),
			});
			expect(await held(db, ledger.id)).toHaveLength(1);

			await Files.createFile({
				ledger,
				key: 'a.rupea',
				content:
					'2024-01-02 Transfer\n\t- group: 2024-01-02-infy-otter\n\tAssets:Zerodha 15000\n\tAssets:Bank\n',
			});
			await issues(ledger);

			expect(await held(db, ledger.id)).toEqual([]);
		}));

	it('waits for another sync of the ledger to finish', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const other = Promise.withResolvers<void>();
			await put(storage, ledger, 'a.rupea', bought);

			const files = stored(storage, ledger);
			const holding = Sync.reindex({
				ledgerId: ledger.id,
				storage: {
					...files,
					read: (k) => ResultAsync.fromSafePromise(other.promise).andThen(() => files.read(k)),
				},
				changed: ['a.rupea'],
			});
			const syncing = issues(ledger);
			const first = await Promise.race([
				syncing.then(() => 'sync'),
				new Promise((r) => setTimeout(() => r('wait'), 200)),
			]);

			other.resolve();
			await Promise.all([holding, syncing]);
			expect(first).toBe('wait');
			expect(await held(db, ledger.id)).toHaveLength(1);
		}));

	it('keeps a file written while it waited for the lock', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const listed = Promise.withResolvers<void>();
			const files = stored(storage, ledger);
			const writing = Sync.reindex({
				ledgerId: ledger.id,
				storage: {
					...files,
					read: (k) =>
						ResultAsync.fromSafePromise(listed.promise)
							.andThen(() => put(storage, ledger, 'a.rupea', groceries))
							.andThen(() => files.read(k)),
				},
				changed: ['a.rupea'],
			});
			await new Promise((r) => setTimeout(r, 50));

			const syncing = issues(ledger);
			await new Promise((r) => setTimeout(r, 200));
			listed.resolve();

			await Promise.all([writing, syncing]);
			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Groceries']);
		}));

	it('rolls back what a sync indexed when booking fails, and books on the next', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const name = sql.id(`fail_lots_${ledger.id.replaceAll('-', '_')}`);
			await sql`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'no lots'; end $$`.execute(
				db,
			);
			await sql`create trigger ${name} before insert on lots for each row when (new.ledger_id = ${sql.lit(ledger.id)}) execute function ${name}()`.execute(
				db,
			);
			await put(storage, ledger, 'a.rupea', bought);

			expect((await Sync.syncIndex(ledger))._unsafeUnwrap()).toEqual([
				expect.objectContaining({ type: 'UnknownError' }),
			]);
			expect(await summary(ledger.id)).toEqual([]);

			await sql`drop trigger ${name} on lots`.execute(db);
			await sql`drop function ${name}()`.execute(db);

			expect(await issues(ledger)).toEqual(ok([]));
			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Buy']);
			expect(await held(db, ledger.id)).toHaveLength(1);
		}));
});

describe('syncing past a failure', () => {
	it('reports a file it cannot read, and indexes the rest', ({ context, db, storage }) => {
		const gone = fault('UnknownError', { message: 'disk gone' });
		const unreadable = {
			...storage,
			read: (k: string) => (k.endsWith('a.rupea') ? errAsync(gone) : storage.read(k)),
		};
		const storages = { local: byUser(unreadable) };

		return provide({ ...context, storages }, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);
			await put(storage, ledger, 'b.rupea', salary);

			expect(await Sync.syncIndex(ledger)).toEqual(
				ok([expect.objectContaining({ type: 'CannotReadFile', path: 'a.rupea', cause: [gone] })]),
			);
			expect(await summary(ledger.id)).toEqual(['b.rupea:1 Salary']);
		});
	});

	it('reports descriptions it cannot embed, and indexes them anyway', ({ context, db, storage }) =>
		provide({ ...context, models: broken(context.models) }, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupea', groceries);

			expect(await Sync.syncIndex(ledger)).toEqual(
				ok([fault('UnknownError', { message: 'no such model' })]),
			);
			expect(await summary(ledger.id)).toEqual(['a.rupea:1 Groceries']);
		}));
});

describe('monthly deltas', () => {
	const july = '2026-07-15 Rent\n\tExpenses:Rent 300\n\tAssets:Bank\n';
	const august = '2026-08-01 Salary\n\tAssets:Bank 1000\n\tIncome:Salary\n';

	it('sum what each account moved in each month', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: `${july}\n${august}` });
			await Files.createFile({ ledger, key: 'b.rupea', content: august });

			expect(await months(db, ledger.id)).toEqual([
				'Assets:Bank INR 2026-07-01 -300',
				'Assets:Bank INR 2026-08-01 2000',
				'Expenses:Rent INR 2026-07-01 300',
				'Income:Salary INR 2026-08-01 -2000',
			]);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('rewrite the months a file left and the months it moved to', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const file = (
				await Files.createFile({ ledger, key: 'a.rupea', content: july })
			)._unsafeUnwrap();
			await Files.editFile({
				ledger,
				key: 'a.rupea',
				content: july.replace('2026-07-15', '2026-09-15'),
				version: file.version,
			});

			expect(await months(db, ledger.id)).toEqual([
				'Assets:Bank INR 2026-09-01 -300',
				'Expenses:Rent INR 2026-09-01 300',
			]);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('keep a month whose postings cancel out', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const refund = '2026-07-20 Refund\n\tExpenses:Rent -300\n\tAssets:Bank\n';
			await Files.createFile({ ledger, key: 'a.rupea', content: `${july}\n${refund}` });

			expect(await months(db, ledger.id)).toEqual([
				'Assets:Bank INR 2026-07-01 0',
				'Expenses:Rent INR 2026-07-01 0',
			]);
		}));

	it('drop the months of a deleted file, or one moved out for review', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: july });
			await Files.createFile({ ledger, key: 'b.rupea', content: august });
			await Files.deleteFiles({ ledger, keys: ['a.rupea'] });
			await Files.renameFiles({ ledger, moves: [{ from: 'b.rupea', to: '_/b.rupea' }] });

			expect(await months(db, ledger.id)).toEqual([]);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));

	it('rewrite the month of evidence another file uncounts', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({
				ledger,
				key: 'hdfc.rupea',
				content: '2026-07-31 BOOKS\n\t- same-as: books\n\tAssets:Bank -50\n\tExpenses:Books\n',
			});
			await Files.createFile({
				ledger,
				key: 'amazon.rupea',
				content: '2026-08-01 Amazon order\n\t- group: books\n\tAssets:Bank -50\n\tExpenses:Books\n',
			});

			expect(await months(db, ledger.id)).toEqual([
				'Assets:Bank INR 2026-08-01 -50',
				'Expenses:Books INR 2026-08-01 50',
			]);
			expect(await drift(db, ledger.id)).toEqual([]);
		}));
});

describe('monthly deltas that drift', () => {
	const july = '2026-07-15 Rent\n\tExpenses:Rent 300\n\tAssets:Bank\n';
	const august = '2026-08-01 Salary\n\tAssets:Bank 1000\n\tIncome:Salary\n';
	const errors = [
		{
			name: 'a wrong amount',
			introduce: (id: string) =>
				sql`update monthly_deltas set amount = amount + 1 where ledger_id = ${id} and month = '2026-07-01'`,
		},
		{
			name: 'a missing month',
			introduce: (id: string) =>
				sql`delete from monthly_deltas where ledger_id = ${id} and month = '2026-07-01'`,
		},
		{
			name: 'stray months before and after the ledger',
			introduce: (id: string) =>
				sql`insert into monthly_deltas (ledger_id, account_id, account_type, commodity, month, amount)
					select ${id}, a.id, 'Assets', 'INR', m, 1
					from accounts a, unnest('{2001-01-01,2030-01-01}'::date[]) m
					where a.ledger_id = ${id} and a.name = 'Assets:Bank'`,
		},
		{
			name: 'every month dropped',
			introduce: (id: string) => sql`delete from monthly_deltas where ledger_id = ${id}`,
		},
		{
			name: 'a posting changed without a settle',
			introduce: (id: string) =>
				sql`update postings p set amount = amount * 2 from accounts a
					where a.id = p.account_id and p.ledger_id = ${id} and a.name = 'Expenses:Rent'`,
		},
	];

	it.for(errors)('put right $name on the next settle', ({ introduce }, { context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Files.createFile({ ledger, key: 'a.rupea', content: `${july}\n${august}` });
			await introduce(ledger.id).execute(db);
			expect(await drift(db, ledger.id)).not.toEqual([]);

			await Files.createFile({ ledger, key: 'b.rupea', content: august });

			expect(await drift(db, ledger.id)).toEqual([]);
		}),
	);

	it('come round to every month, twelve at a time', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const rent = july.replace('2026-07-15', '2023-01-15');
			const lunch = '2024-06-10 Lunch\n\tExpenses:Food 10\n\tAssets:Bank\n';
			await Files.createFile({ ledger, key: 'a.rupea', content: `${rent}\n${august}` });
			await sql`update ledgers set checked_through = null`.execute(db);
			await sql`update monthly_deltas set amount = 0 where month = '2026-08-01'`.execute(db);

			const checked: (string | null)[] = [];
			const drifted: number[] = [];
			for (const n of [1, 2, 3, 4]) {
				await Files.createFile({ ledger, key: `${n}.rupea`, content: lunch });
				checked.push(await checkedThrough(db, ledger.id));
				drifted.push((await drift(db, ledger.id)).length);
			}

			expect(checked).toEqual(['2023-12-31', '2024-12-31', '2025-12-31', null]);
			expect(drifted).toEqual([2, 2, 2, 0]);
		}));
});

const checkedThrough = (db: Database, id: string) =>
	db
		.selectFrom('ledgers')
		.select('checkedThrough')
		.where('id', '=', id)
		.executeTakeFirstOrThrow()
		.then((r) => r.checkedThrough);
