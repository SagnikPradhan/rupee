import type { LedgerConfiguration } from '#lib/server/shared/context/config.ts';
import { parseDate, parseTime, type ReadOptions } from '#lib/server/shared/dates.ts';
import { sha256 } from '#lib/server/shared/hash.ts';
import { batch, type Batch } from '#lib/server/shared/result/batch.ts';
import { fault, type RupeaError } from '#lib/server/shared/result/error.ts';
import { err, ok, type Result } from '#lib/server/shared/result/result.ts';
import { cursorOf, drain, putBack, takeWhile, type Cursor } from '#lib/server/shared/cursor.ts';
import { cut } from '#lib/server/shared/text.ts';
import { match, P } from 'ts-pattern';
import {
	DEFAULT_COMMODITY,
	formatQuantity,
	multiply,
	parseAmount,
	sum,
	type Amount,
	type Quantity,
} from './amounts';
import { movesInKind } from './lots';
import { linkOf, priceOf, toMetadata, transactionOf } from './nodes';
import { accountType } from './taxonomy';
import {
	Feed,
	NodeKind,
	PriceKind,
	type LotCost,
	type Price,
	type RupeaEntries,
	type RupeaEntryNode,
	type RupeaFailedNode,
	type RupeaFile,
	type RupeaFileNode,
	type RupeaLink,
	type RupeaMarketPrice,
	type RupeaMetadata,
	type RupeaNoteNode,
	type RupeaParseLocation,
	type RupeaPostingNode,
	type RupeaTransaction,
} from './types';

const COMMODITY = /^[A-Za-z][A-Za-z0-9._-]*$/;
const LINK = /\s(?<feed>[A-Za-z]+):(?<symbol>\S+)\s*$/;

/** The feeds a link can name; a ledger's own symbols are priced by its files, never linked. */
const LINKED: Record<string, Feed> = { mfapi: Feed.Mfapi, yahoo: Feed.Yahoo };

export const displayLocation = ({ file, line }: RupeaParseLocation): string => `${file}:${line}`;

type RupeaParsedFile = Batch<RupeaTransaction> & {
	metadata: RupeaMetadata;
	prices: RupeaMarketPrice[];
	links: RupeaLink[];
};

/** What a file holds for the ledger, read from its tree. */
export const parse = (
	c: LedgerConfiguration,
	f: Pick<RupeaFile, 'key' | 'content'>,
): RupeaParsedFile => parsedFrom(parseTree(c, f));

export type KeptEntry = { hash: string; line: number };

/** As parse, leaving out each transaction whose lines hash to one held, so only what changed is read. Formats go in the hash, as they decide what the same lines mean. */
export const parseChanged = (
	c: LedgerConfiguration,
	file: Pick<RupeaFile, 'key' | 'content'>,
	held: Record<string, number>,
) => {
	const formats = JSON.stringify([c.dateFormats, c.timeFormats]);
	const left = { ...held };
	const kept: KeptEntry[] = [];
	const hashes: Record<number, string> = {};

	const keep = (entry: RupeaLine[]) => {
		const hash = sha256(`${formats}\n${entry.map((l) => l.content).join('\n')}`);
		const line = entry[0]!.location.line;
		const count = left[hash] ?? 0;
		hashes[line] = hash;
		if (count === 0) return false;

		left[hash] = count - 1;
		kept.push({ hash, line });
		return true;
	};

	return { ...parsedFrom(readTree(c, file, keep)), kept, hashes };
};

const parsedFrom = (tree: RupeaFileNode): RupeaParsedFile => {
	const entries = tree.children;

	return {
		metadata: toMetadata(tree.metadata),
		prices: entries.flatMap((e) => (e.kind === NodeKind.Price ? [priceOf(e)] : [])),
		links: entries.flatMap((e) => (e.kind === NodeKind.Link ? [linkOf(e)] : [])),
		succeeded: entries.flatMap((e) => (e.kind === NodeKind.Transaction ? [transactionOf(e)] : [])),
		failed: entries.flatMap((e) => (e.kind === NodeKind.Failed ? e.errors : [])),
	};
};

