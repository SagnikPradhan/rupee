import { defaultConfiguration } from '#lib/server/shared/context/config.ts';
import { ok } from '#lib/server/shared/result/result.ts';
import { describe, expect, it } from 'vitest';
import {
	displayLocation,
	parse,
	parseAmount,
	parseHeader,
	parseTransactions,
	type RupeeLine,
} from '#services/ledger/domain/parser.ts';
import {
	formatAmount,
	PriceKind,
	type Amount,
	type RupeePosting,
} from '#services/ledger/domain/types.ts';

const file = 'random.rupee';
const at = displayLocation({ file, line: 1 });
const line = (content: string, index: number): RupeeLine => ({
	location: { file, line: index + 1 },
	content,
});

const run = (n: string[]) => parseTransactions(defaultConfiguration.ledger, n.map(line));

const transaction = (
	header: number,
	date: string,
	description: string,
	postings: RupeePosting[],
) => ({
	location: { file, line: header },
	date: Temporal.PlainDate.from(date),
	time: null,
	description,
	metadata: {},
	postings,
});

const posting = (account: string, amount: string): RupeePosting => ({
	account,
	amount: parseAmount(amount) as Amount,
	commodity: 'INR',
	price: null,
	cost: null,
	balance: null,
	metadata: {},
});

describe('parse transactions', () => {
	it('parses a balanced transaction', () => {
		expect(run(['2026-08-29 Groceries', '\tExpenses:Food 100', '\tAssets:Bank -100'])).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-08-29', 'Groceries', [
					posting('Expenses:Food', '100'),
					posting('Assets:Bank', '-100'),
				]),
			],
		});
	});

	it('works out the amount of a posting without one', () => {
		expect(run(['2026-08-29 Transfer', '\tAssets:Bank 100', '\tAssets:Savings'])).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-08-29', 'Transfer', [
					posting('Assets:Bank', '100'),
					posting('Assets:Savings', '-100'),
				]),
			],
		});
	});

	it('works out an amount from several postings, wherever it is', () => {
		expect(
			run(['2026-08-29 Dinner', '\tAssets:Bank', '\tExpenses:Food 90', '\tExpenses:Tip 10']),
		).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-08-29', 'Dinner', [
					posting('Assets:Bank', '-100'),
					posting('Expenses:Food', '90'),
					posting('Expenses:Tip', '10'),
				]),
			],
		});
	});

	it('allows zero amounts', () => {
		expect(run(['2026-08-29 Nothing', '\tAssets:Bank 0', '\tAssets:Savings']).succeeded).toEqual([
			transaction(1, '2026-08-29', 'Nothing', [
				posting('Assets:Bank', '0'),
				posting('Assets:Savings', '0'),
			]),
		]);
	});

	it('reports amounts that do not sum to zero', () => {
		expect(run(['2026-08-29 Oops', '\tExpenses:Food 100', '\tAssets:Bank -99.5'])).toEqual({
			failed: [{ type: 'ParseUnbalancedTransaction', location: at, residual: '0.50' }],
			succeeded: [],
		});
	});

	it('reports several postings without an amount', () => {
		expect(
			run(['2026-08-29 Oops', '\tExpenses:Food 100', '\tAssets:Bank', '\tAssets:Cash']),
		).toEqual({
			failed: [{ type: 'ParseMultipleImplicitPostings', location: at }],
			succeeded: [],
		});
	});

	it.each([['\tExpenses:Food 100'], ['\tExpenses:Food'], ['\tExpenses:Food 0']])(
		'reports a transaction with the single posting %j',
		(only) => {
			expect(run(['2026-08-29 Lonely', only])).toEqual({
				failed: [{ type: 'ParseMissingTransactionBody', location: at }],
				succeeded: [],
			});
		},
	);

	it('drops a transaction with an invalid posting, keeping the others', () => {
		const result = run([
			'2026-08-29 Bad',
			'\tExpenses:Food 100',
			'\ta b c',
			'2026-08-30 Good',
			'\tExpenses:Food 1',
			'\tAssets:Bank',
		]);
		expect(result.failed.map((e) => e.type)).toEqual(['ParseInvalidPosting']);
		expect(result.succeeded.map((t) => t.description)).toEqual(['Good']);
	});

	it.each([['\tFood 100'], ['\tassets:Bank'], ['\tAssetsBank:Cash']])(
		'reports the account outside the account types in %j',
		(bad) => {
			expect(run(['2026-08-29 Groceries', '\tExpenses:Food 100', bad])).toEqual({
				failed: [
					{
						type: 'ParseInvalidAccount',
						location: displayLocation({ file, line: 3 }),
						account: bad.trim().split(/\s+/)[0],
					},
				],
				succeeded: [],
			});
		},
	);

	it('reports an invalid transaction header', () => {
		expect(run(['not a transaction'])).toEqual({
			failed: [{ type: 'ParseInvalidTransactionHeader', location: at }],
			succeeded: [],
		});
	});

	it('reports a transaction with no body', () => {
		expect(run(['2026-08-29 Groceries'])).toEqual({
			failed: [{ type: 'ParseMissingTransactionBody', location: at }],
			succeeded: [],
		});
	});

	it('parses multiple transactions', () => {
		expect(
			run([
				'2026-08-29 Groceries',
				'\tExpenses:Food 100',
				'\tAssets:Bank',
				'2026-08-30 Salary',
				'\tAssets:Bank 1000',
				'\tIncome:Salary',
			]),
		).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-08-29', 'Groceries', [
					posting('Expenses:Food', '100'),
					posting('Assets:Bank', '-100'),
				]),
				transaction(4, '2026-08-30', 'Salary', [
					posting('Assets:Bank', '1000'),
					posting('Income:Salary', '-1000'),
				]),
			],
		});
	});

	it('reports an invalid posting', () => {
		expect(run(['2026-08-29 Groceries', '\ta b c'])).toEqual({
			failed: [
				{
					type: 'ParseInvalidPosting',
					location: displayLocation({ file, line: 2 }),
				},
			],
			succeeded: [],
		});
	});
});

