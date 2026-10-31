import { base } from '#lib/server/db/columns.ts';
import { EMBEDDING_DIMENSIONS } from '#lib/server/shared/onnx/models.ts';
import type { RupeaError } from '#lib/server/shared/result/error.ts';
import { users } from '#services/auth/adapters/database-schema.ts';
import { sql } from 'drizzle-orm';
import * as PG from 'drizzle-orm/pg-core';
import {
	AccountType,
	DisposalKind,
	Feed,
	LotOrigin,
	PriceKind,
	PriceSource,
	ProblemKind,
} from '../domain/types';

export const accountType = PG.pgEnum('account_type', AccountType);
export const priceKind = PG.pgEnum('price_kind', PriceKind);
export const priceSource = PG.pgEnum('price_source', PriceSource);
export const feed = PG.pgEnum('feed', Feed);
export const lotOrigin = PG.pgEnum('lot_origin', LotOrigin);
export const disposalKind = PG.pgEnum('disposal_kind', DisposalKind);
export const problemKind = PG.pgEnum('problem_kind', ProblemKind);

// Ten-billionths of a unit; a bigint would overflow past 900 million units or on a product.
const amount = () => PG.numeric({ precision: 38, scale: 0, mode: 'bigint' });

// The handle also names the ledger's folder in its owner's storage, so it never changes.
export const ledgers = PG.pgTable(
	'ledgers',
	(t) => ({
		...base,
		ownerId: t
			.uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		handle: t.text().notNull().unique('ledgers_handle_unique'),
		name: t.text().notNull(),
		checkedThrough: t.date(), // the last day monthly deltas were rebuilt to, or none to start again
	}),
	(t) => [PG.index('ledgers_owner_id').on(t.ownerId)],
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
		version: t.text().notNull(),
		indexer: t.integer().notNull(),
	}),
	(t) => [PG.unique('ledger_files_ledger_id_key').on(t.ledgerId, t.key)],
);

// What a ledger's owner can fix, kept so it is reported without finding it again.
export const problems = PG.pgTable(
	'problems',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		fileId: t.uuid().references(() => ledgerFiles.id, { onDelete: 'cascade' }),
		kind: problemKind().notNull(),
		error: t.jsonb().$type<RupeaError>().notNull(),
	}),
	(t) => [PG.index('problems_ledger_id').on(t.ledgerId), PG.index('problems_file_id').on(t.fileId)],
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
		sortTime: t
			.time()
			.notNull()
			.generatedAlwaysAs(sql`coalesce("time", '00:00')`), // a missing time sorts as midnight
		description: t.text().notNull(),
		comment: t.text(), // the comment lines above its header, joined
		hash: t.text(), // of the lines it was read from, so a save parses only what changed
		embedding: t.vector({ dimensions: EMBEDDING_DIMENSIONS }), // of the description; filled lazily
		embeddingModel: t.text(),
		counted: t.boolean().notNull().default(true), // false for a group's evidence; set once files settle
	}),
	(t) => [
		PG.index('transactions_file_id').on(t.fileId),
		PG.index('transactions_ledger_id_order').on(t.ledgerId, t.date, t.sortTime, t.id), // lists page by it
		PG.index('transactions_ledger_id_uncounted')
			.on(t.ledgerId)
			.where(sql`not ${t.counted}`),
		PG.index('transactions_description').using('gin', sql`${t.description} gin_trgm_ops`),
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
		date: t.date().notNull(), // its transaction's, so an account's days are read without joining it
		counted: t.boolean().notNull().default(true), // its transaction's, so counted postings are read without joining it
		position: t.integer().notNull(),
		accountId: t
			.uuid()
			.notNull()
			.references(() => accounts.id),
		accountType: accountType().notNull(), // its account's, so balance postings are read without joining it

		// What moves into the account, or out when negative, in signed ten-billionths.
		amount: amount().notNull(),
		commodity: t.text().notNull(),

		// What the commodity is worth in another: `@` per unit or `@@` in total. All or none.
		priceAmount: amount(),
		priceCommodity: t.text(),
		priceKind: priceKind(),

		// The `{cost, date}` per unit of the lot this takes from; balances in place of the price.
		costAmount: amount(),
		costCommodity: t.text(),
		costDate: t.date(),

		// What the account holds of this commodity after this posting, when the file asserts it.
		balance: amount(),

		comment: t.text(), // the comment lines above it, joined

		// What the ledger says it holds there, and the transactions that could fall either side; set when settled.
		actual: amount(),
		unordered: t.uuid().array(),
	}),
	(t) => [
		PG.index('postings_transaction_id').on(t.transactionId),
		PG.index('postings_account_id_commodity_amount').on(t.accountId, t.commodity, t.amount), // refinement matches
		PG.index('postings_account_id_commodity_date').on(t.accountId, t.commodity, t.date), // an account's days
		PG.index('postings_account_id_date').on(t.accountId, t.date), // account filters
		PG.index('postings_ledger_id_commodity').on(t.ledgerId, t.commodity), // lots are booked per commodity
		PG.index('postings_ledger_id_balance')
			.on(t.ledgerId, t.accountId, t.commodity)
			.where(sql`${t.balance} IS NOT NULL`),
	],
);