/** Metadata above the first entry belongs to the file, and a comment to what sits right above it. */
export const parseTree = (
	c: LedgerConfiguration,
	f: Pick<RupeaFile, 'key' | 'content'>,
): RupeaFileNode => readTree(c, f, () => false);

/** Whether to leave out a transaction, given its lines. */
type Keep = (entry: RupeaLine[]) => boolean;

const readTree = (
	c: LedgerConfiguration,
	{ key, content }: Pick<RupeaFile, 'key' | 'content'>,
	keep: Keep,
): RupeaFileNode => {
	const input = cursorOf(lines(key, content));
	const top = readPreamble(input);

	return {
		kind: NodeKind.File,
		comments: top.comments,
		metadata: top.metadata,
		children: [...top.failed, ...readEntries(c, input, keep)],
	};
};

export type RupeaLine = { location: RupeaParseLocation; content: string };

export const lines = (file: string, content: string): RupeaLine[] =>
	content
		.split('\n')
		.slice(0, content.endsWith('\n') ? -1 : undefined)
		.map((text, index) => ({
			location: { file, line: index + 1 },
			content: text,
		}));

/** The file's own metadata, and the comments among it and right after it, before a blank line. */
const readPreamble = (input: Cursor<RupeaLine>) => {
	const taken = takeWhile(input, (l) => isBlank(l) || isMetadata(l) || isComment(l));
	const start = Math.max(
		taken.findLastIndex(isMetadata) + 1,
		taken.findIndex((l) => !isBlank(l)),
	);
	const end = taken.findIndex((l, i) => i >= start && !isComment(l));
	const head = taken.slice(0, end < 0 ? taken.length : end);
	putBack(input, taken.length - head.length);

	const metadata = head.filter(isMetadata).map((l) => ({ line: l, entry: parseMetadata(l) }));
	return {
		comments: head.filter(isComment).map(commentOf),
		metadata: metadata.flatMap(({ entry }) => (entry.isOk() ? [entry.value] : [])),
		failed: metadata.flatMap(({ line, entry }) =>
			entry.isErr() ? [failed([line], [], [entry.error])] : [],
		),
	};
};

/** Comments that nothing above holds stand as a note. */
const readEntries = (
	c: LedgerConfiguration,
	input: Cursor<RupeaLine>,
	keep: Keep,
): RupeaEntryNode[] => {
	const entries: RupeaEntryNode[] = [];

	for (const line of drain(input)) {
		if (isComment(line)) entries.push(note([line, ...takeWhile(input, isComment)]));
		if (!isComment(line) && !isBlank(line)) entries.push(...readNode(c, line, input, keep));
	}
	return entries;
};

/** A bad header ends the transactions, as the next one can't be found. */
const readNode = (
	c: LedgerConfiguration,
	line: RupeaLine,
	rest: Cursor<RupeaLine>,
	keep: Keep,
): RupeaEntryNode[] => {
	if (isPLine(line)) return [readPLine(c, line, commentsUnder(rest))];
	if (isMetadata(line)) return [failed([line], commentsUnder(rest), [detached(line)])];

	const body = bodyOf(rest);
	if (keep([line, ...body])) return [];

	const header = parseHeader(c, line);
	if (header.isErr()) {
		putBack(rest, body.length);
		return unread(c, line, rest, header.error);
	}

	return [readTransaction(c, { line, header: header.value, body })];
};

/** After a bad header only P lines are read; the lines between them are kept as written. */
const unread = (
	c: LedgerConfiguration,
	line: RupeaLine,
	input: Cursor<RupeaLine>,
	error: RupeaError,
): RupeaEntryNode[] => {
	const entries: RupeaEntryNode[] = [
		failed(trimBlank([line, ...takeWhile(input, (l) => !isPLine(l))]), [], [error]),
	];
	for (const line of drain(input)) {
		entries.push(readPLine(c, line, []));
		const between = trimBlank(takeWhile(input, (l) => !isPLine(l)));
		if (between.length > 0) entries.push(failed(between, [], []));
	}
	return entries;
};

