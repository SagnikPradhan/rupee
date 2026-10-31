# Architecture

A map of the code for someone new to it. [GLOSSARY.md](../GLOSSARY.md) has the domain terms, and the [ADRs](adr) say why things are this way.

## Files are the source of truth

A ledger is a folder of plain text files. Postgres holds an index of them: transactions, postings, lots and monthly totals, so pages can be answered by indexed queries instead of parsing files.

The index can always be rebuilt from the files. Anything a user would lose by deleting the database belongs in a file. Only what files can't hold lives in Postgres alone, like users and sessions.

Files can change without Rupea knowing, through an editor or a checkout. So reads never touch files or write the index: they read what the last sync left ([ADR 0026](adr/0026-sync-on-triggers-not-reads.md)).

## Layout

| Path                       | What it holds                                                |
| -------------------------- | ------------------------------------------------------------ |
| `src/routes`               | Pages                                                        |
| `src/lib/endpoints`        | Remote functions, which is all a page can call on the server |
| `src/lib/server/services`  | The services below                                           |
| `src/lib/server/shared`    | What belongs to no service: context, results, storage, ONNX  |
| `src/lib/server/db`        | The connection, migrations and query helpers                 |
| `src/lib/server/server.ts` | Everything that runs outside a request                       |
| `packages`                 | The website, and the theme it shares with the app            |

## Services

| Service      | What it owns                                                           |
| ------------ | ---------------------------------------------------------------------- |
| `auth`       | Users and sessions                                                     |
| `storage`    | Where each user's files live, and noticing when they change            |
| `ledger`     | Parsing and printing files, the index, and everything computed from it |
| `extraction` | Turning statements into draft ledger files                             |
| `refinement` | Suggesting matches between transactions                                |
| `jobs`       | The queue of background work                                           |
| `events`     | Announcing what happened to other services                             |

Services meet only through `application/`, and only a service touches its own tables ([ADR 0007](adr/0007-service-boundaries.md), [ADR 0012](adr/0012-services-own-their-tables.md)).

Each service has the same layers:

- **`domain/`**: pure rules and types, with no database or storage. The ledger's parser, printer and lot matching live here.
- **`application/`**: one orchestrator per thing the service owns, which calls the other two layers.
- **`adapters/`**: the outside world, such as queries, feeds and job definitions. Plain functions the application imports as a namespace (`DB.findLedger`).
- **`tests/`**: named after the layer and file they cover, like `application-sync.test.ts`.

Function names say what a function does: `find`, `list`, `read`, `create`, `save`, `delete`, `rename` ([ADR 0016](adr/0016-service-functions-names-and-shapes.md)).

## Context and errors

`createContext()` builds the database, storages, logger and the rest once. `hooks.server.ts` provides that context per request, and a function asks for what it needs with `withContext('db')((db) => ...)`, so nobody passes `db` through parameters.

A function that can fail returns a `ResultAsync` rather than throwing. Endpoints turn the result into a reply with `replyFrom`.

## A request

Opening a ledger's transactions goes through these steps:

1. The page calls `listTransactions` in `transactions.remote.ts`, which validates its input.
2. `inLedger` checks that the signed-in user may open this ledger, and passes the `Ledger` on.
3. `Transactions.listTransactions` in `application/` calls `DB.listTransactions`.
4. The adapter runs one indexed query for one page. Lists page by keyset, on date, time and id, and filter in the database, so no request loads a whole ledger ([ADR 0015](adr/0015-lists-page-by-keyset-and-filter-in-the-database.md)).

Saving a file is the same up to `application/files.ts`. It writes to storage, then updates the index for that file before answering. If that fails, the next sync picks the file up.

## A sync

A sync brings the index up to date with the files, and it is the one way that happens outside Rupea's own writes. `syncIndex` in `application/sync.ts` does this:

1. **Lock.** Take the ledger's lock inside a transaction, so it is the only writer.
2. **Plan.** List storage and compare each file's version with the one indexed. A file also counts as changed if an older `INDEXER` read it.
3. **Index.** Parse each changed file, skipping transactions whose lines hash to one it already holds, and write only the rows that differ, and remove the rows of files that are gone. Each file runs in a savepoint, so one that fails is reported and leaves the others.
4. **Settle.** Work out what spans files for what the transactions that changed touched: which transactions a group leaves uncounted, if any of them names a group, then lots, and monthly totals and balance checks for the accounts and commodities they post to.
5. **Follow up.** After the lock, queue quote fetches and embed descriptions.

A transaction keeps its id through this while its date, time and description stay the same, so a page cursor stays valid.

## Work outside a request

`src/lib/server/server.ts` lists every job, subscription and loop, and `startServer` starts them.

**Event**: something a service announces it did, named in the past tense, with a valibot payload. `files-changed` says keys in a user's storage may have changed. Events are not stored, so one published as the process stops is lost ([ADR 0028](adr/0028-events-in-process.md)).

**Subscription**: what runs when an event is published, in the publisher's process and as the user the event names. One failing does not stop the others. Work that is slow or must outlive the process queues a job instead of running here.

**Loop**: work the server does until it stops, outside any request or job. One that stops early is logged and started again, after a delay that doubles up to a minute.

**Job**: work a service runs outside a request, in a worker process. Jobs are rows in the database, so they survive a restart. A failed job is tried again, and a job may run more than once, so running it again must be harmless. A partition makes jobs run one at a time, and a dedupe key stops a second copy being queued ([ADR 0010](adr/0010-background-jobs.md)).

To choose one:

- A request needs the answer: call the application function.
- Other services should react to something: publish an event.
- The work is slow, or must not be lost: queue a job.
- The work never ends, like watching a folder: run a loop.

All four meet when a file changes, whoever changed it:

1. The `publishChanges` loop watches each kind of storage, and publishes `files-changed` for each user whose files changed, at most once every quarter second.
2. The `syncChanged` subscription works out which ledgers those files belong to, and queues `sync-ledger` for each.
3. A worker runs the `sync-ledger` job. Its partition and dedupe key are the ledger, so one ledger syncs one at a time, and changes made while a sync waits join it.
4. The job runs the sync above.

## Database

Postgres is either the server at `DATABASE_URL`, or one Rupea starts itself from portable-pg ([ADR 0004](adr/0004-postgres-embedded-or-served.md)). Drizzle declares the tables and Kysely writes the queries ([ADR 0018](adr/0018-queries-with-kysely.md)). What is cheap to work out is derived, and what is not is stored ([ADR 0019](adr/0019-derive-what-is-cheap-store-what-is-not.md)).
