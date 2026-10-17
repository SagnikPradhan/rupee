import { sql } from 'drizzle-orm';
import * as PG from 'drizzle-orm/pg-core';
import type { RupeeError } from '../shared/result/error';

export const EMBEDDING_DIMENSIONS = 384;

const base = {
	id: PG.uuid()
		.primaryKey()
		.default(sql`uuidv7()`),
	createdAt: PG.timestamp({ withTimezone: true }).notNull().defaultNow(),
	updatedAt: PG.timestamp({ withTimezone: true }).notNull().defaultNow(),
};

export enum StorageKind {
	Local = 'local',
}

export const storageKind = PG.pgEnum('storage_kind', StorageKind);

// `@` prices one unit, `@@` the whole posting; kept as written so it prints back.
export enum PriceKind {
	Unit = 'unit',
	Total = 'total',
}

export const priceKind = PG.pgEnum('price_kind', PriceKind);

// Where an indexed price was written: a `P` line, or a posting's `@`.
export enum PriceSource {
	Line = 'line',
	Posting = 'posting',
}

export const priceSource = PG.pgEnum('price_source', PriceSource);

export enum AccountType {
	Assets = 'Assets',
	Liabilities = 'Liabilities',
	Income = 'Income',
	Expenses = 'Expenses',
	Equity = 'Equity',
}

export const accountType = PG.pgEnum('account_type', AccountType);

export enum JobStatus {
	Queued = 'queued',
	Running = 'running',
	Succeeded = 'succeeded',
	Failed = 'failed',
}

export const jobStatus = PG.pgEnum('job_status', JobStatus);

export const users = PG.pgTable('users', (t) => ({
	...base,
	email: t.text().notNull().unique(),
	username: t.text().notNull().unique('users_username_unique'),
}));

// One per user for now: where their schemas and the ledgers they own live.
export const storages = PG.pgTable('storages', (t) => ({
	...base,
	userId: t
		.uuid()
		.notNull()
		.unique('storages_user_id_unique')
		.references(() => users.id, { onDelete: 'cascade' }),
	kind: storageKind().notNull(),
}));

// The owner is the storage's user. The handle also names the ledger's folder, so it never changes.
export const ledgers = PG.pgTable(
	'ledgers',
	(t) => ({
		...base,
		storageId: t
			.uuid()
			.notNull()
			.references(() => storages.id, { onDelete: 'cascade' }),
		handle: t.text().notNull().unique('ledgers_handle_unique'),
		name: t.text().notNull(),
	}),
	(t) => [PG.index('ledgers_storage_id').on(t.storageId)],
);

export const sessions = PG.pgTable('sessions', (t) => ({
	...base,
	expiresAt: t.timestamp({ withTimezone: true }).notNull(),
	tokenHash: t.text().notNull().unique('sessions_token_hash_unique'),
	userId: t
		.uuid()
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
}));

export const emailCodes = PG.pgTable('email_codes', (t) => ({
	...base,
	email: t.text().notNull().unique(),
	codeHash: t.text().notNull(),
	expiresAt: t.timestamp({ withTimezone: true }).notNull(),
}));

// What the statements folder holds, so a statement is found by its content without hashing the folder.
export const statements = PG.pgTable(
	'statements',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		path: t.text().notNull(),
		checksum: t.text().notNull(),
		original: t.text(),
	}),
	(t) => [
		PG.unique('statements_ledger_id_path').on(t.ledgerId, t.path),
		PG.index('statements_ledger_id_checksum').on(t.ledgerId, t.checksum),
		PG.index('statements_ledger_id_original').on(t.ledgerId, t.original),
	],
);

// Contents already read, so previewing a statement again skips the slow PDF table detection.
export const statementGrids = PG.pgTable(
	'statement_grids',
	(t) => ({
		...base,
		checksum: t.text().notNull(),
		reader: t.text().notNull(),
		grid: t.jsonb().$type<string[][]>().notNull(),
		text: t.jsonb().$type<string[]>().notNull().default([]),
		expiresAt: t.timestamp({ withTimezone: true }).notNull(),
	}),
	(t) => [
		PG.unique('statement_grids_checksum_reader').on(t.checksum, t.reader),
		PG.index('statement_grids_expires_at').on(t.expiresAt),
	],
);

export const memberships = PG.pgTable(
	'memberships',
	(t) => ({
		...base,
		userId: t
			.uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
	}),
	(t) => [PG.unique('memberships_user_id_ledger_id').on(t.userId, t.ledgerId)],
);

export const ledgerFiles = PG.pgTable(
	'ledger_files',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		key: t.text().notNull(),
		version: t.text(),
	}),
	(t) => [PG.unique('ledger_files_ledger_id_key').on(t.ledgerId, t.key)],
);

