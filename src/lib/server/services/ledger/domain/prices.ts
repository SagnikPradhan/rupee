import {
	AMOUNT_SCALE,
	PriceKind,
	PriceSource,
	type Amount,
	type Quantity,
	type RupeeLedgerFile,
	type RupeePosting,
} from './types';

// Every price a file writes, `P` lines and postings alike, each for one unit.
export const marketPrices = (file: RupeeLedgerFile) => [
	...file.prices.map((p) => ({ ...p, source: PriceSource.Line })),
	...file.transactions.flatMap((t) =>
		t.postings.flatMap((p) => {
			const price = unitPrice(p);
			return price
				? [
						{
							location: t.location,
							date: t.date,
							commodity: p.commodity,
							price,
							source: PriceSource.Posting,
						},
					]
				: [];
		}),
	),
];

export const unitPrice = (p: Pick<RupeePosting, 'amount' | 'price'>): Quantity | null => {
	if (p.price === null || p.amount === 0n) return null;
	if (p.price.kind === PriceKind.Unit)
		return { amount: p.price.amount, commodity: p.price.commodity };

	const units = (p.amount < 0n ? -p.amount : p.amount) as Amount;
	return { amount: divide(p.price.amount, units), commodity: p.price.commodity };
};

// Both are non-negative here; rounds half up, back to the amount scale.
const divide = (a: Amount, b: Amount): Amount =>
	((a * 10n ** BigInt(AMOUNT_SCALE) * 2n + b) / (2n * b)) as Amount;
