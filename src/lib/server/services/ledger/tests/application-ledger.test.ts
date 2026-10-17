import type { Database } from '#lib/server/db/index.ts';
import {
	EMBEDDING_DIMENSIONS,
	ledgerFiles,
	lots,
	memberships,
	metadata,
	prices,
	PriceSource,
	transactions,
} from '#lib/server/db/schema.ts';
import { provide } from '#lib/server/shared/context/context.ts';
import { isHandle, petName } from '#lib/server/shared/names.ts';
import { err, ok } from '#lib/server/shared/result/result.ts';
import { scoped, type Storage } from '#lib/server/shared/storage/storage.ts';
import { createLedger, createUser } from '#tests/shared/seed.ts';
import { it } from '#tests/shared/vitest.ts';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, vi } from 'vitest';
import { index } from '#services/ledger/adapters/database.ts';
import { formatAmount } from '#services/ledger/domain/types.ts';
import * as Ledger from '#services/ledger/application/ledger.ts';

vi.mock(import('#lib/server/shared/names.ts'), async (original) => {
	const names = await original();
	return { ...names, petName: vi.fn(names.petName) };
});

afterEach(() => {
	vi.mocked(petName).mockReset();
});

const groceries = '2026-08-29 Groceries\n\tExpenses:Food 100.5\n\tAssets:Bank\n';
const salary = '2026-08-01 Salary\n\tAssets:Bank 50000\n\tIncome:Salary\n';

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

const fileMetadata = async (db: Database, ledgerId: string) =>
	(
		await db
			.select({ key: metadata.key, value: metadata.value })
			.from(metadata)
			.innerJoin(ledgerFiles, eq(ledgerFiles.id, metadata.fileId))
			.where(eq(ledgerFiles.ledgerId, ledgerId))
			.orderBy(asc(metadata.position))
	).map((r) => [r.key, r.value]);

// Where the ledger's files are, in a storage holding every user's.
const stored = (storage: Storage, ledger: Ledger.Ledger) =>
	scoped(storage, `users/${ledger.owner}/ledgers/${ledger.handle}/files`);

const put = (storage: Storage, ledger: Ledger.Ledger, key: string, text: string) =>
	stored(storage, ledger).write({
		key,
		content: new TextEncoder().encode(text),
	});

const summary = async (ledgerId: string) => {
	const indexed = await index(ledgerId).transactions();
	return indexed.isOk()
		? indexed.value.map(
				({ location, description }) => `${location.file}:${location.line} ${description}`,
			)
		: indexed;
};

