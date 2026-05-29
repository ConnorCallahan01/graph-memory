import { useMemo } from 'react'
import {
  PipelineJob,
  SessionTraceSummary,
  ProjectWorkingFile,
} from '../lib/api'
import PipelineProgress from './PipelineProgress'

function timeAgo(ts: string): string {
  const ms = Date.now() - Date.parse(ts)
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function getJobProject(job: PipelineJob): string | null {
  const p = job.payload as Record<string, unknown>
  if (typeof p?.project === 'string' && p.project !== 'global') return p.project
  return null
}

export default function ProjectActivity({
  project,
  jobs,
  sessions,
  working,
}: {
  project: string
  jobs: PipelineJob[]
  sessions: SessionTraceSummary[]
  working: ProjectWorkingFile | null
}) {
  const projectJobs = useMemo(() => {
    return jobs
      .filter(j => {
        const jp = getJobProject(j)
        return jp === project
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 15)
  }, [jobs, project])

  const projectSessions = useMemo(() => {
    return sessions
      .filter(s => s.project === project)
      .slice(0, 8)
  }, [sessions, project])

  return (
    <div className="pa">
      {working?.content && (
        <section style={{ marginBottom: 'var(--space-8)' }}>
          <h2 className="pa-section-title">
            Working Memory
            {working.updatedAt && (
              <span className="pa-section-count">{timeAgo(working.updatedAt)}</span>
            )}
          </h2>
          <div className="pa-project-working">
            <pre>{working.content}</pre>
          </div>
        </section>
      )}

      <section style={{ marginBottom: 'var(--space-8)' }}>
        <h2 className="pa-section-title">Pipeline Position</h2>
        <PipelineProgress project={project} />
      </section>

      <section style={{ marginBottom: 'var(--space-8)' }}>
        <h2 className="pa-section-title">
          Pipeline Jobs
          <span className="pa-section-count">{projectJobs.length}</span>
        </h2>
        {projectJobs.length === 0 ? (
          <div className="pa-empty">No pipeline jobs for this project</div>
        ) : (
          <div className="pa-project-jobs">
            {projectJobs.map(j => (
              <div key={j.id} className={`pa-job pa-job-${j.displayState}`}>
                <span className={`pp-state pp-state-${j.displayState}`}>{j.displayState}</span>
                <span className="pa-job-type">{j.type.replace(/_/g, ' ')}</span>
                <span className="pa-job-dur">{fmtDuration(j.durationMs)}</span>
                <span className="pa-job-time">{timeAgo(j.createdAt)}</span>
                {j.lastError && <span className="pp-job-error-badge">!</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 'var(--space-8)' }}>
        <h2 className="pa-section-title">
          Recent Sessions
          <span className="pa-section-count">{projectSessions.length}</span>
        </h2>
        {projectSessions.length === 0 ? (
          <div className="pa-empty">No sessions for this project</div>
        ) : (
          <div className="pa-sessions">
            {projectSessions.map(s => (
              <div key={s.sessionId} className="pa-session">
                <div className="pa-session-header">
                  <span className="pa-session-id">{s.sessionId.slice(0, 8)}</span>
                  <span className="pa-session-time">{timeAgo(s.updatedAt)}</span>
                  <span className="pa-session-tools">{s.eventCount} events</span>
                </div>
                {s.lastEvents.length > 0 && (
                  <div className="pa-session-events">
                    {s.lastEvents.slice(0, 5).map((e, i) => (
                      <div key={i} className="pa-session-event">
                        <span className="pa-session-event-dot" />
                        <span className="pa-session-event-name">{e.toolName || e.type}</span>
                        {e.targetPaths?.[0] && (
                          <span className="pa-session-event-target">
                            {e.targetPaths[0].split('/').pop()}
                          </span>
                        )}
                        {e.durationMs != null && e.durationMs > 0 && (
                          <span className="pa-session-event-dur">{fmtDuration(e.durationMs)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
