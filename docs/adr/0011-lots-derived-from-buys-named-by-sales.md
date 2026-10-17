# Lots are derived from buys and named by sales

A buy is an ordinary priced posting: `Assets:Zerodha  10 INFY @ 1500` opens a lot of 10 INFY at a cost of 1500 each. Nothing in the file names the lot; Rupee derives it. A posting that gains units with no price, balanced by a category or Equity (a bonus, an opening balance), opens a lot at zero cost.

A sale names the lot it takes from with a **lot cost**, and states its gain:

```
2025-03-01 Sell
    Assets:Zerodha   -4 INFY {1500} @ 1700
    Assets:Bank       6800
    Income:Gains     -800
```

A posting with a lot cost weighs its cost, not its price, so the transaction only balances when the gain is right. `{1500}` takes the oldest open lot with that cost; `{1500, 2024-06-03}` picks one by date. The `@` is optional and only feeds prices. What a sale names is the truth: Rupee does not check it against FIFO or any other booking rule. A sale is a posting taking units out against another commodity; one without a lot cost, or naming a lot that is not open or not large enough, is a ledger problem.

A transfer or a gift takes units out against the same commodity, so it has no gain to state. It may name a lot; otherwise it takes the oldest. A commodity whose units net to zero in a transaction is moving in kind, so its lot costs do not weigh. A transfer opens lots in the receiving account that keep their original date and cost. Selling units an account does not hold opens a negative lot at the sale's price, and the buy that covers it names that lot like a sale.

Market prices are `P 2026-10-17 INFY 1820` lines, ledger's syntax, alongside every `@` price. The latest on or before a date wins; on the same date a `P` line beats an `@`.

Lots and disposals are kept in the index and rebuilt, on every change, for each commodity whose postings changed: a transfer crosses accounts, so a commodity is booked across all of them at once. A sale or move no open lot covers is kept as a disposal from no lot, and reported as a problem.

## Considered Options

- **Derive everything, write nothing** (sales are `-4 INFY @ 1700`, gains computed): no new syntax, but gains never reach the books, so assets and income disagree in rupees by every gain. Adding a forgotten old buy silently changes a gain that may already be filed, and a sale cannot be kept as it was booked.
- **Write the gain, derive the cost**: gains are in the file, but whether a transaction balances depends on every other file, and keeping a sale as booked leaves its gain and the remaining lots contradicting each other.
- **Optional lot costs, with a "close the year" step that writes them**: no noise for anyone who does not care, but two kinds of sale and a step that only some users ever see.
- **Lot costs everywhere** (as Beancount does): transfers would repeat each lot's cost on both sides, for no gain to fix.

## Consequences

- Every sale carries a lot cost and a gain line, typed by hand until imports and a booking helper write them.
- A booked sale never changes when history is added; picking a specific lot comes for free.
- Lots exist only in balance accounts, for every commodity but currencies (ISO 4217 codes). Spending dollars on a US stock needs no lot cost, so the stock's cost stays in dollars and currency gains go untracked. Tracking them later means pricing each foreign buy in rupees on its day, which adds lines to these files but changes none.
- FIFO for transfers needs a total order, so same-day postings in different files fall back to file key, then line, where balance assertions would call them unordered.
- Fees stay expenses. Counting them in cost belongs to tax reporting, which can find them in the lot's own transaction.
