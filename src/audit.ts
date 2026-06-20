/**
 * Minimal audit logging (design §9.3). The permission guard / request path is
 * the natural choke point, so every authenticated MCP request is logged with
 * who (token principal), when, and what. Phase 1 logs to stderr as one JSON line
 * per event; a durable sink can be added later without touching call sites.
 */
export interface AuditEvent {
  ts: string;
  principal: string;
  event: string;
  detail?: Record<string, unknown>;
}

export function audit(event: string, principal: string, detail?: Record<string, unknown>): void {
  const entry: AuditEvent = { ts: new Date().toISOString(), principal, event, detail };
  process.stderr.write(`[audit] ${JSON.stringify(entry)}\n`);
}
