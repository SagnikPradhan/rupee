import {
	DATE_FORMATS,
	isDateFormat,
	isTimeFormat,
	parseDate,
	parseTime,
	TIME_FORMATS,
} from '#lib/server/shared/dates.ts';
import { describe, expect, it } from 'vitest';

describe('reading a date', () => {
	it.each([
		['yyyy-MM-dd', '2026-08-29'],
		['dd/MM/yyyy', '29/08/2026'],
		['d MMM yyyy', '29 Aug 2026'],
		['d MMM yyyy', '29 aug 2026'],
		['yyyyMMdd', '20260829'],
		['ddMMMyyyy', '29Aug2026'],
		['do MMM yyyy', '29th Aug 2026'],
		["yyyy-MM-dd'T'", '2026-08-29T'],
		['MMMM d, yyyy', 'August 29, 2026'],
	])('parses %j / %j', (format, text) => {
		expect(parseDate({ format, text })).toEqual(Temporal.PlainDate.from('2026-08-29'));
	});

	it.each([
		['yyyy-MM-dd', '2026-02-30'],
		['yyyy-MM-dd', '2026-13-01'],
		['yyyy-MM-dd', '2026-00-10'],
		['yyyy-MM-dd', '29/08/2026'],
		['yyyy-MM-dd', '2026-08-29x'],
		['yyyy-MM-dd', '2026-8-29'],
		['dd/MM/yyyy', '29/08/26'],
		['d/M/yyyy', '29/08/2026'],
		['d MMM yyyy', '2026-08-29 AAPL 12.5'],
		['yyyy-MM-dd', 'Groceries'],
	])('rejects %j / %j', (ft, tx) => {
		expect(parseDate({ format: ft, text: tx })).toBeNull();
	});

	it('reads a text the same way every time, valid or not', () => {
		const read = (text: string) => parseDate({ format: 'yyyy-MM-dd', text });

		expect(read('2026-08-29')).toEqual(read('2026-08-29'));
		expect(read('2026-08-29')).toEqual(Temporal.PlainDate.from('2026-08-29'));
		expect(read('not a date')).toBeNull();
		expect(read('not a date')).toBeNull();
	});

	it('keeps formats apart when their texts look alike', () => {
		expect(parseDate({ format: 'dd/MM/yyyy', text: '01/02/2026' })?.month).toBe(2);
		expect(parseDate({ format: 'MM/dd/yyyy', text: '01/02/2026' })?.month).toBe(1);
	});

	it('still reads after remembering more texts than it keeps', () => {
		for (const n of Array.from({ length: 10_001 }, (_, i) => i))
			parseDate({ format: 'yyyy-MM-dd', text: `word-${n}` });

		expect(parseDate({ format: 'yyyy-MM-dd', text: '2026-08-29' })?.day).toBe(29);
	});

	it('reads against a reference date without remembering it', () => {
		const read = (reference: Date) =>
			parseDate({ format: 'yyyy-MM-dd HH', text: '2026-08-29 10', reference });

		expect(read(new Date(0))).toEqual(read(new Date(2000, 0, 1)));
	});
});

describe('reading a time', () => {
	it.each([
		['HH:mm', '14:30', '14:30'],
		['H:mm', '9:05', '09:05'],
		['HH:mm:ss', '14:30:15', '14:30:15'],
		['h:mm a', '2:30 PM', '14:30'],
		['h:mm a', '12:15 am', '00:15'],
	])('parses %j / %j', (fmt, txt, tim) => {
		expect(parseTime({ format: fmt, text: txt })).toEqual(Temporal.PlainTime.from(tim));
	});

	it.each([
		['HH:mm', '24:00'],
		['HH:mm', '14:60'],
		['HH:mm', '9:05'],
		['HH:mm', 'Groceries'],
	])('rejects %j / %j', (ft, tx) => {
		expect(parseTime({ format: ft, text: tx })).toBeNull();
	});
});

describe('date formats', () => {
	it.each([...DATE_FORMATS, 'yyyy-MM-dd HH:mm'])('accepts %j', (ft) => {
		expect(isDateFormat(ft)).toBe(true);
	});

	it.each(['yyyy-MM', 'MM-dd', 'yy-MM-dd'])('rejects %j', (ft) => {
		expect(isDateFormat(ft)).toBe(false);
	});

	it('throws on unknown tokens', () => {
		expect(() => isDateFormat('%Y-%m-%d')).toThrow(RangeError);
	});
});

describe('time formats', () => {
	it.each(TIME_FORMATS)('accepts %j', (ft) => {
		expect(isTimeFormat(ft)).toBe(true);
	});

	it.each(['HH', 'mm:ss', 'h:mm'])('rejects %j', (ft) => {
		expect(isTimeFormat(ft)).toBe(false);
	});
});