describe('metadata', () => {
	const failure = (type: string, line: number) => ({
		type,
		location: displayLocation({ file, line }),
	});

	const parseFile = (n: string[]) =>
		parse(defaultConfiguration.ledger, { key: file, content: `${n.join('\n')}\n` });

	it('belongs to the nearest line above it, whatever its indentation', () => {
		const { succeeded, failed } = run([
			'2026-10-01 Amazon order',
			'\t- event: 2026-10-01-amazon-otter',
			'- ref: 402-123',
			'\tLiabilities:Card -1299',
			'\tExpenses:Books 499',
			'\t\t- tags: gift',
			'- note: for Riya',
			'\tExpenses:Electronics',
		]);

		expect(failed).toEqual([]);
		expect(succeeded[0]?.metadata).toEqual({
			event: ['2026-10-01-amazon-otter'],
			ref: ['402-123'],
		});
		expect(succeeded[0]?.postings.map((p) => p.metadata)).toEqual([
			{},
			{ tags: ['gift'], note: ['for Riya'] },
			{},
		]);
	});

	it('collects a repeated key into a list, in order', () => {
		const { succeeded } = run([
			'2026-10-01 Transfer',
			'\t- ref: a',
			'\t- tags: x, y',
			'\t- ref: b',
			'\tAssets:Bank 1',
			'\tAssets:Cash',
		]);

		expect(succeeded[0]?.metadata).toEqual({ ref: ['a', 'b'], tags: ['x, y'] });
	});

	it('keeps colons and spaces inside a value, trimming its ends', () => {
		const { succeeded } = run([
			'2026-10-01 Cash',
			'\t- note:   paid at 10:30, in cash  ',
			'\tAssets:Bank 1',
			'\tAssets:Cash',
		]);

		expect(succeeded[0]?.metadata).toEqual({ note: ['paid at 10:30, in cash'] });
	});

	it('belongs to the file above the first transaction', () => {
		const parsed = parseFile([
			'; imported',
			'- statement: hdfc-oct.pdf',
			'',
			'- tags: tax-2026',
			'',
			'2026-10-01 Cash',
			'\tAssets:Bank 1',
			'\tAssets:Cash',
		]);

		expect(parsed.failed).toEqual([]);
		expect(parsed.metadata).toEqual({ statement: ['hdfc-oct.pdf'], tags: ['tax-2026'] });
		expect(parsed.succeeded[0]?.metadata).toEqual({});
	});

	it('is reported when nothing above it can own it, and the parse goes on', () => {
		expect(
			parseFile([
				'2026-10-01 Cash',
				'\tAssets:Bank 1',
				'\tAssets:Cash',
				'',
				'- ref: lost',
				'2026-10-02 Cash',
				'\tAssets:Bank 2',
				'\tAssets:Cash',
			]),
		).toMatchObject({
			failed: [failure('ParseDetachedMetadata', 5)],
			succeeded: [{ description: 'Cash' }, { description: 'Cash' }],
		});
	});

	it.each(['\t- no colon', '\t- key:', '\t- key:value', '\t-', '\t- : value'])(
		'drops the transaction for %j, keeping the others',
		(bad) => {
			expect(
				run([
					'2026-10-01 Bad',
					'\tAssets:Bank 1',
					bad,
					'\tAssets:Cash',
					'',
					'2026-10-02 Good',
					'\tAssets:Bank 2',
					'\tAssets:Cash',
				]),
			).toMatchObject({
				failed: [failure('ParseInvalidMetadata', 3)],
				succeeded: [{ description: 'Good' }],
			});
		},
	);

	it('reports a bad line in the file metadata', () => {
		expect(parseFile(['- statement', '- schema: hdfc']).failed).toEqual([
			failure('ParseInvalidMetadata', 1),
		]);
	});
});

