import type { LedgerConfiguration } from '#lib/server/shared/context/config.ts';
import { withContext } from '#lib/server/shared/context/context.ts';
import { fault, type RupeeError } from '#lib/server/shared/result/error.ts';
import {
	err,
	errAsync,
	ok,
	okAsync,
	type Result,
	ResultAsync,
	sequence,
} from '#lib/server/shared/result/result.ts';
import { type Batch, batch } from '#lib/server/shared/result/batch.ts';
import { petName } from '#lib/server/shared/names.ts';
import { scoped, type Storage } from '#lib/server/shared/storage/storage.ts';
import { ensureStorage, withStorage } from '#services/storage/application/storage.ts';
import {
	findLedger,
	findLedgers,
	index,
	insertLedger,
	type BalanceCheck,
	type CandidatePair,
	type IndexedTransaction,
} from '../adapters/database';
import { files, type Files } from '../adapters/storage';
import { checkEvents, EventRole, linksOf } from '../domain/events';
import { insertLinks, rewriteLinks, type LinkEdit, type Relink } from '../domain/links';
import { displayLocation, parse } from '../domain/parser';
import { indexedVersion, plan } from '../domain/sync';
import {
	formatQuantity,
	type Ledger,
	type RupeeFile,
	type RupeeTransaction,
} from '../domain/types';

export type { IndexedTransaction, Ledger, LinkEdit };

// A random handle clashes rarely enough that a few tries settle it.
const TRIES = 5;

type WithLedgerOptions<T> = {
	user: string;
	handle: string;
	action: (ledger: Ledger) => Result<T> | ResultAsync<T>;
};

// The one place that decides whether a user may reach a ledger.
export const withLedger = <T>(o: WithLedgerOptions<T>): ResultAsync<T> =>
	findLedger(o.user, o.handle).andThen(o.action);

export const listLedgers = (u: string): ResultAsync<Ledger[]> => findLedgers(u);

type CreateLedgerOptions = {
	user: string;
	name: string;
};

export const createLedger = (o: CreateLedgerOptions): ResultAsync<Ledger> =>
	ensureStorage(o.user).andThen((s) => insertNamed({ ...o, storage: s.id }, TRIES));

const insertNamed = (
	o: CreateLedgerOptions & { storage: string },
	n: number,
): ResultAsync<Ledger> =>
	insertLedger({ ...o, owner: o.user, handle: petName() }).orElse((e) =>
		e.type === 'NameTaken' && n > 1 ? insertNamed(o, n - 1) : errAsync(e),
	);

type Folder = 'files' | 'statements' | 'schemas';

/** One of a ledger's folders in its owner's storage, for a caller that reached the ledger through `withLedger`. */
export const openFolder = (l: Ledger, f: Folder): ResultAsync<Storage> =>
	withStorage({ user: l.owner, action: (s) => ok(scoped(s, `ledgers/${l.handle}/${f}`)) });

const ledgerFiles = (l: Ledger): ResultAsync<Files> => openFolder(l, 'files').map(files);

const indexFile = (ledgerId: string, file: RupeeFile): ResultAsync<RupeeError[]> =>
	withContext('config')((config) => {
		const parsed = parse(config.ledger, file);
		return index(ledgerId)
			.put(file.key, indexedVersion(file.version, parsed.failed), {
				metadata: parsed.metadata,
				transactions: parsed.succeeded,
				prices: parsed.prices,
			})
			.map(() => parsed.failed);
	});

const reindex = (f: Files, l: string, k: string): ResultAsync<RupeeError[]> =>
	f.read(k).andThen((r) => indexFile(l, r));

const unindex = (li: string, k: string): ResultAsync<RupeeError[]> =>
	index(li)
		.remove(k)
		.map((): RupeeError[] => []);

// One file at a time, since embedded Postgres has one connection. A failed
// step is reported, not fatal; failing to list either side is.
const syncFiles = (ledger: Ledger): ResultAsync<RupeeError[]> =>
	ledgerFiles(ledger).andThen((files) =>
		ResultAsync.combine([files.entries(), index(ledger.id).files()]).andThen(
			([stored, indexed]) => {
				const p = plan(stored, indexed);
				return sequence(
					[
						...p.changed.map((k) => () => reindex(files, ledger.id, k)),
						...p.gone.map((k) => () => unindex(ledger.id, k)),
					].map((s) => () => s().orElse((e) => ok([e]))),
				);
			},
		),
	);

// Events and balances span files, so they are checked after every file is in place.
const checkLedger = (ledgerId: string): ResultAsync<RupeeError[]> =>
	index(ledgerId)
		.eventMembers()
		.map(checkEvents)
		.andThen((e) => checkBalances(ledgerId, e.evidence).map((b) => [...e.failed, ...b]))
		.orElse((e) => ok([e]));

// Evidence is not counted: an event's money moves at its primary.
const checkBalances = (l: string, e: string[]): ResultAsync<RupeeError[]> =>
	index(l)
		.balanceChecks(e)
		.map((c) => c.map(toBalanceError));