/** The postings, metadata and comments under a header. */
const bodyOf = (r: Cursor<RupeaLine>): RupeaLine[] =>
	takeWhile(r, (l) => isPosting(l) || isMetadata(l) || isComment(l));

const commentsUnder = (r: Cursor<RupeaLine>): string[] => takeWhile(r, isComment).map(commentOf);

type TransactionLines = { line: RupeaLine; header: Header; body: RupeaLine[] };

/** A bad line fails its whole transaction, which is kept as written. */
const readTransaction = (
	c: LedgerConfiguration,
	{ line, header, body }: TransactionLines,
): RupeaEntryNode => {
	const [own, ...owners] = ownersOf(line, body);
	const metadata = readMetadata(own!.metadata);
	const postings = owners.map((o) => ({
		posting: readPosting(c, o.line).andThen((p) => checkAccount(o.line.location, p)),
		metadata: readMetadata(o.metadata),
		comments: o.comments,
	}));
	const errors = [
		...metadata.failed,
		...postings.flatMap(({ posting, metadata }) => [
			...(posting.isErr() ? [posting.error] : []),
			...metadata.failed,
		]),
	];
	const kept = (e: RupeaError[]) => failed([line, ...body], [], e);
	if (errors.length > 0) return kept(errors);

	const written = postings.flatMap(({ posting, metadata, comments }) =>
		posting.isOk() ? [{ posting: posting.value, metadata: metadata.entries, comments }] : [],
	);
	return balance(line.location, written).match(
		(children) => ({
			kind: NodeKind.Transaction,
			location: line.location,
			comments: own!.comments,
			...header,
			metadata: metadata.entries,
			children,
		}),
		(e) => kept([e]),
	);
};

type Owner = { line: RupeaLine; comments: string[]; metadata: RupeaLine[] };

/** The header and each posting with the comments and metadata under it. */
const ownersOf = (header: RupeaLine, body: RupeaLine[]): Owner[] => {
	const owners: Owner[] = [{ line: header, comments: [], metadata: [] }];

	for (const l of body) {
		const owner = owners.at(-1)!;
		if (isComment(l)) owner.comments.push(commentOf(l));
		if (isMetadata(l)) owner.metadata.push(l);
		if (isPosting(l)) owners.push({ line: l, comments: [], metadata: [] });
	}
	return owners;
};

const note = (comments: RupeaLine[]): RupeaNoteNode => ({
	kind: NodeKind.Note,
	comments: comments.map(commentOf),
	children: [],
});

const failed = (input: RupeaLine[], comments: string[], errors: RupeaError[]): RupeaFailedNode => ({
	kind: NodeKind.Failed,
	location: input[0]!.location,
	comments,
	lines: input.map((l) => l.content),
	errors,
	children: [],
});

const detached = (l: RupeaLine) =>
	fault('ParseDetachedMetadata', { location: displayLocation(l.location) });

/** A comment line without its indent, its semicolon and the space after it. */
const commentOf = ({ content }: RupeaLine) => content.trim().replace(/^; ?/, '');

const trimBlank = (l: RupeaLine[]) =>
	l.slice(
		Math.max(
			0,
			l.findIndex((x) => !isBlank(x)),
		),
		l.findLastIndex((x) => !isBlank(x)) + 1,
	);

type ReadMetadata = { entries: RupeaEntries; failed: RupeaError[] };

const readMetadata = (lines: RupeaLine[]): ReadMetadata => {
	const read = batch(lines.map(parseMetadata));
	return { entries: read.succeeded, failed: read.failed };
};

const parseMetadata = ({ location, content }: RupeaLine): Result<[string, string]> => {
	const entry = readEntry(content);
	return entry
		? ok([entry.key, entry.value])
		: err(fault('ParseInvalidMetadata', { location: displayLocation(location) }));
};

