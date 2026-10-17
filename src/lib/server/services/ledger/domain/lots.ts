import { unitPrice } from './prices';
import {
	DEFAULT_COMMODITY,
	DisposalKind,
	LotOrigin,
	min,
	multiply,
	sum,
	type Amount,
	type LotCost,
	type Price,
	type Quantity,
} from './types';

const LONG = 1n;
const SHORT = -1n;

const UNPRICED: Quantity = { amount: 0n as Amount, commodity: DEFAULT_COMMODITY };

/** A posting in the commodity being booked, in ledger order; `held` when its account is a balance account. */
export type BookedPosting = {
	id: string;
	transaction: string;
	account: string;
	held: boolean;
	date: Temporal.PlainDate;
	amount: Amount;
	price: Price | null;
	cost: LotCost | null;
};

/** `key` stands in for an id until the lot is stored; `source` is the key of the lot a transfer moved. */
export type Lot = {
	key: number;
	posting: string;
	source: number | null;
	account: string;
	origin: LotOrigin;
	date: Temporal.PlainDate;
	units: Amount;
	remaining: Amount;
	cost: Quantity;
};

/** `lot` is null for units no open lot covers; `units` is what the lot changes by. */
export type Disposal = {
	lot: number | null;
	posting: string;
	kind: DisposalKind;
	units: Amount;
	price: Quantity | null;
};

export type Booking = { lots: Lot[]; disposals: Disposal[] };

type Piece = { lot: Lot; units: Amount };

export const book = (postings: BookedPosting[]): Booking => {
	const booking: Booking = { lots: [], disposals: [] };
	for (const group of Map.groupBy(postings, (p) => p.transaction).values())
		bookTransaction(booking, group);

	return booking;
};

// A sale or cover realises its price over the lot's cost, for every unit it takes.
export const realised = (units: Amount, price: Quantity | null, cost: Quantity): Quantity | null =>
	price === null || price.commodity !== cost.commodity
		? null
		: {
				amount: multiply(-units as Amount, (price.amount - cost.amount) as Amount),
				commodity: cost.commodity,
			};

// Units leave before any arrive, so the lots a transfer moves are there to receive.
const bookTransaction = (b: Booking, group: BookedPosting[]) => {
	const held = group.filter((p) => p.held);
	const transfer = held.some((p) => p.amount > 0n && movesInKind(p) && inKind(p, group));

	const moved = held
		.filter((p) => p.amount < 0n)
		.flatMap((p) => takeOut(b, p, !inKind(p, group), transfer));
	for (const p of held.filter((q) => q.amount > 0n)) takeIn(b, p, moved);
};

// A sale names its lot; a transfer or gift may, and takes the oldest otherwise.
const takeOut = (b: Booking, p: BookedPosting, traded: boolean, transfer: boolean): Piece[] => {
	if (traded && p.cost === null) return sellUnnamed(b, p);

	const moved = transfer ? DisposalKind.Transfer : DisposalKind.Gift;
	const disposal = traded ? DisposalKind.Sale : moved;
	const pieces = take(open(b.lots, p.account, LONG, p.cost), -p.amount as Amount, LONG);
	dispose(b, p, disposal, pieces);

	return disposal === DisposalKind.Transfer ? pieces : [];
};

// Selling what the account does not hold opens a short.
const sellUnnamed = (b: Booking, p: BookedPosting): Piece[] => {
	const holding = open(b.lots, p.account, LONG, null).length > 0;
	if (holding) dispose(b, p, DisposalKind.Sale, []);
	if (!holding) openLot(b, p, { origin: LotOrigin.Short, units: p.amount, cost: costOf(p) });

	return [];
};