/** A ledger's accounts and every account above one, one per name whatever its case, spelt as first indexed. */
export const accounts = PG.pgTable(
	'accounts',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		parentId: t.uuid().references((): PG.AnyPgColumn => accounts.id),
		name: t.text().notNull(),
		type: accountType().notNull(),
	}),
	(t) => [
		PG.uniqueIndex('accounts_ledger_id_lower_name').on(
			t.ledgerId,
			sql`lower(${t.name}) text_pattern_ops`,
		), // account filters, whatever their case
		PG.index('accounts_parent_id').on(t.parentId),
	],
);

/** What a feed calls a commodity; a ledger's own commodities are symbols of the ledger feed. */
export const symbols = PG.pgTable(
	'symbols',
	(t) => ({
		...base,
		feed: feed().notNull(),
		symbol: t.text().notNull(),
		ledgerId: t.uuid().references(() => ledgers.id, { onDelete: 'cascade' }),
	}),
	(t) => [
		PG.unique('symbols_feed_ledger_id_symbol').on(t.feed, t.ledgerId, t.symbol).nullsNotDistinct(),
		PG.check(
			'symbols_ledger_owns_its_own',
			sql`(${t.feed} = 'ledger') = (${t.ledgerId} is not null)`,
		),
	],
);

/** A ledger's prices are read from its files, and a feed's quotes, one a day, are fetched. */
export const prices = PG.pgTable(
	'prices',
	(t) => ({
		...base,
		symbolId: t
			.uuid()
			.notNull()
			.references(() => symbols.id, { onDelete: 'cascade' }),
		fileId: t.uuid().references(() => ledgerFiles.id, { onDelete: 'cascade' }),
		line: t.integer(),
		date: t.date().notNull(),
		priceAmount: amount().notNull(), // of one unit, in ten-billionths
		priceCommodity: t.text().notNull(),
		source: priceSource().notNull(),
	}),
	(t) => [
		PG.index('prices_file_id').on(t.fileId),
		PG.index('prices_symbol_id_date').on(t.symbolId, t.date),
		PG.uniqueIndex('prices_symbol_id_date_quoted')
			.on(t.symbolId, t.date)
			.where(sql`${t.fileId} is null`),
		PG.check(
			'prices_read_from_files',
			sql`(${t.source} in ('line', 'posting')) = (${t.fileId} is not null and ${t.line} is not null)`,
		),
	],
);

