export interface GraphNode {
  group: 'nodes'
  data: {
    id: string
    label: string
    category: string
    gist: string
    confidence: number
    soma_intensity: number
    tags: string[]
    project: string | null
    access_count: number
    updated: string
    last_accessed: string
  }
}

export interface GraphEdge {
  group: 'edges'
  data: {
    id: string
    source: string
    target: string
    weight?: number
    edgeType?: string
    anti?: boolean
    reason?: string
  }
}

export type GraphElement = GraphNode | GraphEdge

export interface GraphData {
  elements: GraphElement[]
  nodeCount: number
}

export interface NodeDetail {
  frontmatter: Record<string, any>
  content: string
  raw: string
  indexEntry?: Record<string, any>
}

export interface ActiveProjectInfo {
  name: string
  sessionCount: number
  gitRoot?: string
  cwd?: string
  startedAt?: string
}

export interface PipelineStatus {
  graphRoot: string
  initialized: boolean
  activeProject: string
  activeProjects: ActiveProjectInfo[]
  nodeCount: number
  archiveCount: number
  bufferCount: number
  bufferByProject: Array<{ project: string; count: number; sessionId: string; updatedAt: string }>
  pendingDreams: number
  queuedJobs: number
  runningJobs: number
  failedJobs: number
  noopJobs: number
  rawFailedJobs: number
  completedJobs: number
  jobCounts: Record<string, Record<string, number>>
  pipelineCutoffs: Array<{
    stage: 'scribe' | 'working_update' | 'auditor' | 'librarian' | 'dreamer' | 'observer' | 'compressor' | 'skillforge' | 'memory_analysis'
    current: number
    threshold: number | null
    remaining: number | null
    status: 'counting' | 'ready' | 'queued' | 'running' | 'waiting' | 'idle'
    detail: string
  }>
  warnings: string[]
  runtime: {
    mode: 'manual' | 'docker'
    graphRoot: string
    docker: null | {
      enabled?: boolean
      workerProvider?: 'codex'
      image?: string
      containerName?: string
      authVolume?: string
      graphRootInContainer?: string
      authPathInContainer?: string
      memoryLimit?: string
      cpuLimit?: string
      repoMounts?: Array<{ hostPath: string; containerPath: string; mode: 'ro' | 'rw' }>
      state?: {
        Running?: boolean
        Health?: { Status?: string }
        StartedAt?: string
        Error?: string
        [key: string]: unknown
      }
      codexAuth?: {
        ready?: boolean
        status?: string
        error?: string
      }
    }
    daemonState?: Record<string, unknown> | null
    daemonLockPresent?: boolean
  }
}

export interface ActivityEvent {
  type: string
  message: string
  details?: Record<string, unknown>
  timestamp: string
}

export interface DeltaSummary {
  filename: string
  sessionId: string
  scribes: number
  deltas: number
  timestamp: string | null
}

export interface DreamEntry {
  filename: string
  bucket: string
  type?: string
  fragment?: string
  content?: string
  confidence?: number
  dream_refs?: string[]
  [key: string]: unknown
}

export interface DreamsData {
  pending: DreamEntry[]
  integrated: DreamEntry[]
  archived: DreamEntry[]
}

export interface AuditData {
  brief: string | null
  report: any | null
}

export interface PipelineJob {
  id: string
  type: string
  state: 'queued' | 'running' | 'done' | 'failed'
  displayState: 'queued' | 'running' | 'done' | 'failed' | 'noop'
  createdAt: string
  updatedAt: string
  startedAt: string
  completedAt: string | null
  attempt: number
  maxAttempts: number
  triggerSource: string
  idempotencyKey: string
  payload: Record<string, unknown>
  logFile: string | null
  logPath: string | null
  logFilename: string | null
  lastError?: string
  displayMessage?: string | null
  workerPid?: number
  durationMs: number
  logExists: boolean
  logSize: number
  logTail: string
}

export interface ProjectWorkingFile {
  project: string
  slug: string
  updatedAt: string
  path: string
  content: string
  sessionCount: number
}

export interface SkillforgeManifest {
  source_node: string
  skill_name: string
  generated_at: string
  score: number
  project: string
  project_root: string | null
  content_hash: string
  files: {
    claude_command: string
    opencode_command: string
  }
  reference_nodes: string[]
  refresh_count: number
  last_refreshed_at: string | null
}

export interface WorkerLogSummary {
  filename: string
  size: number
  updatedAt: string
  preview: string
  parsed?: {
    stage: string | null
    model: string | null
    sessionId: string | null
    workdir: string | null
    approval: string | null
    sandbox: string | null
    provider: string | null
    reasoningEffort: string | null
    task: string | null
    codexNotes: string[]
    recentSteps: string[]
  }
}

