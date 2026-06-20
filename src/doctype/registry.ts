/**
 * doc_type vocabulary management (design §9.5).
 *
 * doc_type is not a free-for-all string: a loose default list keeps spelling
 * convergent ("学校手紙" not also "学校のお便り"/"プリント") so per-type rules
 * (dedup behavior, default expiry estimation) stay writable. New types are still
 * allowed, but tools surface the existing vocabulary so callers reuse it.
 */

export interface DocTypeSpec {
  /** Canonical name. */
  name: string;
  /** Human description, also fed to the extraction prompt. */
  description: string;
  /**
   * If true, every version is history (each year's tax notice, past spending),
   * so register never supersedes prior entries via dedup (§9.1).
   */
  keepHistory: boolean;
  /** Hint for how `valid_until` should be estimated during extraction. */
  expiryHint: string;
}

/** Built-in starter vocabulary. Extend by editing this list as usage grows. */
export const DEFAULT_DOC_TYPES: DocTypeSpec[] = [
  { name: "保証書", description: "家電・製品の保証書", keepHistory: false, expiryHint: "保証終了日を valid_until に" },
  { name: "自治体通知", description: "自治体からの通知・プリント", keepHistory: false, expiryHint: "対応期限や有効期限があれば valid_until に" },
  { name: "学校手紙", description: "学校・園からのお便り", keepHistory: false, expiryHint: "提出期限やイベント開催日を valid_until に" },
  { name: "イベント案内", description: "イベント・行事の案内", keepHistory: false, expiryHint: "開催日を valid_until に" },
  { name: "連絡先", description: "電話番号・連絡先テンプレ", keepHistory: false, expiryHint: "通常は無期限（9999-12-31）" },
  { name: "料金プラン", description: "サブスク・固定費の現行プラン", keepHistory: false, expiryHint: "通常は無期限。改定時は更新で差し替え" },
  { name: "確定申告メモ", description: "確定申告・税務メモ", keepHistory: true, expiryHint: "年度情報。無期限で履歴として保持" },
  { name: "固定資産税", description: "各年の固定資産税額", keepHistory: true, expiryHint: "年度情報。無期限で履歴として保持" },
  { name: "支出記録", description: "家計・支出の記録", keepHistory: true, expiryHint: "履歴として保持" },
  { name: "日記", description: "日記・ライフログ", keepHistory: true, expiryHint: "履歴として保持" },
  { name: "メモ", description: "その他の一般メモ", keepHistory: false, expiryHint: "判断できなければ無期限" },
];

export class DocTypeRegistry {
  private readonly byName = new Map<string, DocTypeSpec>();

  constructor(specs: DocTypeSpec[] = DEFAULT_DOC_TYPES) {
    for (const spec of specs) this.byName.set(spec.name, spec);
  }

  list(): DocTypeSpec[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string | null | undefined): DocTypeSpec | undefined {
    return name ? this.byName.get(name) : undefined;
  }

  /** Whether a doc_type preserves history (and so is never auto-superseded). */
  keepsHistory(name: string | null | undefined): boolean {
    return this.get(name)?.keepHistory ?? false;
  }

  /** Known vocabulary plus whether the given type is new (for caller guidance). */
  isKnown(name: string | null | undefined): boolean {
    return !!name && this.byName.has(name);
  }
}
