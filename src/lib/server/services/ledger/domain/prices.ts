import {
	divide,
	PriceKind,
	PriceSource,
	type Amount,
	type Price,
	type Quantity,
	type RupeeLedgerFile,
	type RupeeTransaction,
} from './types';

// Every price a file writes, `P` lines and postings alike, each for one unit.
export const marketPrices = (file: RupeeLedgerFile) => [
	...file.prices.map((p) => ({ ...p, source: PriceSource.Line })),
	...file.transactions.flatMap(postingPrices),
];

export const unitPrice = (p: { amount: Amount; price: Price | null }): Quantity | null => {
	if (p.price === null || p.amount === 0n) return null;
	if (p.price.kind === PriceKind.Unit)
		return { amount: p.price.amount, commodity: p.price.commodity };

	const units = (p.amount < 0n ? -p.amount : p.amount) as Amount;
	return { amount: divide(p.price.amount, units), commodity: p.price.commodity };
};

const postingPrices = (t: RupeeTransaction) =>
	t.postings.flatMap((p) => {
		const price = unitPrice(p);
		if (price === null) return [];

		const at = { location: t.location, date: t.date, commodity: p.commodity };
		return [{ ...at, price, source: PriceSource.Posting }];
	});
