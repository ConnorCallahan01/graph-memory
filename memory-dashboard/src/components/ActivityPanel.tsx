import { useCallback, useMemo, useState } from 'react'
import {
  ActivityEvent,
  DeltaSummary,
  DreamsData,
  MemoryHealth,
  PipelineJob,
  PipelineStatus,
  SessionTraceSummary,
  SkillforgeManifest,
  WorkerLogSummary,
  archiveDream,
  integrateDream,
} from '../lib/api'

function formatTime(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function timeAgo(ts: string): string {
  const ms = Date.now() - Date.parse(ts)
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}

const STAGE_ORDER = ['scribe', 'auditor', 'librarian', 'dreamer', 'memory_analysis'] as const

interface Props {
  projectFilter: string | null
  status: PipelineStatus | null
  jobs: PipelineJob[]
  logs: WorkerLogSummary[]
  traces: SessionTraceSummary[]
  events: ActivityEvent[]
  deltas: DeltaSummary[]
  auditBrief: string | null
  dreams: DreamsData | null
  skills: SkillforgeManifest[]
  health: MemoryHealth | null
}

const GRAPH_LEVEL_TYPES = new Set(['auditor', 'librarian', 'dreamer', 'memory_analysis'])

export default function ActivityPanel({
  projectFilter,
  status,
  jobs,
  logs,
  traces,
  events,
  deltas,
  auditBrief,
  dreams,
  skills,
  health,
}: Props) {
  const [expandedJob, setExpandedJob] = useState<string | null>(null)

  const projectJobs = useMemo(() => {
    let filtered = jobs
    if (projectFilter) {
      filtered = jobs.filter((j) => {
        if (GRAPH_LEVEL_TYPES.has(j.type)) return true
        const p = j.payload?.project
        if (typeof p === 'string') return p === projectFilter || p === 'global'
        return false
      })
    }
    return filtered.slice(0, 15)
  }, [jobs, projectFilter])

  const projectTraces = useMemo(() => {
    if (!projectFilter) return traces.slice(0, 5)
    return traces.filter((t) => t.project === projectFilter).slice(0, 5)
  }, [traces, projectFilter])

  const projectEvents = useMemo(() => {
    let filtered = events
    if (projectFilter) {
      filtered = events.filter((e) => {
        const msg = (e.message || '').toLowerCase()
        if (msg.includes('auditor') || msg.includes('librarian') || msg.includes('dreamer') || msg.includes('daemon')) return true
        return msg.includes(projectFilter.toLowerCase())
      })
    }
    return filtered.slice(0, 8)
  }, [events, projectFilter])

  const cutoffs = status?.pipelineCutoffs ?? []
  const runningCount = jobs.filter((j) => j.state === 'running').length
  const queuedCount = jobs.filter((j) => j.state === 'queued').length
  const failedCount = jobs.filter((j) => j.state === 'failed').length

  return (
    <aside className="activity-rail">
      <div className="rail-section">
        <div className="rail-heading">
          Pipeline
          {runningCount > 0 && <span className="rail-badge running">{runningCount}</span>}
          {queuedCount > 0 && <span className="rail-badge queued">{queuedCount}</span>}
          {failedCount > 0 && <span className="rail-badge failed">{failedCount}</span>}
        </div>

        {cutoffs.length > 0 && (
          <div className="rail-cutoffs">
            {cutoffs.map((c) => (
              <div key={c.stage} className={`rail-cutoff ${c.status}`}>
                <span className="cutoff-stage">{c.stage}</span>
                <span className="cutoff-detail">
                  {c.status === 'running' && c.current > 0
                    ? `${c.current}${c.threshold ? `/${c.threshold}` : ''}`
                    : c.detail}
                </span>
                <span className={`cutoff-indicator ${c.status}`} />
              </div>
            ))}
          </div>
        )}

        {!cutoffs.length && (
          <div className="rail-empty-sm">No pipeline activity</div>
        )}

        {status?.bufferByProject && status.bufferByProject.length > 0 && (
          <div className="rail-buffer-by-project">
            {status.bufferByProject.map((b) => (
              <div key={b.project} className="rail-buffer-row">
                <span className="buffer-project">{b.project === 'global' ? '(global)' : b.project.split('/').pop()}</span>
                <span className="buffer-count">{b.count} msgs</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {skills.length > 0 && (
        <div className="rail-section">
          <div className="rail-heading">
            Skills
            <span className="rail-count">{skills.length}</span>
          </div>
          {skills
            .filter((s) => !projectFilter || s.project === projectFilter)
            .map((skill) => (
              <div key={skill.skill_name} className="rail-skill">
                <div className="rail-skill-header">
                  <span className="rail-skill-name">{skill.skill_name}</span>
                  <span className="rail-skill-score">{(skill.score * 100).toFixed(0)}%</span>
                </div>
                <div className="rail-skill-meta">
                  <span className="rail-skill-project">{skill.project}</span>
                  {skill.refresh_count > 0 && (
                    <span className="rail-skill-refresh">{skill.refresh_count} refreshes</span>
                  )}
                </div>
                <div className="rail-skill-node">{skill.source_node}</div>
              </div>
            ))}
          {skills.filter((s) => !projectFilter || s.project === projectFilter).length === 0 && (
            <div className="rail-empty-sm">No skills for this project</div>
          )}
        </div>
      )}

      {projectTraces.length > 0 && (
        <div className="rail-section">
          <div className="rail-heading">
            Sessions
            <span className="rail-count">{projectTraces.length}</span>
          </div>
          {projectTraces.map((t) => (
            <div key={t.sessionId} className="rail-session">
              <div className="rail-session-header">
                <span className="session-id">{t.sessionId.slice(0, 8)}</span>
                <span className="session-time">{timeAgo(t.updatedAt)}</span>
              </div>
              <div className="rail-session-meta">
                {t.eventCount} events
                {t.tools.length > 0 && <span className="session-tools">{t.tools.slice(0, 3).join(', ')}</span>}
              </div>
              {t.lastEvents.length > 0 && (
                <div className="rail-session-events">
                  {t.lastEvents.slice(0, 2).map((e, i) => (
                    <div key={i} className="session-event-preview">
                      <span className={`event-type-dot ${e.type}`} />
                      {e.toolName || e.type}
                      {e.durationMs != null && (
                        <span className="event-duration">{formatDuration(e.durationMs)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rail-section">
        <div className="rail-heading">
          Jobs
          <span className="rail-count">{projectJobs.length}</span>
        </div>
        {projectJobs.length === 0 && (
          <div className="rail-empty-sm">No recent jobs</div>
        )}
        {projectJobs.map((job) => (
          <div key={job.id} className="rail-job">
            <div
              className="rail-job-header"
              onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
            >
              <span className={`rail-state ${job.displayState}`}>{job.displayState}</span>
              <span className="rail-job-type">{job.type}</span>
              <span className="rail-job-time">{formatTime(job.startedAt || job.createdAt)}</span>
            </div>
            {(job.displayMessage || job.durationMs > 0) && (
              <div className="rail-job-meta">
                {job.displayMessage && <span className="job-msg">{job.displayMessage}</span>}
                {job.durationMs > 0 && <span className="job-duration">{formatDuration(job.durationMs)}</span>}
              </div>
            )}
            {job.displayState === 'failed' && job.lastError && (
              <div className="rail-job-error">{job.lastError.slice(0, 200)}</div>
            )}
            {expandedJob === job.id && job.logTail && (
              <div className="rail-job-log">{job.logTail.slice(0, 500)}</div>
            )}
          </div>
        ))}
      </div>

      {auditBrief && (
        <div className="rail-section">
          <div className="rail-heading">Audit</div>
          <div className="rail-audit">{auditBrief.slice(0, 300)}</div>
        </div>
      )}

      {health && (
        <div className="rail-section">
          <div className="rail-heading">
            Memory health
            <span className={`rail-health-score ${health.score >= 75 ? 'good' : health.score >= 50 ? 'warn' : 'bad'}`}>
              {health.score}
            </span>
          </div>
          <div className="rail-health-grid">
            <div className="rail-health-metric">
              <span className="health-val">{health.nodeCount}</span>
              <span className="health-label">nodes</span>
            </div>
            <div className="rail-health-metric">
              <span className="health-val">{health.staleCount}</span>
              <span className="health-label">stale</span>
            </div>
            <div className="rail-health-metric">
              <span className="health-val">{health.orphanCount}</span>
              <span className="health-label">orphans</span>
            </div>
            <div className="rail-health-metric">
              <span className="health-val">{health.mapUsage}%</span>
              <span className="health-label">MAP</span>
            </div>
          </div>
          {health.balanceDominant && health.balanceDominant.ratio > 60 && (
            <div className="rail-health-warn">
              {health.balanceDominant.ratio}% {health.balanceDominant.category}
            </div>
          )}
        </div>
      )}

      {dreams && dreams.pending.length > 0 && (
        <div className="rail-section">
          <div className="rail-heading">
            Dreams
            <span className="rail-count">{dreams.pending.length}</span>
          </div>
          {dreams.pending.slice(0, 3).map((d, i) => (
            <div key={i} className="rail-dream">
              <div className="rail-dream-text">{d.fragment || d.content?.slice(0, 100) || d.filename}</div>
              <div className="rail-dream-actions">
                <button
                  className="rail-dream-btn accept"
                  onClick={(e) => { e.stopPropagation(); integrateDream(d.bucket, d.filename).catch(() => {}) }}
                >
                  Accept
                </button>
                <button
                  className="rail-dream-btn reject"
                  onClick={(e) => { e.stopPropagation(); archiveDream(d.bucket, d.filename).catch(() => {}) }}
                >
                  Skip
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {projectEvents.length > 0 && (
        <div className="rail-section">
          <div className="rail-heading">
            Events
            <span className="rail-count">{projectEvents.length}</span>
          </div>
          {projectEvents.map((e, i) => (
            <div key={`${e.timestamp}-${i}`} className="rail-event">
              <span className="rail-event-time">{formatTime(e.timestamp)}</span>
              <span className="rail-event-type">{e.type}</span>
              {e.message && <div className="rail-event-msg">{e.message.slice(0, 100)}</div>}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
