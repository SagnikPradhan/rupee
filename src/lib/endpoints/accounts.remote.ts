import { replyFromBatch } from '#lib/server/shared/result/reply.ts';
import * as Ledger from '#services/ledger/application/ledger.ts';
import {
	displayLocation,
	formatAmount,
	formatQuantity,
} from '#services/ledger/application/shared.ts';
import { query } from '$app/server';
import * as v from 'valibot';
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
					lots: x.lots,
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

const Holding = v.object({ handle: Handle, account: v.string(), commodity: v.string() });

export const getLots = query(Holding, async ({ handle, account, commodity }) => {
	const lots = inLedger({ handle, action: (l) => Ledger.getLots(l, account, commodity) });

	return replyFromBatch(
		await lots.map((b) => ({
			...b,
			succeeded: b.succeeded.map((l) => ({
				location: displayLocation(l.location),
				date: l.date.toString(),
				origin: l.origin,
				from: l.from,
				units: formatAmount(l.units),
				remaining: formatAmount(l.remaining),
				cost: formatQuantity(l.cost),
				disposals: l.disposals.map((d) => ({
					location: displayLocation(d.location),
					date: d.date.toString(),
					kind: d.kind,
					units: formatAmount(d.units),
					price: d.price && formatQuantity(d.price),
					gain: d.gain && formatQuantity(d.gain),
				})),
			})),
		})),
	);
});
