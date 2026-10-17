# Rupee

Rupee is a plain-text personal ledger. Bank, card and broker statements are imported into `.rupee` files, which stay the source of truth.

## Ledger

**Ledger**:
Everything one person or household records about their money, made up of ledger files.
_Avoid_: Book, journal

**Ledger file**:
A `.rupee` text file in a ledger; the files, not anything derived from them, are the truth.
_Avoid_: Journal file

**Transaction**:
A dated, described set of postings that balances to zero.
_Avoid_: Entry, record

**Posting**:
One line of a transaction moving an amount into or out of one account.
_Avoid_: Split, leg

**Account**:
A colon-separated name whose first segment is its account type.

**Account type**:
One of Assets, Liabilities, Income, Expenses or Equity; every account has exactly one.
_Avoid_: Root, prefix, category

**Commodity**:
What an amount is counted in: a currency, a share or a fund unit. An amount with none named is in rupees.
_Avoid_: Currency (one kind of commodity), asset, symbol

**Price**:
What a commodity is worth in another, per unit or in total: written on a posting, or as a `P` line for a market price. A transaction balances at its prices, each commodity on its own, except where a posting names a lot cost.
_Avoid_: Rate, cost basis (that is a lot cost)

**Balance account**:
An Assets or Liabilities account, where real money sits.
_Avoid_: Real account

**Balance assertion**:
A posting's claim of what its account holds at that point in time, counting everything before it in any file. A file is ordered by line; other files on the same day only by time.
_Avoid_: Balance check, closing balance

**Unordered posting**:
A posting in another file on the same day as a balance assertion, where one of the two has no time, so it could fall on either side.

**Category**:
An Income or Expenses account, describing what money was for rather than where it is.

**Metadata**:
A `key: value` fact attached to a ledger file, transaction or posting. Any key is allowed; the system acts only on keys it understands.
_Avoid_: Tag (a tag is one kind of metadata value), annotation, attribute

## Investments

**Lot**:
A batch of a commodity a balance account gained at one time, with what each unit cost. A buy's price is its cost.
_Avoid_: Tax lot, position, tranche

**Lot cost**:
The `{cost}` or `{cost, date}` a posting writes to name the lot it takes units from. A sale must name one; a transfer or gift may.
_Avoid_: Cost basis, book value

**Holding**:
Everything one account holds of one commodity, made up of its lots.
_Avoid_: Position, investment

**Disposal**:
Units taken out of a lot by a sale, a transfer, a gift or a buy covering a short. A sale's disposal has a gain; the others have none.
_Avoid_: Sale (only one kind), reduction, closing

**Sale**:
A posting taking units out of a holding against another commodity, balanced at its lot cost with the gain written beside it.
_Avoid_: Sell, redemption

**Transfer**:
A posting taking units out of a holding against the same commodity into another balance account; the lots move with their date and cost.
_Avoid_: Move

## Storage and access

**Storage**:
The place one user's files live, such as a local directory or a Drive folder. It holds every ledger that user owns.
_Avoid_: Root, drive, bucket, vault

**Owner**:
The user whose storage a ledger lives in.

**Member**:
A user other than the owner who has been granted a ledger.
_Avoid_: Collaborator, guest

**Handle**:
A ledger's permanent name, used to address it.
_Avoid_: Slug, ID

## Importing

**Source**:
Anything that reports money movements: a bank or card statement, a broker report, an order export.
_Avoid_: Provider, feed

**Statement**:
A file from a source, kept in the ledger it is imported into.

**Inbox**:
A ledger's statements that no ledger file cites yet.
_Avoid_: Queue, pending, unfiled

**Schema**:
A description of one kind of statement: how to recognise it, how to read it into records, and the account they belong to. It belongs to a ledger.
_Avoid_: Template, parser

**Built-in schema**:
A schema Rupee ships for a common source, copied into a ledger the first time an import with it is saved.
_Avoid_: Template, default schema

**Pattern**:
One of a schema's `match:` entries, recognising a statement by text in it (`text:` or `regex:`) or by its name (`file:`).
_Avoid_: Matcher, rule

**Path**:
Where a schema reads one value of a record: locators to find the cell, then transforms to read it.
_Avoid_: Selector, mapping

**Locator**:
One step of a path towards a cell, by column (`header:`, `col:`), by content (`text:`, `regex:`) or by an offset (`left:`, `below:`).
_Avoid_: Selector

**Transform**:
One step of a path turning the text of a cell into a value, like `date:` or `number`.
_Avoid_: Filter, converter

**Draft**:
The ledger file an import produces from a statement, reviewed and edited before it is saved.
_Avoid_: Preview

## Events

**Event**:
One real money movement, seen as a group of transactions from different sources that share an event ID.
_Avoid_: Duplicate group, merge, cluster

**Primary**:
The one member of an event whose postings count.
_Avoid_: Canonical, master

**Evidence**:
A member of an event that is kept but not counted.
_Avoid_: Duplicate, copy, shadow

**Duplicate**:
Not a separate concept: a re-imported transaction is evidence in an event whose members share a description.

**Refinement**:
The step that finds candidates among saved transactions and proposes events as a reviewable diff.
_Avoid_: Dedup, reconciliation

**Candidate**:
Two transactions refinement suggests might be one event.
_Avoid_: Match (before it is accepted)

**Broken event**:
An event whose members contradict each other, such as no primary or two primaries.

## Background work

**Job**:
A piece of work Rupee does for a user outside a request, like reading a statement they uploaded. Its user can see whether it is waiting, running, done or failed, and why.
_Avoid_: Task, queue item, message

**Partition**:
The jobs of one name that run one at a time, like the statements one user uploaded. A job names its partition with a key, its user's by default.
_Avoid_: Queue, lane, group

**Orchestrator**:
The part of the server that claims due jobs, dispatches each to a worker and settles how it ended: succeeded, retried or failed. A claim holds a lease the orchestrator renews until the job settles; a claim whose lease runs out is released, since its worker died.
_Avoid_: Scheduler, supervisor, dispatcher

**Worker**:
A child process of the server that runs the jobs the server claims, one at a time. Every replica runs up to `RUPEE_JOBS_WORKERS` of them, and one left idle for a while exits.
_Avoid_: Consumer, runner