describe('syncing the ledger', () => {
	it('indexes new files, ordered by date', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupee', groceries);
			await put(storage, ledger, 'b/c.rupee', salary);
			await put(storage, ledger, 'notes.txt', 'not a ledger file');

			expect(await Ledger.sync(ledger)).toEqual(ok([]));
			expect(await summary(ledger.id)).toEqual(['b/c.rupee:1 Salary', 'a.rupee:1 Groceries']);
		}));

	it('indexes metadata of the file, its transactions and their postings', ({
		context,
		db,
		storage,
	}) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupee', annotated);
			await Ledger.sync(ledger);

			const [indexed] = (await index(ledger.id).transactions())._unsafeUnwrap();
			expect(indexed?.metadata).toEqual({ ref: ['a', 'b'], note: ['weekly shop'] });
			expect(indexed?.postings.map((p) => p.metadata)).toEqual([{ tags: ['weekly'] }, {}]);
			expect(await fileMetadata(db, ledger.id)).toEqual([['statement', 'hdfc-oct.pdf']]);
		}));

	it('leaves no metadata behind when a file changes or goes', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			// Other tests share the database, so count only what this one adds.
			const before = await db.$count(metadata);
			await put(storage, ledger, 'a.rupee', annotated);
			await Ledger.sync(ledger);
			expect(await db.$count(metadata)).toBe(before + 5);

			await put(storage, ledger, 'a.rupee', `- statement: other.pdf\n\n${groceries}`);
			await Ledger.sync(ledger);
			expect(await db.$count(metadata)).toBe(before + 1);

			await stored(storage, ledger).delete('a.rupee');
			await Ledger.sync(ledger);
			expect(await db.$count(metadata)).toBe(before);
		}));

	it('indexes market prices, replacing them when the file changes', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const bought = '2026-10-01 Buy INFY\n\tAssets:Zerodha 10 INFY @ 1500\n\tAssets:Bank\n';
			const indexed = () =>
				db
					.select({
						commodity: prices.commodity,
						amount: prices.priceAmount,
						source: prices.source,
					})
					.from(prices)
					.where(eq(prices.ledgerId, ledger.id))
					.orderBy(asc(prices.line));

			await put(storage, ledger, 'a.rupee', `${bought}\nP 2026-10-17 INFY 1820\n`);
			await Ledger.sync(ledger);
			expect(await indexed()).toEqual([
				{ commodity: 'INFY', amount: 1_500_000_000n, source: PriceSource.Posting },
				{ commodity: 'INFY', amount: 1_820_000_000n, source: PriceSource.Line },
			]);

			await put(storage, ledger, 'a.rupee', 'P 2026-10-18 INFY 1830\nP 2026-10-18 TCS 4100\n');
			await Ledger.sync(ledger);
			expect(await indexed()).toEqual([
				{ commodity: 'INFY', amount: 1_830_000_000n, source: PriceSource.Line },
				{ commodity: 'TCS', amount: 4_100_000_000n, source: PriceSource.Line },
			]);
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
			await put(storage, ledger, 'a.rupee', sale);
			await Ledger.sync(ledger);

			const [indexed] = (await index(ledger.id).transactions())._unsafeUnwrap();
			expect(indexed?.postings.map((p) => p.cost)).toEqual([
				{
					amount: 1_500_000_000n,
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
			await put(storage, ledger, 'a.rupee', groceries);
			await put(storage, ledger, 'b.rupee', salary);
			await Ledger.sync(ledger);

			await put(storage, ledger, 'a.rupee', `${salary}${groceries}`);
			await stored(storage, ledger).delete('b.rupee');
			await Ledger.sync(ledger);

			expect(await summary(ledger.id)).toEqual(['a.rupee:1 Salary', 'a.rupee:4 Groceries']);
		}));

	it('keeps a description embedded through a re-index', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
			await put(storage, ledger, 'a.rupee', groceries);
			await Ledger.sync(ledger);
			await db
				.update(transactions)
				.set({ embedding: vector, embeddingModel: 'm1' })
				.where(eq(transactions.ledgerId, ledger.id));

			await put(storage, ledger, 'a.rupee', `${salary}${groceries}`);
			await Ledger.sync(ledger);

			const rows = await db
				.select({
					description: transactions.description,
					model: transactions.embeddingModel,
				})
				.from(transactions)
				.where(eq(transactions.ledgerId, ledger.id))
				.orderBy(asc(transactions.line));
			expect(rows).toEqual([
				{ description: 'Salary', model: null },
				{ description: 'Groceries', model: 'm1' },
			]);
		}));

	it('reports parse errors on every sync until the file is fixed', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupee', `${groceries}2026-08-30 Bad\n\tbad posting x\n`);

			const problem = {
				type: 'ParseInvalidPosting',
				location: 'a.rupee:5',
			};
			expect(await Ledger.sync(ledger)).toEqual(ok([problem]));
			expect(await Ledger.sync(ledger)).toEqual(ok([problem]));
			// What did parse is indexed meanwhile.
			expect(await summary(ledger.id)).toEqual(['a.rupee:1 Groceries']);

			await put(storage, ledger, 'a.rupee', groceries);
			expect(await Ledger.sync(ledger)).toEqual(ok([]));
		}));

	it('orders a day by time, untimed first', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const body = '\tExpenses:Food 1\n\tAssets:Bank\n';
			await put(
				storage,
				ledger,
				'a.rupee',
				[
					`29 Aug 2026 9:15 pm Dinner\n${body}`,
					`29/08/2026 08:00 Breakfast\n${body}`,
					`2026-08-29 Untimed\n${body}`,
				].join('\n'),
			);
			await Ledger.sync(ledger);

			expect(await summary(ledger.id)).toEqual([
				'a.rupee:9 Untimed',
				'a.rupee:5 Breakfast',
				'a.rupee:1 Dinner',
			]);
		}));

	it('keeps ledgers apart', ({ context, db, storage }) =>
		provide(context, async () => {
			const one = await createLedger(db);
			const two = await createLedger(db);
			await put(storage, one, 'a.rupee', groceries);
			await Ledger.sync(one);
			await Ledger.sync(two);

			expect(await summary(two.id)).toEqual([]);
		}));
});

