import { describe, expect, it } from 'vitest';
import { accountTree, value } from '#services/ledger/domain/holdings.ts';
import { parseAmount } from '#services/ledger/domain/parser.ts';
import type { Amount, Quantity } from '#services/ledger/domain/types.ts';

const amount = (text: string) => parseAmount(text) ?? (0n as Amount);
const quantity = (text: string, commodity = 'INR'): Quantity => ({
	amount: amount(text),
	commodity,
});

const holding = (account: string, units: string, commodity: string, cost: Quantity | null) => ({
	account,
	commodity,
	units: amount(units),
	cost,
});

const prices = { INFY: quantity('1800'), AAPL: quantity('250', 'USD'), USD: quantity('85') };

describe('value', () => {
	it('values units at their price, and the gain over what they cost', () => {
		expect(value(holding('Assets:Zerodha', '10', 'INFY', quantity('15000')), prices)).toMatchObject(
			{
				price: quantity('1800'),
				value: amount('18000'),
				gain: amount('3000'),
			},
		);
	});

	it('follows a price in another commodity to rupees', () => {
		expect(
			value(holding('Assets:IBKR', '2', 'AAPL', quantity('400', 'USD')), prices),
		).toMatchObject({ value: amount('42500'), gain: amount('8500') });
	});

	it('leaves what has no price unvalued', () => {
		expect(value(holding('Assets:Zerodha', '3', 'TCS', quantity('9000')), prices)).toMatchObject({
			price: null,
			value: null,
			gain: null,
		});
	});

	it('values rupees as themselves, with no gain', () => {
		expect(value(holding('Assets:Bank', '500', 'INR', null), prices)).toMatchObject({
			value: amount('500'),
			gain: null,
		});
	});
});

describe('accountTree', () => {
	const valued = (account: string, worth: Amount | null) => ({ account, value: worth });

	it('lists every account above a holding, in tree order, with totals', () => {
		const tree = accountTree([
			valued('Assets:Zerodha', amount('18000')),
			valued('Assets:Bank-2', amount('100')),
			valued('Assets:Bank:Savings', amount('500')),
			valued('Assets:Zerodha', null),
		]);

		expect(tree.map((a) => [a.account, a.depth, a.total, a.unpriced])).toEqual([
			['Assets', 0, amount('18600'), 1],
			['Assets:Bank', 1, amount('500'), 0],
			['Assets:Bank:Savings', 2, amount('500'), 0],
			['Assets:Bank-2', 1, amount('100'), 0],
			['Assets:Zerodha', 1, amount('18000'), 1],
		]);
	});
});