/** A metadata line, `- key: value`, with the indent before its dash. */
export const readEntry = (content: string) => {
	const body = content.trimStart();
	const [head, tail = ''] = cut(body.slice(1), ':');

	const key = head.trim();
	const value = tail.trim();
	const spaced = /^\s/.test(head) && /^\s/.test(tail);
	if (!body.startsWith('-') || !spaced || key === '' || /\s/.test(key) || value === '')
		return undefined;

	return { indent: content.slice(0, content.length - body.length), key, value };
};

export const isBlank = ({ content }: RupeaLine) => content.trim() === '';

export const isComment = ({ content }: RupeaLine) => content.trimStart().startsWith(';');

/** Indentation means nothing to a metadata line; the dash does. */
export const isMetadata = ({ content }: RupeaLine) => /^\s*-(\s|$)/.test(content);

/** Any indent makes a posting, as in Ledger and hledger, even the one space an editor carries over. */
export const isPosting = (l: RupeaLine) =>
	/^\s/.test(l.content) && !isBlank(l) && !isMetadata(l) && !isComment(l);

/** A P line prices a commodity, or links it to a feed. */
const isPLine = ({ content }: RupeaLine) => /^P\s/.test(content);
const readPLine = (c: LedgerConfiguration, l: RupeaLine, comments: string[]): RupeaEntryNode => {
	const unread = (e: RupeaError) => failed([l], comments, [e]);
	const link = readLink(c, l);
	if (link)
		return link.match((v) => ({ kind: NodeKind.Link, comments, ...v, children: [] }), unread);

	return parsePriceLine(c, l).match(
		(v) => ({ kind: NodeKind.Price, comments, ...v, children: [] }),
		unread,
	);
};

type Written = { posting: WrittenPosting; metadata: RupeaEntries; comments: string[] };

/** Each commodity nets to zero by weight; a posting without an amount takes what is left. */
const balance = (location: RupeaParseLocation, written: Written[]): Result<RupeaPostingNode[]> => {
	const at = { location: displayLocation(location) };
	if (written.length < 2) return err(fault('ParseMissingTransactionBody', at));

	const [implicit, ...others] = written.filter((w) => w.posting.quantity === null);
	if (others.length > 0) return err(fault('ParseMultipleImplicitPostings', at));

	const explicit = written.flatMap(({ posting: { quantity, ...p } }) =>
		quantity ? [{ ...p, ...quantity }] : [],
	);
	const weights = explicit.map((p) => weight(p, explicit));
	const leftover = Object.entries(Object.groupBy(weights, (w) => w.commodity))
		.map(([commodity, group = []]) => ({ commodity, amount: sum(group.map((w) => w.amount)) }))
		.filter((q) => q.amount !== 0n);
	const residual = leftover.map(formatQuantity).join(', ');
	const balanced = leftover.length === 0 || (implicit && leftover.length === 1);
	if (!balanced) return err(fault('ParseUnbalancedTransaction', { ...at, residual }));

	const left = leftover[0] ?? { amount: 0n as Amount, commodity: DEFAULT_COMMODITY };
	const implied = { ...left, amount: -left.amount as Amount };
	const asserted = implicit?.posting.balance?.commodity;
	if (asserted && asserted !== implied.commodity) return err(fault('ParseInvalidPosting', at));

	return ok(
		written.map(({ posting: { quantity, balance: assertion, ...p }, metadata, comments }) => ({
			kind: NodeKind.Posting,
			comments,
			...p,
			...(quantity ?? implied),
			elided: quantity === null,
			balance: assertion?.amount ?? null,
			metadata,
			children: [],
		})),
	);
};

type Weighed = { amount: Amount; commodity: string; price: Price | null; cost: LotCost | null };

