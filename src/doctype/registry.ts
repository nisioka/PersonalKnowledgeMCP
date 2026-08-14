/**
 * doc_type vocabulary management (design §9.5).
 *
 * doc_type is a purely *semantic* label with no system behavior attached — the
 * behavior (superseding) is driven by each document's `lifecycle`, not its type.
 * The vocabulary is persisted in the `doc_types` table and starts EMPTY: it is
 * grown deliberately via `upsert_doc_type` as real usage reveals stable
 * categories, rather than seeded with guessed buckets. `register` accepts a
 * doc_type only when it is null or already in this vocabulary.
 */
import type { DB } from "../db/index.js";
import { type DocTypeSpec, type Lifecycle } from "../types.js";

export type { DocTypeSpec };

interface RawDocTypeRow {
  name: string;
  description: string;
  default_lifecycle: string;
  expiry_hint: string;
  source: string;
  created_at: string;
}

function parse(raw: RawDocTypeRow): DocTypeSpec {
  return {
    name: raw.name,
    description: raw.description,
    default_lifecycle: raw.default_lifecycle as Lifecycle,
    expiry_hint: raw.expiry_hint,
    source: raw.source as "builtin" | "user",
    created_at: raw.created_at,
  };
}

export interface UpsertDocType {
  name: string;
  description?: string;
  default_lifecycle?: Lifecycle;
  expiry_hint?: string;
}

/** DB-backed view of the doc_type vocabulary. */
export class DocTypeRegistry {
  constructor(private readonly db: DB) {}

  list(): DocTypeSpec[] {
    const rows = this.db
      .prepare(`SELECT * FROM doc_types ORDER BY name`)
      .all() as RawDocTypeRow[];
    return rows.map(parse);
  }

  names(): string[] {
    return (this.db.prepare(`SELECT name FROM doc_types ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
  }

  get(name: string | null | undefined): DocTypeSpec | undefined {
    if (!name) return undefined;
    const row = this.db.prepare(`SELECT * FROM doc_types WHERE name = ?`).get(name) as
      | RawDocTypeRow
      | undefined;
    return row ? parse(row) : undefined;
  }

  isKnown(name: string | null | undefined): boolean {
    return !!name && !!this.db.prepare(`SELECT 1 FROM doc_types WHERE name = ?`).get(name);
  }

  /** Create or update a vocabulary entry. Returns the resulting spec. */
  upsert(input: UpsertDocType): DocTypeSpec {
    const name = input.name.trim();
    if (name.length === 0) throw new Error("doc_type name is required");
    const existing = this.get(name);
    // Preserve an existing entry's provenance/created_at; new ones are 'user'.
    this.db
      .prepare(
        `INSERT INTO doc_types (name, description, default_lifecycle, expiry_hint, source)
           VALUES (@name, @description, @default_lifecycle, @expiry_hint, 'user')
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           default_lifecycle = excluded.default_lifecycle,
           expiry_hint = excluded.expiry_hint`,
      )
      .run({
        name,
        description: input.description ?? existing?.description ?? "",
        default_lifecycle: input.default_lifecycle ?? existing?.default_lifecycle ?? "singleton",
        expiry_hint: input.expiry_hint ?? existing?.expiry_hint ?? "",
      });
    return this.get(name) as DocTypeSpec;
  }

  /** Number of non-deleted documents currently labelled with `name`. */
  usageCount(name: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE doc_type = ? AND deleted = 0`)
      .get(name) as { n: number };
    return row.n;
  }

  /**
   * Remove a vocabulary entry. Refuses if documents still use it unless `force`.
   * Removing the entry never touches the documents themselves — their `doc_type`
   * label is free text and simply becomes "unknown" again.
   */
  remove(name: string, force = false): { removed: boolean; inUse: number } {
    const inUse = this.usageCount(name);
    if (inUse > 0 && !force) return { removed: false, inUse };
    const info = this.db.prepare(`DELETE FROM doc_types WHERE name = ?`).run(name);
    return { removed: info.changes > 0, inUse };
  }
}
