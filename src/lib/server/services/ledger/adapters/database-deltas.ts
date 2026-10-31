import type { Database } from '#lib/server/db/index.ts';
import { atomically } from '#lib/server/db/atomically.ts';
import { monthOf } from '#lib/server/db/expressions.ts';
import { withContext } from '#lib/server/shared/context/context.ts';
import { attempt, type ResultAsync } from '#lib/server/shared/result/result.ts';
import type { Span } from '#lib/shared/dates.ts';
import { sql } from 'kysely';
import type { Position } from './database-files';
import { amongPositions } from './database-queries';

const CHECKED = { months: 12 };

type MonthlyDeltasOptions = { span: Span; positions: Position[] };

/** Rewrites these positions' months from the one holding the span's start to the one holding its end. */
export const saveMonthlyDeltas = (
	ledgerId: string,
	{ span, positions }: MonthlyDeltasOptions,
): ResultAsync<void> =>
	atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				const first = span.from.with({ day: 1 });
				const after = span.to.with({ day: 1 }).add({ months: 1 });

				await rewrite(tx, {
					ledgerId,
					first: first.toString(),
					after: after.toString(),
					positions,
				});
			}),
		),
	);

/** Rewrites the twelve months after the ledger's checked_through and moves it on, back to the start after its last month. */
export const saveCheckedMonths = (ledgerId: string): ResultAsync<void> =>
	atomically(() =>
		withContext('db')((tx) =>
			attempt(async () => {
				const { checked, start, last } = await findChecked(tx, ledgerId);
				const end = start && Temporal.PlainDate.from(start).with({ day: 1 }).add(CHECKED);
				const first = checked && start ? start : '-infinity';
				const after = end && last && end.toString() <= last ? end : null;

				await rewrite(tx, {
					ledgerId,
					first,
					after: after?.toString() ?? 'infinity',
					positions: null,
				});
				await tx
					.updateTable('ledgers')
					.set({ checkedThrough: after?.subtract({ days: 1 }).toString() ?? null })
					.where('id', '=', ledgerId)
					.execute();
			}),
		),
	);

type RewriteOptions = {
	ledgerId: string;
	first: string;
	after: string;
	positions: Position[] | null;
};

const rewrite = async (tx: Database, { ledgerId, first, after, positions }: RewriteOptions) => {
	const month = monthOf(sql.ref<string>('d.date'));

	await tx
		.deleteFrom('monthlyDeltas')
		.where('ledgerId', '=', ledgerId)
		.where('month', '>=', first)
		.where('month', '<', after)
		.where((e) => amongPositions(e.ref('accountId'), e.ref('commodity'), positions))
		.execute();
	await tx
		.insertInto('monthlyDeltas')
		.columns(['ledgerId', 'accountId', 'accountType', 'commodity', 'month', 'amount'])
		.expression(
			tx
				.selectFrom('dailyDeltas as d')
				.select((e) => [
					'd.ledgerId',
					'd.accountId',
					'd.accountType',
					'd.commodity',
					month.as('month'),
					e.fn.sum<bigint>('d.amount').as('amount'),
				])
				.where('d.ledgerId', '=', ledgerId)
				.where('d.date', '>=', first)
				.where('d.date', '<', after)
				.where((e) => amongPositions(e.ref('d.accountId'), e.ref('d.commodity'), positions))
				.groupBy(['d.ledgerId', 'd.accountId', 'd.accountType', 'd.commodity', month]),
		)
		.execute();
};

/** The day after checked_through, or the ledger's first day when it is none, and its last day. */
const findChecked = (tx: Database, ledgerId: string) =>
	tx
		.selectFrom('ledgers as l')
		.select((e) => [
			e('l.checkedThrough', 'is not', null).as('checked'),
			e.fn
				.coalesce(
					sql<string>`${e.ref('l.checkedThrough')} + 1`,
					e
						.selectFrom('transactions as t')
						.select((f) => f.fn.min('t.date').as('date'))
						.whereRef('t.ledgerId', '=', 'l.id'),
				)
				.as('start'),
			e
				.selectFrom('transactions as t')
				.select((f) => f.fn.max('t.date').as('date'))
				.whereRef('t.ledgerId', '=', 'l.id')
				.as('last'),
		])
		.where('l.id', '=', ledgerId)
		.executeTakeFirstOrThrow();
