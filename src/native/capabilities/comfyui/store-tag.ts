/**
 * P5 persistence catalog: every JSON document a store writes carries `format`/`version` so a reader can tell which
 * layout it is looking at. Readers stay tolerant: a missing tag is a legacy document and loads as-is; an unknown
 * version logs and continues instead of throwing.
 */
export interface StoreTag { format?: string; version?: number }

/** Log-and-continue on an unknown document version; the next save rewrites the document at the current version. */
export function warnUnknownStoreVersion(store: string, document: unknown): void {
  const version = (document as StoreTag | null)?.version;
  if (version !== undefined && version !== 1) console.error("ALPHA_STORE_VERSION_UNKNOWN", store, version);
}
