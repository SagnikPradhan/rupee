import { defaultConfiguration } from '#lib/server/shared/context/config.ts';
import { describe, expect, it } from 'vitest';
import { parse, parseAmount } from '#services/ledger/domain/parser.ts';
import { marketPrices } from '#services/ledger/domain/prices.ts';
import { PriceSource, type Amount } from '#services/ledger/domain/types.ts';

const pricesIn = (lines: string[]) => {
	const parsed = parse(defaultConfiguration.ledger, {
		key: 'a.rupee',
		content: `${lines.join('\n')}\n`,
	});
	return marketPrices({ metadata: {}, transactions: parsed.succeeded, prices: parsed.prices }).map(
		(p) => [p.source, p.date.toString(), p.commodity, p.price],
	);
};

const quantity = (amount: string, commodity = 'INR') => ({
	amount: parseAmount(amount) as Amount,
	commodity,
});

describe('market prices', () => {
	it('takes P lines and priced postings, each for one unit', () => {
		expect(
			pricesIn([
				'2026-10-01 Buy INFY',
				'\tAssets:Zerodha 10 INFY @ 1500',
				'\tAssets:Bank',
				'',
				'P 2026-10-17 INFY 1820',
			]),
		).toEqual([
			[PriceSource.Line, '2026-10-17', 'INFY', quantity('1820')],
			[PriceSource.Posting, '2026-10-01', 'INFY', quantity('1500')],
		]);
	});

	it('divides a total price by the units, whichever way they move', () => {
		expect(
			pricesIn(['2026-10-01 Sell AAPL', '\tAssets:IBKR -3 AAPL @@ 700 USD', '\tAssets:IBKR:Cash']),
		).toEqual([[PriceSource.Posting, '2026-10-01', 'AAPL', quantity('233.333333', 'USD')]]);
	});

	it('skips postings without a price', () => {
		expect(pricesIn(['2026-08-29 Groceries', '\tExpenses:Food 100', '\tAssets:Bank'])).toEqual([]);
	});
});
