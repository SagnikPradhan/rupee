import * as dateFns from 'date-fns';

/** Day before month: `MM/dd/yyyy` would read `03/04/2026` the other way. */
export const DATE_FORMATS = [
	'yyyy-MM-dd',
	'yyyy/MM/dd',
	'dd-MM-yyyy',
	'd-M-yyyy',
	'dd/MM/yyyy',
	'd/M/yyyy',
	'd MMM yyyy',
	'd MMMM yyyy',
	'MMM d, yyyy',
	'MMMM d, yyyy',
];

export const TIME_FORMATS = ['HH:mm', 'H:mm', 'HH:mm:ss', 'H:mm:ss', 'h:mm a', 'h:mm:ss a'];

/** date-fns fills fields a format leaves out with the 1st, January or 1970, so this avoids all three. */
const SAMPLE = new Date(2026, 7, 29, 14, 30);

const REMEMBERED = 10_000;

/** Reading is costly and always gives the same answer, and a ledger repeats few dates across many lines. */
const reads = new Map<string, Date | null>();

export type ReadOptions = { format: string; text: string; reference?: Date | undefined };

export const parseDate = (o: ReadOptions): Temporal.PlainDate | null => {
	const d = read(o);
	return d
		? Temporal.PlainDate.from({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() })
		: null;
};

export const parseTime = (o: ReadOptions): Temporal.PlainTime | null => {
	const t = read(o);
	return t
		? Temporal.PlainTime.from({
				hour: t.getHours(),
				minute: t.getMinutes(),
				second: t.getSeconds(),
			})
		: null;
};

export const isDateFormat = (f: string, r?: Date): boolean =>
	parseDate({ format: f, text: dateFns.format(SAMPLE, f), reference: r })?.equals('2026-08-29') ??
	false;

export const isTimeFormat = (f: string): boolean =>
	parseTime({ format: f, text: dateFns.format(SAMPLE, f) })?.equals('14:30') ?? false;

const read = (o: ReadOptions): Date | null => {
	if (o.reference) return readStrictly(o);
	if (!fits(o)) return null;

	const key = `${o.format}\0${o.text}`;
	const known = reads.get(key);
	if (known !== undefined) return known;

	const d = readStrictly(o);
	if (reads.size >= REMEMBERED) reads.clear();
	reads.set(key, d);
	return d;
};

/** Whether a text could print as its format, which is cheap to tell and rules out most: a line is tried against every format, and most of those texts are never seen again. */
const fits = ({ format, text }: ReadOptions): boolean => {
	const shape = shapes.get(format) ?? shapes.set(format, shapeOfFormat(format)).get(format);

	return shape === null || shape === shapeOfText(text);
};

const shapes = new Map<string, string | null>();

const shapeOfText = (t: string) => t.replace(/\d+/g, '0').replace(/[a-z]+/gi, 'a');

/** Null for a format with anything but plain numbers, month names and am or pm, which could print as something else. */
const shapeOfFormat = (format: string) => {
	const shape = format
		.replace(/M{3,4}|a/g, '_')
		.replace(/[yMdHhms]+/g, '0')
		.replace(/0+/g, '0');

	return /^[0_\s/,:.-]*$/.test(shape) ? shape.replaceAll('_', 'a') : null;
};

/** Strict, so a list of formats never reads one text two ways. */
const readStrictly = (o: ReadOptions): Date | null => {
	const d = dateFns.parse(o.text, o.format, o.reference ?? new Date(0));
	return dateFns.isValid(d) && dateFns.format(d, o.format).toLowerCase() === o.text.toLowerCase()
		? d
		: null;
};
