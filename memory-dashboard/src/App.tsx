import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityEvent,
  ArchiveEntry,
  GraphElement,
  GraphNode,
  ModelResponse,
  PipelineJob,
  ProjectSummary,
  ProjectsData,
  StartupContext,
  fetchActivity,
  fetchArchive,
  fetchGraph,
  fetchModel,
  fetchPipeline,
  fetchProjectWorkingFiles,
  fetchProjects,
  fetchStartupContext,
  fetchStatus,
  subscribeToEvents,
} from './lib/api'
import type { PipelineStatus, ProjectWorkingFile } from './lib/api'
import GraphExplorer from './components/GraphExplorer'

function timeAgo(ts: string): string {
  const ms = Date.now() - Date.parse(ts)
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}

export default function App() {
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [elements, setElements] = useState<GraphElement[]>([])
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[]>([])
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const [projectsData, setProjectsData] = useState<ProjectsData | null>(null)
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [model, setModel] = useState<ModelResponse | null>(null)
  const [startupCtx, setStartupCtx] = useState<StartupContext | null>(null)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  const [projectWorking, setProjectWorking] = useState<ProjectWorkingFile | null>(null)
  const [showGraph, setShowGraph] = useState(false)
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

  const loadAll = useCallback(async () => {
    try { const s = await fetchStatus(); setStatus(s) } catch {}
    try { const p = await fetchProjects(); setProjectsData(p) } catch {}
  }, [])

  const loadGlobal = useCallback(async () => {
    try { const m = await fetchModel(); setModel(m) } catch {}
  }, [])

  const loadActivity = useCallback(async () => {
    try { const a = await fetchActivity(30); setActivity(a) } catch {}
    try { const j = await fetchPipeline(); setJobs(j) } catch {}
  }, [])

  useEffect(() => {
    loadGraph()
    loadAll()
    loadGlobal()
    loadActivity()
  }, [loadGraph, loadAll, loadGlobal, loadActivity])

  useEffect(() => {
    const unsub = subscribeToEvents((type) => {
      if (type === 'graph') { loadGraph(); loadAll(); loadGlobal() }
      if (type === 'status') { loadAll(); loadActivity() }
      if (type === 'pipeline') loadActivity()
      if (type === 'activity') loadActivity()
      if (type === 'node' && selectedNodeRef.current) setDetailVersion((v) => v + 1)
    })
    return unsub
  }, [loadGraph, loadAll, loadGlobal])

  useEffect(() => {
    if (!selectedProject) return
    fetchStartupContext().then(setStartupCtx).catch(() => {})
    fetchProjectWorkingFiles().then(files => {
      setProjectWorking(files.find(f => f.project === selectedProject) ?? null)
    }).catch(() => {})
  }, [selectedProject])

  const projects = useMemo(() => projectsData?.projects ?? [], [projectsData])

  const filteredNodes = useMemo(() => {
    if (!selectedProject) return nodes
    return nodes.filter((n) => n.data.project === selectedProject || !n.data.project)
  }, [nodes, selectedProject])

  const filteredElements = useMemo(() => {
    if (!selectedProject) return elements
    const nodeIds = new Set(filteredNodes.map((n) => n.data.id))
    return elements.filter((el) => {
      if (el.group === 'nodes') return nodeIds.has(el.data.id)
      return nodeIds.has(el.data.source) && nodeIds.has(el.data.target)
    })
  }, [elements, filteredNodes, selectedProject])

  const selectedProjectData = useMemo(() => {
    if (!selectedProject) return null
    return projects.find((p) => p.name === selectedProject) ?? null
  }, [projects, selectedProject])

  const daemonState = status?.runtime?.daemonState as Record<string, unknown> | null | undefined
  const daemonRunning = (daemonState?.running as boolean) ?? false
  const daemonPid = (daemonState?.pid as number) ?? null
  const daemonUpdated = (daemonState?.updatedAt as string) ?? null

  const runningJobs = status?.runningJobs ?? 0
  const queuedJobs = status?.queuedJobs ?? 0
  const failedJobs = status?.failedJobs ?? 0

  const topbar = (
    <header className="topbar">
      {selectedProject ? (
        <button className="topbar-brand topbar-back" onClick={() => { setSelectedProject(null); setShowGraph(false) }}>
          Memory
        </button>
      ) : (
        <div className="topbar-brand">Memory</div>
      )}
      {selectedProject && (
        <span className="topbar-project-name">{selectedProject.split('/').pop()}</span>
      )}
      <div className="topbar-right">
        {runningJobs > 0 && <span className="rail-badge running">{runningJobs} running</span>}
        {queuedJobs > 0 && <span className="rail-badge queued">{queuedJobs} queued</span>}
        {failedJobs > 0 && <span className="rail-badge failed">{failedJobs} failed</span>}
        <span className="status-metric">{nodes.length} nodes</span>
      </div>
    </header>
  )

  const injectionLayers = startupCtx?.layers ?? []
  const pinnedNodes = startupCtx?.pinnedNodes ?? []
  const projectInjectionTokens = injectionLayers
    .filter(l => l.id === 'working_project' || l.id === 'map')
    .reduce((s, l) => s + l.tokens, 0)
  const globalInjectionTokens = injectionLayers
    .filter(l => l.id !== 'working_project' && l.id !== 'map')
    .reduce((s, l) => s + l.tokens, 0)
  const pinnedTokens = pinnedNodes.reduce((s, n) => s + n.tokens, 0)

  if (!selectedProject) {
    const allCategories: Record<string, number> = {}
    for (const n of nodes) {
      allCategories[n.data.category] = (allCategories[n.data.category] || 0) + 1
    }

    return (
      <div className="shell">
        {topbar}
        <main className="landing-main">
          <div className="dash-grid">

            <div className="dash-left">
              <section className="arch-section">
                <h2 className="landing-section-title">Global Context</h2>
                <div className="arch-card arch-card-model">
                  <div className="arch-card-header">
                    <span className="arch-card-label">Mental Model</span>
                    <span className="arch-card-tokens">{model?.model?.tokenEstimate ?? 0}t</span>
                  </div>
                  {model?.model ? (
                    <div className="arch-card-body arch-card-body-cols">
                      <div className="arch-col">
                        <div className="model-field">
                          <span className="model-field-label">Thinking</span>
                          <span className="model-field-value">{model.model.cognitiveStyle}</span>
                        </div>
                        {model.model.preferences.length > 0 && (
                          <div className="model-field">
                            <span className="model-field-label">Preferences ({model.model.preferences.length})</span>
                            <ul className="model-list">{model.model.preferences.map((p, i) => <li key={i}>{p}</li>)}</ul>
                          </div>
                        )}
                        {model.model.decisionPatterns.length > 0 && (
                          <div className="model-field">
                            <span className="model-field-label">Decisions ({model.model.decisionPatterns.length})</span>
                            <ul className="model-list">{model.model.decisionPatterns.map((d, i) => <li key={i}>{d}</li>)}</ul>
                          </div>
                        )}
                      </div>
                      <div className="arch-col">
                        {model.model.guardrails.length > 0 && (
                          <div className="model-field">
                            <span className="model-field-label">Guardrails ({model.model.guardrails.length})</span>
                            <ul className="model-list model-list-guardrails">{model.model.guardrails.map((g, i) => <li key={i}>{g}</li>)}</ul>
                          </div>
                        )}
                        {model.model.emotionalProfile && (
                          <div className="model-field">
                            <span className="model-field-label">Engagement</span>
                            <span className="model-field-value">{model.model.emotionalProfile}</span>
                          </div>
                        )}
                      </div>
                      <div className="model-meta">
                        Compressed {timeAgo(model.lastCompressorRun)}
                        {model.observationCount > 0 && ` · ${model.observationCount} obs pending`}
                      </div>
                    </div>
                  ) : (
                    <div className="arch-card-empty">No mental model yet.</div>
                  )}
                </div>
              </section>

              <section className="arch-section">
                <h2 className="landing-section-title">Injection</h2>
                <div className="inject-flow">
                  <div className="inject-layer inject-global">
                    <span className="inject-layer-label">Global</span>
                    <div className="inject-items inject-items-row">
                      <div className="inject-item">
                        <span className="inject-item-name">Model</span>
                        <span className="inject-item-src">mind/model.json</span>
                        <span className="inject-item-tokens">{model?.model?.tokenEstimate ?? '~'}t</span>
                      </div>
                      <div className="inject-item">
                        <span className="inject-item-name">Dreams</span>
                        <span className="inject-item-src">DREAMS.md</span>
                        <span className="inject-item-tokens">{injectionLayers.find(l => l.id === 'dreams')?.tokens ?? 0}t</span>
                      </div>
                    </div>
                  </div>
                  <div className="inject-divider">
                    <span className="inject-divider-line" />
                    <span className="inject-divider-label">+ project</span>
                    <span className="inject-divider-line" />
                  </div>
                  <div className="inject-layer inject-project">
                    <span className="inject-layer-label">Project</span>
                    <div className="inject-items inject-items-row">
                      <div className="inject-item">
                        <span className="inject-item-name">MAP</span>
                        <span className="inject-item-tokens">{injectionLayers.find(l => l.id === 'map')?.tokens ?? '~'}t</span>
                      </div>
                      <div className="inject-item">
                        <span className="inject-item-name">Working</span>
                        <span className="inject-item-tokens">{injectionLayers.find(l => l.id === 'working_project')?.tokens ?? 0}t</span>
                      </div>
                      <div className="inject-item">
                        <span className="inject-item-name">Pinned</span>
                        <span className="inject-item-tokens">{startupCtx?.pinnedNodes?.length ?? 0} nodes</span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="arch-section">
                <h2 className="landing-section-title">Projects</h2>
                {projects.length === 0 ? (
                  <p className="landing-empty">No projects detected</p>
                ) : (
                  <div className="landing-project-grid">
                    {projects.map((p) => (
                      <button
                        key={p.name}
                        className="project-card"
                        onClick={() => setSelectedProject(p.name)}
                      >
                        <div className="project-card-header">
                          <span className="project-card-name">{p.name.split('/').pop()}</span>
                          <span className="project-card-nodes">{p.nodeCount}</span>
                        </div>
                        <div className="project-card-meta">
                          {p.hasWorking && p.workingPreview ? (
                            <span className="project-card-whisper">{p.workingPreview.slice(0, 120)}</span>
                          ) : (
                            <span className="project-card-no-whisper">No working memory</span>
                          )}
                        </div>
                        {p.lastUpdated && (
                          <div className="project-card-session">
                            <span className="project-card-session-label">Updated</span>
                            <span className="project-card-session-time">{timeAgo(p.lastUpdated)}</span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {Object.keys(allCategories).length > 0 && (
                <section className="landing-categories">
                  <h2 className="landing-section-title">Categories</h2>
                  <div className="landing-cat-grid">
                    {Object.entries(allCategories)
                      .sort(([, a], [, b]) => b - a)
                      .map(([cat, count]) => (
                        <div key={cat} className="landing-cat">
                          <span className="landing-cat-name">{cat}</span>
                          <span className="landing-cat-count">{count}</span>
                        </div>
                      ))}
                  </div>
                </section>
              )}
            </div>

            <div className="dash-right">
              <section className="arch-section">
                <h2 className="landing-section-title">
                  Pipeline
                  <span className={`pipeline-daemon-dot-inline ${daemonRunning ? 'alive' : 'dead'}`} />
                  <span className="pipeline-daemon-label-inline">
                    {daemonRunning ? `PID ${daemonPid}` : 'Stopped'}
                  </span>
                </h2>
                <div className="pipeline-flow-compact">
                  <div className="pf-step"><span className="pf-num">1</span><span className="pf-name">Scribe</span></div>
                  <span className="pf-arrow" />
                  <div className="pf-step"><span className="pf-num">2</span><span className="pf-name">Auditor</span></div>
                  <span className="pf-arrow" />
                  <div className="pf-step"><span className="pf-num">3</span><span className="pf-name">Librarian</span></div>
                  <span className="pf-arrow" />
                  <div className="pf-step"><span className="pf-num">4</span><span className="pf-name">Dreamer</span></div>
                </div>
                <div className="pipeline-flow-compact pipeline-flow-compact-global">
                  <div className="pf-step pf-step-global"><span className="pf-num">5</span><span className="pf-name">Observer</span></div>
                  <span className="pf-arrow" />
                  <div className="pf-step pf-step-global"><span className="pf-num">6</span><span className="pf-name">Compressor</span></div>
                </div>
                {status?.pipelineCutoffs && status.pipelineCutoffs.length > 0 && (
                  <div className="pipeline-jobs">
                    {status.pipelineCutoffs.map((c) => (
                      <div key={c.stage} className={`pipeline-job ${c.status}`}>
                        <span className={`pipeline-job-state ${c.status === 'running' ? 'running' : c.status === 'queued' ? 'queued' : c.status === 'ready' ? 'running' : 'done'}`}>{c.status}</span>
                        <span className="pipeline-job-type">{(c.stage || 'unknown').replace('_', ' ')}</span>
                        <span className="pipeline-job-trigger">{c.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="arch-section">
                <h2 className="landing-section-title">Activity</h2>
                <div className="activity-panel">
                  {jobs.length > 0 && (
                    <div className="activity-jobs">
                      {jobs.slice(0, 6).map((j) => (
                        <div key={j.id} className={`activity-job activity-job-${j.displayState}`}>
                          <span className={`activity-job-state activity-job-state-${j.displayState}`}>{j.displayState}</span>
                          <span className="activity-job-type">{j.type}</span>
                          <span className="activity-job-msg">{j.displayMessage || (j.payload as Record<string, string>)?.sessionId || ''}</span>
                          <span className="activity-job-time">{j.durationMs > 0 ? `${(j.durationMs / 1000).toFixed(1)}s` : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="activity-events">
                    {activity.length === 0 ? (
                      <div className="activity-empty">No recent activity</div>
                    ) : (
                      activity.slice().reverse().slice(0, 20).map((e, i) => (
                        <div key={i} className="activity-event">
                          <span className="activity-event-time">{e.timestamp.slice(11, 16)}</span>
                          <span className="activity-event-msg">{e.message.length > 100 ? e.message.slice(0, 100) + '...' : e.message}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </main>
      </div>
    )
  }

  const projectCategories = selectedProjectData?.categories ?? {}

  return (
    <div className="shell">
      {topbar}
      <main className="project-main">
        <div className="project-content">
          <section className="project-inject">
            <h2 className="project-section-title">Context for This Project</h2>
            <div className="inject-flow inject-flow-compact">
              <div className="inject-items inject-items-row">
                <div className="inject-item">
                  <span className="inject-item-name">Working</span>
                  <span className="inject-item-tokens">{injectionLayers.find(l => l.id === 'working_project')?.tokens ?? 0}t</span>
                  <span className="inject-item-src">lean handoff</span>
                </div>
                <div className="inject-item">
                  <span className="inject-item-name">MAP slice</span>
                  <span className="inject-item-tokens">{injectionLayers.find(l => l.id === 'map')?.tokens ?? 0}t</span>
                  <span className="inject-item-src">project nodes</span>
                </div>
                <div className="inject-item">
                  <span className="inject-item-name">Pinned</span>
                  <span className="inject-item-tokens">{pinnedNodes.length} nodes · {pinnedTokens}t</span>
                  <span className="inject-item-src">procedures</span>
                </div>
                <div className="inject-item inject-item-total">
                  <span className="inject-item-name">Total</span>
                  <span className="inject-item-tokens">{projectInjectionTokens + pinnedTokens}t</span>
                </div>
              </div>
            </div>
          </section>

          <section className="project-whisper">
            <h2 className="project-section-title">Working Memory</h2>
            {projectWorking?.content ? (
              <pre className="project-working-content">{projectWorking.content}</pre>
            ) : (
              <p className="project-whisper-empty">No working memory for this project</p>
            )}
          </section>

          <section className="project-sessions">
            <h2 className="project-section-title">
              Nodes
              <span className="project-section-count">{filteredNodes.length}</span>
            </h2>
            {Object.keys(projectCategories).length > 0 ? (
              <div className="landing-cat-grid" style={{ marginBottom: 'var(--space-3)' }}>
                {Object.entries(projectCategories)
                  .sort(([, a], [, b]) => b - a)
                  .map(([cat, count]) => (
                    <div key={cat} className="landing-cat">
                      <span className="landing-cat-name">{cat}</span>
                      <span className="landing-cat-count">{count}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="project-empty">No nodes for this project</p>
            )}
          </section>

          <section className="project-graph-section">
            <div className="project-graph-header">
              <h2 className="project-section-title">Graph</h2>
              <button
                className={`graph-toggle-btn${showGraph ? ' active' : ''}`}
                onClick={() => setShowGraph(!showGraph)}
              >
                {showGraph ? 'Collapse' : 'Expand'}
              </button>
            </div>
            {showGraph ? (
              <div className="project-graph-canvas">
                <GraphExplorer
                  elements={filteredElements}
                  nodes={filteredNodes}
                  archivedNodes={archiveEntries}
                  selectedNode={selectedNode}
                  onSelectNode={setSelectedNode}
                  detailVersion={detailVersion}
                  onNavigate={setSelectedNode}
                />
              </div>
            ) : (
              <div className="project-graph-summary">
                <span className="project-graph-stat">{filteredNodes.length} nodes</span>
                <span className="project-graph-stat">{filteredElements.filter((e) => e.group === 'edges').length} edges</span>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  )
}
