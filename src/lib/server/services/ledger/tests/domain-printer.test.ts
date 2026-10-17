import { defaultConfiguration } from '#lib/server/shared/context/config.ts';
import { describe, expect, it } from 'vitest';
import { parse, parseAmount } from '#services/ledger/domain/parser.ts';
import { print, viewTransaction } from '#services/ledger/domain/printer.ts';
import {
	PriceKind,
	type Amount,
	type RupeeLedgerFile,
	type RupeeTransaction,
} from '#services/ledger/domain/types.ts';

const amount = (t: string) => parseAmount(t) as Amount;

const transactions: RupeeTransaction[] = [
	{
		location: { file: 'a.rupee', line: 1 },
		date: Temporal.PlainDate.from('2026-08-29'),
		time: Temporal.PlainTime.from('18:45'),
		description: 'Groceries',
		metadata: {},
		postings: [
			{
				account: 'Expenses:Food',
				amount: amount('100.5'),
				commodity: 'INR',
				price: null,
				balance: null,
				metadata: {},
			},
			{
				account: 'Assets:Bank',
				amount: amount('-100.5'),
				commodity: 'INR',
				price: null,
				balance: null,
				metadata: {},
			},
		],
	},
	{
		location: { file: 'a.rupee', line: 5 },
		date: Temporal.PlainDate.from('2026-08-30'),
		time: null,
		description: 'Salary for August',
		metadata: {},
		postings: [
			{
				account: 'Assets:Bank',
				amount: amount('-0.000001'),
				commodity: 'INR',
				price: null,
				balance: null,
				metadata: {},
			},
			{
				account: 'Income:Salary',
				amount: amount('0.000001'),
				commodity: 'INR',
				price: null,
				balance: null,
				metadata: {},
			},
		],
	},
];

const ledger = (t: RupeeTransaction[]): RupeeLedgerFile => ({
	metadata: {},
	transactions: t,
	prices: [],
});

const annotated: RupeeLedgerFile = {
	metadata: { statement: ['hdfc-card-oct-2026.pdf'] },
	transactions: [
		{
			location: { file: 'a.rupee', line: 3 },
			date: Temporal.PlainDate.from('2026-10-01'),
			time: null,
			description: 'Amazon order 402-123',
			metadata: { event: ['2026-10-01-amazon-otter'], ref: ['402-1', '402-2'] },
			postings: [
				{
					account: 'Liabilities:Card',
					amount: amount('-1299'),
					commodity: 'INR',
					price: null,
					balance: null,
					metadata: {},
				},
				{
					account: 'Expenses:Books',
					amount: amount('499'),
					commodity: 'INR',
					price: null,
					balance: null,
					metadata: { tags: ['gift, 80c'] },
				},
				{
					account: 'Expenses:Electronics',
					amount: amount('800'),
					commodity: 'INR',
					price: null,
					balance: null,
					metadata: {},
				},
			],
		},
	],
	prices: [],
};

