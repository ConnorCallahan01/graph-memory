/**
 * Observer pipeline worker (v3).
 *
 * Replaces the v2 scribe. Single LLM pass that watches the conversation
 * and produces:
 *   - observations (global + project)
 *   - session logs
 *   - graph node upserts
 *
 * This is an empty shell for Phase 0 — behavior will be implemented in Phase 1.
 */

export interface ObserverResult {
  observationsCreated: number;
  sessionLogged: boolean;
  nodesUpserted: number;
  errors: string[];
}

export async function runObserver(_payload: {
  sessionId: string;
  project: string;
  snapshotPath: string;
  assistantTracePath?: string;
  toolTracePath?: string;
}): Promise<ObserverResult> {
  // Phase 1 implementation
  return {
    observationsCreated: 0,
    sessionLogged: false,
    nodesUpserted: 0,
    errors: [],
  };
}
