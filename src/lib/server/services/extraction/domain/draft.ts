import type { LedgerConfiguration } from '#lib/server/shared/context/config.ts';
import type { RupeeError } from '#lib/server/shared/result/error.ts';
import {
	accountType,
	DEFAULT_COMMODITY,
	print,
	type Amount,
	type RupeeTransaction,
} from '#services/ledger/application/shared.ts';
import type { RupeeRecord } from './types';

export type Draft = { key: string; content: string; failed: RupeeError[] };

// A record with the account its money came from or went to.
export type Categorised = RupeeRecord & { account: string };

type DraftOptions = {
	config: LedgerConfiguration;
	statement: string;
	checksum: string;
	// The upload's checksum, when unlocking it changed the content.
	original: string | null;
	account: string;
	// In any order; they are written in the statement's.
	records: Categorised[];
	failed: RupeeError[];
};

// A statement's own category counts only when it names a ledger account.
export const uncategorised = (l: RupeeRecord[]) => l.filter((r) => categoryAccount(r) === null);

export const categorised = (records: RupeeRecord[]): Categorised[] =>
	records.flatMap((r) => {
		const account = categoryAccount(r);
		return account ? [{ ...r, account }] : [];
	});

export const draft = (options: DraftOptions): Draft => ({
	key: `imports/${options.statement.replace(/\.[^.]*$/, '')}.rupee`,
	content: print(options.config, {
		metadata: citation(options),
		transactions: options.records
			.toSorted((a, b) => a.location.line - b.location.line)
			.map(toTransaction(options.account)),
		prices: [],
	}),
	failed: options.failed,
});

// The checksum finds the statement wherever it has moved; the path is only what it was called.
const citation = ({ statement, checksum, original }: DraftOptions) => ({
	statement: [statement],
	checksum: [checksum],
	...(original ? { original: [original] } : {}),
});

const toTransaction =
	(account: string) =>
	(record: Categorised): RupeeTransaction => ({
		location: record.location,
		date: record.date,
		time: null,
		description: words(record.description).join(' '),
		metadata: {},
		postings: [
			{
				account,
				amount: record.amount,
				commodity: DEFAULT_COMMODITY,
				price: null,
				cost: null,
				balance: record.balance,
				metadata: {},
			},
			{
				account: record.account,
				amount: -record.amount as Amount,
				commodity: DEFAULT_COMMODITY,
				price: null,
				cost: null,
				balance: null,
				metadata: {},
			},
		],
	});

const categoryAccount = (record: RupeeRecord): string | null => {
	if (!record.category) return null;

	const account = words(record.category).join('-');
	return accountType(account) ? account : null;
};

// A `.rupee` header is one line, and an account a single word.
const words = (t: string) => t.trim().split(/\s+/);