describe('balance assertions', () => {
	const asserted = (b: string) => ({ balance: parseAmount(b) as Amount });

	it('reads the balance after a posting, with or without its amount', () => {
		expect(
			run([
				'2026-08-29 Groceries',
				'\tAssets:Bank -100 = 1,900.50',
				'\tExpenses:Food',
				'',
				'2026-08-30 Salary',
				'\tIncome:Salary -500',
				'\tAssets:Bank = 2400.50 INR',
			]),
		).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-08-29', 'Groceries', [
					{ ...posting('Assets:Bank', '-100'), ...asserted('1900.50') },
					posting('Expenses:Food', '100'),
				]),
				transaction(5, '2026-08-30', 'Salary', [
					posting('Income:Salary', '-500'),
					{ ...posting('Assets:Bank', '500'), ...asserted('2400.50') },
				]),
			],
		});
	});

	it.each(['\tAssets:Bank -100 =', '\tAssets:Bank -100 = abc', '\tAssets:Bank = 1 = 2', '\t= 5'])(
		'rejects %j',
		(p) => {
			expect(run(['2026-08-29 Groceries', p, '\tExpenses:Food']).failed).toEqual([
				{ type: 'ParseInvalidPosting', location: displayLocation({ file, line: 2 }) },
			]);
		},
	);
});