/** Prices a ledger's commodity by a feed's symbol from since on, or from the start when it is null. */
export const symbolLinks = PG.pgTable(
	'symbol_links',
	(t) => ({
		...base,
		symbolId: t
			.uuid()
			.notNull()
			.references(() => symbols.id, { onDelete: 'cascade' }),
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		alias: t.text().notNull(),
		since: t.date(),
		fileId: t
			.uuid()
			.notNull()
			.references(() => ledgerFiles.id, { onDelete: 'cascade' }),
		line: t.integer().notNull(),
	}),
	(t) => [
		PG.index('symbol_links_ledger_id_alias').on(t.ledgerId, t.alias),
		PG.index('symbol_links_file_id').on(t.fileId),
		PG.index('symbol_links_symbol_id').on(t.symbolId),
	],
);

/** How a feed symbol's last fetches went: when one last worked, and since when they have failed. */
export const symbolFetches = PG.pgTable('symbol_fetches', (t) => ({
	...base,
	symbolId: t
		.uuid()
		.notNull()
		.unique('symbol_fetches_symbol_id_unique')
		.references(() => symbols.id, { onDelete: 'cascade' }),
	fetchedAt: t.timestamp({ withTimezone: true }),
	failingSince: t.timestamp({ withTimezone: true }),
	error: t.jsonb().$type<RupeaError>(),
}));

export const lots = PG.pgTable(
	'lots',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		postingId: t
			.uuid()
			.notNull()
			.references(() => postings.id, { onDelete: 'cascade' }),
		sourceId: t.uuid().references((): PG.AnyPgColumn => lots.id, { onDelete: 'set null' }), // the lot a transfer moved
		accountId: t
			.uuid()
			.notNull()
			.references(() => accounts.id),
		commodity: t.text().notNull(),
		origin: lotOrigin().notNull(),
		date: t.date().notNull(),
		units: amount().notNull(), // signed ten-billionths; negative for a short
		remaining: amount().notNull(),
		costAmount: amount().notNull(), // of one unit
		costCommodity: t.text().notNull(),
	}),
	(t) => [
		PG.index('lots_ledger_id_commodity_account_id').on(t.ledgerId, t.commodity, t.accountId),
		PG.index('lots_posting_id').on(t.postingId),
		PG.index('lots_source_id').on(t.sourceId),
	],
);

/** What an account's counted postings of a commodity moved in one month, so history before a day is summed by the month. */
export const monthlyDeltas = PG.pgTable(
	'monthly_deltas',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		accountId: t
			.uuid()
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		accountType: accountType().notNull(),
		commodity: t.text().notNull(),
		month: t.date().notNull(), // its first day
		amount: amount().notNull(),
	}),
	(t) => [
		PG.unique('monthly_deltas_ledger_id_account_id_commodity_month').on(
			t.ledgerId,
			t.accountId,
			t.commodity,
			t.month,
		),
	],
);

export const disposals = PG.pgTable(
	'disposals',
	(t) => ({
		...base,
		ledgerId: t
			.uuid()
			.notNull()
			.references(() => ledgers.id, { onDelete: 'cascade' }),
		lotId: t.uuid().references(() => lots.id, { onDelete: 'cascade' }), // none when no open lot covers it
		postingId: t
			.uuid()
			.notNull()
			.references(() => postings.id, { onDelete: 'cascade' }),
		commodity: t.text().notNull(),
		kind: disposalKind().notNull(),
		units: amount().notNull(), // what the lot changes by, signed ten-billionths
		priceAmount: amount(), // of one unit; with its commodity, all or none
		priceCommodity: t.text(),
	}),
	(t) => [
		PG.index('disposals_lot_id').on(t.lotId),
		PG.index('disposals_posting_id').on(t.postingId),
		PG.index('disposals_ledger_id_commodity').on(t.ledgerId, t.commodity),
		PG.index('disposals_ledger_id_unmatched')
			.on(t.ledgerId)
			.where(sql`${t.lotId} IS NULL`),
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
