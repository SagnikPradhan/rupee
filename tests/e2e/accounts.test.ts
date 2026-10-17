import { expect, test } from './support/test.ts';
import { visit } from './support/visit.ts';

const ledgerFile = [
	'2026-01-02 Buy',
	'\tAssets:Zerodha 10 INFY @ 1500',
	'\tAssets:Bank',
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
		'18000.00 (excludes 1 unpriced)',
	);
	const infy = page.getByRole('row').filter({ hasText: 'INFY' });
	for (const cell of ['10.00 INFY', '15000.00', '1800.00', '18000.00', '3000.00'])
		await expect(infy).toContainText(cell);
	await expect(page.getByRole('row').filter({ hasText: 'TCS' })).toContainText('unpriced');
});
