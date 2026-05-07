import { JSX, useMemo, useState } from 'react'
import { LatestBrief, PipelineStatus, ProjectWorkingFile } from '../lib/api'

interface Props {
  brief: LatestBrief | null
  projectFilter: string | null
  status: PipelineStatus | null
  onNavigate: (view: 'brief' | 'graph' | 'context' | 'sessions') => void
  workingFiles: ProjectWorkingFile[]
}

function parseMarkdownSections(md: string) {
  const lines = md.split('\n')
  const sections: Array<{ level: number; title: string; body: string }> = []
  let current: (typeof sections)[0] | null = null

  for (const line of lines) {
    const h2 = line.match(/^## (.+)/)
    const h3 = line.match(/^### (.+)/)
    const h1 = line.match(/^# (.+)/)

    if (h1 || h2 || h3) {
      const level = h1 ? 1 : h2 ? 2 : 3
      const title = (h1 || h2 || h3)![1]
      current = { level, title, body: '' }
      sections.push(current)
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }

  return sections
}

function renderMarkdownLine(text: string) {
  const parts: Array<string | JSX.Element> = []
  let remaining = text
  let key = 0

  while (remaining) {
    const codeMatch = remaining.match(/`([^`]+)`/)
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/)
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/)

    const matches = [
      codeMatch ? { match: codeMatch, start: codeMatch.index!, type: 'code' } : null,
      boldMatch ? { match: boldMatch, start: boldMatch.index!, type: 'bold' } : null,
      linkMatch ? { match: linkMatch, start: linkMatch.index!, type: 'link' } : null,
    ].filter(Boolean) as Array<{ match: RegExpMatchArray; start: number; type: string }>

    if (matches.length === 0) {
      parts.push(remaining)
      break
    }

    const earliest = matches.reduce((a, b) => (a.start < b.start ? a : b))

    if (earliest.start > 0) {
      parts.push(remaining.slice(0, earliest.start))
    }

    if (earliest.type === 'code') {
      parts.push(<code key={key++}>{earliest.match[1]}</code>)
    } else if (earliest.type === 'bold') {
      parts.push(<strong key={key++}>{earliest.match[1]}</strong>)
    } else if (earliest.type === 'link') {
      parts.push(<a key={key++} href={earliest.match[2]}>{earliest.match[1]}</a>)
    }

    remaining = remaining.slice(earliest.start + earliest.match[0].length)
  }

  return parts
}

function renderBody(body: string) {
  const lines = body.split('\n').filter((l) => l.trim())
  const elements: JSX.Element[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = []
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(lines[i].replace(/^[-*] /, ''))
        i++
      }
      elements.push(
        <ul className="brief-list" key={key++}>
          {items.map((item, j) => (
            <li key={j}>{renderMarkdownLine(item)}</li>
          ))}
        </ul>
      )
      continue
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''))
        i++
      }
      elements.push(
        <ol className="brief-list" key={key++} style={{ listStyle: 'decimal', paddingLeft: 20 }}>
          {items.map((item, j) => (
            <li key={j}>{renderMarkdownLine(item)}</li>
          ))}
        </ol>
      )
      continue
    }

    if (line.startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      const rows = tableLines
        .filter((l) => !l.match(/^\|[\s-|]+\|$/))
        .map((l) => l.split('|').filter(Boolean).map((c) => c.trim()))
      if (rows.length > 0) {
        elements.push(
          <table key={key++}>
            <thead>
              <tr>{rows[0].map((cell, j) => <th key={j}>{cell}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, j) => (
                <tr key={j}>{row.map((cell, k) => <td key={k}>{renderMarkdownLine(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )
      }
      continue
    }

    elements.push(<p key={key++}>{renderMarkdownLine(line)}</p>)
    i++
  }

  return elements
}

export default function BriefView({ brief, projectFilter, status, onNavigate, workingFiles }: Props) {
  const [expandedWorking, setExpandedWorking] = useState<Set<string>>(new Set())
  const projectSection = useMemo(() => {
    if (!projectFilter || !brief?.json?.project_breakdown) return null
    return brief.json.project_breakdown.find((p) => p.project === projectFilter) ?? null
  }, [brief, projectFilter])

  const displayWorkingFiles = useMemo(() => {
    if (projectFilter) return workingFiles.filter((wf) => wf.project === projectFilter)
    return workingFiles
  }, [workingFiles, projectFilter])

  if (!brief) {
    return (
      <div className="brief-view">
        <div className="brief-empty">
          <div className="brief-empty-icon">~</div>
          <div className="brief-empty-title">No brief yet</div>
          <div className="brief-empty-sub">
            The morning brief will appear here once the memory analysis pipeline generates one.
          </div>
        </div>
      </div>
    )
  }

  const sections = brief.markdown ? parseMarkdownSections(brief.markdown) : []
  const dateStr = brief.date.replace(/^\d{4}-/, '').replace(/-/g, '/')

  return (
    <div className="brief-view">
      <div className="brief-date">{dateStr}</div>

      {status?.runningJobs ? (
        <div className="brief-notice">Pipeline is running</div>
      ) : null}

      {projectSection ? (
        <div>
          <h2 className="brief-heading">{projectFilter}</h2>
          <div className="brief-section">
            {projectSection.open_loops && projectSection.open_loops.length > 0 && (
              <div style={{ marginBottom: 'var(--space-5)' }}>
                <div className="brief-section-label">Open loops</div>
                <ul className="brief-list">
                  {projectSection.open_loops.map((item, i) => (
                    <li key={i}>{renderMarkdownLine(item)}</li>
                  ))}
                </ul>
              </div>
            )}
            {projectSection.agent_friction && projectSection.agent_friction.length > 0 && (
              <div style={{ marginBottom: 'var(--space-5)' }}>
                <div className="brief-section-label">Friction</div>
                <ul className="brief-list">
                  {projectSection.agent_friction.map((item, i) => (
                    <li key={i}>{renderMarkdownLine(item)}</li>
                  ))}
                </ul>
              </div>
            )}
            {projectSection.suggested_memory_updates && projectSection.suggested_memory_updates.length > 0 && (
              <div>
                <div className="brief-section-label">Suggested memory updates</div>
                <ul className="brief-list">
                  {projectSection.suggested_memory_updates.map((item, i) => (
                    <li key={i}>{renderMarkdownLine(item)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div style={{ marginTop: 'var(--space-6)' }}>
            <button
              className="brief-graph-link"
              onClick={() => onNavigate('graph')}
            >
              View graph for {projectFilter}
            </button>
          </div>
        </div>
      ) : (
        <div className="brief-content">
          {sections.length > 0 ? (
            sections.map((section, i) => (
              <div key={i}>
                {section.level === 1 ? (
                  <h1>{renderMarkdownLine(section.title)}</h1>
                ) : section.level === 2 ? (
                  <h2>{renderMarkdownLine(section.title)}</h2>
                ) : (
                  <h3>{renderMarkdownLine(section.title)}</h3>
                )}
                {section.body.trim() && renderBody(section.body.trim())}
              </div>
            ))
          ) : (
            <div className="brief-raw">{brief.markdown}</div>
          )}
        </div>
      )}

      {displayWorkingFiles.length > 0 && (
        <div className="brief-section" style={{ marginTop: 'var(--space-8)' }}>
          <div className="brief-heading">
            WORKING files
            <span className="brief-section-count">{displayWorkingFiles.length}</span>
          </div>
          {displayWorkingFiles.map((wf) => {
            const isExpanded = expandedWorking.has(wf.project)
            return (
              <div key={wf.project} className="working-card">
                <div
                  className="working-card-header"
                  onClick={() => {
                    setExpandedWorking((prev) => {
                      const next = new Set(prev)
                      if (next.has(wf.project)) next.delete(wf.project)
                      else next.add(wf.project)
                      return next
                    })
                  }}
                >
                  <span className="working-card-project">{wf.project}</span>
                  <span className="working-card-meta">
                    {wf.sessionCount} sessions
                    <span className="working-card-time">{new Date(wf.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <span className="working-card-toggle">{isExpanded ? '\u2212' : '+'}</span>
                </div>
                {isExpanded && (
                  <div className="working-card-content">
                    {wf.content.split('\n').map((line, i) => {
                      if (line.startsWith('# ')) return <h3 key={i} className="working-h">{line.slice(2)}</h3>
                      if (line.startsWith('> ')) return <p key={i} className="working-quote">{line.slice(2)}</p>
                      if (line.startsWith('**')) return <p key={i} className="working-bold">{renderMarkdownLine(line)}</p>
                      if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} className="working-item">{renderMarkdownLine(line.slice(2))}</div>
                      if (line === '---') return <hr key={i} className="working-hr" />
                      if (line.trim()) return <p key={i} className="working-para">{renderMarkdownLine(line)}</p>
                      return null
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
