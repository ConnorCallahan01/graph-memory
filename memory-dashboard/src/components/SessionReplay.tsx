import { useMemo, useState } from 'react'
import { SessionTraceEvent, SessionTraceSummary } from '../lib/api'

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function EventRow({ event }: { event: SessionTraceEvent }) {
  const [open, setOpen] = useState(false)

  const icon = event.type === 'tool_use' ? '>' :
    event.type === 'assistant' ? 'A' :
    event.type === 'user' ? 'U' : '.'

  const successClass = event.success === true ? 'success' : event.success === false ? 'fail' : ''

  return (
    <div className={`replay-event${open ? ' expanded' : ''}`} onClick={() => setOpen(!open)}>
      <div className="replay-event-row">
        <span className={`replay-event-icon ${successClass}`}>{icon}</span>
        <span className="replay-event-type">{event.toolName || event.type}</span>
        {event.durationMs != null && (
          <span className="replay-event-dur">{formatDuration(event.durationMs)}</span>
        )}
        <span className="replay-event-time">{formatTime(event.timestamp)}</span>
      </div>
      {event.text && (
        <div className="replay-event-preview">{event.text.slice(0, 120)}</div>
      )}
      {open && (
        <div className="replay-event-detail">
          {event.commandPreview && (
            <div className="replay-detail-block">
              <span className="replay-detail-label">Command</span>
              <code>{event.commandPreview}</code>
            </div>
          )}
          {event.argsPreview && Object.keys(event.argsPreview).length > 0 && (
            <div className="replay-detail-block">
              <span className="replay-detail-label">Args</span>
              <code>{JSON.stringify(event.argsPreview, null, 2).slice(0, 500) as string}</code>
            </div>
          )}
          {event.targetPaths && event.targetPaths.length > 0 && (
            <div className="replay-detail-block">
              <span className="replay-detail-label">Targets</span>
              <code>{event.targetPaths.join(', ')}</code>
            </div>
          )}
          {event.errorPreview != null && (
            <div className="replay-detail-block error">
              <span className="replay-detail-label">Error</span>
              <code>{String(typeof event.errorPreview === 'string' ? event.errorPreview : JSON.stringify(event.errorPreview)).slice(0, 500)}</code>
            </div>
          )}
          {event.text && event.text.length > 120 && (
            <div className="replay-detail-block">
              <span className="replay-detail-label">Full text</span>
              <pre>{event.text.slice(0, 2000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface Props {
  traces: SessionTraceSummary[]
}

export default function SessionReplay({ traces }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = useMemo(() => {
    if (!selectedId) return null
    return traces.find((t) => t.sessionId === selectedId) ?? null
  }, [traces, selectedId])

  if (traces.length === 0) {
    return (
      <div className="replay-view">
        <div className="replay-empty">No session traces recorded yet</div>
      </div>
    )
  }

  return (
    <div className="replay-layout">
      <div className="replay-list">
        <div className="replay-list-heading">Sessions</div>
        {traces.map((t) => (
          <div
            key={t.sessionId}
            className={`replay-session${selectedId === t.sessionId ? ' active' : ''}`}
            onClick={() => setSelectedId(t.sessionId)}
          >
            <div className="replay-session-header">
              <span className="replay-session-id">{t.sessionId.slice(0, 8)}</span>
              <span className="replay-session-project">{t.project || 'global'}</span>
            </div>
            <div className="replay-session-meta">
              {t.eventCount} events
              {t.tools.length > 0 && <span className="replay-tools">{t.tools.slice(0, 3).join(', ')}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="replay-timeline">
        {selected ? (
          <>
            <div className="replay-timeline-header">
              <div>
                <div className="replay-timeline-id">{selected.sessionId.slice(0, 8)}</div>
                <div className="replay-timeline-project">{selected.project || 'global'}</div>
              </div>
              <div className="replay-timeline-stats">
                <span>{selected.eventCount} events</span>
                <span>{selected.tools.length} tools</span>
                {selected.cwd && <span>{selected.cwd.split('/').slice(-2).join('/')}</span>}
              </div>
            </div>
            <div className="replay-events">
              {selected.lastEvents.map((event, i) => (
                <EventRow key={`${event.timestamp}-${i}`} event={event} />
              ))}
            </div>
          </>
        ) : (
          <div className="replay-timeline-empty">Select a session to replay</div>
        )}
      </div>
    </div>
  )
}