describe('mutations', () => {
	it('index what they write without a sync', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'a.rupee', content: groceries });
			expect(await summary(ledger.id)).toEqual(['a.rupee:1 Groceries']);

			await Ledger.renameFile({ ledger, from: 'a.rupee', to: 'b.rupee' });
			expect(await summary(ledger.id)).toEqual(['b.rupee:1 Groceries']);

			await Ledger.deleteFile(ledger, 'b.rupee');
			expect(await summary(ledger.id)).toEqual([]);
		}));

	it('leave the index alone when the write is refused', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'a.rupee', content: groceries });
			const again = await Ledger.createFile({
				ledger,
				key: 'a.rupee',
				content: salary,
			});

			expect(again).toMatchObject({ error: { type: 'StorageConflict' } });
			expect(await summary(ledger.id)).toEqual(['a.rupee:1 Groceries']);
		}));
});

describe('reading a file', () => {
	it('returns what is in storage, even before any sync', ({ context, db, storage }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await put(storage, ledger, 'a.rupee', groceries);

			const file = await Ledger.getFile(ledger, 'a.rupee');
			expect(file.isOk() && file.value).toMatchObject({ key: 'a.rupee', content: groceries });
			expect(await summary(ledger.id)).toEqual([]);
		}));

	it('fails for a file that is not there', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			expect(await Ledger.getFile(ledger, 'a.rupee')).toMatchObject({
				error: { type: 'CannotReadFile', path: 'a.rupee' },
			});
		}));
});

describe('listing transactions', () => {
	it('returns exact amounts and source locations', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'a.rupee', content: groceries });
			const transactions = await Ledger.getTransactions(ledger);
			if (transactions.isErr()) throw new Error('getTransactions failed');

			const [groceriesTransaction] = transactions.value.succeeded;
			expect(groceriesTransaction).toMatchObject({
				location: { file: 'a.rupee', line: 1 },
				description: 'Groceries',
			});
			expect(
				groceriesTransaction?.postings.map(({ account, amount }) => [
					account,
					formatAmount(amount),
				]),
			).toEqual([
				['Expenses:Food', '100.50'],
				['Assets:Bank', '-100.50'],
			]);
		}));

	it('returns every field as the file wrote it', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const content = [
				'2026-08-01 Opening',
				'\tAssets:Bank 100000',
				'\tEquity:Opening',
				'',
				'2026-08-29 18:45 Bought shares',
				'\t- ref: 402-123',
				'\tAssets:Broker 10 INFY @ 1500.125',
				'\t\t- tags: long, tech',
				'\tAssets:Bank -15001.25 = 84998.75',
				'\tExpenses:Fees 20 USD @@ 1680',
				'\tAssets:Bank',
				'',
			].join('\n');
			await Ledger.createFile({ ledger, key: 'a.rupee', content });

			const listed = (await Ledger.getTransactions(ledger))._unsafeUnwrap();

			expect(listed.failed).toEqual([]);
			expect(listed.succeeded).toMatchObject(Ledger.check('a.rupee', content).succeeded);
		}));
});

