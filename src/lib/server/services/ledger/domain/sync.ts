type FileVersion = { key: string; version: string };

type IndexedFile = { key: string; version: string; indexer: number };

export type SyncPlan = { changed: string[]; gone: string[] };

/** Goes up whenever indexing changes what it makes of a file, so sync indexes every file again. */
export const INDEXER = 3;

/** Which stored files to index again, as they are new, at another version or indexed by an older indexer, and which indexed files are gone. */
export const plan = (stored: FileVersion[], indexed: IndexedFile[]): SyncPlan => {
	const current = indexed.filter((f) => f.indexer === INDEXER);
	const versions = new Map(current.map((f) => [f.key, f.version]));
	const present = new Set(stored.map((f) => f.key));
	return {
		changed: stored.filter((f) => versions.get(f.key) !== f.version).map((f) => f.key),
		gone: indexed.filter((f) => !present.has(f.key)).map((f) => f.key),
	};
};
