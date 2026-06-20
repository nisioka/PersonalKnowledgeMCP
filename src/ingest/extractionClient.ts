/**
 * Client for the Python OCR + structure-extraction service (design §3/§4,
 * Phase 2). The heavy lifting (PaddleOCR, Anthropic extraction) lives in Python;
 * the TypeScript side just calls it over HTTP and stores the result.
 */
export interface IngestResult {
  full_text: string;
  doc_type: string | null;
  extracted: Record<string, unknown>;
  valid_until?: string;
  dedup_key?: string | null;
}

export interface IngestClient {
  /** OCR a file and extract structured metadata from it. */
  ingestFile(buffer: Buffer, filename: string, mimeType: string): Promise<IngestResult>;
  /** Extract structured metadata from already-text content. */
  extractText(fullText: string, docTypeHint?: string | null): Promise<IngestResult>;
}

export class HttpIngestClient implements IngestClient {
  constructor(private readonly baseUrl: string) {}

  async ingestFile(buffer: Buffer, filename: string, mimeType: string): Promise<IngestResult> {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/ingest`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`ingest service /ingest failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as IngestResult;
  }

  async extractText(fullText: string, docTypeHint?: string | null): Promise<IngestResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_text: fullText, doc_type_hint: docTypeHint ?? null }),
    });
    if (!res.ok) throw new Error(`ingest service /extract failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as IngestResult;
  }
}
