import { defaultConfiguration } from '#lib/server/shared/context/config.ts';
import { describe, expect, it } from 'vitest';
import { BALANCE_TYPES } from '#services/ledger/domain/events.ts';
import { book, type BookedPosting } from '#services/ledger/domain/lots.ts';
import { parse } from '#services/ledger/domain/parser.ts';
import { accountType, formatAmount, formatQuantity } from '#services/ledger/domain/types.ts';

// Each posting is named `line.position` after its transaction's header line.
const booked = (lines: string[], commodity = 'INFY') => {
	const content = `${lines.join('\n')}\n`;
	const parsed = parse(defaultConfiguration.ledger, { key: 'a.rupee', content });
	if (parsed.failed.length > 0) throw new Error(JSON.stringify(parsed.failed));

	const postings: BookedPosting[] = parsed.succeeded.flatMap((t) =>
		t.postings.flatMap((p, position) =>
			p.commodity === commodity
				? [
						{
							id: `${t.location.line}.${position}`,
							transaction: String(t.location.line),
							account: p.account,
							held: BALANCE_TYPES.some((r) => r === accountType(p.account)),
							date: t.date,
							amount: p.amount,
							price: p.price,
							cost: p.cost,
						},
					]
				: [],
		),
	);
	const { lots, disposals } = book(postings);

	return {
		lots: lots.map(
			(l) =>
				`${l.key} ${l.account} ${formatAmount(l.units)} {${formatQuantity(l.cost)}, ${l.date.toString()}} ${l.origin} left ${formatAmount(l.remaining)}${l.source === null ? '' : ` from ${l.source}`}`,
		),
		disposals: disposals.map(
			(d) =>
				`${d.posting} ${d.kind} ${formatAmount(d.units)} from ${d.lot ?? 'nothing'}${d.price ? ` @ ${formatQuantity(d.price)}` : ''}`,
		),
	};
};

const buys = [
	'2024-01-02 Buy',
	'\tAssets:Zerodha 10 INFY @ 1500',
	'\tAssets:Bank',
	'',
	'2024-06-03 Buy',
	'\tAssets:Zerodha 10 INFY @@ 15000',
	'\tAssets:Bank',
	'',
	'2024-07-01 Buy',
	'\tAssets:Zerodha 5 INFY @ 1800',
	'\tAssets:Bank',
	'',
];

describe('buying', () => {
	it('opens a lot at the price of each unit', () => {
		expect(booked(buys).lots).toEqual([
			'0 Assets:Zerodha 10.00 {1500.00, 2024-01-02} buy left 10.00',
			'1 Assets:Zerodha 10.00 {1500.00, 2024-06-03} buy left 10.00',
			'2 Assets:Zerodha 5.00 {1800.00, 2024-07-01} buy left 5.00',
		]);
	});

	it('opens nothing for an account that is a category', () => {
		expect(
			booked(['2024-01-02 Bonus', '\tAssets:Zerodha 10 INFY', '\tIncome:Bonus -10 INFY']).lots,
		).toEqual(['0 Assets:Zerodha 10.00 {0.00, 2024-01-02} unpriced left 10.00']);
	});
});