describe('commodities', () => {
	const held = (
		account: string,
		amount: string,
		commodity: string,
		price: RupeePosting['price'] = null,
	): RupeePosting => ({ ...posting(account, amount), commodity, price });
	const unit = (amount: string, commodity: string) => ({
		amount: parseAmount(amount) as Amount,
		commodity,
		kind: PriceKind.Unit,
	});
	const buy = (lines: string[]) => run(['2026-10-01 Buy AAPL', ...lines]);

	it('balances a priced posting at its price', () => {
		expect(buy(['\tAssets:IBKR 10 AAPL @ 180.25 USD', '\tAssets:IBKR:Cash -1802.50 USD'])).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-10-01', 'Buy AAPL', [
					held('Assets:IBKR', '10', 'AAPL', unit('180.25', 'USD')),
					held('Assets:IBKR:Cash', '-1802.50', 'USD'),
				]),
			],
		});
	});

	it('takes a total price, and fills in the one commodity left over', () => {
		expect(buy(['\tAssets:IBKR 10 aapl @@ 1802.50 USD', '\tAssets:IBKR:Cash']).succeeded).toEqual([
			transaction(1, '2026-10-01', 'Buy AAPL', [
				held('Assets:IBKR', '10', 'AAPL', { ...unit('1802.50', 'USD'), kind: PriceKind.Total }),
				held('Assets:IBKR:Cash', '-1802.50', 'USD'),
			]),
		]);
	});

	it('prices in rupees when the price names no commodity', () => {
		expect(buy(['\tAssets:IBKR:Cash 100 USD @ 83.50', '\tAssets:HDFC']).succeeded).toEqual([
			transaction(1, '2026-10-01', 'Buy AAPL', [
				held('Assets:IBKR:Cash', '100', 'USD', unit('83.50', 'INR')),
				posting('Assets:HDFC', '-8350'),
			]),
		]);
	});

	it('checks each commodity on its own', () => {
		expect(buy(['\tAssets:IBKR 10 AAPL', '\tAssets:IBKR:Cash -1802.50 USD']).failed).toEqual([
			{
				type: 'ParseUnbalancedTransaction',
				location: at,
				residual: '10.00 AAPL, -1802.50 USD',
			},
		]);
		expect(
			buy(['\tAssets:IBKR 10 AAPL', '\tAssets:IBKR:Cash 5 USD', '\tEquity:Conversion']).failed,
		).toMatchObject([{ type: 'ParseUnbalancedTransaction', residual: '10.00 AAPL, 5.00 USD' }]);
	});

	it('asserts a balance in the posting commodity', () => {
		const [bought] = buy([
			'\tAssets:IBKR 10 AAPL @ 180 USD = 30 AAPL',
			'\tAssets:IBKR:Cash',
		]).succeeded;
		expect(bought?.postings[0]?.balance).toBe(parseAmount('30'));
	});

	it.each([
		['a price without an amount', '\tAssets:IBKR @ 180 USD'],
		['a price without a number', '\tAssets:IBKR 10 AAPL @ USD'],
		['a negative price', '\tAssets:IBKR 10 AAPL @ -180 USD'],
		['a balance in another commodity', '\tAssets:IBKR 10 AAPL @ 180 USD = 30 USD'],
	])('rejects %s', (_, line) => {
		expect(buy([line, '\tAssets:IBKR:Cash']).failed).toMatchObject([
			{ type: 'ParseInvalidPosting' },
		]);
	});
});

describe('market prices', () => {
	const parseFile = (n: string[]) =>
		parse(defaultConfiguration.ledger, { key: file, content: `${n.join('\n')}\n` });
	const price = (line: number, date: string, commodity: string, amount: string, of = 'INR') => ({
		location: { file, line },
		date: Temporal.PlainDate.from(date),
		commodity,
		price: { amount: parseAmount(amount) as Amount, commodity: of },
	});

	it('reads a P line, in rupees when it names no commodity', () => {
		expect(parseFile(['P 2026-10-17 INFY 1820', 'P 2026-10-17 aapl 230.5 usd'])).toEqual({
			metadata: {},
			prices: [
				price(1, '2026-10-17', 'INFY', '1820'),
				price(2, '2026-10-17', 'AAPL', '230.5', 'USD'),
			],
			succeeded: [],
			failed: [],
		});
	});

	it('ends the transaction above it, and sits anywhere among transactions', () => {
		const parsed = parseFile([
			'2026-10-01 Buy INFY',
			'\tAssets:Zerodha 10 INFY @ 1500',
			'\tAssets:Bank',
			'P 2026-10-17 INFY 1820',
			'\tAssets:Bank 5',
		]);

		expect(parsed.prices).toEqual([price(4, '2026-10-17', 'INFY', '1820')]);
		expect(parsed.succeeded.map((t) => t.postings.length)).toEqual([2]);
		expect(parsed.failed).toMatchObject([{ type: 'ParseInvalidTransactionHeader' }]);
	});

	it.each([
		['no date', 'P INFY 1820'],
		['no commodity', 'P 2026-10-17 1820'],
		['no price', 'P 2026-10-17 INFY'],
		['a negative price', 'P 2026-10-17 INFY -1820'],
		['a word after the price', 'P 2026-10-17 INFY 1820 INR each'],
	])('rejects %s', (_, line) => {
		expect(parseFile([line])).toMatchObject({
			prices: [],
			failed: [{ type: 'ParseInvalidPrice', location: at }],
		});
	});
});

