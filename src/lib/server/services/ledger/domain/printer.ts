import type { LedgerConfiguration } from '#lib/server/shared/context/config.ts';
import * as dateFns from 'date-fns';
import {
	formatQuantity,
	PriceKind,
	type RupeeLedgerFile,
	type RupeeMarketPrice,
	type RupeeMetadata,
	type RupeePosting,
	type RupeeTransaction,
} from './types';

export const PRICE_SIGN: Record<PriceKind, string> = {
	[PriceKind.Unit]: '@',
	[PriceKind.Total]: '@@',
};

export const print = (c: LedgerConfiguration, file: RupeeLedgerFile): string =>
	[
		printMetadata('', file.metadata),
		...file.transactions.map((t) => printTransaction(c, t)),
		file.prices.map((p) => printPrice(c, p)).join(''),
	]
		.filter(Boolean)
		.join('\n');

// A single outgoing posting leaves its amount out; it is whatever balances.
// With prices or several commodities every amount is spelled out.
const printTransaction = (
	{ dateFormats, timeFormats }: LedgerConfiguration,
	{ date, time, description, metadata, postings }: RupeeTransaction,
): string => {
	const header = [
		printDate(dateFormats[0], date),
		...(time ? [printTime(timeFormats[0], time)] : []),
		description,
	].join(' ');

	const outgoing = postings.filter((p) => p.amount < 0n);
	const plain = postings.every((p) => p.price === null && p.commodity === postings[0]?.commodity);
	const elided = plain && outgoing.length === 1 ? outgoing[0] : undefined;

	return [
		`${header}\n`,
		printMetadata('\t', metadata),
		...postings.map((p) => printPosting(p, p === elided)),
	].join('');
};

// Posting metadata sits a level deeper only for the reader; the parser ignores indentation.
const printPosting = (p: RupeePosting, elided: boolean): string => {
	const line = [
		p.account,
		...(elided ? [] : [formatQuantity(p)]),
		...(p.price === null ? [] : [PRICE_SIGN[p.price.kind], formatQuantity(p.price)]),
		...(p.balance === null
			? []
			: ['=', formatQuantity({ amount: p.balance, commodity: p.commodity })]),
	].join(' ');
	return `\t${line}\n${printMetadata('\t\t', p.metadata)}`;
};

const printPrice = ({ dateFormats }: LedgerConfiguration, p: RupeeMarketPrice): string =>
	`P ${printDate(dateFormats[0], p.date)} ${p.commodity} ${formatQuantity(p.price)}\n`;

const printMetadata = (t: string, m: RupeeMetadata): string =>
	Object.entries(m)
		.flatMap(([key, values]) => values.map((v) => `${t}- ${key}: ${v}\n`))
		.join('');

const printDate = (f: string | undefined, d: Temporal.PlainDate) =>
	f ? dateFns.format(new Date(d.year, d.month - 1, d.day), f) : d.toString();

const printTime = (f: string | undefined, t: Temporal.PlainTime) =>
	f ? dateFns.format(new Date(1970, 0, 1, t.hour, t.minute, t.second), f) : t.toString();

export type PostingView = { account: string; amount: string; price: string | null };

export type TransactionView = {
	file: string;
	line: number;
	date: string;
	time: string | null;
	description: string;
	postings: PostingView[];
};

// For reading, not for writing back: amounts as text, the time to the minute.
export const viewTransaction = (t: RupeeTransaction): TransactionView => ({
	file: t.location.file,
	line: t.location.line,
	date: t.date.toString(),
	time: t.time?.toString({ smallestUnit: 'minute' }) ?? null,
	description: t.description,
	postings: t.postings.map(viewPosting),
});

const viewPosting = (p: RupeePosting): PostingView => ({
	account: p.account,
	amount: formatQuantity(p),
	price: p.price === null ? null : `${PRICE_SIGN[p.price.kind]} ${formatQuantity(p.price)}`,
});