export const transactions = PG.pgTable(
	'transactions',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		fileId: t
			.uuid()
			.notNull()
			.references(() => ledgerFiles.id, { onDelete: 'cascade' }),
		line: t.integer().notNull(),
		date: t.date().notNull(),
		time: t.time(),
		description: t.text().notNull(),
		embedding: t.vector({ dimensions: EMBEDDING_DIMENSIONS }), // of the description; filled lazily
		embeddingModel: t.text(),
	}),
	(t) => [
		PG.index('transactions_file_id').on(t.fileId),
		PG.index('transactions_ledger_id_date').on(t.ledgerId, t.date),
		PG.index('transactions_embedding').using('hnsw', t.embedding.op('vector_cosine_ops')),
	],
);

export const postings = PG.pgTable(
	'postings',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		transactionId: t
			.uuid()
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		position: t.integer().notNull(),
		account: t.text().notNull(),
		accountType: accountType().notNull(),
		amount: t.bigint({ mode: 'bigint' }).notNull(), // signed millionths
		commodity: t.text().notNull(),
		priceAmount: t.bigint({ mode: 'bigint' }), // price fields: all or none
		priceCommodity: t.text(),
		priceKind: priceKind(),
		balance: t.bigint({ mode: 'bigint' }),
	}),
	(t) => [
		PG.index('postings_transaction_id').on(t.transactionId),
		PG.index('postings_ledger_id_account_amount').on(t.ledgerId, t.account, t.commodity, t.amount), // refinement matches
		PG.index('postings_ledger_id_balance')
			.on(t.ledgerId, t.account, t.commodity)
			.where(sql`${t.balance} IS NOT NULL`),
	],
);

export const prices = PG.pgTable(
	'prices',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		fileId: t
			.uuid()
			.notNull()
			.references(() => ledgerFiles.id, { onDelete: 'cascade' }),
		line: t.integer().notNull(),
		date: t.date().notNull(),
		commodity: t.text().notNull(),
		priceAmount: t.bigint({ mode: 'bigint' }).notNull(), // of one unit, in millionths
		priceCommodity: t.text().notNull(),
		source: priceSource().notNull(),
	}),
	(t) => [
		PG.index('prices_file_id').on(t.fileId),
		PG.index('prices_ledger_id_commodity_date').on(t.ledgerId, t.commodity, t.date),
	],
);

export const metadata = PG.pgTable(
	'metadata',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		fileId: t.uuid().references(() => ledgerFiles.id, { onDelete: 'cascade' }),
		transactionId: t.uuid().references(() => transactions.id, { onDelete: 'cascade' }),
		postingId: t.uuid().references(() => postings.id, { onDelete: 'cascade' }),
		position: t.integer().notNull(),
		key: t.text().notNull(),
		value: t.text().notNull(),
	}),
	(t) => [
		PG.index('metadata_file_id').on(t.fileId),
		PG.index('metadata_transaction_id').on(t.transactionId),
		PG.index('metadata_posting_id').on(t.postingId),
		PG.index('metadata_ledger_id_key_value').on(t.ledgerId, t.key, t.value),
		PG.check(
			'metadata_one_owner',
			sql`num_nonnulls(${t.fileId}, ${t.transactionId}, ${t.postingId}) = 1`,
		),
	],
);

export const dismissedMatches = PG.pgTable(
	'dismissed_matches',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		fingerprint: t.text().notNull(), // declined suggestion pair
	}),
	(t) => [PG.unique('dismissed_matches_ledger_id_fingerprint').on(t.ledgerId, t.fingerprint)],
);

/** Jobs of one name and partition run one at a time, which `jobs_name_partition_running` enforces. */
export const jobs = PG.pgTable(
	'jobs',
	(t) => ({
		...base,
		userId: t
			.uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: t.text().notNull(),
		partition: t.text().notNull(),
		version: t.integer().notNull(),
		payload: t.jsonb().notNull(),
		dedupe: t.text().notNull(),
		status: jobStatus().notNull().default(JobStatus.Queued),
		attempts: t.integer().notNull().default(0),
		runAt: t.timestamp({ withTimezone: true }).notNull().defaultNow(),
		leasedUntil: t.timestamp({ withTimezone: true }),
		error: t.jsonb().$type<RupeeError>(),
	}),
	(t) => [
		PG.uniqueIndex('jobs_user_id_name_dedupe_queued')
			.on(t.userId, t.name, t.dedupe)
			.where(sql`${t.status} = 'queued'`),
		PG.uniqueIndex('jobs_name_partition_running')
			.on(t.name, t.partition)
			.where(sql`${t.status} = 'running'`),
		PG.index('jobs_run_at_queued')
			.on(t.runAt)
			.where(sql`${t.status} = 'queued'`),
		PG.index('jobs_leased_until_running')
			.on(t.leasedUntil)
			.where(sql`${t.status} = 'running'`),
		PG.index('jobs_status_updated_at').on(t.status, t.updatedAt),
		PG.index('jobs_user_id_created_at').on(t.userId, t.createdAt),
	],
);
