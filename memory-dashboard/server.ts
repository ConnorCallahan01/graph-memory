import express from 'express'
import cors from 'cors'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, resolve, relative } from 'path'
import { homedir } from 'os'
import { watch } from 'chokidar'
import matter from 'gray-matter'
import { spawnSync } from 'child_process'

const app = express()
app.use(express.json())
const PORT = Number.parseInt(process.env.MEMORY_DASHBOARD_API_PORT || process.env.PORT || '3001', 10)

type JobState = 'queued' | 'running' | 'done' | 'failed'
type JobType = 'scribe' | 'working_update' | 'auditor' | 'librarian' | 'dreamer' | 'dreamer_v3' | 'memory_analysis' | 'skillforge' | 'skillforge_refresh' | 'observer' | 'compressor' | 'bootstrap_project_doc' | 'notion_sync' | 'notion_inbound_triage' | 'notion_inbound_enrich'

interface RuntimeConfig {
  mode?: 'manual' | 'docker'
  graphRoot?: string
  docker?: {
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
  }
}

type StartupLayerId = 'priors' | 'soma' | 'map' | 'working_global' | 'working_project' | 'dreams'
  | 'global_whisper' | 'project_whisper' | 'session_log' | 'guardrails'

interface JobRecord {
  id: string
  type: JobType
  state: JobState
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  attempt: number
  maxAttempts: number
  triggerSource: string
  idempotencyKey: string
  payload: Record<string, unknown>
  logFile?: string
  lastError?: string
  workerPid?: number
}

interface ParsedWorkerLog {
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

interface ProjectWorkingFileSummary {
  project: string
  slug: string
  updatedAt: string
  path: string
  content: string
  sessionCount: number
}

interface PipelineCutoffStatus {
  stage: 'scribe' | 'working_update' | 'auditor' | 'librarian' | 'dreamer' | 'memory_analysis' | 'notion_sync'
  current: number
  threshold: number | null
  remaining: number | null
  status: 'counting' | 'ready' | 'queued' | 'running' | 'waiting' | 'idle'
  detail: string
}

const SCRIBE_INTERVAL = 10
const AUDITOR_SCRIBE_THRESHOLD = 5
const OBSERVER_SCRIBE_THRESHOLD = 3
const COMPRESSOR_OBSERVER_THRESHOLD = 5
const DAILY_ANALYSIS_HOUR_LOCAL = 7

const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

const corsOrigin = process.env.MEMORY_DASHBOARD_CORS_ORIGIN || 'http://localhost:5173'
app.use(cors({ origin: corsOrigin }))

function getPointerConfigPath(): string {
  return join(homedir(), '.graph-memory-config.yml')
}

function parseGraphRootFromPointer(raw: string): string | null {
  const match = raw.match(/^\s*graphRoot:\s*(.+?)\s*$/m)
  if (!match) return null
  const value = match[1].trim().replace(/^['"]|['"]$/g, '')
  return value || null
}

function getGraphRoot(): string {
  if (process.env.GRAPH_MEMORY_ROOT) return resolve(process.env.GRAPH_MEMORY_ROOT)
  const pointerPath = getPointerConfigPath()
  if (existsSync(pointerPath)) {
    try {
      const parsed = parseGraphRootFromPointer(readFileSync(pointerPath, 'utf-8'))
      if (parsed) return resolve(parsed)
    } catch {
      // fall through
    }
  }
  return join(homedir(), '.graph-memory')
}

function getPaths(graphRoot = getGraphRoot()) {
  return {
    graphRoot,
    index: join(graphRoot, '.index.json'),
    archiveIndex: join(graphRoot, '.archive-index.json'),
    nodes: join(graphRoot, 'nodes'),
    archive: join(graphRoot, 'archive'),
    logs: join(graphRoot, '.logs'),
    activityLog: join(graphRoot, '.logs', 'activity.jsonl'),
    deltas: join(graphRoot, '.deltas'),
    dreams: join(graphRoot, 'dreams'),
    map: join(graphRoot, 'MAP.md'),
    priors: join(graphRoot, 'PRIORS.md'),
    soma: join(graphRoot, 'SOMA.md'),
    working: join(graphRoot, 'WORKING.md'),
    workingRoot: join(graphRoot, 'working'),
    workingGlobal: join(graphRoot, 'working', 'global.md'),
    workingProjects: join(graphRoot, 'working', 'projects'),
    dreamsContext: join(graphRoot, 'DREAMS.md'),
    briefs: join(graphRoot, 'briefs'),
    dailyBriefs: join(graphRoot, 'briefs', 'daily'),
    auditBrief: join(graphRoot, '.audit-brief.md'),
    auditReport: join(graphRoot, '.audit-report.json'),
    runtimeConfig: join(graphRoot, '.runtime-config.json'),
    pipelineLogs: join(graphRoot, '.pipeline-logs'),
    activeProjects: join(graphRoot, '.active-projects'),
    sessions: join(graphRoot, '.sessions'),
    buffer: join(graphRoot, '.buffer'),
    jobs: {
      root: join(graphRoot, '.jobs'),
      queued: join(graphRoot, '.jobs', 'queued'),
      running: join(graphRoot, '.jobs', 'running'),
      done: join(graphRoot, '.jobs', 'done'),
      failed: join(graphRoot, '.jobs', 'failed'),
      daemonState: join(graphRoot, '.jobs', 'daemon-state.json'),
      daemonLock: join(graphRoot, '.jobs', 'daemon.lock'),
    },
    skillforge: join(graphRoot, '.skillforge'),
    mind: join(graphRoot, 'mind'),
    globalModel: join(graphRoot, 'mind', 'model.json'),
    globalWhisper: join(graphRoot, 'mind', 'whisper.txt'),
    lenses: join(graphRoot, 'lenses'),
    v3Sessions: join(graphRoot, 'sessions'),
  }
}

function safeJsonParse(filePath: string): any {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function readLegacyIndex(graphRoot = getGraphRoot()) {
  const indexPath = getPaths(graphRoot).index
  if (!existsSync(indexPath)) return []
  const parsed = safeJsonParse(indexPath)
  return Array.isArray(parsed) ? parsed : []
}

function isArchivedNodePath(nodePath: string): boolean {
  return nodePath === '.archive' ||
    nodePath.startsWith('.archive/') ||
    nodePath === 'archive' ||
    nodePath.startsWith('archive/')
}

function readIndex(graphRoot = getGraphRoot()) {
  return readLegacyIndex(graphRoot).filter((entry: any) => !isArchivedNodePath(entry.path || ''))
}

function readV3Index(graphRoot = getGraphRoot()) {
  const legacyEntries = readLegacyIndex(graphRoot)
  const entries: Record<string, any> = {}
  const categories: Record<string, string[]> = {}
  const projects: Record<string, string[]> = {}

  for (const entry of legacyEntries) {
    if (!entry?.path) continue
    if (isArchivedNodePath(entry.path)) continue
    const category = entry.category || entry.path.split('/')[0] || 'uncategorized'
    entries[entry.path] = { ...entry, category }
    if (!categories[category]) categories[category] = []
    categories[category].push(entry.path)
    if (entry.project) {
      if (!projects[entry.project]) projects[entry.project] = []
      projects[entry.project].push(entry.path)
    }
  }

  return { entries, categories, projects, builtAt: null, fallback: 'legacy-index' }
}

function updateNodeIndexes(graphRoot: string, nodePath: string, frontmatter: Record<string, any>) {
  const paths = getPaths(graphRoot)
  const patchEntry = (entry: any) => ({
    ...entry,
    gist: frontmatter.gist ?? entry.gist,
    confidence: frontmatter.confidence ?? entry.confidence,
    tags: frontmatter.tags ?? entry.tags ?? [],
    category: frontmatter.category ?? entry.category ?? nodePath.split('/')[0],
    project: frontmatter.project ?? entry.project,
    updated: frontmatter.updated ?? entry.updated,
    anti_pattern: frontmatter.anti_pattern ?? entry.anti_pattern,
  })

  const v2Index = safeJsonParse(paths.index)
  if (Array.isArray(v2Index)) {
    const next = v2Index.map((entry: any) => entry.path === nodePath ? patchEntry(entry) : entry)
    writeFileSync(paths.index, JSON.stringify(next, null, 2))
  }
}

function readNodeFile(nodePath: string) {
  return readNodeFileForGraph(getGraphRoot(), nodePath)
}

function readNodeFileForGraph(graphRoot: string, nodePath: string) {
  const { nodes } = getPaths(graphRoot)
  const fullPath = resolve(nodes, nodePath.endsWith('.md') ? nodePath : `${nodePath}.md`)
  if (!fullPath.startsWith(nodes)) return null
  if (!existsSync(fullPath)) return null
  const raw = readFileSync(fullPath, 'utf-8')
  const { data, content } = matter(raw)
  return { frontmatter: data, content: content.trim(), raw }
}

function walkNodeFiles(dir: string, prefix = ''): Array<{ nodePath: string; filePath: string }> {
  if (!existsSync(dir)) return []

  const files: Array<{ nodePath: string; filePath: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
      files.push(...walkNodeFiles(join(dir, entry.name), childPrefix))
      continue
    }

    if (!entry.name.endsWith('.md')) continue
    const nodePath = prefix ? `${prefix}/${entry.name.replace(/\.md$/, '')}` : entry.name.replace(/\.md$/, '')
    files.push({ nodePath, filePath: join(dir, entry.name) })
  }

  return files
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (String(entry).endsWith('.md')) count += 1
  }
  return count
}

function countActiveMarkdownFiles(dir: string): number {
  return walkNodeFiles(dir).filter(({ nodePath }) => !isArchivedNodePath(nodePath)).length
}

function countArchiveMarkdownFiles(graphRoot = getGraphRoot()): number {
  const paths = getPaths(graphRoot)
  return countMarkdownFiles(paths.archive) +
    countMarkdownFiles(join(paths.nodes, '.archive')) +
    countMarkdownFiles(join(paths.nodes, 'archive'))
}

function sanitizeProjectSlug(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9._-]+/g, '__') || 'global'
}

function getProjectWorkingPath(graphRoot = getGraphRoot(), projectName?: string): string | null {
  if (!projectName || projectName === 'global') return null
  return join(getPaths(graphRoot).workingProjects, `${sanitizeProjectSlug(projectName)}.md`)
}

function getProjectNameFromWorkingFilename(filename: string): string | null {
  if (!filename.endsWith('.md')) return null
  return filename.slice(0, -3).replace(/__/g, '/')
}

function listProjectWorkingFiles(graphRoot = getGraphRoot()): ProjectWorkingFileSummary[] {
  const dir = getPaths(graphRoot).workingProjects
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const project = getProjectNameFromWorkingFilename(file)
      if (!project) return null
      const slug = file.slice(0, -3)
      const filePath = join(dir, file)
      const statePath = join(dir, `${slug}.state.json`)
      const stat = statSync(filePath)
      const state = existsSync(statePath) ? safeJsonParse(statePath) : null
      return {
        project,
        slug,
        updatedAt: stat.mtime.toISOString(),
        path: filePath,
        content: readFileSync(filePath, 'utf-8'),
        sessionCount: Array.isArray(state?.sessions) ? state.sessions.length : 0,
      }
    })
    .filter((entry): entry is ProjectWorkingFileSummary => Boolean(entry))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function readTextTail(filePath: string, lineCount = 30): string {
  if (!existsSync(filePath)) return ''
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    return lines.slice(-lineCount).join('\n').trim()
  } catch {
    return ''
  }
}

function readTextPreview(filePath: string, lineCount = 8): string {
  if (!existsSync(filePath)) return ''
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    return lines.slice(0, lineCount).join('\n').trim()
  } catch {
    return ''
  }
}

function listDailyBriefFiles(graphRoot = getGraphRoot()) {
  const dir = getPaths(graphRoot).dailyBriefs
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => b.localeCompare(a))
}

function getLatestBrief(graphRoot = getGraphRoot()) {
  const files = listDailyBriefFiles(graphRoot)
  const latest = files[0]
  if (!latest) return null

  const markdownPath = join(getPaths(graphRoot).dailyBriefs, latest)
  const jsonPath = markdownPath.replace(/\.md$/, '.json')
  const markdown = existsSync(markdownPath) ? readFileSync(markdownPath, 'utf-8') : ''
  const json = existsSync(jsonPath) ? safeJsonParse(jsonPath) : null
  const stat = existsSync(markdownPath) ? statSync(markdownPath) : null

  return {
    date: latest.replace(/\.md$/, ''),
    updatedAt: stat ? stat.mtime.toISOString() : null,
    markdown,
    json,
  }
}

