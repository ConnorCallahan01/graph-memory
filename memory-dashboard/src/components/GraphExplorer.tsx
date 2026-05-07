import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { Core } from 'cytoscape'
import fcose from 'cytoscape-fcose'
import {
  ArchiveEntry,
  GraphElement,
  GraphNode,
  NodeDetail,
  fetchNode,
  updateNode,
} from '../lib/api'

cytoscape.use(fcose)

const CATEGORY_COLORS: Record<string, string> = {
  people: 'oklch(72% 0.06 155)',
  projects: 'oklch(70% 0.06 250)',
  architecture: 'oklch(72% 0.06 310)',
  patterns: 'oklch(78% 0.07 75)',
  meta: 'oklch(72% 0.05 195)',
  dreams: 'oklch(73% 0.06 350)',
}

const CATEGORY_DOT_COLORS: Record<string, string> = {
  people: 'var(--cat-people)',
  projects: 'var(--cat-projects)',
  architecture: 'var(--cat-architecture)',
  patterns: 'var(--cat-patterns)',
  meta: 'var(--cat-meta)',
  dreams: 'var(--cat-dreams)',
}

const CATEGORIES = ['people', 'projects', 'architecture', 'patterns', 'meta', 'dreams']
const NODE_LIST_BATCH = 80

function formatTimeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const ms = Date.now() - Date.parse(dateStr)
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}

interface Props {
  elements: GraphElement[]
  nodes: GraphNode[]
  archivedNodes: ArchiveEntry[]
  selectedNode: string | null
  onSelectNode: (path: string | null) => void
  detailVersion: number
  onNavigate: (path: string) => void
}