describe('printing a ledger', () => {
	it('writes .rupee text in the first configured formats', () => {
		expect(print(defaultConfiguration.ledger, ledger(transactions))).toBe(
			[
				'2026-08-29 18:45 Groceries',
				'\tExpenses:Food 100.50',
				'\tAssets:Bank',
				'',
				'2026-08-30 Salary for August',
				'\tAssets:Bank',
				'\tIncome:Salary 0.000001',
				'',
			].join('\n'),
		);
	});

	it('spells every amount unless exactly one posting is outgoing', () => {
		const spelled = (postings: [string, string][]) =>
			print(
				defaultConfiguration.ledger,
				ledger([
					{
						...transactions[0]!,
						postings: postings.map(([account, a]) => ({
							account,
							amount: amount(a),
							commodity: 'INR',
							price: null,
							balance: null,
							metadata: {},
						})),
					},
				]),
			)
				.split('\n')
				.slice(1, -1);
		expect(
			spelled([
				['A', '-1'],
				['B', '-2'],
				['C', '3'],
			]),
		).toEqual(['\tA -1.00', '\tB -2.00', '\tC 3.00']);
		expect(
			spelled([
				['A', '0'],
				['B', '0'],
			]),
		).toEqual(['\tA 0.00', '\tB 0.00']);
	});

	it('reads back as what it wrote', () => {
		const content = print(defaultConfiguration.ledger, ledger(transactions));
		expect(parse(defaultConfiguration.ledger, { key: 'a.rupee', content })).toEqual({
			metadata: {},
			prices: [],
			succeeded: transactions,
			failed: [],
		});
	});

	it('writes metadata under what it belongs to, posting metadata a level deeper', () => {
		expect(print(defaultConfiguration.ledger, annotated)).toBe(
			[
				'- statement: hdfc-card-oct-2026.pdf',
				'',
				'2026-10-01 Amazon order 402-123',
				'\t- event: 2026-10-01-amazon-otter',
				'\t- ref: 402-1',
				'\t- ref: 402-2',
				'\tLiabilities:Card',
				'\tExpenses:Books 499.00',
				'\t\t- tags: gift, 80c',
				'\tExpenses:Electronics 800.00',
				'',
			].join('\n'),
		);
	});

	it('reads metadata back as what it wrote', () => {
		const content = print(defaultConfiguration.ledger, annotated);
		expect(parse(defaultConfiguration.ledger, { key: 'a.rupee', content })).toEqual({
			metadata: annotated.metadata,
			prices: [],
			succeeded: annotated.transactions,
			failed: [],
		});
	});

	it('writes a balance after the amount, and reads it back', () => {
		const [groceries, salary] = transactions;
		const asserted = ledger([
			{
				...groceries!,
				postings: groceries!.postings.map((p) => ({ ...p, balance: amount('1899.5') })),
			},
			salary!,
		]);
		const content = print(defaultConfiguration.ledger, asserted);

		expect(content.split('\n').slice(1, 3)).toEqual([
			'\tExpenses:Food 100.50 = 1899.50',
			'\tAssets:Bank = 1899.50',
		]);
		expect(parse(defaultConfiguration.ledger, { key: 'a.rupee', content }).succeeded).toEqual(
			asserted.transactions,
		);
	});

	it('spells out commodities and prices, and reads them back', () => {
		const content = [
			'2026-10-01 Buy AAPL',
			'\tAssets:IBKR 10.00 AAPL @ 180.25 USD = 30.00 AAPL',
			'\tAssets:IBKR:Cash -1802.50 USD',
			'',
			'2026-10-02 Fund IBKR',
			'\tAssets:IBKR:Cash 100.00 USD @@ 8350.00',
			'\tAssets:HDFC -8350.00',
			'',
		].join('\n');
		const parsed = parse(defaultConfiguration.ledger, { key: 'a.rupee', content });

		expect(parsed.failed).toEqual([]);
		expect(print(defaultConfiguration.ledger, ledger(parsed.succeeded))).toBe(content);
	});

	it('writes market prices after the transactions, and reads them back', () => {
		const content = [
			'2026-10-01 Buy INFY',
			'\tAssets:Zerodha 10.00 INFY @ 1500.00',
			'\tAssets:Bank -15000.00',
			'',
			'P 2026-10-17 INFY 1820.00',
			'P 2026-10-17 AAPL 230.50 USD',
			'',
		].join('\n');
		const parsed = parse(defaultConfiguration.ledger, { key: 'a.rupee', content });

		expect(parsed.failed).toEqual([]);
		expect(
			print(defaultConfiguration.ledger, { ...ledger(parsed.succeeded), prices: parsed.prices }),
		).toBe(content);
	});

	it('follows the configuration', () => {
		const cfg = { dateFormats: ['d MMM yyyy'], timeFormats: ['h:mm a'] };
		expect(print(cfg, ledger(transactions.slice(0, 1)))).toMatch(
			/^29 Aug 2026 6:45 PM Groceries\n/,
		);
	});

	it('writes nothing for no transactions', () => {
		expect(print(defaultConfiguration.ledger, ledger([]))).toBe('');
	});
});

describe('viewing a transaction', () => {
	const transaction: RupeeTransaction = {
		location: { file: 'bank.rupee', line: 12 },
		date: Temporal.PlainDate.from('2026-08-29'),
		time: Temporal.PlainTime.from('18:45:30'),
		description: 'Bought shares',
		metadata: {},
		postings: [
			{
				account: 'Assets:Broker',
				amount: amount('10'),
				commodity: 'INFY',
				price: { kind: PriceKind.Unit, amount: amount('1500.125'), commodity: 'INR' },
				balance: null,
				metadata: {},
			},
			{
				account: 'Assets:Bank',
				amount: amount('-15001.25'),
				commodity: 'INR',
				price: null,
				balance: null,
				metadata: {},
			},
		],
	};

	it('flattens it into plain text for the page', () => {
		expect(viewTransaction(transaction)).toEqual({
			file: 'bank.rupee',
			line: 12,
			date: '2026-08-29',
			time: '18:45',
			description: 'Bought shares',
			postings: [
				{ account: 'Assets:Broker', amount: '10.00 INFY', price: '@ 1500.125' },
				{ account: 'Assets:Bank', amount: '-15001.25', price: null },
			],
		});
	});

	it('shows a total price with @@', () => {
		const [first] = transaction.postings;
		const priced = {
			...transaction,
			postings: [
				{ ...first!, price: { kind: PriceKind.Total, amount: amount('5'), commodity: 'USD' } },
			],
		};
		expect(viewTransaction(priced).postings[0]?.price).toBe('@@ 5.00 USD');
	});

	it('leaves an untimed transaction without a time', () => {
		expect(viewTransaction({ ...transaction, time: null }).time).toBeNull();
	});
});