function listSessionTraces(graphRoot = getGraphRoot()) {
  const sessionsDir = getPaths(graphRoot).sessions
  if (!existsSync(sessionsDir)) return []

  return readdirSync(sessionsDir)
    .map((sessionId) => {
      const toolTracePath = join(sessionsDir, sessionId, 'tool-trace.jsonl')
      const assistantTracePath = join(sessionsDir, sessionId, 'assistant-trace.jsonl')
      if (!existsSync(toolTracePath) && !existsSync(assistantTracePath)) return null

      const readJsonLines = (filePath: string) => {
        if (!existsSync(filePath)) return []
        return readFileSync(filePath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line) } catch { return null }
          })
          .filter(Boolean)
      }

      const toolEvents = readJsonLines(toolTracePath)
      const assistantEvents = readJsonLines(assistantTracePath)
      const events = [...toolEvents, ...assistantEvents]
        .sort((a: any, b: any) => Date.parse(a.timestamp || '') - Date.parse(b.timestamp || ''))
      if (events.length === 0) return null

      const updatedAtMs = Math.max(
        existsSync(toolTracePath) ? statSync(toolTracePath).mtimeMs : 0,
        existsSync(assistantTracePath) ? statSync(assistantTracePath).mtimeMs : 0
      )
      const tools = [...new Set(toolEvents.map((event: any) => event.toolName).filter(Boolean))]
      const targets = [...new Set(toolEvents.flatMap((event: any) => Array.isArray(event.targetPaths) ? event.targetPaths : []))]

      return {
        sessionId,
        updatedAt: new Date(updatedAtMs).toISOString(),
        project: events[events.length - 1]?.project || 'global',
        cwd: events[events.length - 1]?.cwd || null,
        eventCount: events.length,
        tools,
        targets: targets.slice(0, 20),
        lastEvents: events.slice(-40),
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 30)
}

function countPendingDreams(graphRoot = getGraphRoot()): number {
  const pendingDir = join(getPaths(graphRoot).dreams, 'pending')
  if (!existsSync(pendingDir)) return 0
  return readdirSync(pendingDir).filter((file) => file.endsWith('.json')).length
}

function readBufferCount(graphRoot = getGraphRoot()): number {
  const bufferDir = join(getPaths(graphRoot).buffer)
  if (!existsSync(bufferDir)) return 0
  let total = 0
  for (const file of readdirSync(bufferDir)) {
    if (file.startsWith('conversation-') && file.endsWith('.jsonl')) {
      const content = readFileSync(join(bufferDir, file), 'utf-8').trim()
      total += content ? content.split('\n').filter(Boolean).length : 0
    }
  }
  return total
}

interface BufferProjectCount {
  project: string
  count: number
  sessionId: string
  updatedAt: string
}

function readBufferCountsByProject(graphRoot = getGraphRoot()): BufferProjectCount[] {
  const bufferDir = join(getPaths(graphRoot).buffer)
  if (!existsSync(bufferDir)) return []
  const byProject = new Map<string, { count: number; sessionId: string; updatedAt: string }>()
  for (const file of readdirSync(bufferDir)) {
    if (!file.startsWith('conversation-') || !file.endsWith('.jsonl')) continue
    const content = readFileSync(join(bufferDir, file), 'utf-8').trim()
    if (!content) continue
    const lines = content.split('\n').filter(Boolean)
    const sessionId = file.replace('conversation-', '').replace('.jsonl', '')
    let project = 'global'
    let latestTs = ''
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.project) project = entry.project
        if (entry.timestamp && entry.timestamp > latestTs) latestTs = entry.timestamp
      } catch {}
    }
    const existing = byProject.get(project)
    const count = lines.length
    if (!existing || count > existing.count) {
      byProject.set(project, { count: (existing?.count || 0) + count, sessionId, updatedAt: latestTs || new Date().toISOString() })
    } else {
      existing.count += count
      if (latestTs > existing.updatedAt) existing.updatedAt = latestTs
    }
  }
  return Array.from(byProject.entries())
    .map(([project, data]) => ({ project, ...data }))
    .sort((a, b) => b.count - a.count)
}

function readLatestActiveProjectEntry(graphRoot = getGraphRoot()): { name: string; gitRoot?: string; cwd?: string; updatedAt: string } | null {
  const activeProjectsDir = getPaths(graphRoot).activeProjects
  if (!existsSync(activeProjectsDir)) return null
  const files = readdirSync(activeProjectsDir).filter((file) => file.endsWith('.json'))
  let latest: { name: string; gitRoot?: string; cwd?: string; mtimeMs: number } | null = null

  for (const file of files) {
    const filePath = join(activeProjectsDir, file)
    const entry = safeJsonParse(filePath)
    if (!entry?.name) continue
    const mtimeMs = statSync(filePath).mtimeMs
    if (!latest || mtimeMs > latest.mtimeMs) {
      latest = { name: entry.name, gitRoot: entry.gitRoot, cwd: entry.cwd, mtimeMs }
    }
  }

  return latest
    ? { name: latest.name, gitRoot: latest.gitRoot, cwd: latest.cwd, updatedAt: new Date(latest.mtimeMs).toISOString() }
    : null
}

function readLatestTraceProject(graphRoot = getGraphRoot()): { name: string; cwd?: string; updatedAt: string } | null {
  const latestTrace = listSessionTraces(graphRoot)[0]
  if (!latestTrace?.project) return null
  return {
    name: latestTrace.project,
    cwd: latestTrace.cwd || undefined,
    updatedAt: latestTrace.updatedAt,
  }
}

function readLatestWorkingProject(graphRoot = getGraphRoot()): { name: string; updatedAt: string } | null {
  const dir = getPaths(graphRoot).workingProjects
  if (!existsSync(dir)) return null

  let latest: { name: string; updatedAt: string; mtimeMs: number } | null = null
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
    const name = getProjectNameFromWorkingFilename(file)
    if (!name) continue
    const filePath = join(dir, file)
    const stat = statSync(filePath)
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = { name, updatedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs }
    }
  }

  return latest ? { name: latest.name, updatedAt: latest.updatedAt } : null
}

function readActiveProject(graphRoot = getGraphRoot()): { name: string; gitRoot?: string } | null {
  const active = readLatestActiveProjectEntry(graphRoot)
  const trace = readLatestTraceProject(graphRoot)
  const working = readLatestWorkingProject(graphRoot)

  const activeTs = active ? Date.parse(active.updatedAt) : 0
  const traceTs = trace ? Date.parse(trace.updatedAt) : 0
  const workingTs = working ? Date.parse(working.updatedAt) : 0
  const freshnessCutoffMs = Date.now() - (12 * 60 * 60 * 1000)

  if (trace && traceTs >= freshnessCutoffMs && traceTs >= activeTs) {
    return { name: trace.name }
  }

  if (active && activeTs >= freshnessCutoffMs) {
    return { name: active.name, gitRoot: active.gitRoot }
  }

  if (working && workingTs >= activeTs) {
    return { name: working.name }
  }

  return active ? { name: active.name, gitRoot: active.gitRoot } : (trace ? { name: trace.name } : null)
}

function listAllActiveProjects(graphRoot = getGraphRoot()): Array<{ name: string; sessionCount: number; gitRoot?: string; cwd?: string; startedAt?: string }> {
  const activeProjectsDir = getPaths(graphRoot).activeProjects
  if (!existsSync(activeProjectsDir)) return []

  const projectMap = new Map<string, { name: string; sessionCount: number; gitRoot?: string; cwd?: string; startedAt?: string }>()

  for (const file of readdirSync(activeProjectsDir).filter((f) => f.endsWith('.json'))) {
    const entry = safeJsonParse(join(activeProjectsDir, file))
    if (!entry?.name) continue
    const existing = projectMap.get(entry.name)
    if (existing) {
      existing.sessionCount++
      if (entry.startedAt && (!existing.startedAt || entry.startedAt > existing.startedAt)) {
        existing.startedAt = entry.startedAt
      }
    } else {
      projectMap.set(entry.name, {
        name: entry.name,
        sessionCount: 1,
        gitRoot: entry.gitRoot,
        cwd: entry.cwd,
        startedAt: entry.startedAt,
      })
    }
  }

  return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function readJobs(state: JobState, graphRoot = getGraphRoot()): JobRecord[] {
  const dir = getPaths(graphRoot).jobs[state]
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => safeJsonParse(join(dir, file)))
    .filter(Boolean)
}

function isScribeNoop(job: Pick<JobRecord, 'type' | 'lastError'> | null | undefined): boolean {
  return job?.type === 'scribe' && /no new deltas|without writing any delta files/i.test(job.lastError || '')
}

function readAllJobs(graphRoot = getGraphRoot()) {
  const jobs = {
    queued: readJobs('queued', graphRoot),
    running: readJobs('running', graphRoot),
    done: readJobs('done', graphRoot),
    failed: readJobs('failed', graphRoot),
  }

  const byType: Record<JobType, Record<JobState, number>> = {
    scribe: { queued: 0, running: 0, done: 0, failed: 0 },
    working_update: { queued: 0, running: 0, done: 0, failed: 0 },
    auditor: { queued: 0, running: 0, done: 0, failed: 0 },
    librarian: { queued: 0, running: 0, done: 0, failed: 0 },
    dreamer: { queued: 0, running: 0, done: 0, failed: 0 },
    dreamer_v3: { queued: 0, running: 0, done: 0, failed: 0 },
    memory_analysis: { queued: 0, running: 0, done: 0, failed: 0 },
    skillforge: { queued: 0, running: 0, done: 0, failed: 0 },
    skillforge_refresh: { queued: 0, running: 0, done: 0, failed: 0 },
    observer: { queued: 0, running: 0, done: 0, failed: 0 },
    compressor: { queued: 0, running: 0, done: 0, failed: 0 },
    bootstrap_project_doc: { queued: 0, running: 0, done: 0, failed: 0 },
    notion_sync: { queued: 0, running: 0, done: 0, failed: 0 },
  }

  for (const state of Object.keys(jobs) as JobState[]) {
    for (const job of jobs[state]) {
      if (!byType[job.type]) byType[job.type] = { queued: 0, running: 0, done: 0, failed: 0 }
      byType[job.type][state] += 1
    }
  }

  const noopJobs = jobs.failed.filter((job) => isScribeNoop(job)).length
  const actionableFailedJobs = jobs.failed.length - noopJobs

  return {
    ...jobs,
    totals: {
      queued: jobs.queued.length,
      running: jobs.running.length,
      done: jobs.done.length,
      failed: actionableFailedJobs,
      rawFailed: jobs.failed.length,
      noop: noopJobs,
    },
    byType,
  }
}

function countActiveDeltaFiles(graphRoot = getGraphRoot()): number {
  const deltasDir = getPaths(graphRoot).deltas
  if (!existsSync(deltasDir)) return 0
  return readdirSync(deltasDir).filter((file) => file.endsWith('.json')).length
}

function latestJobTime(job: JobRecord): number {
  return Date.parse(job.completedAt || job.updatedAt || job.createdAt || '') || 0
}

function countCompletedScribesSinceLastAuditor(jobs: ReturnType<typeof readAllJobs>) {
  const latestAuditorMs = jobs.done
    .filter((job) => job.type === 'auditor')
    .map((job) => latestJobTime(job))
    .sort((a, b) => b - a)[0] || 0

  return jobs.done
    .filter((job) => job.type === 'scribe')
    .filter((job) => latestJobTime(job) > latestAuditorMs)
    .length
}

function countCompletedProjectScopedScribes(jobs: ReturnType<typeof readAllJobs>) {
  return jobs.done
    .filter((job) => job.type === 'scribe')
    .filter((job) => {
      const project = typeof job.payload?.project === 'string' ? job.payload.project : ''
      return Boolean(project && project !== 'global')
    })
    .length
}

function countCompletedScribesSinceLastObserver(jobs: ReturnType<typeof readAllJobs>) {
  const latestObserverMs = jobs.done
    .filter((job) => job.type === 'observer')
    .map((job) => latestJobTime(job))
    .sort((a, b) => b - a)[0] || 0

  return jobs.done
    .filter((job) => job.type === 'scribe')
    .filter((job) => latestJobTime(job) > latestObserverMs)
    .length
}

function countCompletedObserversSinceLastCompressor(jobs: ReturnType<typeof readAllJobs>) {
  const latestCompressorMs = jobs.done
    .filter((job) => job.type === 'compressor')
    .map((job) => latestJobTime(job))
    .sort((a, b) => b - a)[0] || 0

  return jobs.done
    .filter((job) => job.type === 'observer')
    .filter((job) => latestJobTime(job) > latestCompressorMs)
    .length
}