describe('lot costs', () => {
	const sell = (lines: string[]) => run(['2026-10-01 Sell INFY', ...lines]);
	const sold = (cost: RupeePosting['cost'], price: RupeePosting['price'] = null): RupeePosting => ({
		...posting('Assets:Zerodha', '-4'),
		commodity: 'INFY',
		cost,
		price,
	});
	const rupees = (amount: string, date: string | null = null) => ({
		amount: parseAmount(amount) as Amount,
		commodity: 'INR',
		date: date === null ? null : Temporal.PlainDate.from(date),
	});

	it('balances a sale at its lot cost, with the gain beside it', () => {
		expect(
			sell(['\tAssets:Zerodha -4 INFY {1500} @ 1700', '\tAssets:Bank 6800', '\tIncome:Gains -800']),
		).toEqual({
			failed: [],
			succeeded: [
				transaction(1, '2026-10-01', 'Sell INFY', [
					sold(rupees('1500'), {
						amount: parseAmount('1700') as Amount,
						commodity: 'INR',
						kind: PriceKind.Unit,
					}),
					posting('Assets:Bank', '6800'),
					posting('Income:Gains', '-800'),
				]),
			],
		});
	});

	it('leaves the gain unbalanced when it is missing', () => {
		expect(sell(['\tAssets:Zerodha -4 INFY {1500} @ 1700', '\tAssets:Bank 6800']).failed).toEqual([
			{ type: 'ParseUnbalancedTransaction', location: at, residual: '800.00' },
		]);
	});

	it('fills in the posting left without an amount at cost', () => {
		const [t] = sell([
			'\tAssets:Zerodha -4 INFY {1500}',
			'\tIncome:Gains -800',
			'\tAssets:Bank',
		]).succeeded;
		expect(t?.postings[2]).toEqual(posting('Assets:Bank', '6800'));
	});

	it('names a lot by the day it was bought, in a configured format', () => {
		const [t] = sell(['\tAssets:Zerodha -4 INFY {1500, 2024-06-03}', '\tAssets:Bank']).succeeded;
		expect(t?.postings[0]).toEqual(sold(rupees('1500', '2024-06-03')));
	});

	it('takes a lot cost in another commodity', () => {
		const [t] = sell(['\tAssets:IBKR -4 AAPL {180 usd}', '\tAssets:IBKR:Cash']).succeeded;
		expect(t?.postings[0]?.cost).toEqual({ ...rupees('180'), commodity: 'USD' });
		expect(t?.postings[1]?.amount).toBe(parseAmount('720'));
	});

	it.each([
		['an empty lot cost', '\tAssets:Zerodha -4 INFY {}'],
		['a negative lot cost', '\tAssets:Zerodha -4 INFY {-1500}'],
		['a lot cost without an amount', '\tAssets:Zerodha {1500}'],
		['a lot date that is not a date', '\tAssets:Zerodha -4 INFY {1500, June}'],
		['a lot date without a space after the comma', '\tAssets:Zerodha -4 INFY {1500,2024-06-03}'],
	])('rejects %s', (_, line) => {
		expect(sell([line, '\tAssets:Bank']).failed).toMatchObject([{ type: 'ParseInvalidPosting' }]);
	});
});

describe('hledger-style input', () => {
	it('parses space indentation, an INR suffix and comments', () => {
		expect(
			run([
				'; opening',
				'2023/04/01 Opening Balance',
				'    Assets:Checking:HDFC                    28350.18 INR',
				'; between postings',
				'    Equity:OpeningBalances',
			]),
		).toEqual({
			failed: [],
			succeeded: [
				transaction(2, '2023-04-01', 'Opening Balance', [
					posting('Assets:Checking:HDFC', '28350.18'),
					posting('Equity:OpeningBalances', '-28350.18'),
				]),
			],
		});
	});

	it('accepts the INR suffix in any case', () => {
		expect(
			run(['2026-08-29 Groceries', '  Expenses:Food 100 inr', '  Assets:Bank']).failed,
		).toEqual([]);
	});

	it.each(['  Expenses:Food 100 1USD', ' Expenses:Food 100'])('rejects %j', (p) => {
		expect(run(['2026-08-29 Groceries', p]).succeeded).toEqual([]);
	});
});

