import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityEvent,
  ArchiveEntry,
  AuditData,
  DeltaSummary,
  DreamsData,
  GraphElement,
  GraphNode,
  LatestBrief,
  MemoryHealth,
  PipelineJob,
  PipelineStatus,
  ProjectWorkingFile,
  SessionTraceSummary,
  SkillforgeManifest,
  WorkerLogSummary,
  fetchActivity,
  fetchArchive,
  fetchAudit,
  fetchAuditedDeltas,
  fetchDeltas,
  fetchDreams,
  fetchGraph,
  fetchHealth,
  fetchLatestBrief,
  fetchLogs,
  fetchPipeline,
  fetchProjectWorkingFiles,
  fetchSkills,
  fetchStatus,
  fetchSessionTraces,
  subscribeToEvents,
} from './lib/api'
import BriefView from './components/BriefView'
import GraphExplorer from './components/GraphExplorer'
import ActivityPanel from './components/ActivityPanel'
import ContextView from './components/ContextView'
import SessionReplay from './components/SessionReplay'

type ViewTab = 'brief' | 'graph' | 'context' | 'sessions'

function deriveProjects(
  workingFiles: ProjectWorkingFile[],
): string[] {
  const seen = new Set<string>()
  const projects: string[] = []

  for (const wf of workingFiles) {
    if (wf.project && wf.project !== 'global' && !seen.has(wf.project)) {
      seen.add(wf.project)
      projects.push(wf.project)
    }
  }

  return projects
}

function getHealthStatus(status: PipelineStatus | null) {
  if (!status) return { level: 'ok' as const, label: 'Loading' }
  if (status.failedJobs > 0) return { level: 'err' as const, label: `${status.failedJobs} failed` }
  if (status.runningJobs > 0) return { level: 'ok' as const, label: 'Running' }
  if (status.warnings.length > 0) return { level: 'warn' as const, label: `${status.warnings.length} warning${status.warnings.length > 1 ? 's' : ''}` }
  return { level: 'ok' as const, label: 'Healthy' }
}