/** Its lot cost, else its price, else itself; a lot cost moving in kind only picks lots. */
const weight = (p: Weighed, transaction: Weighed[]): Quantity => {
	const units = transaction.filter((t) => t.commodity === p.commodity).map((t) => t.amount);
	if (p.cost !== null && !movesInKind(units))
		return { amount: multiply(p.amount, p.cost.amount), commodity: p.cost.commodity };
	if (p.price === null) return { amount: p.amount, commodity: p.commodity };
	if (p.price.kind === PriceKind.Total)
		return {
			amount: (p.amount < 0n ? -p.price.amount : p.price.amount) as Amount,
			commodity: p.price.commodity,
		};

	return { amount: multiply(p.amount, p.price.amount), commodity: p.price.commodity };
};

type Header = { date: Temporal.PlainDate; time: Temporal.PlainTime | null; description: string };

const parseHeader = (
	{ dateFormats, timeFormats }: LedgerConfiguration,
	{ location, content }: RupeaLine,
): Result<Header> => {
	const words = content.trim().split(/\s+/);
	const date = readWords(dateFormats, words, parseDate);
	const time = date ? readWords(timeFormats, date.rest, parseTime) : undefined;
	const description = (time ?? date)?.rest.join(' ');
	return date && description
		? ok({ date: date.value, time: time?.value ?? null, description })
		: err(fault('ParseInvalidTransactionHeader', { location: displayLocation(location) }));
};

const readWords = <T>(
	formats: string[],
	words: string[],
	read: (options: ReadOptions) => T | null,
): { value: T; rest: string[] } | undefined =>
	formats
		.flatMap((format) => {
			const length = format.trim().split(/\s+/).length;
			const value = read({ format, text: words.slice(0, length).join(' ') });
			return value === null ? [] : [{ value, rest: words.slice(length) }];
		})
		.sort((a, b) => a.rest.length - b.rest.length)
		.at(0);

/** P date commodity price [commodity], as ledger writes it. */
const parsePriceLine = (
	{ dateFormats }: LedgerConfiguration,
	{ location, content }: RupeaLine,
): Result<RupeaMarketPrice> => {
	const date = readWords(dateFormats, content.trim().split(/\s+/).slice(1), parseDate);
	const [commodity = '', ...price] = date?.rest ?? [];
	const quantity = readQuantity(price.join(' '));
	if (!date || !COMMODITY.test(commodity) || !quantity || quantity.amount < 0n)
		return err(fault('ParseInvalidPrice', { location: displayLocation(location) }));

	return ok({
		location,
		date: date.value,
		commodity: commodity.toUpperCase(),
		price: withDefaultCommodity(quantity),
	});
};

/**
 * P date|* commodity feed:symbol, where * links it from the start. Any other P line is a price,
 * so a line that only ends in a word with a colon is a bad price. Feeds spell symbols in capitals.
 */
const readLink = (
	{ dateFormats }: LedgerConfiguration,
	{ location, content }: RupeaLine,
): Result<RupeaLink> | null => {
	const { feed = '', symbol = '' } = LINK.exec(content)?.groups ?? {};
	if (!symbol) return null;

	const words = content.trim().split(/\s+/).slice(1, -1);
	const since =
		words[0] === '*'
			? { value: null, rest: words.slice(1) }
			: readWords(dateFormats, words, parseDate);
	const [commodity = '', ...extra] = since?.rest ?? [];
	if (!since || !COMMODITY.test(commodity) || extra.length > 0) return null;

	const linked = LINKED[feed.toLowerCase()];
	if (!linked) return err(fault('ParseUnknownFeed', { location: displayLocation(location), feed }));
	return ok({
		location,
		since: since.value,
		commodity: commodity.toUpperCase(),
		feed: linked,
		symbol: symbol.toUpperCase(),
	});
};

type WrittenPosting = {
	account: string;
	quantity: Quantity | null;
	price: Price | null;
	cost: LotCost | null;
	balance: WrittenQuantity | null;
};