describe('reaching a ledger', () => {
	it('lets its owner and its members in, and no one else', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const member = await createUser(db);
			const stranger = await createUser(db);
			await db.insert(memberships).values({ userId: member.userId, ledgerId: ledger.id });
			const reach = (user: string) =>
				Ledger.withLedger({ user, handle: ledger.handle, action: (l) => ok(l) });

			expect(await reach(ledger.owner)).toEqual(ok(ledger));
			expect(await reach(member.userId)).toEqual(ok(ledger));
			expect(await reach(stranger.userId)).toEqual(
				err({ type: 'LedgerNotFound', handle: ledger.handle }),
			);
		}));

	it('lists the ledgers a user owns and those shared with them', ({ context, db }) =>
		provide(context, async () => {
			const own = await createLedger(db);
			const shared = await createLedger(db);
			await createLedger(db);
			await db.insert(memberships).values({ userId: own.owner, ledgerId: shared.id });

			expect(await Ledger.listLedgers(own.owner)).toEqual(ok([own, shared]));
		}));

	it("creates a ledger under a fresh handle, in its owner's storage", ({ context, db, storage }) =>
		provide(context, async () => {
			const { userId } = await createUser(db);
			const created = (await Ledger.createLedger({ user: userId, name: 'Home' }))._unsafeUnwrap();
			await Ledger.createFile({ ledger: created, key: 'a.rupee', content: groceries });

			expect(created).toMatchObject({ name: 'Home', owner: userId });
			expect(isHandle(created.handle)).toBe(true);
			expect((await stored(storage, created).read('a.rupee')).isOk()).toBe(true);
		}));

	it('tries another handle when one is taken, and gives up after a few', ({ context, db }) =>
		provide(context, async () => {
			const { userId } = await createUser(db);
			vi.mocked(petName).mockReturnValueOnce('quiet-heron');
			await Ledger.createLedger({ user: userId, name: 'Home' });
			vi.mocked(petName).mockReturnValueOnce('quiet-heron').mockReturnValueOnce('brave-otter');

			expect(await Ledger.createLedger({ user: userId, name: 'Work' })).toMatchObject(
				ok({ handle: 'brave-otter', name: 'Work' }),
			);

			vi.mocked(petName).mockReturnValue('quiet-heron');
			expect(await Ledger.createLedger({ user: userId, name: 'Away' })).toEqual(
				err({ type: 'NameTaken', name: 'quiet-heron' }),
			);
		}));
});