function countSkillforgeManifests(graphRoot = getGraphRoot()): number {
  const dir = getPaths(graphRoot).skillforge
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length
}

function hasJobInFlight(jobs: ReturnType<typeof readAllJobs>, type: JobType): 'running' | 'queued' | null {
  if (jobs.running.some((job) => job.type === type)) return 'running'
  if (jobs.queued.some((job) => job.type === type)) return 'queued'
  return null
}

function buildPipelineCutoffs(graphRoot = getGraphRoot(), jobs = readAllJobs(graphRoot)): PipelineCutoffStatus[] {
  const bufferCount = readBufferCount(graphRoot)
  const activeDeltaFiles = countActiveDeltaFiles(graphRoot)
  const completedScribesSinceAuditor = countCompletedScribesSinceLastAuditor(jobs)
  const completedScribesSinceObserver = countCompletedScribesSinceLastObserver(jobs)
  const completedObserversSinceCompressor = countCompletedObserversSinceLastCompressor(jobs)
  const completedProjectScopedScribes = countCompletedProjectScopedScribes(jobs)
  const hasProjectWorkingHandoffs = listProjectWorkingFiles(graphRoot).some((file) => file.sessionCount > 0)
  const scribeState = hasJobInFlight(jobs, 'scribe')
  const workingUpdateState = hasJobInFlight(jobs, 'working_update')
  const auditorState = hasJobInFlight(jobs, 'auditor')
  const librarianState = hasJobInFlight(jobs, 'librarian')
  const dreamerState = hasJobInFlight(jobs, 'dreamer')
  const observerState = hasJobInFlight(jobs, 'observer')
  const compressorState = hasJobInFlight(jobs, 'compressor')
  const analysisState = hasJobInFlight(jobs, 'memory_analysis')
  const skillforgeState = hasJobInFlight(jobs, 'skillforge')
  const skillforgeRefreshState = hasJobInFlight(jobs, 'skillforge_refresh')
  const skillforgeCompleted = jobs.byType.skillforge.done
  const skillforgeRefreshCompleted = jobs.byType.skillforge_refresh.done
  const skillforgeManifestCount = countSkillforgeManifests(graphRoot)
  const now = new Date()
  const analysisReady = now.getHours() >= DAILY_ANALYSIS_HOUR_LOCAL
  const todaysBriefExists = (() => {
    const today = new Date().toISOString().slice(0, 10)
    return existsSync(join(getPaths(graphRoot).dailyBriefs, `${today}.md`))
  })()

  const notionSyncJobState = hasJobInFlight(jobs, 'notion_sync')
  const notionSyncEnabled = (() => {
    const configPath = join(graphRoot, 'config.yml')
    if (!existsSync(configPath)) return false
    const raw = readFileSync(configPath, 'utf-8')
    return /notionSync\.enabled:\s*true/i.test(raw)
  })()
  const notionSyncStateFile = (() => {
    const statePath = join(graphRoot, '.notion-sync-state.json')
    if (!existsSync(statePath)) return null
    try { return JSON.parse(readFileSync(statePath, 'utf-8')) } catch { return null }
  })()
  const notionLastSyncAt = notionSyncStateFile?.lastSyncAt ? new Date(notionSyncStateFile.lastSyncAt) : null
  const notionSyncHour = notionSyncStateFile?.syncHourLocal ?? 8
  const notionPageCount = notionSyncStateFile?.pages ? Object.keys(notionSyncStateFile.pages).length : 0
  const notionRowCount = notionSyncStateFile?.databases
    ? Object.values(notionSyncStateFile.databases as Record<string, { rowCount?: number }>).reduce((s: number, d: { rowCount?: number }) => s + (d.rowCount ?? 0), 0)
    : 0

  return [
    {
      stage: 'scribe',
      current: bufferCount,
      threshold: SCRIBE_INTERVAL,
      remaining: Math.max(0, SCRIBE_INTERVAL - bufferCount),
      status: scribeState || (bufferCount >= SCRIBE_INTERVAL ? 'ready' : 'counting'),
      detail: scribeState
        ? `Snapshot threshold reached. Scribe is ${scribeState}.`
        : bufferCount >= SCRIBE_INTERVAL
          ? 'Ready to rotate the next 10-message snapshot.'
          : `${bufferCount} of ${SCRIBE_INTERVAL} canonical messages buffered. ${Math.max(0, SCRIBE_INTERVAL - bufferCount)} more until the next snapshot.`,
    },
    {
      stage: 'working_update',
      current: completedProjectScopedScribes,
      threshold: null,
      remaining: null,
      status: workingUpdateState || (jobs.byType.working_update.done > 0 || hasProjectWorkingHandoffs ? 'idle' : completedProjectScopedScribes > 0 ? 'waiting' : 'idle'),
      detail: workingUpdateState
        ? `Working updater is ${workingUpdateState} on the latest repo handoff.`
        : hasProjectWorkingHandoffs
          ? 'Repo-specific WORKING handoffs already exist. Future working-updater passes will keep them fresh after successful project-scoped scribes.'
        : jobs.byType.working_update.done > 0
          ? 'Repo-specific WORKING handoffs are being maintained after scribe completion.'
          : completedProjectScopedScribes > 0
            ? 'Project-scoped scribes exist, but no working-updater completion has been recorded yet. Scribes are session snapshots; only sessions tagged with a project feed repo WORKING handoffs.'
            : 'No project-scoped scribes have completed yet. Global-only sessions do not create repo WORKING handoffs.',
    },
    {
      stage: 'auditor',
      current: completedScribesSinceAuditor,
      threshold: AUDITOR_SCRIBE_THRESHOLD,
      remaining: Math.max(0, AUDITOR_SCRIBE_THRESHOLD - completedScribesSinceAuditor),
      status: auditorState || (activeDeltaFiles === 0 ? 'idle' : completedScribesSinceAuditor >= AUDITOR_SCRIBE_THRESHOLD ? 'ready' : 'counting'),
      detail: auditorState
        ? `Auditor is ${auditorState} on the current scribe backlog.`
        : activeDeltaFiles === 0
          ? 'Waiting for fresh scribe deltas before audit can run.'
          : completedScribesSinceAuditor >= AUDITOR_SCRIBE_THRESHOLD
            ? 'Enough successful scribes have accumulated. Auditor is ready.'
            : `${completedScribesSinceAuditor} of ${AUDITOR_SCRIBE_THRESHOLD} successful scribes since the last audit. ${Math.max(0, AUDITOR_SCRIBE_THRESHOLD - completedScribesSinceAuditor)} more needed. ${activeDeltaFiles} active delta file${activeDeltaFiles === 1 ? '' : 's'} on disk.`,
    },
    {
      stage: 'librarian',
      current: 0,
      threshold: null,
      remaining: null,
      status: librarianState || (auditorState ? 'waiting' : activeDeltaFiles > 0 ? 'waiting' : 'idle'),
      detail: librarianState
        ? `Librarian is ${librarianState} to rebuild core memory artifacts.`
        : auditorState
          ? 'Waiting for auditor to finish and hand off the audited delta set.'
          : activeDeltaFiles > 0
            ? 'Fresh deltas exist, but librarian cannot run until auditor completes.'
            : 'No audited delta set is ready for librarian yet.',
    },
    {
      stage: 'dreamer',
      current: 0,
      threshold: null,
      remaining: null,
      status: dreamerState || (librarianState ? 'waiting' : jobs.done.some((job) => job.type === 'librarian') ? 'waiting' : 'idle'),
      detail: dreamerState
        ? `Dreamer is ${dreamerState} on the latest librarian output.`
        : librarianState
          ? 'Waiting for librarian to finish before speculative recombination can run.'
          : jobs.done.some((job) => job.type === 'librarian')
            ? 'Dreamer runs after each fresh librarian completion.'
            : 'No fresh librarian pass yet, so dreamer is idle.',
    },
    {
      stage: 'observer',
      current: completedScribesSinceObserver,
      threshold: OBSERVER_SCRIBE_THRESHOLD,
      remaining: Math.max(0, OBSERVER_SCRIBE_THRESHOLD - completedScribesSinceObserver),
      status: observerState || (completedScribesSinceObserver >= OBSERVER_SCRIBE_THRESHOLD ? 'ready' : 'counting'),
      detail: observerState
        ? `Observer is ${observerState} on cross-project pattern extraction.`
        : completedScribesSinceObserver >= OBSERVER_SCRIBE_THRESHOLD
          ? `${completedScribesSinceObserver} scribes accumulated. Observer ready to extract cross-project patterns.`
          : `${completedScribesSinceObserver} of ${OBSERVER_SCRIBE_THRESHOLD} scribes since last observer. ${Math.max(0, OBSERVER_SCRIBE_THRESHOLD - completedScribesSinceObserver)} more needed.`,
    },
    {
      stage: 'compressor',
      current: completedObserversSinceCompressor,
      threshold: COMPRESSOR_OBSERVER_THRESHOLD,
      remaining: Math.max(0, COMPRESSOR_OBSERVER_THRESHOLD - completedObserversSinceCompressor),
      status: compressorState || (completedObserversSinceCompressor >= COMPRESSOR_OBSERVER_THRESHOLD ? 'ready' : 'counting'),
      detail: compressorState
        ? `Compressor is ${compressorState} updating the global mental model.`
        : completedObserversSinceCompressor >= COMPRESSOR_OBSERVER_THRESHOLD
          ? `${completedObserversSinceCompressor} observers accumulated. Compressor ready to update mental model + graph maintenance.`
          : `${completedObserversSinceCompressor} of ${COMPRESSOR_OBSERVER_THRESHOLD} observers since last compressor. ${Math.max(0, COMPRESSOR_OBSERVER_THRESHOLD - completedObserversSinceCompressor)} more needed.`,
    },
    {
      stage: 'skillforge',
      current: skillforgeManifestCount,
      threshold: null,
      remaining: null,
      status: skillforgeState || skillforgeRefreshState || (skillforgeCompleted > 0 || skillforgeRefreshCompleted > 0 ? 'idle' : 'waiting'),
      detail: skillforgeState
        ? `Skillforge is ${skillforgeState} on a candidate node.`
        : skillforgeRefreshState
          ? `Skill refresh is ${skillforgeRefreshState} on a drifted skill.`
          : skillforgeCompleted > 0
            ? `${skillforgeCompleted} skill${skillforgeCompleted === 1 ? '' : 's'} generated. ${skillforgeManifestCount} manifest${skillforgeManifestCount === 1 ? '' : 's'} tracked.`
            : 'No skills generated yet. Skillforge scores nodes by access patterns and generates installable agent skills.',
    },
    {
      current: todaysBriefExists ? 1 : 0,
      threshold: 1,
      remaining: todaysBriefExists ? 0 : 1,
      status: analysisState || (todaysBriefExists ? 'idle' : analysisReady ? 'ready' : 'waiting'),
      detail: analysisState
        ? `Morning brief is ${analysisState}.`
        : todaysBriefExists
          ? 'Today’s morning brief has already been generated.'
          : analysisReady
            ? `Daily brief window is open after ${DAILY_ANALYSIS_HOUR_LOCAL}:00 local.`
            : `Daily brief will become eligible after ${DAILY_ANALYSIS_HOUR_LOCAL}:00 local.`,
    },
    {
      stage: 'notion_sync',
      current: notionPageCount + notionRowCount,
      threshold: null,
      remaining: null,
      status: !notionSyncEnabled
        ? 'idle'
        : notionSyncJobState || (notionLastSyncAt ? 'idle' : 'waiting'),
      detail: !notionSyncEnabled
        ? 'Notion sync is not enabled.'
        : notionSyncJobState
          ? `Notion sync is ${notionSyncJobState}.`
          : notionLastSyncAt
            ? `${notionPageCount} pages, ${notionRowCount} rows synced. Last sync ${notionLastSyncAt.toLocaleDateString()} ${notionLastSyncAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Next at ${notionSyncHour}:00.`
            : `Notion sync enabled. Waiting for first sync at ${notionSyncHour}:00 local.`,
    },
  ]
}

interface PipelineStageProgress {
  stage: string
  label: string
  current: number
  threshold: number | null
  remaining: number | null
  status: 'counting' | 'ready' | 'running' | 'queued' | 'waiting' | 'idle' | 'done'
  detail: string
}