// A buy covering a short names its lot like a sale.
const takeIn = (b: Booking, p: BookedPosting, moved: Piece[]) => {
	if (p.cost !== null) {
		dispose(
			b,
			p,
			DisposalKind.Cover,
			take(open(b.lots, p.account, SHORT, p.cost), p.amount, SHORT),
		);
		return;
	}
	if (p.price !== null) {
		openLot(b, p, { origin: LotOrigin.Buy, units: p.amount, cost: costOf(p) });
		return;
	}

	receive(b, p, moved);
};

// A transfer's lots arrive with their date and cost; units from nowhere tracked cost nothing.
const receive = (b: Booking, p: BookedPosting, moved: Piece[]) => {
	const received: Amount[] = [];
	for (const piece of moved) {
		const units = min(piece.units, (p.amount - sum(received)) as Amount);
		if (units === 0n) break;

		const source = piece.lot;
		openLot(b, p, {
			origin: LotOrigin.Transfer,
			date: source.date,
			units,
			cost: source.cost,
			source: source.key,
		});
		received.push(units);
		piece.units = (piece.units - units) as Amount;
	}
	moved.splice(0, moved.length, ...moved.filter((m) => m.units > 0n));

	const rest = (p.amount - sum(received)) as Amount;
	if (rest > 0n) openLot(b, p, { origin: LotOrigin.Unpriced, units: rest, cost: UNPRICED });
};

// Units no open lot covers are disposed of from no lot, which reports them.
const dispose = (b: Booking, p: BookedPosting, kind: DisposalKind, pieces: Piece[]) => {
	const sign = p.amount < 0n ? -1n : 1n;
	const price = kind === DisposalKind.Sale || kind === DisposalKind.Cover ? unitPrice(p) : null;
	const rest = (sign * p.amount - sum(pieces.map((c) => c.units))) as Amount;

	b.disposals.push(
		...pieces.map((c) => ({
			lot: c.lot.key,
			posting: p.id,
			kind,
			units: (sign * c.units) as Amount,
			price,
		})),
		...(rest > 0n
			? [{ lot: null, posting: p.id, kind, units: (sign * rest) as Amount, price }]
			: []),
	);
};

type Opening = {
	origin: LotOrigin;
	units: Amount;
	cost: Quantity;
	date?: Temporal.PlainDate;
	source?: number;
};

// A lot opens on its posting's day, from no other lot, unless a transfer brought it.
const openLot = (b: Booking, p: BookedPosting, o: Opening) =>
	b.lots.push({
		date: p.date,
		source: null,
		...o,
		key: b.lots.length,
		posting: p.id,
		account: p.account,
		remaining: o.units,
	});

// Takes units from each lot in turn, oldest first, until it has them all.
const take = (lots: Lot[], units: Amount, side: bigint): Piece[] =>
	lots.reduce<Piece[]>((pieces, lot) => {
		const taken = min(
			(units - sum(pieces.map((c) => c.units))) as Amount,
			(lot.remaining * side) as Amount,
		);
		if (taken === 0n) return pieces;

		lot.remaining = (lot.remaining - side * taken) as Amount;
		return [...pieces, { lot, units: taken }];
	}, []);

const open = (lots: Lot[], account: string, side: bigint, cost: LotCost | null): Lot[] =>
	lots
		.filter(
			(l) => l.account === account && l.remaining * side > 0n && (cost === null || names(cost, l)),
		)
		.toSorted((a, b) => Temporal.PlainDate.compare(a.date, b.date) || a.key - b.key);

const names = (c: LotCost, l: Lot) =>
	c.amount === l.cost.amount &&
	c.commodity === l.cost.commodity &&
	(c.date === null || c.date.equals(l.date));

// The other side of a transaction moving the same commodity, not trading it.
const inKind = (p: BookedPosting, g: BookedPosting[]) =>
	g.some((q) => q !== p && q.amount * p.amount < 0n && movesInKind(q));

const movesInKind = (p: BookedPosting) => p.price === null && (p.amount < 0n || p.cost === null);

const costOf = (p: BookedPosting): Quantity => unitPrice(p) ?? UNPRICED;
