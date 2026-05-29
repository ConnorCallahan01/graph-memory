import { useState, useEffect, useCallback } from 'react'
import {
  PipelineJob,
  fetchLogDetail,
  WorkerLogDetail,
} from '../lib/api'

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

type Tab = 'running' | 'queued' | 'done' | 'failed'

function JobRow({ job, onExpand, expanded }: {
  job: PipelineJob
  onExpand: () => void
  expanded: boolean
}) {
  const project = getJobProject(job)
  const duration = job.durationMs > 0
    ? fmtDuration(job.durationMs)
    : job.state === 'running' && job.startedAt
      ? fmtDuration(Date.now() - Date.parse(job.startedAt))
      : ''

  return (
    <div className={`pp-job pp-job-${job.displayState}`}>
      <div className="pp-job-row" onClick={onExpand}>
        <span className={`pp-state pp-state-${job.displayState}`}>{job.displayState}</span>
        <span className="pp-job-type">{job.type.replace(/_/g, ' ')}</span>
        {project && <span className="pp-job-project">{project.split('/').pop()}</span>}
        <span className="pp-job-duration">{duration}</span>
        <span className="pp-job-time">{timeAgo(job.createdAt)}</span>
        {job.lastError && <span className="pp-job-error-badge">!</span>}
        <span className="pp-job-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && <JobDetail job={job} />}
    </div>
  )
}

function JobDetail({ job }: { job: PipelineJob }) {
  const [log, setLog] = useState<WorkerLogDetail | null>(null)
  const [loading, setLoading] = useState(false)

  const loadLog = useCallback(async () => {
    if (!job.logFilename) return
    setLoading(true)
    try {
      const detail = await fetchLogDetail(job.logFilename)
      setLog(detail)
    } catch {
      setLog(null)
    } finally {
      setLoading(false)
    }
  }, [job.logFilename])

  useEffect(() => {
    if (job.displayState === 'running') {
      loadLog()
      const iv = setInterval(loadLog, 5000)
      return () => clearInterval(iv)
    }
    if (job.logFilename && (job.displayState === 'done' || job.displayState === 'failed')) {
      loadLog()
    }
  }, [job.logFilename, job.displayState, loadLog])

  const project = getJobProject(job)
  const trigger = job.triggerSource.replace(/^daemon:/, '').replace(/-/g, ' ')

  return (
    <div className="pp-detail">
      <div className="pp-detail-meta">
        <div className="pp-detail-row">
          <span className="pp-detail-label">Job</span>
          <span className="pp-detail-value pp-mono">{job.id}</span>
        </div>
        {project && (
          <div className="pp-detail-row">
            <span className="pp-detail-label">Project</span>
            <span className="pp-detail-value">{project}</span>
          </div>
        )}
        <div className="pp-detail-row">
          <span className="pp-detail-label">Trigger</span>
          <span className="pp-detail-value">{trigger}</span>
        </div>
        <div className="pp-detail-row">
          <span className="pp-detail-label">Attempt</span>
          <span className="pp-detail-value">{job.attempt}/{job.maxAttempts}</span>
        </div>
        {job.workerPid && (
          <div className="pp-detail-row">
            <span className="pp-detail-label">PID</span>
            <span className="pp-detail-value">{job.workerPid}</span>
          </div>
        )}
      </div>
      {job.lastError && (
        <div className="pp-detail-error">
          <div className="pp-detail-error-header">Error</div>
          <pre>{job.lastError}</pre>
        </div>
      )}
      {loading && <div className="pp-log-loading">Loading log...</div>}
      {log && (
        <div className="pp-detail-log">
          <div className="pp-detail-log-header">
            <span>Worker log</span>
            {log.parsed && (
              <span className="pp-log-meta">
                {log.parsed.provider && <span className="pp-log-tag">{log.parsed.provider}</span>}
                {log.parsed.model && <span className="pp-log-tag">{log.parsed.model}</span>}
                {log.parsed.reasoningEffort && <span className="pp-log-tag">{log.parsed.reasoningEffort}</span>}
              </span>
            )}
          </div>
          {log.parsed?.recentSteps && log.parsed.recentSteps.length > 0 && (
            <div className="pp-log-steps">
              {log.parsed.recentSteps.map((step, i) => (
                <div key={i} className="pp-log-step">{step}</div>
              ))}
            </div>
          )}
          {log.content && (
            <pre className="pp-log-content">{log.content.slice(-8000)}</pre>
          )}
        </div>
      )}
      {!job.logFilename && !loading && (
        <div className="pp-log-none">No log file available</div>
      )}
    </div>
  )
}

export default function PipelinePanel({ jobs }: { jobs: PipelineJob[] }) {
  const [tab, setTab] = useState<Tab>('running')
  const [expandedJob, setExpandedJob] = useState<string | null>(null)

  const grouped = {
    running: jobs.filter(j => j.displayState === 'running'),
    queued: jobs.filter(j => j.displayState === 'queued'),
    done: jobs.filter(j => j.displayState === 'done'),
    failed: jobs.filter(j => j.displayState === 'failed'),
  }

  const counts = {
    running: grouped.running.length,
    queued: grouped.queued.length,
    done: grouped.done.length,
    failed: grouped.failed.length,
  }

  const current = grouped[tab]

  return (
    <div className="pp">
      <div className="pp-tabs">
        {(['running', 'queued', 'done', 'failed'] as Tab[]).map(t => (
          <button
            key={t}
            className={`pp-tab ${tab === t ? 'pp-tab-active' : ''} ${t === 'failed' && counts[t] > 0 ? 'pp-tab-has-errors' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            {counts[t] > 0 && <span className="pp-tab-count">{counts[t]}</span>}
          </button>
        ))}
      </div>
      <div className="pp-list">
        {current.length === 0 ? (
          <div className="pp-empty">No {tab} jobs</div>
        ) : (
          current.slice(0, 50).map(job => (
            <JobRow
              key={job.id}
              job={job}
              expanded={expandedJob === job.id}
              onExpand={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}