describe('blank lines', () => {
	it.each([[[]], [['']], [['', '  ', '\t']]])('parses nothing from %j', (n) => {
		expect(run(n)).toEqual({ failed: [], succeeded: [] });
	});

	it('separate transactions and may lead or trail', () => {
		expect(
			run([
				'',
				'2026-08-29 Groceries',
				'\tExpenses:Food 100',
				'\tAssets:Bank',
				'',
				'\t',
				'2026-08-30 Salary',
				'\tAssets:Bank 1000',
				'\tIncome:Salary',
				'  ',
			]),
		).toEqual({
			failed: [],
			succeeded: [
				transaction(2, '2026-08-29', 'Groceries', [
					posting('Expenses:Food', '100'),
					posting('Assets:Bank', '-100'),
				]),
				transaction(7, '2026-08-30', 'Salary', [
					posting('Assets:Bank', '1000'),
					posting('Income:Salary', '-1000'),
				]),
			],
		});
	});

	it('end the postings above them', () => {
		expect(run(['2026-08-29 Groceries', '', '\tExpenses:Food 100'])).toEqual({
			failed: [
				{ type: 'ParseMissingTransactionBody', location: at },
				{
					type: 'ParseInvalidTransactionHeader',
					location: displayLocation({ file, line: 3 }),
				},
			],
			succeeded: [],
		});
	});
});

describe('reading an amount', () => {
	it.each([
		['100', 100_000_000n],
		['-1250.50', -1_250_500_000n],
		['+5', 5_000_000n],
		['₹1,250.50', 1_250_500_000n],
		['0.000001', 1n],
	])('reads %j as %s millionths', (tx, am) => {
		expect(parseAmount(tx)).toBe(am);
	});

	it.each(['', 'abc', '₹', '.5', '1.2345678', '100abc', '10AAPL', '5.5.5', '1,250.00Cr'])(
		'rejects %j',
		(tx) => {
			expect(parseAmount(tx)).toBeNull();
		},
	);
});

describe('writing an amount', () => {
	it.each([
		[100_000_000n, '100.00'],
		[-1_250_500_000n, '-1250.50'],
		[1n, '0.000001'],
		[-1n, '-0.000001'],
		[0n, '0.00'],
	])('writes %s millionths as %j', (am, tx) => {
		expect(formatAmount(am as Amount)).toBe(tx);
	});
});

describe('reading a transaction header', () => {
	const header = (c: string) => parseHeader(defaultConfiguration.ledger, line(c, 0));

	it.each([
		['2026-08-29 Groceries at the shop', null],
		['29/08/2026 Groceries at the shop', null],
		['29 Aug 2026 Groceries at the shop', null],
		['Aug 29, 2026 Groceries at the shop', null],
		['2026-08-29 18:45 Groceries at the shop', '18:45'],
		['29 August 2026 6:45 pm Groceries at the shop', '18:45'],
	])('reads %j', (content, time) => {
		expect(header(content)).toEqual(
			ok({
				date: Temporal.PlainDate.from('2026-08-29'),
				time: time === null ? null : Temporal.PlainTime.from(time),
				description: 'Groceries at the shop',
			}),
		);
	});

	it('keeps a word that is not a time in the description', () => {
		expect(header('2026-08-29 24:00 madness')).toMatchObject({
			value: { time: null, description: '24:00 madness' },
		});
	});

	it.each(['2026-08-29', '2026-08-29 18:45', '08/29/2026 Groceries'])('rejects %j', (content) => {
		expect(header(content)).toMatchObject({ error: { type: 'ParseInvalidTransactionHeader' } });
	});
});