function getProjectPipelineProgress(graphRoot: string, project: string): PipelineStageProgress[] {
  const jobs = readAllJobs(graphRoot)
  const slug = sanitizeProjectSlug(project)

  const bufferForProject = readBufferCountsByProject(graphRoot).find(b => b.project === project)
  const bufferCount = bufferForProject?.count ?? 0

  const hasJob = (type: JobType) => {
    const state = hasJobInFlight(jobs, type)
    if (!state) {
      const projectJob = [...jobs.running, ...jobs.queued].find(j =>
        j.type === type && (j.payload?.project === project || j.payload?.project === slug)
      )
      return projectJob ? (projectJob.state as 'running' | 'queued') : null
    }
    return state
  }

  const projectScribes = jobs.done.filter(j => {
    if (j.type !== 'scribe') return false
    return j.payload?.project === project || j.payload?.project === slug
  })

  const projectAuditors = jobs.done.filter(j => {
    if (j.type !== 'auditor') return false
    return j.payload?.project === project || j.payload?.project === slug
  })

  const lastAuditorMs = projectAuditors.map(j => latestJobTime(j)).sort((a, b) => b - a)[0] || 0
  const scribesSinceAuditor = projectScribes.filter(j => latestJobTime(j) > lastAuditorMs).length

  const allScribeSessions = projectScribes.map(j => (j.payload as any)?.sessionId).filter(Boolean) as string[]
  const deltasDir = getPaths(graphRoot).deltas
  let deltaCount = 0
  for (const sid of allScribeSessions) {
    if (existsSync(join(deltasDir, `${sid}.json`))) deltaCount++
    if (existsSync(join(deltasDir, 'audited', `${sid}.json`))) deltaCount++
  }

  const scribeState = hasJob('scribe')
  const auditorState = hasJob('auditor')
  const librarianState = hasJob('librarian')
  const dreamerState = hasJob('dreamer')

  const hasAuditedDeltas = (() => {
    for (const sid of allScribeSessions) {
      if (existsSync(join(deltasDir, 'audited', `${sid}.json`))) return true
    }
    return false
  })()

  return [
    {
      stage: 'scribe',
      label: 'Scribe',
      current: bufferCount,
      threshold: SCRIBE_INTERVAL,
      remaining: bufferCount >= SCRIBE_INTERVAL ? 0 : SCRIBE_INTERVAL - bufferCount,
      status: scribeState
        ? scribeState
        : bufferCount >= SCRIBE_INTERVAL
          ? 'ready'
          : 'counting',
      detail: scribeState
        ? `Scribe is ${scribeState}.`
        : bufferCount >= SCRIBE_INTERVAL
          ? 'Buffer threshold reached. Ready to snapshot.'
          : `${bufferCount}/${SCRIBE_INTERVAL} messages buffered. ${SCRIBE_INTERVAL - bufferCount} more to trigger scribe.`,
    },
    {
      stage: 'auditor',
      label: 'Auditor',
      current: scribesSinceAuditor,
      threshold: AUDITOR_SCRIBE_THRESHOLD,
      remaining: scribesSinceAuditor >= AUDITOR_SCRIBE_THRESHOLD ? 0 : AUDITOR_SCRIBE_THRESHOLD - scribesSinceAuditor,
      status: auditorState
        ? auditorState
        : scribesSinceAuditor >= AUDITOR_SCRIBE_THRESHOLD && deltaCount > 0
          ? 'ready'
          : scribesSinceAuditor > 0
            ? 'counting'
            : 'idle',
      detail: auditorState
        ? `Auditor is ${auditorState}.`
        : scribesSinceAuditor >= AUDITOR_SCRIBE_THRESHOLD
          ? `${scribesSinceAuditor} scribes accumulated. Ready to audit.`
          : scribesSinceAuditor > 0
            ? `${scribesSinceAuditor}/${AUDITOR_SCRIBE_THRESHOLD} scribes since last audit. ${AUDITOR_SCRIBE_THRESHOLD - scribesSinceAuditor} more needed.`
            : 'Waiting for scribe deltas to accumulate.',
    },
    {
      stage: 'librarian',
      label: 'Librarian',
      current: hasAuditedDeltas ? 1 : 0,
      threshold: 1,
      remaining: hasAuditedDeltas ? 0 : 1,
      status: librarianState
        ? librarianState
        : auditorState
          ? 'waiting'
          : hasAuditedDeltas
            ? 'ready'
            : 'idle',
      detail: librarianState
        ? `Librarian is ${librarianState}.`
        : auditorState
          ? 'Waiting for auditor to finish.'
          : hasAuditedDeltas
            ? 'Audited deltas ready. Librarian can run.'
            : 'No audited deltas yet.',
    },
    {
      stage: 'dreamer',
      label: 'Dreamer',
      current: jobs.done.filter(j =>
        j.type === 'librarian' && (j.payload?.project === project || j.payload?.project === slug)
      ).length,
      threshold: null,
      remaining: null,
      status: dreamerState
        ? dreamerState
        : librarianState
          ? 'waiting'
          : 'idle',
      detail: dreamerState
        ? `Dreamer is ${dreamerState}.`
        : librarianState
          ? 'Waiting for librarian to finish.'
          : 'Runs after librarian completes.',
    },
  ]
}

function collectWarnings(graphRoot = getGraphRoot(), nodeCount?: number): string[] {
  const { map } = getPaths(graphRoot)
  const warnings: string[] = []
  const actualNodeCount = nodeCount ?? countActiveMarkdownFiles(getPaths(graphRoot).nodes)

  if (existsSync(map)) {
    const mapTokens = Math.ceil(readFileSync(map, 'utf-8').length / 4)
    const mapUsage = mapTokens / 12000
    if (mapUsage > 0.9) warnings.push(`MAP at ${Math.round(mapUsage * 100)}% of token budget`)
  }

  const nodeUsage = actualNodeCount / 750
  if (nodeUsage > 0.8) {
    warnings.push(`Node count at ${Math.round(nodeUsage * 100)}% of limit (${actualNodeCount}/750)`)
  }

  const lowConfidence = readIndex(graphRoot).filter((entry: any) => (entry.confidence || 0.5) < 0.3).length
  if (lowConfidence > 0) warnings.push(`${lowConfidence} node(s) below 0.3 confidence`)

  return warnings
}

function readRuntimeConfig(graphRoot = getGraphRoot()): RuntimeConfig {
  const runtimePath = getPaths(graphRoot).runtimeConfig
  return safeJsonParse(runtimePath) ?? {
    mode: 'manual',
    graphRoot,
  }
}

function runCommand(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string; error?: string } {
  const pathEntries = Array.from(new Set([
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    ...COMMON_BIN_DIRS,
  ]))
  const env = {
    ...process.env,
    PATH: pathEntries.join(':'),
  }
  const resolvedCommand = command.includes('/')
    ? command
    : pathEntries
        .map((dir) => join(dir, command))
        .find((candidate) => existsSync(candidate)) || command

  const run = (cmd: string, cmdArgs: string[]) => spawnSync(cmd, cmdArgs, {
    encoding: 'utf-8',
    env,
  })

  let result = run(resolvedCommand, args)

  if (result.error?.message?.includes('EBADF')) {
    const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const shellCommand = [resolvedCommand, ...args].map(shellQuote).join(' ')
    result = run('/bin/zsh', ['-lc', shellCommand])
  }

  if (result.error) {
    return {
      ok: false,
      stdout: result.stdout?.trim?.() ?? '',
      stderr: result.stderr?.trim?.() ?? '',
      error: result.error.message,
    }
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout?.trim?.() ?? '',
      stderr: result.stderr?.trim?.() ?? '',
      error: `command exited with code ${result.status}`,
    }
  }

  return {
    ok: true,
    stdout: result.stdout?.trim?.() ?? '',
    stderr: result.stderr?.trim?.() ?? '',
  }
}

function getDockerState(runtime: RuntimeConfig) {
  if (runtime.mode !== 'docker' || !runtime.docker?.containerName) return null

  const dockerCheck = runCommand('docker', ['--version'])
  if (!dockerCheck.ok) {
    return { available: false, error: dockerCheck.error || dockerCheck.stderr || 'docker unavailable' }
  }

  const inspect = runCommand('docker', [
    'inspect',
    runtime.docker.containerName,
    '--format',
    '{{json .State}}',
  ])

  if (!inspect.ok || !inspect.stdout) {
    return { available: true, present: false, error: inspect.stderr || inspect.error || 'container missing' }
  }

  try {
    return { available: true, present: true, ...JSON.parse(inspect.stdout) }
  } catch {
    return { available: true, present: true, raw: inspect.stdout }
  }
}

function getCodexAuthState(runtime: RuntimeConfig, dockerState: any) {
  if (runtime.mode !== 'docker' || !runtime.docker?.containerName || !runtime.docker?.authPathInContainer) return null
  if (!dockerState?.Running) return null

  const auth = runCommand('docker', [
    'exec',
    '-e', `HOME=${runtime.docker.authPathInContainer}`,
    runtime.docker.containerName,
    'bash',
    '-lc',
    'codex login status',
  ])

  if (!auth.ok) {
    return { ready: false, error: auth.stderr || auth.error || 'codex auth unavailable' }
  }

  const status = auth.stdout || auth.stderr
  return { ready: /Logged in/i.test(status), status }
}

function isFreshDaemonHeartbeat(daemonState: any): boolean {
  const updatedAt = daemonState?.updatedAt
  if (!updatedAt) return false
  const ageMs = Date.now() - Date.parse(updatedAt)
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 2 * 60 * 1000
}

function inferDockerStateFromDaemon(daemonState: any) {
  if (!daemonState?.running || !isFreshDaemonHeartbeat(daemonState)) return null
  return {
    available: false,
    inferred: true,
    Running: true,
    Health: { Status: 'healthy' },
    StartedAt: daemonState.updatedAt,
  }
}

function inferCodexAuthFromJobs(graphRoot: string) {
  const jobs = readAllJobs(graphRoot)
  const hasSuccessfulWorker = jobs.running.length > 0 || jobs.done.length > 0
  if (!hasSuccessfulWorker) return null
  return {
    ready: true,
    inferred: true,
    status: 'Inferred from successful Codex worker activity',
  }
}