describe('events across files', () => {
	const transfer = (role: string, amount: string) =>
		[
			'2026-10-03 NEFT IBKR',
			`\t- ${role}: 2026-10-03-ibkr-otter`,
			`\tAssets:IBKR ${amount}`,
			'\tAssets:HDFC',
			'',
		].join('\n');

	it('counts an event once, keeping its evidence', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: transfer('event', '1000') });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: transfer('same-as', '1000') });
			await Ledger.createFile({ ledger, key: 'a.rupee', content: groceries });

			expect(await Ledger.sync(ledger)).toEqual(ok([]));
			const listed = (await Ledger.getTransactions(ledger))._unsafeUnwrap();
			expect(listed.failed).toEqual([]);
			expect(listed.succeeded.map((t) => [t.location.file, t.counted])).toEqual([
				['a.rupee', true],
				['hdfc.rupee', true],
				['ibkr.rupee', false],
			]);
		}));

	it('reports a broken event on every sync and counts all of it', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: transfer('same-as', '1000') });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: transfer('same-as', '1000') });

			const problem = {
				type: 'EventWithoutPrimary',
				event: '2026-10-03-ibkr-otter',
				location: 'hdfc.rupee:1, ibkr.rupee:1',
			};
			expect(await Ledger.sync(ledger)).toEqual(ok([problem]));
			expect(await Ledger.sync(ledger)).toEqual(ok([problem]));
			const listed = (await Ledger.getTransactions(ledger))._unsafeUnwrap();
			expect(listed.failed).toEqual([problem]);
			expect(listed.succeeded.every((t) => t.counted)).toBe(true);
		}));

	it('reports evidence that disagrees with its primary', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: transfer('event', '1000') });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: transfer('same-as', '999') });

			expect((await Ledger.sync(ledger))._unsafeUnwrap()).toMatchObject([
				{ type: 'EventDisagreement', location: 'ibkr.rupee:1', account: 'Assets:IBKR' },
				{ type: 'EventDisagreement', location: 'ibkr.rupee:1', account: 'Assets:HDFC' },
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
			await Ledger.createFile({ ledger, key: 'opening.rupee', content: opening });
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: statement });

			expect(await Ledger.sync(ledger)).toEqual(ok([]));
		}));

	it('reports an assertion that does not hold, on every listing', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'opening.rupee', content: opening });
			await Ledger.createFile({
				ledger,
				key: 'hdfc.rupee',
				content: statement.replace('= 850', '= 800'),
			});

			const problem = {
				type: 'BalanceAssertionFailed',
				location: 'hdfc.rupee:5',
				account: 'Assets:Bank',
				expected: '800.00',
				actual: '850.00',
			};
			expect(await Ledger.sync(ledger)).toEqual(ok([problem]));
			expect((await Ledger.getTransactions(ledger))._unsafeUnwrap().failed).toEqual([problem]);
		}));

	it('orders another file by time, and warns when it cannot', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'opening.rupee', content: opening });
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: statement });
			await Ledger.createFile({
				ledger,
				key: 'cash.rupee',
				content: '2026-08-02 ATM\n\tAssets:Bank -10\n\tAssets:Cash\n',
			});

			expect((await Ledger.sync(ledger))._unsafeUnwrap()).toEqual([
				{
					type: 'BalanceAssertionAmbiguous',
					location: 'hdfc.rupee:1',
					account: 'Assets:Bank',
					unordered: 'cash.rupee:1',
				},
				expect.objectContaining({ type: 'BalanceAssertionAmbiguous', location: 'hdfc.rupee:5' }),
				expect.objectContaining({ type: 'BalanceAssertionFailed', location: 'hdfc.rupee:9' }),
			]);
		}));

	it('places an event at its primary', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'opening.rupee', content: opening });
			await Ledger.createFile({
				ledger,
				key: 'hdfc.rupee',
				content: statement
					.replace('2026-08-02 TEA', '2026-08-02 09:00 TEA')
					.replace('2026-08-02 BOOKS\n', '2026-08-02 10:05 BOOKS\n\t- same-as: books\n'),
			});
			await Ledger.createFile({
				ledger,
				key: 'amazon.rupee',
				content: [
					'2026-08-02 10:00 Amazon order',
					'\t- event: books',
					'\tAssets:Bank -50',
					'\tExpenses:Books 30',
					'\tExpenses:Stationery 20',
					'',
				].join('\n'),
			});

			expect(await Ledger.sync(ledger)).toEqual(ok([]));
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
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: ibkr('2') });
			expect(await Ledger.sync(ledger)).toEqual(ok([]));

			await Ledger.deleteFile(ledger, 'ibkr.rupee');
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: ibkr('3') });
			expect(await Ledger.sync(ledger)).toEqual(
				ok([
					{
						type: 'BalanceAssertionFailed',
						location: 'ibkr.rupee:5',
						account: 'Assets:IBKR',
						expected: '3.00 AAPL',
						actual: '2.00 AAPL',
					},
				]),
			);
		}));
});