export default function App() {
  const [view, setView] = useState<ViewTab>('brief')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [elements, setElements] = useState<GraphElement[]>([])
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[]>([])
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [brief, setBrief] = useState<LatestBrief | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([])
  const [deltas, setDeltas] = useState<DeltaSummary[]>([])
  const [auditedDeltas, setAuditedDeltas] = useState<DeltaSummary[]>([])
  const [dreams, setDreams] = useState<DreamsData | null>(null)
  const [pipelineJobs, setPipelineJobs] = useState<PipelineJob[]>([])
  const [logs, setLogs] = useState<WorkerLogSummary[]>([])
  const [sessionTraces, setSessionTraces] = useState<SessionTraceSummary[]>([])
  const [projectWorkingFiles, setProjectWorkingFiles] = useState<ProjectWorkingFile[]>([])
  const [auditData, setAuditData] = useState<AuditData>({ brief: null, report: null })
  const [skills, setSkills] = useState<SkillforgeManifest[]>([])
  const [health, setHealth] = useState<MemoryHealth | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const shellRef = useRef<HTMLDivElement>(null)
  const selectedNodeRef = useRef(selectedNode)
  selectedNodeRef.current = selectedNode

  const loadGraph = useCallback(async () => {
    try {
      const [data, archive] = await Promise.all([fetchGraph(), fetchArchive()])
      setElements(data.elements)
      setNodes(data.elements.filter((el): el is GraphNode => el.group === 'nodes'))
      setArchiveEntries(archive)
    } catch {}
  }, [])

  const loadBrief = useCallback(async () => {
    try { setBrief(await fetchLatestBrief()) } catch {}
  }, [])

  const loadStatus = useCallback(async () => {
    try { setStatus(await fetchStatus()) } catch {}
  }, [])

  const loadWorkingFiles = useCallback(async () => {
    try { setProjectWorkingFiles(await fetchProjectWorkingFiles()) } catch {}
  }, [])

  const loadActivity = useCallback(async () => {
    try { setActivityEvents(await fetchActivity()) } catch {}
  }, [])

  const loadChanges = useCallback(async () => {
    try {
      const [deltaResult, dreamsResult, auditedResult, auditResult] = await Promise.all([
        fetchDeltas(),
        fetchDreams(),
        fetchAuditedDeltas(),
        fetchAudit(),
      ])
      setDeltas(deltaResult)
      setDreams(dreamsResult)
      setAuditedDeltas(auditedResult)
      setAuditData(auditResult)
    } catch {}
  }, [])

  const loadPipeline = useCallback(async () => {
    try {
      const [jobResult, logResult, traceResult] = await Promise.all([
        fetchPipeline(),
        fetchLogs(),
        fetchSessionTraces(),
      ])
      setPipelineJobs(jobResult)
      setLogs(logResult)
      setSessionTraces(traceResult)
    } catch {}
  }, [])

  const loadSkills = useCallback(async () => {
    try { setSkills(await fetchSkills()) } catch {}
  }, [])

  const loadHealth = useCallback(async () => {
    try { setHealth(await fetchHealth()) } catch {}
  }, [])

  useEffect(() => {
    loadGraph()
    loadBrief()
    loadStatus()
    loadWorkingFiles()
    loadActivity()
    loadChanges()
    loadPipeline()
    loadSkills()
    loadHealth()
  }, [loadGraph, loadBrief, loadStatus, loadWorkingFiles, loadActivity, loadChanges, loadPipeline, loadSkills, loadHealth])

  useEffect(() => {
    setProjects(deriveProjects(projectWorkingFiles))
  }, [nodes, projectWorkingFiles, brief])

  useEffect(() => {
    if (projectFilter || projects.length === 0) return
    const activeNames = status?.activeProjects?.map((p: any) => p.name).filter((n: string) => n && n !== 'global') || []
    if (activeNames.length > 0 && projects.includes(activeNames[0])) {
      setProjectFilter(activeNames[0])
    } else {
      setProjectFilter(projects[0])
    }
  }, [projects, status?.activeProjects])

  useEffect(() => {
    const unsub = subscribeToEvents((type) => {
      if (type === 'graph') { loadGraph(); loadBrief(); loadWorkingFiles(); loadSkills() }
      if (type === 'status') { loadStatus(); loadBrief(); loadSkills() }
      if (type === 'activity') loadActivity()
      if (type === 'deltas') loadChanges()
      if (type === 'pipeline' || type === 'logs') { loadPipeline(); loadHealth() }
      if (type === 'node' && selectedNodeRef.current) {
        setDetailVersion((v) => v + 1)
      }
    })
    return unsub
  }, [loadGraph, loadBrief, loadStatus, loadWorkingFiles, loadActivity, loadChanges, loadPipeline])

  const pipelineHealth = getHealthStatus(status)

  const filteredNodes = projectFilter
    ? nodes.filter((n) => n.data.project === projectFilter || !n.data.project)
    : nodes

  const filteredElements = projectFilter
    ? (() => {
        const nodeIds = new Set(filteredNodes.map((n) => n.data.id))
        return elements.filter((el) => {
          if (el.group === 'nodes') return nodeIds.has(el.data.id)
          return nodeIds.has(el.data.source) && nodeIds.has(el.data.target)
        })
      })()
    : elements

  const projectNodeCounts = new Map<string, number>()
  for (const n of nodes) {
    const p = n.data.project || '__global__'
    projectNodeCounts.set(p, (projectNodeCounts.get(p) || 0) + 1)
  }

  const activeProjectNames = status?.activeProjects?.map((p: any) => p.name).filter((n: string) => n && n !== 'global') || []

  return (
    <div className="shell" ref={shellRef}>
      <header className="topbar">
        <div className="topbar-brand">Memory</div>
        <nav className="topbar-nav">
          {([
            ['brief', 'Brief'],
            ['graph', 'Graph'],
            ['context', 'Context'],
            ['sessions', 'Sessions'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={`topbar-tab${view === key ? ' active' : ''}`}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span className={`status-dot ${pipelineHealth.level}${status?.runningJobs ? ' pulse' : ''}`} />
          <span className="status-label">{pipelineHealth.label}</span>
          {status && (
            <>
              <span className="status-metric">{status.nodeCount} nodes</span>
              {health?.tokenAccounting && (
                <span className={`status-metric${health.tokenAccounting.overBudget ? ' status-metric-err' : ''}`}>
                  {health.tokenAccounting.total.toLocaleString()}t/{health.tokenAccounting.budget.toLocaleString()}t
                </span>
              )}
            </>
          )}
        </div>
      </header>

      <div className="project-strip">
        {projects.length === 0 ? (
          <span className="project-empty">No projects detected</span>
        ) : (
          projects.map((p) => {
            const isActive = activeProjectNames.includes(p)
            const isSelected = projectFilter === p
            const count = projectNodeCounts.get(p) || 0
            const globalCount = projectNodeCounts.get('__global__') || 0
            return (
              <button
                key={p}
                className={`project-chip${isSelected ? ' active' : ''}${isActive ? ' live' : ''}`}
                onClick={() => setProjectFilter(isSelected && projects.length > 1 ? (projects.find(x => x !== p) || null) : p)}
              >
                {p}
                <span className="project-chip-count">{count > 0 ? `${count + globalCount}` : `${globalCount}`}</span>
                {isActive && <span className="project-chip-dot" />}
              </button>
            )
          })
        )}
      </div>

      <main className="main">
        <div className={`content-area${view === 'graph' || view === 'sessions' ? ' graph-mode' : ''}`}>
          {view === 'brief' && (
            <BriefView
              brief={brief}
              projectFilter={projectFilter}
              status={status}
              onNavigate={(v) => setView(v)}
              workingFiles={projectWorkingFiles}
            />
          )}
          {view === 'graph' && (
            <GraphExplorer
              elements={filteredElements}
              nodes={filteredNodes}
              archivedNodes={archiveEntries}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              detailVersion={detailVersion}
              onNavigate={setSelectedNode}
            />
          )}
          {view === 'context' && <ContextView activeProjects={status?.activeProjects ?? []} />}
          {view === 'sessions' && <SessionReplay traces={sessionTraces} />}
        </div>

        <ActivityPanel
          projectFilter={projectFilter}
          status={status}
          jobs={pipelineJobs}
          logs={logs}
          traces={sessionTraces}
          events={activityEvents}
          deltas={deltas}
          auditBrief={auditData.brief}
          dreams={dreams}
          skills={skills}
          health={health}
        />
      </main>
    </div>
  )
}
