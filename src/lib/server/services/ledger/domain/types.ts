import {
	AccountType,
	DisposalKind,
	LotOrigin,
	PriceKind,
	PriceSource,
} from '#lib/server/db/schema.ts';

export { AccountType, DisposalKind, LotOrigin, PriceKind, PriceSource };

// `owner` is the user whose storage holds the ledger.
export type Ledger = { id: string; handle: string; name: string; owner: string };

export type RupeeFile = {
	key: string;
	size: number;
	modified: Date;
	version: string;
	content: string;
};

export const AMOUNT_SCALE = 6;

// Millionths of a unit (`1250.5` is `1_250_500_000n`); only `parseAmount` makes one.
export type Amount = bigint & { readonly brand: unique symbol };

export type RupeeParseLocation = { file: string; line: number };

// A repeated key collects its values in the order they were written.
export type RupeeMetadata = Record<string, string[]>;

export const toMetadata = (entries: [string, string][]): RupeeMetadata =>
	Object.fromEntries(
		Object.entries(Object.groupBy(entries, ([key]) => key)).map(([key, group = []]) => [
			key,
			group.map(([, value]) => value),
		]),
	);

// What a bare amount is in.
export const DEFAULT_COMMODITY = 'INR';

/** ISO 4217 codes, which are held as money rather than in lots. */
export const CURRENCIES = Intl.supportedValuesOf('currency');

export type Quantity = { amount: Amount; commodity: string };
export type Price = Quantity & { kind: PriceKind };
// Names a lot by what one unit cost, and the day it was bought when the cost alone is ambiguous.
export type LotCost = Quantity & { date: Temporal.PlainDate | null };

export type RupeePosting = {
	account: string;
	amount: Amount;
	commodity: string;
	price: Price | null;
	cost: LotCost | null;
	// What the account holds of the posting's commodity after it, if the file asserts it.
	balance: Amount | null;
	metadata: RupeeMetadata;
};

export type RupeeTransaction = {
	location: RupeeParseLocation;
	date: Temporal.PlainDate;
	time: Temporal.PlainTime | null;
	description: string;
	metadata: RupeeMetadata;
	postings: RupeePosting[];
};

export type RupeeMarketPrice = {
	location: RupeeParseLocation;
	date: Temporal.PlainDate;
	commodity: string;
	price: Quantity;
};

export type RupeeLedgerFile = {
	metadata: RupeeMetadata;
	transactions: RupeeTransaction[];
	prices: RupeeMarketPrice[];
};

export const formatAmount = (amount: Amount): string => {
	const digits = (amount < 0n ? -amount : amount).toString().padStart(AMOUNT_SCALE + 1, '0');
	const whole = digits.slice(0, -AMOUNT_SCALE);
	const fraction = digits.slice(-AMOUNT_SCALE).replace(/0+$/, '').padEnd(2, '0');
	return `${amount < 0n ? '-' : ''}${whole}.${fraction}`;
};

export const formatQuantity = ({ amount, commodity }: Quantity): string =>
	commodity === DEFAULT_COMMODITY ? formatAmount(amount) : `${formatAmount(amount)} ${commodity}`;

// What a posting weighs in balancing: its lot cost, else its price, else itself.
export const weight = (
	p: Pick<RupeePosting, 'amount' | 'commodity' | 'price' | 'cost'>,
): Quantity => {
	if (p.cost !== null)
		return { amount: multiply(p.amount, p.cost.amount), commodity: p.cost.commodity };
	if (p.price === null) return { amount: p.amount, commodity: p.commodity };
	if (p.price.kind === PriceKind.Total)
		return {
			amount: (p.amount < 0n ? -p.price.amount : p.price.amount) as Amount,
			commodity: p.price.commodity,
		};

	return { amount: multiply(p.amount, p.price.amount), commodity: p.price.commodity };
};

// Rounds half away from zero, back to the amount scale.
export const multiply = (a: Amount, b: Amount): Amount => {
	const scale = 10n ** BigInt(AMOUNT_SCALE);
	const product = a * b;
	const half = (product < 0n ? -scale : scale) / 2n;
	return ((product + half) / scale) as Amount;
};

export const accountType = (a: string): AccountType | null =>
	Object.values(AccountType).find((r) => r === a.split(':')[0]) ?? null;