// An assertion that could go either way is not checked; a time on either side settles it.
const toBalanceError = (c: BalanceCheck): RupeeError =>
	c.unordered.length > 0
		? fault('BalanceAssertionAmbiguous', {
				location: displayLocation(c.location),
				account: c.account,
				unordered: c.unordered.join(', '),
			})
		: fault('BalanceAssertionFailed', {
				location: displayLocation(c.location),
				account: c.account,
				expected: formatQuantity({ amount: c.expected, commodity: c.commodity }),
				actual: formatQuantity({ amount: c.actual, commodity: c.commodity }),
			});

export const sync = (l: Ledger): ResultAsync<RupeeError[]> =>
	syncFiles(l).andThen((f) => checkLedger(l.id).map((e) => [...f, ...e]));

// For callers that need the index fresh but not the ledger's errors, which
// cost a pass over every event and balance assertion.
export const syncIndex = (l: Ledger): ResultAsync<RupeeError[]> => syncFiles(l);

export type CountedTransaction = IndexedTransaction & { counted: boolean };

export const getTransactions = (l: Ledger): ResultAsync<Batch<CountedTransaction>> =>
	syncFiles(l).andThen((fl) =>
		index(l.id)
			.transactions()
			.map((t) => counting(t, fl))
			.andThen((c) =>
				checkBalances(l.id, c.evidence).map((b) => ({
					...c.batch,
					failed: [...c.batch.failed, ...b],
				})),
			),
	);

type Counting = { batch: Batch<CountedTransaction>; evidence: string[] };

// Evidence is kept but not counted.
const counting = (all: IndexedTransaction[], failed: RupeeError[]): Counting => {
	const events = checkEvents(all);
	const evidence = new Set(events.evidence);

	return {
		batch: {
			succeeded: all.map((t) => ({ ...t, counted: !evidence.has(t.id) })),
			failed: [...failed, ...events.failed],
		},
		evidence: events.evidence,
	};
};

export type Candidates = { pairs: CandidatePair[]; transactions: IndexedTransaction[] };

// Pairs a file's transactions could form events with, and both sides of each.
export const findCandidates = (ledger: Ledger, key: string): ResultAsync<Candidates> =>
	index(ledger.id)
		.candidates(key)
		.andThen((c) =>
			index(ledger.id)
				.byIds([...new Set(c.flatMap((p) => [p.ours, p.theirs]))])
				.map((t) => ({ pairs: c, transactions: t })),
		);

export const isEventIdTaken = (l: Ledger, id: string): ResultAsync<boolean> =>
	index(l.id).eventIdTaken(id);

export const listFiles = (l: Ledger): ResultAsync<Batch<RupeeFile>> =>
	ledgerFiles(l).andThen((f) => f.list());

export const getFile = (l: Ledger, k: string): ResultAsync<RupeeFile> =>
	ledgerFiles(l).andThen((f) => f.read(k));

export const check = (k: string, c: string): Batch<RupeeTransaction> =>
	withContext('config')((f) => parse(f.ledger, { key: k, content: c }));

type WriteFileOptions = {
	ledger: Ledger;
	key: string;
	content: string;
	ifVersion: string | null;
};

// If indexing fails, the next sync picks the file up.
const writeFile = (options: WriteFileOptions): ResultAsync<RupeeFile> => {
	const { ledger, key, content, ifVersion } = options;
	return ledgerFiles(ledger)
		.andThen((f) => f.write({ key, content, ifVersion }))
		.andTee((w) => indexFile(ledger.id, w));
};

type CreateFileOptions = {
	ledger: Ledger;
	key: string;
	content: string;
};

export const createFile = (o: CreateFileOptions): ResultAsync<RupeeFile> =>
	writeFile({ ...o, ifVersion: null });

type EditFileOptions = CreateFileOptions & {
	version: string;
};

export const editFile = (options: EditFileOptions): ResultAsync<RupeeFile> => {
	const { ledger, key, content, version } = options;
	return writeFile({ ledger, key, content, ifVersion: version });
};

type RenameFileOptions = {
	ledger: Ledger;
	from: string;
	to: string;
};

export const renameFile = (options: RenameFileOptions): ResultAsync<RupeeFile> => {
	const { ledger, from, to } = options;
	return ledgerFiles(ledger)
		.andThen((f) => f.rename(from, to))
		.andTee(() => index(ledger.id).rename(from, to));
};

export const deleteFile = (l: Ledger, k: string): ResultAsync<void> =>
	ledgerFiles(l)
		.andThen((f) => f.delete(k))
		.andTee(() => index(l.id).remove(k));