function readRuntimeStatus(graphRoot = getGraphRoot()) {
  const runtime = readRuntimeConfig(graphRoot)
  const daemonState = safeJsonParse(getPaths(graphRoot).jobs.daemonState)
  const inspectedDockerState = getDockerState(runtime)
  const dockerState = inspectedDockerState?.Running
    ? inspectedDockerState
    : (inferDockerStateFromDaemon(daemonState) ?? inspectedDockerState)
  const inspectedCodexAuth = getCodexAuthState(runtime, dockerState)
  const inferredCodexAuth = inferCodexAuthFromJobs(graphRoot)
  const codexAuth = inspectedCodexAuth?.ready
    ? inspectedCodexAuth
    : (inferredCodexAuth ?? inspectedCodexAuth)

  return {
    mode: runtime.mode ?? 'manual',
    graphRoot,
    docker: runtime.mode === 'docker'
      ? {
          ...runtime.docker,
          state: dockerState,
          codexAuth,
        }
      : null,
    daemonState,
    daemonLockPresent: existsSync(getPaths(graphRoot).jobs.daemonLock),
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function formatRecentSessionLogs(graphRoot: string, project: string): string {
  const filePath = join(getPaths(graphRoot).v3Sessions, `${sanitizeProjectSlug(project)}.jsonl`)
  if (!project || project === 'global' || !existsSync(filePath)) return ''

  try {
    const logs = readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    if (logs.length === 0) return ''
    const log = logs[logs.length - 1]

    const date = typeof log.timestamp === 'string' ? log.timestamp.slice(0, 10) : 'unknown'
    const lines = ['## Last Session', '', `**${date}**`]
    if (Array.isArray(log.openThreads) && log.openThreads.length > 0) lines.push(`Open: ${log.openThreads.join('; ')}`)
    if (log.nextSessionShould) lines.push(`Next: ${log.nextSessionShould}`)

    return lines.join('\n').trim()
  } catch {
    return ''
  }
}

function readPickupBlock(graphRoot: string, project: string): string {
  if (!project || project === 'global') return ''
  const statePath = join(getPaths(graphRoot).workingProjects, `${sanitizeProjectSlug(project)}.state.json`)
  if (!existsSync(statePath)) return ''

  try {
    const state = safeJsonParse(statePath)
    const latest = Array.isArray(state?.sessions) ? state.sessions[0] : null
    const items = Array.isArray(latest?.nextPickup) ? latest.nextPickup.slice(0, 3) : []
    if (items.length === 0) return ''
    return ['## Pick Up', '', ...items.map((item: string) => `- ${item}`)].join('\n')
  } catch {
    return ''
  }
}

function buildGuardrailsBlock(graphRoot: string, project: string): string {
  const antiPatterns = readIndex(graphRoot)
    .filter((entry: any) => entry.anti_pattern || entry.category === 'anti-patterns')
    .filter((entry: any) => !entry.project || project === 'global' || entry.project === project)
    .slice(0, 8)

  if (antiPatterns.length === 0) return ''
  return ['## Guardrails', '', ...antiPatterns.map((entry: any) => `- ${entry.gist || entry.path}`)].join('\n')
}

function getArtifactInfo(graphRoot = getGraphRoot(), projectOverride?: string) {
  const paths = getPaths(graphRoot)
  const activeProject = projectOverride || readActiveProject(graphRoot)?.name || 'global'
  const projectWhisperPath = activeProject !== 'global' ? join(paths.lenses, sanitizeProjectSlug(activeProject), 'whisper.txt') : null
  const sessionLog = formatRecentSessionLogs(graphRoot, activeProject)
  const pickupBlock = readPickupBlock(graphRoot, activeProject)
  const guardrails = buildGuardrailsBlock(graphRoot, activeProject)
  const layers: Array<{
    id: StartupLayerId
    label: string
    subtitle: string
    owner: 'librarian' | 'dreamer' | 'compressor' | 'observer'
    injected: boolean
    updatedAt: string | null
    tokens: number
    content: string
  }> = [
    { id: 'global_whisper', label: 'Global Whisper', subtitle: 'Compressed global mental model', owner: 'compressor', injected: true, updatedAt: null, tokens: 0, content: existsSync(paths.globalWhisper) ? readFileSync(paths.globalWhisper, 'utf-8') : '' },
    { id: 'guardrails', label: 'Guardrails', subtitle: 'Anti-patterns from graph index', owner: 'compressor', injected: Boolean(guardrails), updatedAt: null, tokens: 0, content: guardrails },
  ]

  if (projectWhisperPath) {
    layers.push({
      id: 'project_whisper',
      label: `Project Whisper`,
      subtitle: activeProject,
      owner: 'compressor',
      injected: true,
      updatedAt: null,
      tokens: 0,
      content: existsSync(projectWhisperPath) ? readFileSync(projectWhisperPath, 'utf-8') : '',
    })
    layers.push({
      id: 'session_log',
      label: 'Recent Sessions',
      subtitle: 'Last three compressed session logs',
      owner: 'observer',
      injected: Boolean(sessionLog),
      updatedAt: null,
      tokens: 0,
      content: sessionLog,
    })
    layers.push({
      id: 'working_project',
      label: 'Pick Up',
      subtitle: 'Next-session project handoff',
      owner: 'observer',
      injected: Boolean(pickupBlock),
      updatedAt: null,
      tokens: 0,
      content: pickupBlock,
    })
  }

  for (const layer of layers) {
    const filePath = {
      priors: paths.priors,
      soma: paths.soma,
      map: paths.map,
      working_global: paths.workingGlobal,
      working_project: activeProject !== 'global' ? join(paths.workingProjects, `${sanitizeProjectSlug(activeProject)}.state.json`) : '',
      dreams: paths.dreamsContext,
      global_whisper: paths.globalWhisper,
      project_whisper: projectWhisperPath,
      session_log: activeProject !== 'global' ? join(paths.v3Sessions, `${sanitizeProjectSlug(activeProject)}.jsonl`) : '',
      guardrails: paths.index,
    }[layer.id] || ''
    if (filePath && existsSync(filePath)) {
      layer.updatedAt = statSync(filePath).mtime.toISOString()
      layer.tokens = estimateTokens(layer.content)
    }
  }

  return layers
}

function getPinnedNodes(graphRoot = getGraphRoot(), projectOverride?: string) {
  const activeProject = projectOverride || readActiveProject(graphRoot)?.name || 'global'
  const index = readIndex(graphRoot)
  const indexedPinned = index
    .filter((entry: any) => entry.pinned)
    .filter((entry: any) => !entry.project || entry.project === activeProject)
    .slice(0, 12)

  const entries = indexedPinned.length > 0
    ? indexedPinned
    : walkNodeFiles(getPaths(graphRoot).nodes)
        .map(({ nodePath, filePath }) => {
          try {
            const raw = readFileSync(filePath, 'utf-8')
            const { data, content } = matter(raw)
            if (data.pinned !== true) return null
            if (data.project && data.project !== activeProject) return null
            return {
              path: nodePath,
              gist: data.gist || '',
              project: data.project || 'global',
              _detail: {
                frontmatter: data,
                content: content.trim(),
                raw,
              },
            }
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .slice(0, 12)

  return entries
    .map((entry: any) => {
      const detail = entry._detail || readNodeFileForGraph(graphRoot, entry.path)
      const content = detail?.content || ''
      return {
        path: entry.path,
        title: detail?.frontmatter?.title || entry.path,
        gist: entry.gist || '',
        project: entry.project || 'global',
        updatedAt: detail?.frontmatter?.updated || null,
        tokens: estimateTokens(content),
        contentPreview: content.slice(0, 280),
      }
    })
}

function countAllPinnedNodes(graphRoot = getGraphRoot()) {
  const indexedPinnedCount = readIndex(graphRoot).filter((entry: any) => entry.pinned).length
  if (indexedPinnedCount > 0) {
    return indexedPinnedCount
  }

  return walkNodeFiles(getPaths(graphRoot).nodes).reduce((count, { filePath }) => {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const { data } = matter(raw)
      return data.pinned === true ? count + 1 : count
    } catch {
      return count
    }
  }, 0)
}

function summarizeJob(job: JobRecord, graphRoot = getGraphRoot()) {
  const startedAt = job.startedAt || job.createdAt
  const finishedAt = job.completedAt || null
  const endTs = finishedAt ? Date.parse(finishedAt) : (job.state === 'running' ? Date.now() : Date.parse(startedAt))
  const durationMs = Math.max(0, endTs - Date.parse(startedAt))
  const fullLogPath = job.logFile
    ? (job.logFile.startsWith('/graph-memory/')
        ? join(graphRoot, job.logFile.replace('/graph-memory/', ''))
        : job.logFile)
    : null

  const logExists = fullLogPath ? existsSync(fullLogPath) : false
  const logSize = logExists ? statSync(fullLogPath!).size : 0
  const displayState = isScribeNoop(job) ? 'noop' : job.state
  const displayMessage = isScribeNoop(job)
    ? 'No new deltas were extracted from this snapshot.'
    : (job.lastError ?? null)

  return {
    ...job,
    startedAt,
    completedAt: finishedAt,
    durationMs,
    logFile: job.logFile ?? null,
    logPath: fullLogPath ? relative(graphRoot, fullLogPath) : null,
    logFilename: fullLogPath ? relative(getPaths(graphRoot).pipelineLogs, fullLogPath) : null,
    logExists,
    logSize,
    logTail: logExists ? readTextTail(fullLogPath!, 40) : '',
    displayState,
    displayMessage,
  }
}

function listPipelineJobs(graphRoot = getGraphRoot()) {
  const allJobs = readAllJobs(graphRoot)
  return [...allJobs.running, ...allJobs.queued, ...allJobs.failed, ...allJobs.done]
    .map((job) => summarizeJob(job, graphRoot))
    .sort((a, b) => Date.parse(b.startedAt || b.createdAt) - Date.parse(a.startedAt || a.createdAt))
    .slice(0, 30)
}

function listWorkerLogs(graphRoot = getGraphRoot()) {
  const logsDir = getPaths(graphRoot).pipelineLogs
  if (!existsSync(logsDir)) return []

  return readdirSync(logsDir)
    .filter((file) => file.endsWith('.log'))
    .map((file) => {
      const filePath = join(logsDir, file)
      const stat = statSync(filePath)
      const content = readFileSync(filePath, 'utf-8')
      const parsed = parseWorkerLog(content, file)
      return {
        filename: file,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        preview: readTextPreview(filePath, 10),
        parsed,
      }
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 40)
}

function parseWorkerLog(content: string, filename: string): ParsedWorkerLog {
  const lines = content.split('\n')
  const valueAfter = (prefix: string) => {
    const line = lines.find((entry) => entry.startsWith(prefix))
    return line ? line.slice(prefix.length).trim() : null
  }

  const stage = filename.split('-')[0] || null
  const taskIdx = lines.findIndex((line) => line.trim() === 'user')
  const warningIdx = lines.findIndex((line) => line.startsWith('warning:'))
  const taskLines = taskIdx >= 0
    ? lines.slice(taskIdx + 1, warningIdx >= 0 ? warningIdx : taskIdx + 8).filter(Boolean)
    : []

  const codexNotes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() === 'codex')
    .map(({ index }) => lines[index + 1]?.trim())
    .filter(Boolean)
    .slice(-3) as string[]

  const recentSteps = lines
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('exec') ||
        trimmed.startsWith('succeeded in') ||
        trimmed.startsWith('exited ') ||
        trimmed.startsWith('failed in') ||
        trimmed.startsWith('/bin/bash -lc')
    })
    .slice(-12)

  return {
    stage,
    model: valueAfter('model:'),
    sessionId: valueAfter('session id:'),
    workdir: valueAfter('workdir:'),
    approval: valueAfter('approval:'),
    sandbox: valueAfter('sandbox:'),
    provider: valueAfter('provider:'),
    reasoningEffort: valueAfter('reasoning effort:'),
    task: taskLines.join(' ').trim() || null,
    codexNotes,
    recentSteps,
  }
}

app.get('/api/graph', (_req, res) => {
  try {
    const index = readIndex()
    const cytoscapeElements: any[] = []

    for (const node of index) {
      cytoscapeElements.push({
        group: 'nodes',
        data: {
          id: node.path,
          label: node.path.split('/').pop(),
          category: node.path.split('/')[0],
          gist: node.gist,
          confidence: node.confidence ?? 0.5,
          soma_intensity: node.soma_intensity ?? 0,
          tags: node.tags ?? [],
          project: node.project ?? null,
          access_count: node.access_count ?? 0,
          updated: node.updated,
          last_accessed: node.last_accessed,
        },
      })
    }

    for (const node of index) {
      for (const edge of node.edges ?? []) {
        const target = typeof edge === 'string' ? edge : edge.target
        const weight = typeof edge === 'string' ? 0.5 : (edge.weight ?? 0.5)
        const type = typeof edge === 'string' ? 'relates_to' : (edge.type ?? 'relates_to')
        if (index.some((entry: any) => entry.path === target)) {
          cytoscapeElements.push({
            group: 'edges',
            data: {
              id: `${node.path}->${target}`,
              source: node.path,
              target,
              weight,
              edgeType: type,
            },
          })
        }
      }

      for (const edge of node.anti_edges ?? []) {
        const target = typeof edge === 'string' ? edge : edge.target
        if (target && index.some((entry: any) => entry.path === target)) {
          cytoscapeElements.push({
            group: 'edges',
            data: {
              id: `${node.path}-x->${target}`,
              source: node.path,
              target,
              anti: true,
              reason: typeof edge === 'string' ? '' : edge.reason || '',
            },
          })
        }
      }
    }

    res.json({ elements: cytoscapeElements, nodeCount: index.length })
  } catch (err) {
    console.error('Error in /api/graph:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/node/:path(*)', (req, res) => {
  try {
    const node = readNodeFile(req.params.path)
    if (!node) return res.status(404).json({ error: 'Node not found' })
    const indexEntry = readIndex().find((entry: any) => entry.path === req.params.path)
    res.json({ ...node, indexEntry })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.put('/api/node/:path(*)', (req, res) => {
  try {
    const graphRoot = getGraphRoot()
    const { nodes } = getPaths(graphRoot)
    const fullPath = resolve(nodes, req.params.path.endsWith('.md') ? req.params.path : `${req.params.path}.md`)
    if (!fullPath.startsWith(nodes)) return res.status(400).json({ error: 'Invalid path' })
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'Node not found' })

    const raw = readFileSync(fullPath, 'utf-8')
    const { data: fm, content: body } = matter(raw)

    if (req.body.gist !== undefined) fm.gist = req.body.gist
    if (req.body.confidence !== undefined) fm.confidence = req.body.confidence
    if (req.body.tags !== undefined) fm.tags = req.body.tags
    fm.updated = new Date().toISOString()

    const updated = matter.stringify(body, fm)
    writeFileSync(fullPath, updated)
    updateNodeIndexes(graphRoot, req.params.path, fm)

    const node = readNodeFileForGraph(graphRoot, req.params.path)
    res.json(node)
  } catch (err) {
    console.error('Error in PUT /api/node:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/status', (_req, res) => {
  try {
    const graphRoot = getGraphRoot()
    const nodeCount = countActiveMarkdownFiles(getPaths(graphRoot).nodes)
    const jobs = readAllJobs(graphRoot)
    const runtime = readRuntimeStatus(graphRoot)
    const activeProject = readActiveProject(graphRoot)

    res.json({
      graphRoot,
      initialized: existsSync(getPaths(graphRoot).map),
      activeProject: activeProject?.name ?? 'global',
      activeProjects: listAllActiveProjects(graphRoot),
      nodeCount,
      archiveCount: countArchiveMarkdownFiles(graphRoot),
      bufferCount: readBufferCount(graphRoot),
      bufferByProject: readBufferCountsByProject(graphRoot),
      pendingDreams: countPendingDreams(graphRoot),
      queuedJobs: jobs.totals.queued,
      runningJobs: jobs.totals.running,
      failedJobs: jobs.totals.failed,
      noopJobs: jobs.totals.noop,
      rawFailedJobs: jobs.totals.rawFailed,
      completedJobs: jobs.totals.done,
      jobCounts: jobs.byType,
      pipelineCutoffs: buildPipelineCutoffs(graphRoot, jobs),
      warnings: collectWarnings(graphRoot, nodeCount),
      runtime,
    })
  } catch (err) {
    console.error('Error in /api/status:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/health', (_req, res) => {
  try {
    const graphRoot = getGraphRoot()
    const paths = getPaths(graphRoot)
    const nodeCount = countActiveMarkdownFiles(paths.nodes)
    const archiveCount = countArchiveMarkdownFiles(graphRoot)

    const index = readIndex()
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    const categories: Record<string, number> = {}
    let staleCount = 0
    let orphanCount = 0
    const edgeSources = new Set<string>()
    const edgeTargets = new Set<string>()

    for (const node of index) {
      for (const edge of node.edges ?? []) {
        const target = typeof edge === 'string' ? edge : edge.target
        if (target) {
          edgeSources.add(node.path)
          edgeTargets.add(target)
        }
      }
      for (const edge of node.anti_edges ?? []) {
        const target = typeof edge === 'string' ? edge : edge.target
        if (target) {
          edgeSources.add(node.path)
          edgeTargets.add(target)
        }
      }
    }
    const allConnected = new Set([...edgeSources, ...edgeTargets])

    for (const entry of index) {
      const cat = entry.category || 'uncategorized'
      categories[cat] = (categories[cat] || 0) + 1

      const lastAccessed = entry.last_accessed ? Date.parse(entry.last_accessed) : 0
      if (lastAccessed > 0 && lastAccessed < thirtyDaysAgo) staleCount++

      if (!allConnected.has(entry.path)) orphanCount++
    }

    const globalWhisperTokens = existsSync(paths.globalWhisper) ? estimateTokens(readFileSync(paths.globalWhisper, 'utf-8')) : 0
    const activeProject = readActiveProject(graphRoot)?.name || 'global'
    const projectWhisperPath = activeProject !== 'global' ? join(paths.lenses, sanitizeProjectSlug(activeProject), 'whisper.txt') : ''
    const projectWhisperTokens = projectWhisperPath && existsSync(projectWhisperPath) ? estimateTokens(readFileSync(projectWhisperPath, 'utf-8')) : 0
    const sessionLogTokens = estimateTokens(formatRecentSessionLogs(graphRoot, activeProject))
    const guardrailTokens = estimateTokens(buildGuardrailsBlock(graphRoot, activeProject))
    const mapTokens = globalWhisperTokens
    const mapBudget = 1100
    const mapUsage = mapTokens / mapBudget

    const priorsTokens = globalWhisperTokens
    const somaTokens = guardrailTokens
    const dreamsTokens = sessionLogTokens

    let workingTokens = 0
    workingTokens = projectWhisperTokens

    let pinnedTokens = 0
    let pinnedCount = 0
    for (const entry of index) {
      if (entry.pinned) {
        pinnedCount++
        const nodePath = join(paths.nodes, `${entry.path}.md`)
        if (existsSync(nodePath)) {
          pinnedTokens += Math.ceil(readFileSync(nodePath, 'utf-8').length / 4)
        }
      }
    }

    const totalInjectionTokens = globalWhisperTokens + guardrailTokens + projectWhisperTokens + sessionLogTokens
    const injectionBudget = 1100

    const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]
    const balanceRatio = topCategory ? topCategory[1] / Math.max(nodeCount, 1) : 0

    let pipelineStats = { scribe: 0, auditor: 0, librarian: 0, dreamer: 0, skillforge: 0, failed: 0 }
    try {
      const doneDir = join(graphRoot, '.jobs', 'done')
      if (existsSync(doneDir)) {
        for (const f of readdirSync(doneDir)) {
          if (!f.endsWith('.json')) continue
          try {
            const job = JSON.parse(readFileSync(join(doneDir, f), 'utf-8'))
            const type = job.type || ''
            if (type in pipelineStats) (pipelineStats as any)[type]++
            if (job.state === 'failed') pipelineStats.failed++
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    let lowConfidenceCount = 0
    let noDecayRateCount = 0
    for (const entry of index) {
      if ((entry.confidence || 0.5) < 0.4) lowConfidenceCount++
    }

    const injectionEfficiency = totalInjectionTokens > 0 ? Math.min(totalInjectionTokens / injectionBudget, 2) : 0

    const score = Math.round(
      (nodeCount > 0 ? Math.min(nodeCount / 50, 1) * 15 : 0) +
      (staleCount === 0 ? 15 : Math.max(0, 15 - (staleCount / nodeCount) * 30)) +
      (orphanCount === 0 ? 10 : Math.max(0, 10 - (orphanCount / nodeCount) * 20)) +
      (mapUsage < 0.8 ? 10 : Math.max(0, 10 - (mapUsage - 0.8) * 100)) +
      (globalWhisperTokens < 500 ? 15 : Math.max(0, 15 - (globalWhisperTokens - 500) / 100)) +
      (projectWhisperTokens < 600 ? 15 : Math.max(0, 15 - (projectWhisperTokens - 600) / 100)) +
      (lowConfidenceCount / Math.max(nodeCount, 1) < 0.2 ? 10 : Math.max(0, 10 - (lowConfidenceCount / Math.max(nodeCount, 1)) * 50)) +
      (totalInjectionTokens < injectionBudget ? 10 : 0)
    )

    res.json({
      nodeCount,
      archiveCount,
      staleCount,
      orphanCount,
      categories,
      mapTokens,
      mapBudget,
      mapUsage: Math.round(mapUsage * 100),
      balanceDominant: topCategory ? { category: topCategory[0], ratio: Math.round(balanceRatio * 100) } : null,
      score: Math.min(score, 100),
      lowConfidenceCount,
      lowConfidenceRatio: nodeCount > 0 ? Math.round((lowConfidenceCount / nodeCount) * 100) : 0,
      pipelineStats,
      tokenAccounting: {
        priors: globalWhisperTokens,
        priorsBudget: 400,
        map: mapTokens,
        mapBudget,
        soma: guardrailTokens,
        somaBudget: 150,
        dreams: sessionLogTokens,
        dreamsBudget: 200,
        working: projectWhisperTokens,
        workingBudget: 500,
        pinned: 0,
        pinnedCount,
        pinnedBudget: 0,
        total: totalInjectionTokens,
        budget: injectionBudget,
        overBudget: totalInjectionTokens > injectionBudget,
        efficiency: Math.round(injectionEfficiency * 100),
      },
    })
  } catch (err) {
    console.error('Error in /api/health:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/startup-context', (_req, res) => {
  try {
    const graphRoot = getGraphRoot()
    const project = typeof _req.query.project === 'string' && _req.query.project ? _req.query.project : undefined
    const activeProject = project || readActiveProject(graphRoot)?.name || 'global'
    const layers = getArtifactInfo(graphRoot, activeProject)
    const pinnedNodes = getPinnedNodes(graphRoot, activeProject)
    const totalTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0) + pinnedNodes.reduce((sum, node) => sum + node.tokens, 0)

    res.json({
      graphRoot,
      activeProject,
      layers,
      pinnedNodes,
      allPinnedNodeCount: countAllPinnedNodes(graphRoot),
      totalTokens,
    })
  } catch (err) {
    console.error('Error in /api/startup-context:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/briefs/latest', (_req, res) => {
  try {
    res.json(getLatestBrief())
  } catch (err) {
    console.error('Error in /api/briefs/latest:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/session-traces', (_req, res) => {
  try {
    res.json(listSessionTraces())
  } catch (err) {
    console.error('Error in /api/session-traces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/activity', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 1000)
    const logPath = getPaths().activityLog
    if (!existsSync(logPath)) return res.json([])
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
    const events = lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    res.json(events)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/deltas', (_req, res) => {
  try {
    const deltasDir = getPaths().deltas
    if (!existsSync(deltasDir)) return res.json([])
    const files = readdirSync(deltasDir).filter((file) => file.endsWith('.json'))
    const summaries = files.map((file) => {
      const data = safeJsonParse(join(deltasDir, file))
      if (!data) return null
      return {
        filename: file,
        sessionId: data.sessionId ?? data.session_id ?? file.replace('.json', ''),
        scribes: Array.isArray(data.scribes) ? data.scribes.length : 0,
        deltas: Array.isArray(data.deltas)
          ? data.deltas.length
          : (Array.isArray(data.scribes) ? data.scribes.reduce((count: number, s: any) => count + (s.deltas?.length ?? 0), 0) : 0),
        timestamp: data.timestamp ?? data.created ?? data.started_at ?? null,
      }
    }).filter(Boolean)
    res.json(summaries)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/deltas/audited', (_req, res) => {
  try {
    const auditedDir = join(getPaths().deltas, 'audited')
    if (!existsSync(auditedDir)) return res.json([])
    const files = readdirSync(auditedDir).filter((file) => file.endsWith('.json'))
    const summaries = files.map((file) => {
      const data = safeJsonParse(join(auditedDir, file))
      if (!data) return null
      return {
        filename: file,
        sessionId: data.sessionId ?? data.session_id ?? file.replace('.json', ''),
        scribes: Array.isArray(data.scribes) ? data.scribes.length : 0,
        deltas: Array.isArray(data.deltas)
          ? data.deltas.length
          : (Array.isArray(data.scribes) ? data.scribes.reduce((count: number, s: any) => count + (s.deltas?.length ?? 0), 0) : 0),
        timestamp: data.timestamp ?? data.created ?? data.started_at ?? null,
      }
    }).filter(Boolean)
    res.json(summaries)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/deltas/audited/:sessionId', (req, res) => {
  try {
    const auditedDir = join(getPaths().deltas, 'audited')
    const filePath = resolve(auditedDir, `${req.params.sessionId}.json`)
    if (!filePath.startsWith(resolve(auditedDir))) return res.status(403).json({ error: 'Forbidden' })
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
    res.json(safeJsonParse(filePath))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/deltas/:sessionId', (req, res) => {
  try {
    const deltasDir = getPaths().deltas
    const filePath = resolve(deltasDir, `${req.params.sessionId}.json`)
    if (!filePath.startsWith(resolve(deltasDir))) return res.status(403).json({ error: 'Forbidden' })
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
    res.json(safeJsonParse(filePath))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/dreams', (_req, res) => {
  try {
    const dreamsDir = getPaths().dreams
    const buckets = ['pending', 'integrated', 'archived']
    const result: Record<string, any[]> = {}

    for (const bucket of buckets) {
      const dir = join(dreamsDir, bucket)
      if (!existsSync(dir)) {
        result[bucket] = []
        continue
      }
      result[bucket] = readdirSync(dir)
        .filter((file) => file.endsWith('.json') || file.endsWith('.md'))
        .map((file) => {
          const filePath = join(dir, file)
          if (file.endsWith('.json')) {
            return { filename: file, bucket, ...(safeJsonParse(filePath) ?? {}) }
          }
          const raw = readFileSync(filePath, 'utf-8')
          const { data, content } = matter(raw)
          return { filename: file, bucket, ...data, content: content.trim().slice(0, 500) }
        })
    }

    res.json(result)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/dreams/:bucket/:filename/integrate', (req, res) => {
  try {
    const dreamsDir = getPaths().dreams
    const srcDir = join(dreamsDir, req.params.bucket)
    const srcPath = resolve(srcDir, req.params.filename)
    if (!srcPath.startsWith(resolve(dreamsDir))) return res.status(403).json({ error: 'Forbidden' })
    if (!existsSync(srcPath)) return res.status(404).json({ error: 'Not found' })

    const destDir = join(dreamsDir, 'integrated')
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, req.params.filename)

    if (resolve(srcPath) !== resolve(destPath)) {
      renameSync(srcPath, destPath)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error integrating dream:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/dreams/:bucket/:filename/archive', (req, res) => {
  try {
    const dreamsDir = getPaths().dreams
    const srcDir = join(dreamsDir, req.params.bucket)
    const srcPath = resolve(srcDir, req.params.filename)
    if (!srcPath.startsWith(resolve(dreamsDir))) return res.status(403).json({ error: 'Forbidden' })
    if (!existsSync(srcPath)) return res.status(404).json({ error: 'Not found' })

    const destDir = join(dreamsDir, 'archived')
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, req.params.filename)

    if (resolve(srcPath) !== resolve(destPath)) {
      renameSync(srcPath, destPath)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error archiving dream:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/archive', (_req, res) => {
  try {
    const paths = getPaths()
    const archiveIndex = safeJsonParse(paths.archiveIndex)
    if (Array.isArray(archiveIndex)) {
      const legacyArchiveEntries = [
        ...walkNodeFiles(join(paths.nodes, '.archive')),
        ...walkNodeFiles(join(paths.nodes, 'archive')),
      ].map(({ nodePath, filePath }) => {
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const parsed = matter(raw)
          return {
            path: nodePath,
            gist: parsed.data.gist || parsed.data.title || nodePath,
            tags: parsed.data.tags || [],
            confidence: parsed.data.confidence ?? 0,
            archived_reason: parsed.data.archived_reason || parsed.data.archive_reason || 'legacy archive under nodes/',
            archived_date: parsed.data.archived_date || parsed.data.archivedAt || null,
          }
        } catch {
          return null
        }
      }).filter(Boolean)
      res.json([...archiveIndex, ...legacyArchiveEntries])
      return
    }

    const entries = [
      ...walkNodeFiles(paths.archive),
      ...walkNodeFiles(join(paths.nodes, '.archive')),
      ...walkNodeFiles(join(paths.nodes, 'archive')),
    ].map(({ nodePath, filePath }) => {
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = matter(raw)
        return {
          path: nodePath,
          gist: parsed.data.gist || parsed.data.title || nodePath,
          tags: parsed.data.tags || [],
          confidence: parsed.data.confidence ?? 0,
          archived_reason: parsed.data.archived_reason || parsed.data.archive_reason || '',
          archived_date: parsed.data.archived_date || parsed.data.archivedAt || null,
        }
      } catch {
        return null
      }
    }).filter(Boolean)
    res.json(entries)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

for (const [route, fileKey] of [
  ['/api/map', 'map'],
  ['/api/priors', 'priors'],
  ['/api/soma', 'soma'],
  ['/api/working', 'working'],
  ['/api/dreams-context', 'dreamsContext'],
] as const) {
  app.get(route, (_req, res) => {
    try {
      const filePath = getPaths()[fileKey]
      if (!existsSync(filePath)) return res.type('text/plain').send('')
      res.type('text/plain').send(readFileSync(filePath, 'utf-8'))
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })
}

app.get('/api/working/projects', (_req, res) => {
  try {
    res.json(listProjectWorkingFiles())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/skills', (_req, res) => {
  try {
    const dir = getPaths().skillforge
    if (!existsSync(dir)) { res.json([]); return }
    const skills = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')) }
        catch { return null }
      })
      .filter(Boolean)
    res.json(skills)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/skills/:name/content', (req, res) => {
  try {
    const dir = getPaths().skillforge
    if (!existsSync(dir)) { res.status(404).json({ error: 'No skills directory' }); return }
    const manifestFile = readdirSync(dir).find((f) => {
      if (!f.endsWith('.json')) return false
      try {
        const m = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
        return m.skill_name === req.params.name
      } catch { return false }
    })
    if (!manifestFile) { res.status(404).json({ error: 'Skill not found' }); return }
    const manifest = JSON.parse(readFileSync(join(dir, manifestFile), 'utf-8'))
    const contentPath = manifest.canonical_content_path
      ? join(getPaths().graphRoot, manifest.canonical_content_path)
      : null
    if (!contentPath || !existsSync(contentPath)) {
      const legacyPath = manifest.files?.claude_command || manifest.files?.opencode_command
      if (legacyPath && manifest.project_root) {
        const fullPath = join(manifest.project_root, legacyPath)
        if (existsSync(fullPath)) {
          res.json({ content: readFileSync(fullPath, 'utf-8'), manifest })
          return
        }
      }
      res.status(404).json({ error: 'No skill content found' }); return
    }
    res.json({ content: readFileSync(contentPath, 'utf-8'), manifest })
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/audit', (_req, res) => {
  try {
    const paths = getPaths()
    res.json({
      brief: existsSync(paths.auditBrief) ? readFileSync(paths.auditBrief, 'utf-8') : null,
      report: existsSync(paths.auditReport) ? safeJsonParse(paths.auditReport) : null,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/pipeline', (_req, res) => {
  try {
    res.json(listPipelineJobs())
  } catch (err) {
    console.error('Error in /api/pipeline:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/pipeline-progress/:project', (req, res) => {
  try {
    const project = decodeURIComponent(req.params.project)
    res.json(getProjectPipelineProgress(getGraphRoot(), project))
  } catch (err) {
    console.error('Error in /api/pipeline-progress:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/logs', (_req, res) => {
  try {
    res.json(listWorkerLogs())
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/logs/:filename(*)', (req, res) => {
  try {
    const logsDir = getPaths().pipelineLogs
    const filePath = resolve(logsDir, req.params.filename)
    if (!filePath.startsWith(resolve(logsDir))) return res.status(403).json({ error: 'Forbidden' })
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Log not found' })
    const stat = statSync(filePath)
    const content = readFileSync(filePath, 'utf-8')
    res.json({
      filename: req.params.filename,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      content,
      parsed: parseWorkerLog(content, req.params.filename),
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

const clients = new Set<express.Response>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

app.get('/api/events', (_req, res) => {
  if (clients.size >= 20) {
    res.status(503).json({ error: 'Too many connections' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')
  clients.add(res)
  _req.on('close', () => clients.delete(res))
})

// ── Mental Model Endpoints ─────────────────────────────────────────────────────

app.get('/api/projects', (_req, res) => {
  try {
    const paths = getPaths()
    const index = existsSync(paths.index) ? JSON.parse(readFileSync(paths.index, 'utf-8')) : []
    const byProject = new Map<string, { nodeCount: number; lastUpdated: string | null; categories: Record<string, number>; nodePaths: string[] }>()

    for (const entry of index) {
      const project = entry.project || null
      if (!project) continue
      const existing = byProject.get(project) || { nodeCount: 0, lastUpdated: null, categories: {} as Record<string, number>, nodePaths: [] as string[] }
      existing.nodeCount++
      existing.nodePaths.push(entry.path)
      const cat = entry.path?.split('/')[0] || 'unknown'
      existing.categories[cat] = (existing.categories[cat] || 0) + 1
      const updated = entry.updated || entry.created
      if (updated && (!existing.lastUpdated || updated > existing.lastUpdated)) {
        existing.lastUpdated = updated
      }
      byProject.set(project, existing)
    }

    const workingFiles = listProjectWorkingFiles()

    const projects = Array.from(byProject.entries()).map(([name, data]) => {
      const working = workingFiles.find(w => w.project === name)
      return {
        name,
        nodeCount: data.nodeCount,
        lastUpdated: data.lastUpdated,
        categories: data.categories,
        hasWorking: !!working,
        workingPreview: working?.content?.slice(0, 200) || null,
        workingUpdatedAt: working?.updatedAt || null,
        sessionCount: working?.sessionCount || 0,
      }
    }).sort((a, b) => b.nodeCount - a.nodeCount)

    const globalNodes = index.filter((e: any) => !e.project)
    const globalCategories: Record<string, number> = {}
    for (const entry of globalNodes) {
      const cat = entry.path?.split('/')[0] || 'unknown'
      globalCategories[cat] = (globalCategories[cat] || 0) + 1
    }

    res.json({
      projects,
      global: {
        nodeCount: globalNodes.length,
        categories: globalCategories,
      },
      totalNodes: index.length,
      totalProjects: projects.length,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/model', (_req, res) => {
  const graphRoot = getGraphRoot()
  const modelPath = join(graphRoot, 'mind/model.json')
  if (!existsSync(modelPath)) {
    res.json({ model: null })
    return
  }
  try {
    const parsed = JSON.parse(readFileSync(modelPath, 'utf-8'))
    const globalObsFile = join(graphRoot, 'mind', 'observations.jsonl')
    let observationCount = 0
    if (existsSync(globalObsFile)) {
      observationCount = readFileSync(globalObsFile, 'utf-8').trim().split('\n').filter(Boolean).reduce((count: number, line: string) => {
        try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
      }, 0)
    }
    const lensesDir = join(graphRoot, 'lenses')
    if (existsSync(lensesDir)) {
      for (const entry of readdirSync(lensesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue
        const obsFile = join(lensesDir, entry.name, 'observations.jsonl')
        if (existsSync(obsFile)) {
          observationCount += readFileSync(obsFile, 'utf-8').trim().split('\n').filter(Boolean).reduce((count: number, line: string) => {
            try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
          }, 0)
        }
      }
    }
    res.json({ ...parsed, observationCount })
  } catch {
    res.json({ model: null })
  }
})

app.get('/api/whisper', (_req, res) => {
  const graphRoot = getGraphRoot()
  const whisperPath = join(graphRoot, 'mind/whisper.txt')
  if (!existsSync(whisperPath)) {
    res.json({ whisper: null, tokens: 0 })
    return
  }
  const text = readFileSync(whisperPath, 'utf-8').trim()
  res.json({ whisper: text, tokens: Math.ceil(text.length / 4) })
})

app.get('/api/lenses', (_req, res) => {
  const graphRoot = getGraphRoot()
  const lensesDir = join(graphRoot, 'lenses')
  if (!existsSync(lensesDir)) {
    res.json([])
    return
  }
  const lenses: Array<{
    project: string
    hasModel: boolean
    hasWhisper: boolean
    observationCount: number
    lastCompressorRun: string
    model?: Record<string, unknown>
    whisper?: string
  }> = []
  for (const entry of readdirSync(lensesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const dir = join(lensesDir, entry.name)
    const modelFile = join(dir, 'model.json')
    const whisperFile = join(dir, 'whisper.txt')
    const obsFile = join(dir, 'observations.jsonl')

    let model: Record<string, unknown> | null = null
    let lastCompressorRun = ''
    let observationCount = 0

    if (existsSync(modelFile)) {
      try {
        const parsed = JSON.parse(readFileSync(modelFile, 'utf-8'))
        model = parsed.model || null
        lastCompressorRun = parsed.lastCompressorRun || ''
      } catch { /* skip */ }
    }

    if (existsSync(obsFile)) {
      const content = readFileSync(obsFile, 'utf-8').trim()
      observationCount = content.split('\n').filter(Boolean).reduce((count: number, line: string) => {
        try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
      }, 0)
    }

    let whisper: string | undefined
    if (existsSync(whisperFile)) {
      whisper = readFileSync(whisperFile, 'utf-8').trim() || undefined
    }

    lenses.push({
      project: entry.name,
      hasModel: existsSync(modelFile),
      hasWhisper: existsSync(whisperFile),
      observationCount,
      lastCompressorRun,
      ...(model ? { model } : {}),
      ...(whisper ? { whisper } : {}),
    })
  }
  res.json(lenses)
})

app.get('/api/lens/:project', (req, res) => {
  const graphRoot = getGraphRoot()
  const lensDir = join(graphRoot, 'lenses', sanitizeProjectSlug(req.params.project))
  if (!existsSync(lensDir)) {
    res.status(404).json({ error: 'Lens not found' })
    return
  }
  const modelFile = join(lensDir, 'model.json')
  const whisperFile = join(lensDir, 'whisper.txt')
  const obsFile = join(lensDir, 'observations.jsonl')

  let model = null
  let observations: Array<Record<string, unknown>> = []

  if (existsSync(modelFile)) {
    try { model = JSON.parse(readFileSync(modelFile, 'utf-8')) } catch { /* skip */ }
  }
  if (existsSync(obsFile)) {
    try {
      observations = readFileSync(obsFile, 'utf-8')
        .trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line))
    } catch { /* skip */ }
  }

  res.json({
    project: req.params.project,
    model,
    whisper: existsSync(whisperFile) ? readFileSync(whisperFile, 'utf-8').trim() : null,
    observations,
  })
})

app.get('/api/sessions/:project', (req, res) => {
  const graphRoot = getGraphRoot()
  const sessionsFile = join(graphRoot, 'sessions', `${sanitizeProjectSlug(req.params.project)}.jsonl`)
  if (!existsSync(sessionsFile)) {
    res.json([])
    return
  }
  try {
    const sessions = readFileSync(sessionsFile, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line))
    res.json(sessions)
  } catch {
    res.json([])
  }
})

app.get('/api/observations', (_req, res) => {
  const graphRoot = getGraphRoot()

  const globalObsFile = join(graphRoot, 'mind', 'observations.jsonl')
  let globalCount = 0
  if (existsSync(globalObsFile)) {
    globalCount = readFileSync(globalObsFile, 'utf-8').trim().split('\n').filter(Boolean).reduce((count: number, line: string) => {
      try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
    }, 0)
  }

  const projectObs: Record<string, number> = {}
  const lensesDir = join(graphRoot, 'lenses')
  if (existsSync(lensesDir)) {
    for (const entry of readdirSync(lensesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue
      const obsFile = join(lensesDir, entry.name, 'observations.jsonl')
      if (existsSync(obsFile)) {
        projectObs[entry.name] = readFileSync(obsFile, 'utf-8').trim().split('\n').filter(Boolean).reduce((count: number, line: string) => {
          try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
        }, 0)
      }
    }
  }

  res.json({ global: globalCount, projects: projectObs })
})

app.get('/api/mind-graph', (_req, res) => {
  const graphRoot = getGraphRoot()
  const index = readV3Index(graphRoot)
  if (!index.entries || Object.keys(index.entries).length === 0) {
    res.json({ entries: {}, categories: {}, projects: {}, totalNodes: 0, antiPatterns: 0 })
    return
  }
  try {
    const entries = index.entries || {}
    const nodes = Object.values(entries) as Array<Record<string, unknown>>

    const elements: Array<Record<string, unknown>> = []
    for (const node of nodes) {
      elements.push({
        data: {
          id: node.path,
          label: (node.path as string).split('/').pop(),
          category: node.category,
          confidence: node.confidence,
          gist: (node.gist as string || '').slice(0, 80),
          anti_pattern: node.anti_pattern || false,
        },
      })
      for (const edge of (node.edges as Array<Record<string, unknown>> || [])) {
        elements.push({
          data: {
            id: `${node.path}->${edge.target}`,
            source: node.path,
            target: edge.target,
            type: edge.type,
            weight: edge.weight,
          },
        })
      }
    }

    const categories: Record<string, number> = {}
    for (const cat of Object.keys(index.categories || {})) {
      categories[cat] = (index.categories[cat] as unknown[]).length
    }

    const projects: Record<string, number> = {}
    for (const proj of Object.keys(index.projects || {})) {
      projects[proj] = (index.projects[proj] as unknown[]).length
    }

    res.json({
      elements,
      totalNodes: nodes.length,
      antiPatterns: nodes.filter(n => n.anti_pattern || n.category === 'anti-patterns').length,
      categories,
      projects,
      builtAt: index.builtAt,
    })
  } catch {
    res.json({ entries: {}, categories: {}, projects: {}, totalNodes: 0, antiPatterns: 0 })
  }
})

app.get('/api/mind-node/:path(*)', (req, res) => {
  const graphRoot = getGraphRoot()
  const { nodes } = getPaths(graphRoot)
  const nodePath = resolve(nodes, `${req.params['path']}.md`)
  if (!nodePath.startsWith(nodes) || !existsSync(nodePath)) {
    res.status(404).json({ error: 'Node not found' })
    return
  }
  try {
    const raw = readFileSync(nodePath, 'utf-8')
    const parsed = matter(raw)
    res.json({
      path: req.params['path'],
      frontmatter: parsed.data,
      content: parsed.content.trim(),
    })
  } catch {
    res.status(500).json({ error: 'Failed to parse node' })
  }
})

app.get('/api/mind-status', (_req, res) => {
  const graphRoot = getGraphRoot()
  const mindDir = join(graphRoot, 'mind')
  const hasMind = existsSync(mindDir) && existsSync(join(mindDir, 'whisper.txt'))
  const index = readV3Index(graphRoot)

  let graphStats = { totalNodes: 0, antiPatterns: 0, categories: {} as Record<string, number>, projects: {} as Record<string, number> }
  if (index.entries && Object.keys(index.entries).length > 0) {
    try {
      const entries = Object.values(index.entries || {}) as Array<Record<string, unknown>>
      graphStats = {
        totalNodes: entries.length,
        antiPatterns: entries.filter(n => n.anti_pattern || n.category === 'anti-patterns').length,
        categories: Object.fromEntries(Object.entries(index.categories || {}).map(([k, v]) => [k, (v as unknown[]).length])),
        projects: Object.fromEntries(Object.entries(index.projects || {}).map(([k, v]) => [k, (v as unknown[]).length])),
      }
    } catch { /* skip */ }
  }

  const lensesDir = join(graphRoot, 'lenses')
  let lensCount = 0
  if (existsSync(lensesDir)) {
    lensCount = readdirSync(lensesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).length
  }

  res.json({
    initialized: existsSync(join(graphRoot, 'nodes')) || existsSync(join(graphRoot, 'MAP.md')),
    v3: {
      hasGlobalWhisper: hasMind,
      lensCount,
      ...graphStats,
    },
    v2: {
      hasMap: existsSync(join(graphRoot, 'MAP.md')),
      nodeCount: existsSync(join(graphRoot, 'nodes')) ? countActiveMarkdownFiles(join(graphRoot, 'nodes')) : 0,
    },
  })
})

app.get('/api/active-sessions', (_req, res) => {
  const graphRoot = getGraphRoot()
  const bufferDir = getPaths(graphRoot).buffer
  const sessionsDir = join(graphRoot, '.sessions')
  if (!existsSync(bufferDir)) { res.json([]); return }

  const activeSessions: Array<Record<string, unknown>> = []
  const bufferFiles = readdirSync(bufferDir).filter(f => f.startsWith('conversation-') && f.endsWith('.jsonl'))

  for (const bf of bufferFiles) {
    const filePath = join(bufferDir, bf)
    const sessionId = bf.replace('conversation-', '').replace('.jsonl', '')
    try {
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
      const first = JSON.parse(lines[0])
      const last = JSON.parse(lines[lines.length - 1])
      const project = first.project || last.project || null

      const sessionDir = join(sessionsDir, sessionId)
      let hasAssistantTrace = false
      let hasToolTrace = false
      if (existsSync(sessionDir)) {
        hasAssistantTrace = existsSync(join(sessionDir, 'assistant-trace.jsonl'))
        hasToolTrace = existsSync(join(sessionDir, 'tool-trace.jsonl'))
      }

      activeSessions.push({
        sessionId,
        project,
        messageCount: lines.length,
        startedAt: first.timestamp,
        lastActivity: last.timestamp,
        hasAssistantTrace,
        hasToolTrace,
      })
    } catch {}
  }

  activeSessions.sort((a, b) => Date.parse(b.lastActivity as string) - Date.parse(a.lastActivity as string))
  res.json(activeSessions)
})

app.get('/api/mind-pipeline', (_req, res) => {
  const graphRoot = getGraphRoot()
  const jobsDir = join(graphRoot, '.jobs')

  let daemonState: Record<string, unknown> | null = null
  const daemonStatePath = join(jobsDir, 'daemon-state.json')
  if (existsSync(daemonStatePath)) {
    try { daemonState = JSON.parse(readFileSync(daemonStatePath, 'utf-8')) } catch {}
  }

  const recentJobs: Array<Record<string, unknown>> = []
  const states: Array<'done' | 'failed' | 'running' | 'queued'> = ['running', 'queued', 'failed', 'done']
  for (const state of states) {
    const dir = join(jobsDir, state)
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of state === 'done' ? files.slice(-20) : files) {
      try {
        const job = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
        if (!job || typeof job !== 'object') continue
        recentJobs.push({
          id: job.id,
          type: job.type,
          state,
          project: job.payload?.project || null,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          attempt: job.attempt,
          lastError: job.lastError || null,
          triggerSource: job.triggerSource || null,
        })
      } catch {}
    }
  }
  recentJobs.sort((a, b) => {
    const ta = Date.parse((a.startedAt || a.createdAt) as string) || 0
    const tb = Date.parse((b.startedAt || b.createdAt) as string) || 0
    return tb - ta
  })

  const completedObservers = recentJobs
    .filter(j => j.type === 'observer' && j.state === 'done')
  const completedCompressors = recentJobs
    .filter(j => j.type === 'compressor' && j.state === 'done')
  const lastCompressorAt = completedCompressors.length > 0
    ? Date.parse((completedCompressors[0].completedAt as string) || '')
    : 0
  const observersSinceCompressor = completedObservers
    .filter(j => Date.parse((j.completedAt as string) || '') > lastCompressorAt)
    .length

  let pendingObservations = 0
  const globalObsFile = join(graphRoot, 'mind', 'observations.jsonl')
  if (existsSync(globalObsFile)) {
    const content = readFileSync(globalObsFile, 'utf-8').trim()
    pendingObservations = content.split('\n').filter(Boolean).reduce((count: number, line: string) => {
      try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
    }, 0)
  }
  const lensObsDir = join(graphRoot, 'lenses')
  if (existsSync(lensObsDir)) {
    for (const entry of readdirSync(lensObsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const lensObs = join(lensObsDir, entry.name, 'observations.jsonl')
      if (!existsSync(lensObs)) continue
      const content = readFileSync(lensObs, 'utf-8').trim()
      pendingObservations += content.split('\n').filter(Boolean).reduce((count: number, line: string) => {
        try { return JSON.parse(line).absorbed ? count : count + 1 } catch { return count + 1 }
      }, 0)
    }
  }

  res.json({
    daemon: daemonState ? {
      running: daemonState.running,
      pid: daemonState.pid,
      updatedAt: daemonState.updatedAt,
    } : null,
    observersSinceCompressor,
    compressorThreshold: 5,
    pendingObservations,
    recentJobs: recentJobs.slice(0, 25),
  })
})

function countNodes(dir: string): number {
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countNodes(join(dir, entry.name))
    else if (entry.name.endsWith('.md')) count++
  }
  return count
}

function broadcast(type: string) {
  const existing = debounceTimers.get(type)
  if (existing) clearTimeout(existing)
  debounceTimers.set(type, setTimeout(() => {
    debounceTimers.delete(type)
    const payload = `data: ${JSON.stringify({ type })}\n\n`
    for (const client of clients) client.write(payload)
  }, 300))
}

const initialGraphRoot = getGraphRoot()
const watcher = watch([
  initialGraphRoot,
  getPointerConfigPath(),
], {
  ignoreInitial: true,
  ignored: /(^|[\/\\])\.git(\/|$)/,
  depth: 5,
})

watcher.on('all', (_event, changedPath) => {
  if (changedPath.includes('.pipeline-logs/')) {
    broadcast('pipeline')
    broadcast('logs')
    return
  }
  if (changedPath.includes('.jobs/')) {
    broadcast('status')
    broadcast('pipeline')
    return
  }
  if (changedPath.endsWith('.runtime-config.json') || changedPath.includes('.active-projects/')) {
    broadcast('status')
    return
  }
  if (changedPath.includes('activity.jsonl')) {
    broadcast('activity')
    return
  }
  if (changedPath.includes('.deltas/') || changedPath.includes('/dreams/')) {
    broadcast('deltas')
    broadcast('status')
    return
  }
  if (
    changedPath.endsWith('.index.json') ||
    changedPath.endsWith('MAP.md') ||
    changedPath.endsWith('PRIORS.md') ||
    changedPath.endsWith('SOMA.md') ||
    changedPath.endsWith('WORKING.md') ||
    changedPath.includes('/working/') ||
    changedPath.endsWith('DREAMS.md') ||
    changedPath.includes('/briefs/') ||
    changedPath.includes('/nodes/') ||
    changedPath.includes('/archive/') ||
    changedPath.includes('/mind/') ||
    changedPath.includes('/lenses/') ||
    changedPath.includes('/sessions/') ||
    changedPath.includes('/graph/') ||
    changedPath.includes('/.pipeline/observations')
  ) {
    broadcast('graph')
    broadcast('status')
    return
  }
  if (changedPath.includes('.buffer/') && changedPath.includes('conversation-') && changedPath.endsWith('.jsonl')) {
    broadcast('status')
  }
})

const server = app.listen(PORT, () => {
  console.log(`Memory dashboard server listening on http://localhost:${PORT}`)
  console.log(`Graph root: ${initialGraphRoot}`)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Memory dashboard API port ${PORT} is already in use. ` +
      `Stop the existing process or restart with MEMORY_DASHBOARD_API_PORT set to a different port.`,
    )
    process.exit(1)
  }

  throw error
})