export default function GraphExplorer({
  elements,
  nodes,
  archivedNodes,
  selectedNode,
  onSelectNode,
  detailVersion,
  onNavigate,
}: Props) {
  const cyRef = useRef<Core | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const layoutDone = useRef(false)
  const [search, setSearch] = useState('')
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set(CATEGORIES))
  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [visibleNodes, setVisibleNodes] = useState(NODE_LIST_BATCH)
  const [editing, setEditing] = useState(false)
  const [editGist, setEditGist] = useState('')
  const [editConfidence, setEditConfidence] = useState(0.5)
  const [editTags, setEditTags] = useState('')
  const [saving, setSaving] = useState(false)

  const cyElements = useMemo(() => {
    return elements.map((el) => ({
      data: {
        ...el.data,
        ...(el.group === 'nodes' && {
          color: CATEGORY_COLORS[(el.data as any).category] ?? 'oklch(70% 0.05 165)',
        }),
      },
      group: el.group,
    }))
  }, [elements])

  useEffect(() => {
    if (!containerRef.current) return
    if (cyElements.length === 0) return

    const cy = cytoscape({
      container: containerRef.current,
      elements: cyElements as any,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            width: 24,
            height: 24,
            'border-width': 1.5,
            'border-color': 'oklch(100% 0.002 165)',
            'border-opacity': 0.7,
            'font-size': 10,
            'font-family': '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            color: 'oklch(25% 0.01 165)',
            'text-outline-color': 'oklch(99% 0.003 165)',
            'text-outline-width': 3,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'ellipsis',
            'text-max-width': '60px',
          },
        },
        {
          selector: 'node:active',
          style: { 'overlay-opacity': 0.08 },
        },
        {
          selector: 'node.hidden',
          style: { display: 'none' },
        },
        {
          selector: 'edge',
          style: {
            width: 0.8,
            'line-color': 'oklch(88% 0.008 165)',
            'curve-style': 'bezier',
            opacity: 0.35,
            'arrow-scale': 0.4,
            'target-arrow-color': 'oklch(88% 0.008 165)',
            'target-arrow-shape': 'triangle',
          },
        },
        {
          selector: 'edge.hidden',
          style: { display: 'none' },
        },
        {
          selector: 'edge[anti]',
          style: {
            'line-style': 'dashed',
            'line-color': 'oklch(82% 0.04 22)',
            'target-arrow-color': 'oklch(82% 0.04 22)',
            opacity: 0.3,
          },
        },
      ],
      layout: { name: 'fcose', animate: false, quality: 'default', spacingFactor: 1.1 } as any,
      minZoom: 0.15,
      maxZoom: 4,
      wheelSensitivity: 0.25,
    })

    cy.on('tap', 'node', (evt) => {
      onSelectNode(evt.target.id())
    })

    cyRef.current = cy
    layoutDone.current = true

    return () => {
      cy.destroy()
      cyRef.current = null
      layoutDone.current = false
    }
  }, [cyElements, onSelectNode])

  const filteredNodes = useMemo(() => {
    let result = nodes
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (n) =>
          n.data.id.toLowerCase().includes(q) ||
          n.data.gist?.toLowerCase().includes(q) ||
          n.data.tags?.some((t) => t.toLowerCase().includes(q)),
      )
    }
    if (activeCategories.size < CATEGORIES.length) {
      result = result.filter((n) => activeCategories.has(n.data.category))
    }
    return result
  }, [nodes, search, activeCategories])

  const filteredIds = useMemo(() => new Set(filteredNodes.map((n) => n.data.id)), [filteredNodes])
  const displayNodes = useMemo(() => filteredNodes.slice(0, visibleNodes), [filteredNodes, visibleNodes])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy || !layoutDone.current) return

    try {
      cy.nodes().forEach((node: any) => {
        if (filteredIds.has(node.id())) {
          node.removeClass('hidden')
        } else {
          node.addClass('hidden')
        }
      })

      cy.edges().forEach((edge: any) => {
        const src = edge.source().id()
        const tgt = edge.target().id()
        if (filteredIds.has(src) && filteredIds.has(tgt)) {
          edge.removeClass('hidden')
        } else {
          edge.addClass('hidden')
        }
      })
    } catch (err) {
      console.error('Graph filter error:', err)
    }
  }, [filteredIds])

  useEffect(() => {
    if (!cyRef.current || !selectedNode) return
    const node = cyRef.current.getElementById(selectedNode)
    if (node.length) {
      cyRef.current.animate({
        center: { eles: node },
        duration: 150,
      })
    }
  }, [selectedNode])

  useEffect(() => {
    if (!selectedNode) { setNodeDetail(null); return }
    fetchNode(selectedNode)
      .then(setNodeDetail)
      .catch(() => setNodeDetail(null))
  }, [selectedNode, detailVersion])

  const toggleCategory = useCallback((cat: string) => {
    setActiveCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) {
        if (next.size > 1) next.delete(cat)
      } else {
        next.add(cat)
      }
      return next
    })
    setVisibleNodes(NODE_LIST_BATCH)
  }, [])

  const startEdit = useCallback(() => {
    if (!nodeDetail) return
    setEditGist(nodeDetail.frontmatter.gist || '')
    setEditConfidence(nodeDetail.frontmatter.confidence ?? 0.5)
    setEditTags((nodeDetail.frontmatter.tags || []).join(', '))
    setEditing(true)
  }, [nodeDetail])

  const saveEdit = useCallback(async () => {
    if (!selectedNode) return
    setSaving(true)
    try {
      const updated = await updateNode(selectedNode, {
        gist: editGist,
        confidence: editConfidence,
        tags: editTags.split(',').map((t) => t.trim()).filter(Boolean),
      })
      setNodeDetail(updated)
      setEditing(false)
    } catch {
    } finally {
      setSaving(false)
    }
  }, [selectedNode, editGist, editConfidence, editTags])

  const handleZoom = useCallback((dir: 'in' | 'out' | 'fit') => {
    const cy = cyRef.current
    if (!cy) return
    if (dir === 'fit') cy.fit(cy.nodes('.hidden').length < cy.nodes().length ? cy.nodes().filter((n: any) => !n.hasClass('hidden')) : undefined, 30)
    else cy.zoom({ level: cy.zoom() * (dir === 'in' ? 1.3 : 0.7), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
  }, [])

  const loadMoreNodes = useCallback(() => {
    setVisibleNodes((prev) => Math.min(prev + NODE_LIST_BATCH, filteredNodes.length))
  }, [filteredNodes.length])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
      loadMoreNodes()
    }
  }, [loadMoreNodes])

  const edges = nodeDetail?.frontmatter?.edges ?? []
  const antiEdges = nodeDetail?.frontmatter?.anti_edges ?? []

  return (
    <div className="graph-layout">
      <div className="graph-sidebar">
        <div className="graph-search">
          <input
            type="text"
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setVisibleNodes(NODE_LIST_BATCH) }}
          />
        </div>
        <div className="filter-chips">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`filter-chip${activeCategories.has(cat) ? ' active' : ''}`}
              onClick={() => toggleCategory(cat)}
            >
              <span className="filter-dot" style={{ background: CATEGORY_DOT_COLORS[cat] }} />
              {cat}
            </button>
          ))}
        </div>
        <div className="node-list" onScroll={handleScroll}>
          {displayNodes.map((node) => (
            <div
              key={node.data.id}
              className={`node-item${selectedNode === node.data.id ? ' active' : ''}`}
              onClick={() => onSelectNode(node.data.id)}
            >
              <span className="node-dot" style={{ background: CATEGORY_DOT_COLORS[node.data.category] ?? 'var(--text-muted)' }} />
              <div className="node-item-meta">
                <div className="node-item-label">{node.data.label || node.data.id}</div>
                {node.data.gist && <div className="node-item-gist">{node.data.gist.slice(0, 80)}</div>}
              </div>
            </div>
          ))}
          {visibleNodes < filteredNodes.length && (
            <button className="node-load-more" onClick={loadMoreNodes}>
              {filteredNodes.length - visibleNodes} more
            </button>
          )}
          {filteredNodes.length === 0 && (
            <div className="node-list-empty">No nodes match</div>
          )}
        </div>
      </div>

      <div className="graph-canvas" ref={containerRef}>
        <div className="graph-canvas-controls">
          <button className="graph-control-btn" onClick={() => handleZoom('in')} title="Zoom in">+</button>
          <button className="graph-control-btn" onClick={() => handleZoom('out')} title="Zoom out">&minus;</button>
          <button className="graph-control-btn" onClick={() => handleZoom('fit')} title="Fit all" style={{ fontSize: 'var(--text-xs)' }}>Fit</button>
        </div>
      </div>

      <div className="graph-detail">
        {selectedNode && nodeDetail ? (
          <div className="graph-detail-inner">
            <div className="detail-title">
              {nodeDetail.frontmatter.title || selectedNode.split('/').pop()}
            </div>
            <div className="detail-path">{selectedNode}</div>

            {editing ? (
              <div className="detail-edit-form">
                <div className="detail-edit-field">
                  <label className="detail-edit-label">Gist</label>
                  <textarea
                    className="detail-edit-textarea"
                    value={editGist}
                    onChange={(e) => setEditGist(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="detail-edit-field">
                  <label className="detail-edit-label">Confidence</label>
                  <div className="detail-edit-slider">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={editConfidence}
                      onChange={(e) => setEditConfidence(parseFloat(e.target.value))}
                    />
                    <span className="detail-edit-conf-val">{editConfidence.toFixed(2)}</span>
                  </div>
                </div>
                <div className="detail-edit-field">
                  <label className="detail-edit-label">Tags (comma-separated)</label>
                  <input
                    type="text"
                    className="detail-edit-input"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                  />
                </div>
                <div className="detail-edit-actions">
                  <button className="detail-edit-save" onClick={saveEdit} disabled={saving}>
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button className="detail-edit-cancel" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {nodeDetail.frontmatter.gist && (
                  <div className="detail-gist">{nodeDetail.frontmatter.gist}</div>
                )}

                <div className="detail-confidence">
                  <span className="detail-label" style={{ margin: 0 }}>Confidence</span>
                  <div className="confidence-bar">
                    <div
                      className="confidence-fill"
                      style={{ width: `${(nodeDetail.frontmatter.confidence ?? 0.5) * 100}%` }}
                    />
                  </div>
                  <span className="confidence-value">
                    {(nodeDetail.frontmatter.confidence ?? 0.5).toFixed(2)}
                  </span>
                </div>

                {nodeDetail.frontmatter.tags?.length > 0 && (
                  <div className="detail-section">
                    <div className="detail-label">Tags</div>
                    <div className="detail-tags">
                      {nodeDetail.frontmatter.tags.map((tag: string) => (
                        <span key={tag} className="detail-tag">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}

                <button className="detail-edit-toggle" onClick={startEdit}>
                  Edit
                </button>
              </>
            )}

            {(edges.length > 0 || antiEdges.length > 0) && (
              <div className="detail-section">
                <div className="detail-label">Connections</div>
                <div className="detail-edges">
                  {edges.map((edge: any) => {
                    const target = typeof edge === 'string' ? edge : edge.target
                    const type = typeof edge === 'string' ? 'relates_to' : edge.type ?? 'relates_to'
                    return (
                      <button key={target} className="detail-edge" onClick={() => onNavigate(target)}>
                        {type}: {target}
                      </button>
                    )
                  })}
                  {antiEdges.map((edge: any) => {
                    const target = typeof edge === 'string' ? edge : edge.target
                    return (
                      <button
                        key={`anti-${target}`}
                        className="detail-edge"
                        style={{ color: 'var(--error)', opacity: 0.8 }}
                        onClick={() => onNavigate(target)}
                      >
                        conflicts: {target}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {nodeDetail.frontmatter.updated && (
              <div className="detail-section">
                <div className="detail-label">Updated</div>
                <div className="detail-meta-value">{formatTimeAgo(nodeDetail.frontmatter.updated)}</div>
              </div>
            )}

            {nodeDetail.content && (
              <div className="detail-section">
                <div className="detail-label">
                  Content
                  <button className="detail-expand-btn" onClick={() => setExpanded(!expanded)}>
                    {expanded ? 'collapse' : 'expand'}
                  </button>
                </div>
                <div className="detail-content" style={expanded ? { maxHeight: 'none' } : undefined}>
                  {nodeDetail.content}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="detail-empty">Select a node to inspect</div>
        )}
      </div>
    </div>
  )
}
