/**
 * Core types for Session Logs (Layer 3).
 *
 * Session logs are factual records of recent sessions per project.
 * They expire in 7-30 days based on age.
 * Storage: sessions/{project}.jsonl
 */
export interface SessionLog {
  id: string;
  project: string;
  sessionId: string;
  timestamp: string;
  activeWork: string[];
  shipped: string[];
  decisions: string[];
  blocked: string[];
  openThreads: string[];
  correctionsGiven: string[];
  nextSessionShould: string;
}
