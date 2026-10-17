import { expect, test } from './support/test.ts';
import { visit } from './support/visit.ts';

const ledgerFile = [
	'2026-01-02 Buy',
	'\tAssets:Zerodha 10 INFY @ 1500',
	'\tAssets:Bank',
	'',
	'2026-03-01 Sell',
	'\tAssets:Zerodha -4 INFY {1500} @ 1700',
	'\tAssets:Bank 6800',
	'\tIncome:Gains -800',
	'',
	'2026-04-01 Bonus',
	'\tAssets:Zerodha 1 TCS',
	'\tIncome:Bonus -1 TCS',
	'',
	'P 2026-10-01 INFY 1800',
	'',
].join('\n');

test('shows what each account holds and what it is worth', async ({ signedIn: page, ledger }) => {
	await visit(page, `${ledger}/files`);
	page.once('dialog', (d) => void d.accept('shares.rupee'));
	await page.getByRole('button', { name: 'New file' }).click();
	await page.getByLabel('Ledger file').fill(ledgerFile);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

	await visit(page, `${ledger}/accounts`);
	await expect(page.getByRole('row', { name: 'Assets:Zerodha' })).toContainText(
		'10800.00 (excludes 1 unpriced)',
	);
	const infy = page.getByRole('row').filter({ hasText: 'INFY' });
	for (const cell of ['6.00 INFY', '9000.00', '1800.00', '10800.00', '1800.00'])
		await expect(infy).toContainText(cell);
	await expect(page.getByRole('row').filter({ hasText: 'TCS' })).toContainText('unpriced');

	await page.getByRole('link', { name: 'INFY' }).click();
	await expect(page.getByRole('heading', { name: 'INFY in Assets:Zerodha' })).toBeVisible();
	await expect(page.getByRole('article', { name: 'Lot of 2026-01-02' })).toContainText(
		'buy at shares.rupee:1, 6.00 left',
	);
	await expect(page.getByRole('row').filter({ hasText: 'sale' })).toContainText('800.00');
});
