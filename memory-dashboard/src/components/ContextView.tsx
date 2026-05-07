import { useEffect, useState } from 'react'
import { ActiveProjectInfo, StartupContext, StartupContextLayer, StartupPinnedNode, fetchStartupContext } from '../lib/api'

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function LayerCard({ layer }: { layer: StartupContextLayer }) {
  const [open, setOpen] = useState(false)
  const pct = Math.min((layer.tokens / 4000) * 100, 100)

  return (
    <div className={`ctx-layer${open ? ' expanded' : ''}`}>
      <div className="ctx-layer-header" onClick={() => setOpen(!open)}>
        <div className="ctx-layer-left">
          <span className={`ctx-layer-dot${layer.injected ? ' injected' : ''}`} />
          <span className="ctx-layer-label">{layer.label}</span>
          {layer.injected && <span className="ctx-injected-badge">live</span>}
        </div>
        <div className="ctx-layer-right">
          <span className="ctx-layer-tokens">{formatTokens(layer.tokens)}</span>
          <div className="ctx-token-bar">
            <div className="ctx-token-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="ctx-layer-subtitle">{layer.subtitle}</div>
      {layer.updatedAt && (
        <div className="ctx-layer-meta">Updated {new Date(layer.updatedAt).toLocaleString()}</div>
      )}
      {open && layer.content && (
        <div className="ctx-layer-content">{layer.content.slice(0, 2000)}</div>
      )}
    </div>
  )
}

function PinnedNodeCard({ node }: { node: StartupPinnedNode }) {
  return (
    <div className="ctx-pinned-node">
      <div className="ctx-pinned-header">
        <span className="ctx-pinned-title">{node.title}</span>
        <span className="ctx-pinned-tokens">{formatTokens(node.tokens)}</span>
      </div>
      <div className="ctx-pinned-path">{node.path}</div>
      <div className="ctx-pinned-gist">{node.gist}</div>
    </div>
  )
}

interface Props {
  activeProjects: ActiveProjectInfo[]
}

export default function ContextView({ activeProjects }: Props) {
  const [ctx, setCtx] = useState<StartupContext | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStartupContext()
      .then(setCtx)
      .catch(() => setCtx(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="ctx-view"><div className="ctx-loading">Loading context...</div></div>
  if (!ctx) return <div className="ctx-view"><div className="ctx-loading">No startup context available</div></div>

  const layers = ctx.layers
  const pinned = ctx.pinnedNodes
  const layerTokens = layers.reduce((s, l) => s + l.tokens, 0)
  const pinnedTokens = pinned.reduce((s, n) => s + n.tokens, 0)
  const injectedCount = layers.filter((l) => l.injected).length

  return (
    <div className="ctx-view">
      {activeProjects.length > 0 && (
        <div className="ctx-section" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="ctx-section-heading">
            Active sessions
            <span className="ctx-section-count">{activeProjects.length} projects</span>
          </div>
          <div className="ctx-active-grid">
            {activeProjects.map((p) => (
              <div key={p.name} className="ctx-active-card">
                <div className="ctx-active-name">{p.name}</div>
                <div className="ctx-active-meta">
                  {p.sessionCount} session{p.sessionCount !== 1 ? 's' : ''}
                  {p.startedAt && (
                    <span className="ctx-active-since">since {new Date(p.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                </div>
                {p.cwd && <div className="ctx-active-cwd">{p.cwd}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ctx-hero">
        <div className="ctx-hero-total">
          <span className="ctx-hero-number">{formatTokens(ctx.totalTokens)}</span>
          <span className="ctx-hero-label">tokens injected at session start</span>
        </div>
        <div className="ctx-hero-stats">
          <div className="ctx-stat">
            <span className="ctx-stat-value">{ctx.activeProject}</span>
            <span className="ctx-stat-label">Active project</span>
          </div>
          <div className="ctx-stat">
            <span className="ctx-stat-value">{injectedCount}/{layers.length}</span>
            <span className="ctx-stat-label">Layers live</span>
          </div>
          <div className="ctx-stat">
            <span className="ctx-stat-value">{pinned.length}</span>
            <span className="ctx-stat-label">Pinned nodes</span>
          </div>
        </div>
      </div>

      <div className="ctx-section">
        <div className="ctx-section-heading">
          Context layers
          <span className="ctx-section-count">{formatTokens(layerTokens)} tokens</span>
        </div>
        <div className="ctx-layers">
          {layers.map((layer) => (
            <LayerCard key={layer.id} layer={layer} />
          ))}
        </div>
      </div>

      {pinned.length > 0 && (
        <div className="ctx-section">
          <div className="ctx-section-heading">
            Pinned nodes
            <span className="ctx-section-count">{formatTokens(pinnedTokens)} tokens</span>
          </div>
          <div className="ctx-pinned">
            {pinned.map((node) => (
              <PinnedNodeCard key={node.path} node={node} />
            ))}
          </div>
          {ctx.allPinnedNodeCount > pinned.length && (
            <div className="ctx-more">
              {ctx.allPinnedNodeCount - pinned.length} more pinned nodes not shown
            </div>
          )}
        </div>
      )}
    </div>
  )
}
