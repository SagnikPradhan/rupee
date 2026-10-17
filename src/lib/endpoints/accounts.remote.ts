import { replyFromBatch } from '#lib/server/shared/result/reply.ts';
import * as Ledger from '#services/ledger/application/ledger.ts';
import { formatAmount, formatQuantity } from '#services/ledger/application/shared.ts';
import { query } from '$app/server';
import { Handle, inLedger } from './shared';

export const getAccounts = query(Handle, async (h) => {
	const today = Temporal.Now.plainDateISO();
	const accounts = inLedger({ handle: h, action: (l) => Ledger.getAccounts(l, today) });

	return replyFromBatch(
		await accounts.map((b) => ({
			...b,
			succeeded: b.succeeded.map((a) => ({
				...a,
				total: formatAmount(a.total),
				holdings: a.holdings.map((x) => ({
					commodity: x.commodity,
					units: formatQuantity({ amount: x.units, commodity: x.commodity }),
					cost: x.cost && formatQuantity(x.cost),
					price: x.price && formatQuantity(x.price),
					value: x.value === null ? null : formatAmount(x.value),
					gain: x.gain === null ? null : formatAmount(x.gain),
				})),
			})),
		})),
	);
});