export interface WorkerLogDetail extends WorkerLogSummary {
  content: string
}

export interface StartupContextLayer {
  id: 'priors' | 'soma' | 'map' | 'working_global' | 'working_project' | 'dreams'
  label: string
  subtitle: string
  owner: 'librarian' | 'dreamer'
  injected: boolean
  updatedAt: string | null
  tokens: number
  content: string
}

export interface StartupPinnedNode {
  path: string
  title: string
  gist: string
  project: string
  updatedAt: string | null
  tokens: number
  contentPreview: string
}

export interface StartupContext {
  graphRoot: string
  activeProject: string
  totalTokens: number
  layers: StartupContextLayer[]
  pinnedNodes: StartupPinnedNode[]
  allPinnedNodeCount: number
}

export interface MemoryHealth {
  nodeCount: number
  archiveCount: number
  staleCount: number
  orphanCount: number
  categories: Record<string, number>
  mapTokens: number
  mapBudget: number
  mapUsage: number
  balanceDominant: { category: string; ratio: number } | null
  score: number
  lowConfidenceCount: number
  lowConfidenceRatio: number
  pipelineStats: { scribe: number; auditor: number; librarian: number; dreamer: number; skillforge: number; failed: number }
  tokenAccounting: {
    priors: number
    priorsBudget: number
    map: number
    mapBudget: number
    soma: number
    somaBudget: number
    dreams: number
    dreamsBudget: number
    working: number
    workingBudget: number
    pinned: number
    pinnedCount: number
    pinnedBudget: number
    total: number
    budget: number
    overBudget: boolean
    efficiency: number
  }
}

export interface LatestBrief {
  date: string
  updatedAt: string | null
  markdown: string
  json: {
    start_here?: string[]
    yesterday?: string[]
    open_loops?: string[]
    seven_day_trends?: string[]
    agent_friction?: string[]
    suggested_claude_updates?: string[]
    suggested_memory_updates?: string[]
    one_thing_today?: string
    project_breakdown?: Array<{
      project: string
      claude_file_path?: string | null
      yesterday?: string[]
      open_loops?: string[]
      agent_friction?: string[]
      suggested_claude_updates?: string[]
      suggested_claude_update_blocks?: string[]
      suggested_memory_updates?: string[]
    }>
    [key: string]: unknown
  } | null
}

export interface SessionTraceEvent {
  type: string
  timestamp: string
  toolName?: string
  accessKind?: 'read' | 'write' | 'search' | 'execute' | 'mcp' | 'unknown'
  project?: string
  cwd?: string
  success?: boolean | null
  durationMs?: number | null
  commandPreview?: string | null
  argsPreview?: Record<string, unknown> | null
  targetPaths?: string[]
  outputPreview?: unknown
  errorPreview?: unknown
  rawKeys?: string[]
  kind?: 'intermediate' | 'final'
  text?: string
  source?: 'claude_session_log' | 'stop_hook'
  assistantUuid?: string
}

export interface SessionTraceSummary {
  sessionId: string
  updatedAt: string
  project: string
  cwd: string | null
  eventCount: number
  tools: string[]
  targets: string[]
  lastEvents: SessionTraceEvent[]
}

export interface ProjectSummary {
  name: string
  nodeCount: number
  lastUpdated: string | null
  categories: Record<string, number>
  hasWorking: boolean
  workingPreview: string | null
  workingUpdatedAt: string | null
  sessionCount: number
}

export interface ProjectsData {
  projects: ProjectSummary[]
  global: {
    nodeCount: number
    categories: Record<string, number>
  }
  totalNodes: number
  totalProjects: number
}

export async function fetchProjects(): Promise<ProjectsData> {
  const res = await fetch('/api/projects')
  if (!res.ok) return { projects: [], global: { nodeCount: 0, categories: {} }, totalNodes: 0, totalProjects: 0 }
  return res.json()
}

export async function fetchPipeline(): Promise<PipelineJob[]> {
  const res = await fetch('/api/pipeline')
  if (!res.ok) return []
  return res.json()
}

export async function fetchLogs(): Promise<WorkerLogSummary[]> {
  const res = await fetch('/api/logs')
  if (!res.ok) return []
  return res.json()
}

