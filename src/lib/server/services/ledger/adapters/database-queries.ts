import { sql, type Expression, type SqlBool } from 'kysely';
import { literalLike } from '#lib/server/db/index.ts';
import type { Span } from '#lib/shared/dates.ts';
import { AMOUNT_UNIT, type Amount, type Quantity } from '../domain/amounts';
import type { LotCost, Price, PriceKind } from '../domain/types';
import type { Position } from './database-files';

const LISTED = ['date', 'sortTime', 'id'];

/** Where a transaction falls among its ledger's, newest last, as a tuple a cursor compares with; more columns break ties. */
export const listingKey = (t: string, ...ties: Expression<unknown>[]) =>
	sql`(${sql.join([...LISTED.map((c) => column(t, c)), ...ties])})`;

/** Transactions newest first, as a page reads transactions_ledger_id_order backwards. */
export const newestFirst = (t: string) => sql.join(LISTED.map((c) => sql`${column(t, c)} desc`));

/** The order a ledger's postings happen in: by day, by time with none first, then by file and line. */
export const ledgerOrder = (t: string, f: string) =>
	sql.join([
		column(t, 'date'),
		sql`${column(t, 'time')} nulls first`,
		column(f, 'key'),
		column(t, 'line'),
	]);

/** An amount times a price per unit, rounded to a ten-billionth as the domain's multiply is. */
export const multiply = (a: Expression<unknown>, b: Expression<unknown>) =>
	sql<bigint>`round(${a} * ${b} / ${sql.lit(AMOUNT_UNIT)})`;

/** This account or any under it, ignoring case, so it reads through accounts_ledger_id_lower_name; every account when there is none. */
export const underAccount = (c: Expression<string>, a: string | null) =>
	a !== null
		? sql<SqlBool>`(lower(${c}) = lower(${a}) or lower(${c}) like lower(${literalLike(a)}) || ':%')`
		: sql<SqlBool>`true`;

/** One of these accounts holding its commodity; every position when there are none to name. */
export const amongPositions = (
	a: Expression<string>,
	c: Expression<string>,
	ps: Position[] | null,
) =>
	ps
		? sql<SqlBool>`(${a}, ${c}) in (select * from unnest(${ps.map((p) => p.accountId)}::uuid[], ${ps.map((p) => p.commodity)}::text[]))`
		: sql<SqlBool>`true`;

type PriceColumns = {
	priceAmount: bigint | null;
	priceCommodity: string | null;
	priceKind: PriceKind | null;
};

export const toPrice = ({ priceAmount, priceCommodity, priceKind }: PriceColumns): Price | null =>
	priceAmount === null || priceCommodity === null || priceKind === null
		? null
		: {
				amount: priceAmount as Amount,
				commodity: priceCommodity,
				kind: priceKind,
			};

type CostColumns = {
	costAmount: bigint | null;
	costCommodity: string | null;
	costDate: string | null;
};

export const toCost = ({ costAmount, costCommodity, costDate }: CostColumns): LotCost | null =>
	costAmount === null || costCommodity === null
		? null
		: {
				amount: costAmount as Amount,
				commodity: costCommodity,
				date: costDate === null ? null : Temporal.PlainDate.from(costDate),
			};

type QuantityColumns = { amount: bigint | null; commodity: string | null };

export const toQuantity = ({ amount, commodity }: QuantityColumns): Quantity | null =>
	amount === null || commodity === null ? null : { amount: amount as Amount, commodity };

type SpanColumns = { from: string | null; to: string | null };

/** The first and last day of some rows, or none when there were no rows. */
export const toSpans = ({ from, to }: SpanColumns): Span[] =>
	from === null || to === null
		? []
		: [{ from: Temporal.PlainDate.from(from), to: Temporal.PlainDate.from(to) }];

const column = (t: string, c: string) => sql.ref(`${t}.${c}`);
