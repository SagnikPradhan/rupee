import {
	EventRole,
	parseAmount,
	type Amount,
	type RupeeMetadata,
} from '#services/ledger/application/shared.ts';
import { describe, expect, it } from 'vitest';
import {
	Confidence,
	fingerprint,
	suggest,
	type MatchedTransaction,
} from '#services/refinement/domain/matching.ts';

const transaction = (
	id: string,
	description: string,
	postings: [string, string][] = [
		['Liabilities:Card', '-1299'],
		['Expenses:Shopping', '1299'],
	],
	metadata: RupeeMetadata = {},
): MatchedTransaction => ({
	id,
	location: { file: `${id.split('/')[0]}.rupee`, line: Number(id.split('/')[1] ?? 1) },
	date: Temporal.PlainDate.from('2026-10-01'),
	time: null,
	description,
	metadata,
	postings: postings.map(([account, amount]) => ({
		account,
		amount: parseAmount(amount) as Amount,
		commodity: 'INR',
		price: null,
		cost: null,
		balance: null,
		metadata: {},
	})),
});

const run = (t: MatchedTransaction[], pairs: [string, string][], dismissed: string[] = []) =>
	suggest({
		transactions: t,
		pairs: pairs.map(([ours, theirs]) => ({ ours, theirs })),
		dismissed: new Set(dismissed),
	});

const roles = (s: ReturnType<typeof run>) =>
	s.map((x) => [x.event, x.confidence, x.links.map((l) => `${l.file}:${l.line} ${l.role}`)]);

describe('suggesting events', () => {
	it('makes the transaction with more postings the primary of a new event', () => {
		const card = transaction('card/1', 'AMAZON PAY INDIA');
		const order = transaction('amazon/4', 'Amazon order 402-123', [
			['Liabilities:Card', '-1299'],
			['Expenses:Books', '499'],
			['Expenses:Electronics', '800'],
		]);

		expect(roles(run([card, order], [['card/1', 'amazon/4']]))).toEqual([
			[
				null,
				Confidence.Possible,
				[`amazon.rupee:4 ${EventRole.Primary}`, `card.rupee:1 ${EventRole.Evidence}`],
			],
		]);
	});

	it('prefers the transaction being refined on a tie, and calls a same description a duplicate', () => {
		const a = transaction('sep/3', 'UPI GROCER');
		const b = transaction('oct/1', 'UPI  grocer');

		expect(roles(run([a, b], [['oct/1', 'sep/3']]))).toEqual([
			[
				null,
				Confidence.Duplicate,
				[`oct.rupee:1 ${EventRole.Primary}`, `sep.rupee:3 ${EventRole.Evidence}`],
			],
		]);
	});

	it('joins an event either side is already in', () => {
		const order = transaction('amazon/1', 'Order', undefined, { event: ['e1'] });
		const card = transaction('card/1', 'AMAZON');
		const csv = transaction('csv/1', 'AMAZON', undefined, { 'same-as': ['e2'] });

		expect(roles(run([order, card], [['card/1', 'amazon/1']]))).toEqual([
			['e1', Confidence.Possible, [`card.rupee:1 ${EventRole.Evidence}`]],
		]);
		expect(roles(run([order, csv], [['amazon/1', 'csv/1']]))).toEqual([]);
		expect(roles(run([card, csv], [['card/1', 'csv/1']]))).toEqual([
			['e2', Confidence.Duplicate, [`card.rupee:1 ${EventRole.Evidence}`]],
		]);
	});

	it('pairs identical charges one to one', () => {
		const ours = ['oct/1', 'oct/4'].map((id) => transaction(id, 'TEA'));
		const theirs = ['sep/1', 'sep/4', 'sep/7'].map((id) => transaction(id, 'TEA'));
		const pairs = ours.flatMap((o) => theirs.map((t): [string, string] => [o.id, t.id]));

		expect(run([...ours, ...theirs], pairs).map((s) => [s.ours.id, s.theirs.id])).toEqual([
			['oct/1', 'sep/1'],
			['oct/4', 'sep/4'],
		]);
	});

	it('never puts a second member from the refined file into an event', () => {
		const first = transaction('oct/1', 'TEA', undefined, { event: ['e1'] });
		const second = transaction('oct/4', 'TEA');
		const theirs = transaction('sep/1', 'TEA', undefined, { 'same-as': ['e1'] });

		expect(
			run(
				[first, second, theirs],
				[
					['oct/1', 'sep/1'],
					['oct/4', 'sep/1'],
				],
			),
		).toEqual([]);
	});

	it('leaves out dismissed pairs, without them using up a transaction', () => {
		const ours = transaction('oct/1', 'TEA');
		const old = transaction('sep/1', 'TEA');
		const other = transaction('sep/4', 'TEA');

		const s = run(
			[ours, old, other],
			[
				['oct/1', 'sep/1'],
				['oct/1', 'sep/4'],
			],
			[fingerprint(ours, old)],
		);
		expect(s.map((x) => x.theirs.id)).toEqual(['sep/4']);
	});
});

describe('fingerprinting a pair', () => {
	it('ignores which side is which, and changes with either', () => {
		const a = transaction('a/1', 'TEA');
		const b = transaction('b/1', 'COFFEE');

		expect(fingerprint(a, b)).toBe(fingerprint(b, a));
		expect(fingerprint(a, { ...b, description: 'COFFEE BEANS' })).not.toBe(fingerprint(a, b));
	});
});