export async function fetchLogDetail(filename: string): Promise<WorkerLogDetail> {
  const res = await fetch(`/api/logs/${encodeURIComponent(filename)}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchLatestBrief(): Promise<LatestBrief | null> {
  const res = await fetch('/api/briefs/latest')
  if (!res.ok) return null
  return res.json()
}

export async function fetchSessionTraces(): Promise<SessionTraceSummary[]> {
  const res = await fetch('/api/session-traces')
  if (!res.ok) return []
  return res.json()
}

export async function fetchActivity(limit = 200): Promise<ActivityEvent[]> {
  const res = await fetch(`/api/activity?limit=${limit}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchDeltas(): Promise<DeltaSummary[]> {
  const res = await fetch('/api/deltas')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchDeltaDetail(sessionId: string, audited = false): Promise<any> {
  const base = audited ? `/api/deltas/audited/${sessionId}` : `/api/deltas/${sessionId}`
  const res = await fetch(base)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchDreams(): Promise<DreamsData> {
  const res = await fetch('/api/dreams')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export interface ArchiveEntry {
  path: string
  gist: string
  tags: string[]
  confidence: number
  archived_reason: string
  archived_date: string | null
}

export async function fetchArchive(): Promise<ArchiveEntry[]> {
  const res = await fetch('/api/archive')
  if (!res.ok) return []
  return res.json()
}

export async function fetchGraph(): Promise<GraphData> {
  const res = await fetch('/api/graph')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchNode(path: string): Promise<NodeDetail> {
  const res = await fetch(`/api/node/${path}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchStatus(): Promise<PipelineStatus> {
  const res = await fetch('/api/status')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchMap(): Promise<string> {
  const res = await fetch('/api/map')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.text()
}

export async function fetchPriors(): Promise<string> {
  const res = await fetch('/api/priors')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.text()
}

export async function fetchSoma(): Promise<string> {
  const res = await fetch('/api/soma')
  if (!res.ok) return ''
  return res.text()
}

export async function fetchWorking(): Promise<string> {
  const res = await fetch('/api/working')
  if (!res.ok) return ''
  return res.text()
}

export async function fetchProjectWorkingFiles(): Promise<ProjectWorkingFile[]> {
  const res = await fetch('/api/working/projects')
  if (!res.ok) return []
  return res.json()
}

export async function fetchDreamsContext(): Promise<string> {
  const res = await fetch('/api/dreams-context')
  if (!res.ok) return ''
  return res.text()
}

export async function fetchAudit(): Promise<AuditData> {
  const res = await fetch('/api/audit')
  if (!res.ok) return { brief: null, report: null }
  return res.json()
}

export async function fetchAuditedDeltas(): Promise<DeltaSummary[]> {
  const res = await fetch('/api/deltas/audited')
  if (!res.ok) return []
  return res.json()
}

export async function fetchSkills(): Promise<SkillforgeManifest[]> {
  const res = await fetch('/api/skills')
  if (!res.ok) return []
  return res.json()
}

export async function fetchStartupContext(): Promise<StartupContext> {
  const res = await fetch('/api/startup-context')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchHealth(): Promise<MemoryHealth> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function updateNode(path: string, updates: { gist?: string; confidence?: number; tags?: string[] }): Promise<NodeDetail> {
  const res = await fetch(`/api/node/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function integrateDream(bucket: string, filename: string): Promise<void> {
  const res = await fetch(`/api/dreams/${bucket}/${filename}/integrate`, { method: 'POST' })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
}

export async function archiveDream(bucket: string, filename: string): Promise<void> {
  const res = await fetch(`/api/dreams/${bucket}/${filename}/archive`, { method: 'POST' })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
}

export interface MentalModel {
  version: number
  generatedAt: string
  cognitiveStyle: string
  decisionPatterns: string[]
  preferences: string[]
  guardrails: string[]
  emotionalProfile: string
  relationalNotes: string[]
  tokenEstimate: number
}

export interface ModelResponse {
  model: MentalModel
  lastCompressorRun: string
  observationCount: number
}

export interface WhisperResponse {
  whisper: string
  tokens: number
}

export async function fetchModel(): Promise<ModelResponse | null> {
  const res = await fetch('/api/v3/model')
  if (!res.ok) return null
  return res.json()
}

export async function fetchWhisper(): Promise<WhisperResponse | null> {
  const res = await fetch('/api/v3/whisper')
  if (!res.ok) return null
  return res.json()
}

export function subscribeToEvents(onEvent: (type: string) => void): () => void {
  const es = new EventSource('/api/events')
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (data.type === 'connected') {
        onEvent('graph')
        onEvent('status')
        return
      }
      onEvent(data.type)
    } catch {}
  }
  return () => es.close()
}
