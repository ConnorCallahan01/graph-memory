import { useEffect, useState } from 'react'
import { PipelineStageProgress, fetchPipelineProgress } from '../lib/api'

interface Props {
  project: string
}

const STAGE_ICONS: Record<string, string> = {
  scribe: 'W',
  auditor: 'A',
  librarian: 'L',
  dreamer: 'D',
}

const STATUS_COLORS: Record<string, string> = {
  counting: 'pp-status-counting',
  ready: 'pp-status-ready',
  running: 'pp-status-running',
  queued: 'pp-status-queued',
  waiting: 'pp-status-waiting',
  idle: 'pp-status-idle',
  done: 'pp-status-done',
}

export default function PipelineProgress({ project }: Props) {
  const [stages, setStages] = useState<PipelineStageProgress[]>([])

  useEffect(() => {
    if (!project || project === 'global') return
    fetchPipelineProgress(project).then(setStages).catch(() => {})
    const id = setInterval(() => {
      fetchPipelineProgress(project).then(setStages).catch(() => {})
    }, 10000)
    return () => clearInterval(id)
  }, [project])

  if (!stages.length) return null

  return (
    <div className="pp-chain">
      {stages.map((stage, i) => (
        <div key={stage.stage} className="pp-stage-row">
          <div className="pp-stage-icon">
            <span className={`pp-icon ${STATUS_COLORS[stage.status] ?? ''}`}>
              {STAGE_ICONS[stage.stage] ?? '?'}
            </span>
            {i < stages.length - 1 && <span className="pp-connector" />}
          </div>
          <div className="pp-stage-body">
            <div className="pp-stage-header">
              <span className="pp-stage-label">{stage.label}</span>
              <span className={`pp-stage-badge ${STATUS_COLORS[stage.status] ?? ''}`}>
                {stage.status}
              </span>
            </div>
            {stage.threshold != null && stage.threshold > 0 && (
              <div className="pp-progress-track">
                <div
                  className={`pp-progress-fill ${STATUS_COLORS[stage.status] ?? ''}`}
                  style={{ width: `${Math.min(100, (stage.current / stage.threshold) * 100)}%` }}
                />
                <span className="pp-progress-label">
                  {stage.current}/{stage.threshold}
                </span>
              </div>
            )}
            <p className="pp-stage-detail">{stage.detail}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