describe('changing an event', () => {
	const hdfc = [
		'2026-10-03 NEFT TO INTERACTIVE BROKERS',
		'\tAssets:HDFC -1000',
		'\tAssets:IBKR',
		'',
		'2026-10-03 SWIGGY',
		'\tAssets:HDFC -450',
		'\tExpenses:Food',
		'',
	].join('\n');

	const ibkr = [
		'2026-10-03 Deposit',
		'\tAssets:IBKR 1000',
		'\tAssets:HDFC',
		'',
		'2026-10-03 ZOMATO',
		'\tLiabilities:Card -450',
		'\tExpenses:Food',
		'',
	].join('\n');

	const linkedHdfc = hdfc.replace(
		'NEFT TO INTERACTIVE BROKERS\n',
		'NEFT TO INTERACTIVE BROKERS\n\t- same-as: transfer-otter\n',
	);
	const linkedIbkr = ibkr.replace('Deposit\n', 'Deposit\n\t- event: transfer-otter\n');

	const counted = async (ledger: Ledger.Ledger) =>
		(await Ledger.getTransactions(ledger))
			._unsafeUnwrap()
			.succeeded.filter((t) => !t.counted)
			.map((t) => t.description);

	it('lists the events a file takes part in, with members from every file', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: linkedHdfc });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: linkedIbkr });

			const events = (await Ledger.eventsIn(ledger, 'hdfc.rupee'))._unsafeUnwrap();
			expect(
				events.map((e) => [e.event, e.members.map((m) => [m.location.file, m.role, m.counted])]),
			).toEqual([
				[
					'transfer-otter',
					[
						['hdfc.rupee', 'evidence', false],
						['ibkr.rupee', 'primary', true],
					],
				],
			]);
		}));

	it('makes evidence the primary, and the old primary evidence', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: linkedHdfc });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: linkedIbkr });

			expect(
				await Ledger.makePrimary({
					ledger,
					event: 'transfer-otter',
					file: 'hdfc.rupee',
					line: 1,
				}),
			).toEqual(ok([]));
			expect((await Ledger.getFile(ledger, 'hdfc.rupee'))._unsafeUnwrap().content).toBe(
				linkedHdfc.replace('same-as:', 'event:'),
			);
			expect((await Ledger.getFile(ledger, 'ibkr.rupee'))._unsafeUnwrap().content).toBe(
				linkedIbkr.replace('event:', 'same-as:'),
			);
			expect(await Ledger.sync(ledger)).toEqual(ok([]));
			expect(await counted(ledger)).toEqual(['Deposit']);
		}));

	it('refuses to make primary a transaction outside the event', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: linkedHdfc });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: linkedIbkr });

			expect(
				(
					await Ledger.makePrimary({
						ledger,
						event: 'transfer-otter',
						file: 'hdfc.rupee',
						line: 6,
					})
				)._unsafeUnwrapErr(),
			).toEqual({ type: 'EventStale', location: 'hdfc.rupee:6' });
		}));

	it('renames an event in every file, and refuses a name in use', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'hdfc.rupee', content: linkedHdfc });
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content: linkedIbkr });
			await Ledger.createFile({
				ledger,
				key: 'cash.rupee',
				content: '2026-10-04 ATM\n\t- event: taken\n\tAssets:Cash 5\n\tAssets:HDFC\n',
			});

			expect(await Ledger.renameEvent(ledger, 'transfer-otter', 'taken')).toEqual(
				err({ type: 'EventIdTaken', event: 'taken' }),
			);
			expect(await Ledger.renameEvent(ledger, 'transfer-otter', 'ibkr-funding')).toEqual(ok([]));
			expect((await Ledger.getFile(ledger, 'hdfc.rupee'))._unsafeUnwrap().content).toBe(
				linkedHdfc.replace('transfer-otter', 'ibkr-funding'),
			);
			expect((await Ledger.getFile(ledger, 'ibkr.rupee'))._unsafeUnwrap().content).toBe(
				linkedIbkr.replace('transfer-otter', 'ibkr-funding'),
			);
			expect(await Ledger.sync(ledger)).toEqual(ok([]));
			expect(await counted(ledger)).toEqual(['NEFT TO INTERACTIVE BROKERS']);
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
			.select({ account: lots.account, remaining: lots.remaining, origin: lots.origin })
			.from(lots)
			.where(eq(lots.ledgerId, ledgerId))
			.orderBy(asc(lots.date), asc(lots.account));

	it('books lots across files, and what a sale takes from them', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'a.rupee', content: bought });
			await Ledger.createFile({
				ledger,
				key: 'b.rupee',
				content: sold('\tAssets:Zerodha -4 INFY {1500} @ 1700'),
			});

			expect(await Ledger.sync(ledger)).toEqual(ok([]));
			expect(await held(db, ledger.id)).toEqual([
				{ account: 'Assets:Zerodha', remaining: 6_000_000n, origin: 'buy' },
			]);
		}));

	it('books again when only the file with the buy changes', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			await Ledger.createFile({ ledger, key: 'a.rupee', content: bought });
			await Ledger.createFile({
				ledger,
				key: 'b.rupee',
				content: sold('\tAssets:Zerodha -4 INFY {1500} @ 1700'),
			});

			const file = (await Ledger.getFile(ledger, 'a.rupee'))._unsafeUnwrap();
			await Ledger.editFile({
				ledger,
				key: 'a.rupee',
				content: bought.replace('@ 1500', '@ 1400'),
				version: file.version,
			});

			expect(await Ledger.sync(ledger)).toEqual(
				ok([
					{
						type: 'LotNotOpen',
						location: 'b.rupee:1',
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
			await Ledger.createFile({ ledger, key: 'a.rupee', content: bought });
			await Ledger.createFile({
				ledger,
				key: 'b.rupee',
				content: sold('\tAssets:Zerodha -4 INFY @ 1700'),
			});
			await Ledger.createFile({
				ledger,
				key: 'c.rupee',
				content: sold('\tAssets:Zerodha -4 INFY {1500} @ 1700'),
			});
			expect((await Ledger.sync(ledger))._unsafeUnwrap()).toEqual([
				{ type: 'LotCostMissing', location: 'b.rupee:1', account: 'Assets:Zerodha' },
			]);

			await Ledger.deleteFile(ledger, 'a.rupee');
			expect((await Ledger.sync(ledger))._unsafeUnwrap()).toEqual([
				{
					type: 'LotNotOpen',
					location: 'c.rupee:1',
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
			await Ledger.createFile({ ledger, key: 'a.rupee', content: buy('event') });
			await Ledger.createFile({ ledger, key: 'b.rupee', content: buy('same-as') });

			expect(await Ledger.sync(ledger)).toEqual(ok([]));
			expect(await held(db, ledger.id)).toHaveLength(1);
		}));
});

describe('accounts', () => {
	const day = Temporal.PlainDate.from('2026-10-17');

	it('values what each account holds at its latest price, a P line first', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const content = [
				'2026-01-02 Buy',
				'\tAssets:Zerodha 10 INFY @ 1500',
				'\tAssets:Bank',
				'',
				'2026-03-01 Sell',
				'\tAssets:Zerodha -4 INFY {1500} @ 1700',
				'\tAssets:Bank 6800',
				'\tIncome:Gains -800',
				'',
				'2026-04-01 Bonus',
				'\tAssets:Zerodha 1 TCS',
				'\tIncome:Bonus -1 TCS',
				'',
				'2026-10-01 Buy',
				'\tAssets:Zerodha 1 INFY @ 1900',
				'\tAssets:Bank',
				'',
				'P 2026-10-01 INFY 1800',
				'P 2026-10-20 INFY 2000',
				'',
			].join('\n');
			await Ledger.createFile({ ledger, key: 'a.rupee', content });

			const accounts = (await Ledger.getAccounts(ledger, day))._unsafeUnwrap().succeeded;
			expect(accounts.map((a) => [a.account, a.total, a.unpriced])).toEqual([
				['Assets', 2500_000_000n, 1],
				['Assets:Bank', -10100_000_000n, 0],
				['Assets:Zerodha', 12600_000_000n, 1],
			]);
			expect(accounts[2]?.holdings).toMatchObject([
				{
					commodity: 'INFY',
					units: 7_000_000n,
					cost: { amount: 10900_000_000n, commodity: 'INR' },
					price: { amount: 1800_000_000n, commodity: 'INR' },
					gain: 1700_000_000n,
				},
				{ commodity: 'TCS', units: 1_000_000n, value: null },
			]);
		}));

	it('values shares priced in dollars at the price of a dollar', ({ context, db }) =>
		provide(context, async () => {
			const ledger = await createLedger(db);
			const content = [
				'2026-10-01 Fund',
				'\tAssets:IBKR 1000 USD @ 83',
				'\tAssets:HDFC',
				'',
				'2026-10-02 Buy',
				'\tAssets:IBKR 2 AAPL @ 200 USD',
				'\tAssets:IBKR -400 USD',
				'',
				'P 2026-10-03 AAPL 250 USD',
				'',
			].join('\n');
			await Ledger.createFile({ ledger, key: 'ibkr.rupee', content });

			const accounts = (await Ledger.getAccounts(ledger, day))._unsafeUnwrap().succeeded;
			expect(accounts.find((a) => a.account === 'Assets:IBKR')?.holdings).toMatchObject([
				{ commodity: 'AAPL', value: 41500_000_000n, gain: 8300_000_000n },
				{ commodity: 'USD', value: 49800_000_000n, gain: null },
			]);
		}));
});