describe('selling', () => {
	const sell = (posting: string) => [
		...buys,
		'2025-03-01 Sell',
		posting,
		'\tAssets:Bank 20000',
		'\tIncome:Gains',
	];

	it('takes from the oldest lot with the cost it names', () => {
		const { lots, disposals } = booked(sell('\tAssets:Zerodha -4 INFY {1800} @ 2000'));
		expect(lots[2]).toBe('2 Assets:Zerodha 5.00 {1800.00, 2024-07-01} buy left 1.00');
		expect(disposals).toEqual(['13.0 sale -4.00 from 2 @ 2000.00']);
	});

	it('runs on into the next lot with that cost', () => {
		const { lots, disposals } = booked(sell('\tAssets:Zerodha -12 INFY {1500} @ 2000'));
		expect(lots.map((l) => l.split(' left ')[1])).toEqual(['0.00', '8.00', '5.00']);
		expect(disposals).toEqual([
			'13.0 sale -10.00 from 0 @ 2000.00',
			'13.0 sale -2.00 from 1 @ 2000.00',
		]);
	});

	it('picks a lot by the day it was bought', () => {
		const { disposals } = booked(sell('\tAssets:Zerodha -4 INFY {1500, 2024-06-03} @ 2000'));
		expect(disposals).toEqual(['13.0 sale -4.00 from 1 @ 2000.00']);
	});

	it('reports units no open lot covers', () => {
		expect(booked(sell('\tAssets:Zerodha -4 INFY {1600} @ 2000')).disposals).toEqual([
			'13.0 sale -4.00 from nothing @ 2000.00',
		]);
		expect(booked(sell('\tAssets:Zerodha -30 INFY {1500} @ 2000')).disposals).toEqual([
			'13.0 sale -10.00 from 0 @ 2000.00',
			'13.0 sale -10.00 from 1 @ 2000.00',
			'13.0 sale -10.00 from nothing @ 2000.00',
		]);
	});

	it('reports a sale from a holding that names no lot', () => {
		expect(booked(sell('\tAssets:Zerodha -4 INFY @ 2000')).disposals).toEqual([
			'13.0 sale -4.00 from nothing @ 2000.00',
		]);
	});
});

describe('shorting', () => {
	it('opens a short selling what the account does not hold, and covers it by name', () => {
		const { lots, disposals } = booked([
			'2025-03-01 Short',
			'\tAssets:IBKR -4 INFY @ 1700',
			'\tAssets:Bank',
			'',
			'2025-04-01 Cover',
			'\tAssets:IBKR 4 INFY {1700} @ 1600',
			'\tAssets:Bank -6400',
			'\tIncome:Gains -400',
		]);
		expect(lots).toEqual(['0 Assets:IBKR -4.00 {1700.00, 2025-03-01} short left 0.00']);
		expect(disposals).toEqual(['5.0 cover 4.00 from 0 @ 1600.00']);
	});
});

describe('moving in kind', () => {
	it('moves the oldest lots to another account, with their date and cost', () => {
		const { lots, disposals } = booked([
			...buys,
			'2025-01-10 Move to Groww',
			'\tAssets:Zerodha -12 INFY',
			'\tAssets:Groww 12 INFY',
		]);
		expect(lots.slice(3)).toEqual([
			'3 Assets:Groww 10.00 {1500.00, 2024-01-02} transfer left 10.00 from 0',
			'4 Assets:Groww 2.00 {1500.00, 2024-06-03} transfer left 2.00 from 1',
		]);
		expect(disposals).toEqual(['13.0 transfer -10.00 from 0', '13.0 transfer -2.00 from 1']);
	});

	it('moves the lot it names', () => {
		const { lots } = booked([
			...buys,
			'2025-01-10 Move to Groww',
			'\tAssets:Zerodha -5 INFY {1800}',
			'\tAssets:Groww 5 INFY',
		]);
		expect(lots[3]).toBe('3 Assets:Groww 5.00 {1800.00, 2024-07-01} transfer left 5.00 from 2');
	});

	it('gives lots away to a category, with no price', () => {
		const { lots, disposals } = booked([
			...buys,
			'2025-01-10 Shares to sister',
			'\tAssets:Zerodha -4 INFY',
			'\tExpenses:Gifts 4 INFY',
		]);
		expect(lots).toHaveLength(3);
		expect(disposals).toEqual(['13.0 gift -4.00 from 0']);
	});

	it('reports moving more than is held', () => {
		expect(
			booked(['2025-01-10 Move', '\tAssets:Zerodha -4 INFY', '\tAssets:Groww 4 INFY']),
		).toEqual({
			lots: ['0 Assets:Groww 4.00 {0.00, 2025-01-10} unpriced left 4.00'],
			disposals: ['1.0 transfer -4.00 from nothing'],
		});
	});
});
