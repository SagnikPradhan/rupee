import { DEFAULT_COMMODITY, multiply, type Amount, type Quantity } from './types';

// At most two prices reach rupees: `AAPL` in `USD`, then `USD` in rupees.
const HOPS = 2;

/** Units held now in one account, and what its open lots cost in all, when that is one commodity. */
export type Holding = { account: string; commodity: string; units: Amount; cost: Quantity | null };

export const value = (h: Holding, prices: Record<string, Quantity>) => {
	const worth = inHome({ amount: h.units, commodity: h.commodity }, prices, HOPS);
	const paid = h.cost && inHome(h.cost, prices, HOPS);

	return {
		...h,
		price: prices[h.commodity] ?? null,
		value: worth,
		gain: worth === null || paid === null ? null : ((worth - paid) as Amount),
	};
};

// A sale or cover realises its price over the lot's cost, for every unit it takes.
export const realised = (u: Amount, p: Quantity | null, c: Quantity): Amount | null =>
	p === null || p.commodity !== c.commodity
		? null
		: multiply(-u as Amount, (p.amount - c.amount) as Amount);

// Every account holding something, and every account above one, in tree order.
export const accountTree = <H extends { account: string; value: Amount | null }>(holdings: H[]) =>
	[...new Set(holdings.flatMap((h) => ancestors(h.account)))].toSorted(bySegments).map((a) => {
		const within = holdings.filter((h) => h.account === a || h.account.startsWith(`${a}:`));
		return {
			account: a,
			depth: a.split(':').length - 1,
			holdings: within.filter((h) => h.account === a),
			total: within.reduce((t, h) => t + (h.value ?? 0n), 0n) as Amount,
			unpriced: within.filter((h) => h.value === null).length,
		};
	});

const inHome = (q: Quantity, prices: Record<string, Quantity>, hops: number): Amount | null => {
	if (q.commodity === DEFAULT_COMMODITY) return q.amount;

	const price = prices[q.commodity];
	const rate = price && hops > 0 ? inHome(price, prices, hops - 1) : null;
	return rate === null ? null : multiply(q.amount, rate);
};

const ancestors = (a: string) => a.split(':').map((_, i, s) => s.slice(0, i + 1).join(':'));

const bySegments = (a: string, b: string) => {
	const x = a.split(':');
	const y = b.split(':');
	const i = x.findIndex((s, j) => s !== y[j]);
	if (i === -1) return x.length - y.length;

	return (x[i] ?? '').localeCompare(y[i] ?? '');
};