/** Account [amount [commodity] [{lot cost}] [@ price | @@ total]] [= balance] */
const readPosting = (
	{ dateFormats }: LedgerConfiguration,
	{ location, content }: RupeaLine,
): Result<WrittenPosting> => {
	const invalid = err(fault('ParseInvalidPosting', { location: displayLocation(location) }));
	const parts = splitPosting(content);
	if (!parts) return invalid;

	const units = readQuantity(parts.amount);
	const cost = readLotCost(dateFormats, parts.lot);
	const paid = readQuantity(parts.price);
	const asserted = readQuantity(parts.balance);
	if (units === undefined || cost === undefined || paid === undefined || asserted === undefined)
		return invalid;
	if (paid && paid.amount < 0n) return invalid;

	const quantity = units ? withDefaultCommodity(units) : null;
	const assertsOther =
		quantity !== null && (asserted?.commodity ?? quantity.commodity) !== quantity.commodity;
	if (assertsOther) return invalid;

	return ok({
		account: parts.account,
		quantity,
		price: paid
			? {
					...withDefaultCommodity(paid),
					kind: parts.total ? PriceKind.Total : PriceKind.Unit,
				}
			: null,
		cost,
		balance: asserted,
	});
};

type PostingParts = {
	account: string;
	amount: string | undefined;
	lot: string | undefined;
	price: string | undefined;
	total: boolean;
	balance: string | undefined;
};

/** Cuts a posting at its marks from the right: `=` for a balance, `@` for a price, `{` for a lot. */
const splitPosting = (content: string): PostingParts | undefined => {
	const [head, balance] = cut(content, '=');
	const [held, priced] = cut(head, '@');
	const [written, opened] = cut(held, '{');
	const [lot, trailing] = opened === undefined ? [] : cut(opened, '}');

	const [account = '', ...words] = written.trim().split(/\s+/);
	const amount = words.length ? words.join(' ') : undefined;
	const total = priced?.startsWith('@') ?? false;
	const price = total ? priced?.slice(1) : priced;

	const closed = opened === undefined || trailing?.trim() === '';
	const valued = amount !== undefined || (lot === undefined && price === undefined);
	if (account === '' || !closed || !valued || price?.includes('@')) return undefined;

	return { account, amount, lot, price, total, balance };
};

const checkAccount = (
	location: RupeaParseLocation,
	posting: WrittenPosting,
): Result<WrittenPosting> => {
	if (accountType(posting.account)) return ok(posting);

	return err(
		fault('ParseInvalidAccount', {
			location: displayLocation(location),
			account: posting.account,
		}),
	);
};

/** cost [commodity][, date], the date in a configured format. */
const readLotCost = (formats: string[], text: string | undefined): LotCost | null | undefined => {
	if (text === undefined) return null;

	const trimmed = text.trim();
	const at = trimmed.search(/,\s/);
	const written = at < 0 ? trimmed : trimmed.slice(0, at);
	const day = at < 0 ? undefined : trimmed.slice(at + 1);
	const cost = readQuantity(written);
	const date = readDate(formats, day);
	if (!cost || cost.amount < 0n || date === undefined) return undefined;

	return { ...withDefaultCommodity(cost), date };
};

const readDate = (
	formats: string[],
	text: string | undefined,
): Temporal.PlainDate | null | undefined => {
	if (text === undefined) return null;

	const date = readWords(formats, text.trim().split(/\s+/), parseDate);
	return date?.rest.length === 0 ? date.value : undefined;
};

/** A commodity left out means the home one for an amount, the posting's own for a balance. */
type WrittenQuantity = { amount: Amount; commodity: string | null };
/** An amount and optionally its commodity; null without text, undefined if it is neither. */
const readQuantity = (text: string | undefined): WrittenQuantity | null | undefined => {
	if (text === undefined) return null;

	return match(text.split(/\s+/).filter(Boolean))
		.with([P.string], [P.string, P.string.regex(COMMODITY)], ([amount, commodity]) => {
			const parsed = parseAmount(amount);
			return parsed === null
				? undefined
				: { amount: parsed, commodity: commodity?.toUpperCase() ?? null };
		})
		.otherwise(() => undefined);
};

const withDefaultCommodity = (q: WrittenQuantity): Quantity => ({
	amount: q.amount,
	commodity: q.commodity ?? DEFAULT_COMMODITY,
});