// Every file is checked before any is written, and files holding a primary go
// first, each only if unchanged since it was read. Writing stops at the first
// failure, which leaves at worst a primary still without its evidence: a whole
// event, never evidence without its primary.
export const linkEvents = (ledger: Ledger, edits: LinkEdit[]): ResultAsync<RupeeError[]> =>
	sequence<Result<Linked>>(
		Object.entries(Object.groupBy(edits, (e) => e.file)).map(
			([key, group = []]) =>
				() =>
					linked(ledger, key, group)
						.map((l) => [ok(l)])
						.orElse((e) => okAsync([err(e)])),
		),
	)
		.map(batch)
		.andThen((b) => (b.failed.length > 0 ? okAsync(b.failed) : writeLinked(ledger, b.succeeded)));

type Linked = { file: RupeeFile; content: string; primary: boolean };

const linked = (ledger: Ledger, key: string, edits: LinkEdit[]): ResultAsync<Linked> =>
	getFile(ledger, key).andThen((file) =>
		withContext('config')((c) => insertLinks(c.ledger, file, edits)).map((content) => ({
			file,
			content,
			primary: edits.some((e) => e.role === EventRole.Primary),
		})),
	);

const writeLinked = (ledger: Ledger, linked: Linked[]): ResultAsync<RupeeError[]> =>
	sequence(
		linked
			.toSorted((a, b) => Number(b.primary) - Number(a.primary))
			.map((l) => () => writeLinks(ledger, l).map((): RupeeError[] => [])),
	).orElse((e) => ok([e]));

const writeLinks = (ledger: Ledger, l: Linked): ResultAsync<RupeeFile> => {
	const file = l.file;
	return l.content === file.content
		? okAsync(file)
		: editFile({ ledger, key: file.key, content: l.content, version: file.version });
};

export type EventMember = IndexedTransaction & { role: EventRole; counted: boolean };
export type FileEvent = { event: string; members: EventMember[] };

// Events with a member in the file, with every member wherever it is written.
export const eventsIn = (l: Ledger, k: string): ResultAsync<FileEvent[]> =>
	syncIndex(l)
		.andThen(() => index(l.id).eventsIn(k))
		.map(grouped);

const grouped = (transactions: IndexedTransaction[]): FileEvent[] => {
	const evidence = new Set(checkEvents(transactions).evidence);

	const members = transactions.flatMap((t) =>
		linksOf(t).map((l) => ({
			event: l.event,
			member: { ...t, role: l.role, counted: !evidence.has(t.id) },
		})),
	);

	return Object.entries(Object.groupBy(members, (m) => m.event)).map(([event, group = []]) => ({
		event,
		members: group.map((m) => m.member),
	}));
};

export const renameEvent = (ledger: Ledger, event: string, to: string): ResultAsync<RupeeError[]> =>
	syncIndex(ledger)
		.andThen(() => isEventIdTaken(ledger, to))
		.andThen((t) =>
			t ? errAsync(fault('EventIdTaken', { event: to })) : index(ledger.id).membersOf(event),
		)
		.andThen((m) => relinkFiles(ledger, m, event, (_, l) => ({ ...l, event: to })));

type MakePrimaryOptions = { ledger: Ledger; event: string; file: string; line: number };

// The member becomes the one that counts; the old primary becomes evidence.
export const makePrimary = (options: MakePrimaryOptions): ResultAsync<RupeeError[]> => {
	const { ledger, event, file, line } = options;

	const isTarget = (t: RupeeTransaction) => t.location.file === file && t.location.line === line;
	const isPrimary = (t: IndexedTransaction) =>
		linksOf(t).some((l) => l.event === event && l.role === EventRole.Primary);

	return syncIndex(ledger)
		.andThen(() => index(ledger.id).membersOf(event))
		.andThen((m) =>
			m.some(isTarget)
				? relinkFiles(
						ledger,
						m.filter((t) => isTarget(t) || isPrimary(t)),
						event,
						(t, l) => ({ ...l, role: isTarget(t) ? EventRole.Primary : EventRole.Evidence }),
					)
				: errAsync(fault('EventStale', { location: `${file}:${line}` })),
		);
};

// File by file, like `linkEvents`: a file that fails is reported, the rest go ahead.
const relinkFiles = (
	ledger: Ledger,
	members: IndexedTransaction[],
	event: string,
	relink: Relink,
): ResultAsync<RupeeError[]> =>
	sequence(
		[...new Set(members.map((m) => m.location.file))].map(
			(k) => () =>
				editLinks(ledger, k, (c, f) => rewriteLinks(c, f, event, relink)).orElse((e) => ok([e])),
		),
	);

type LinkWriter = (c: LedgerConfiguration, f: RupeeFile) => Result<string>;

const editLinks = (ledger: Ledger, key: string, write: LinkWriter): ResultAsync<RupeeError[]> =>
	getFile(ledger, key)
		.andThen((f) =>
			withContext('config')((c) => write(c.ledger, f)).asyncAndThen((t) =>
				t === f.content ? okAsync(f) : editFile({ ledger, key, content: t, version: f.version }),
			),
		)
		.map((): RupeeError[] => []);
