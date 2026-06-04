// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理面板
//
//   文件:       LayerPanel.tsx
//
//   日期:       2026年05月26日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download,
  Eye, EyeOff, Filter, FolderPlus, Layers, LocateFixed, MinusCircle,
  Pencil, Search, Trash2, X,
} from 'lucide-react'
import type { LayerTreeNode } from '../hooks/useLayerManager'
import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import './LayerPanel.css'

const LAYER_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
  '#0f172a', '#78716c',
]

interface LayerPanelProps {
  tree: LayerTreeNode[]
  selectedId: string | null
  searchQuery: string
  totalCount: number
  visibleCount: number
  selectedNode: LayerTreeNode | undefined
  layers?: LayerDescriptor[]
  onSelectLayer: (id: string | null) => void
  onToggleVisibility: (id: string) => void
  onToggleAllVisibility: () => void
  onSetOpacity: (id: string, opacity: number) => void
  onSetColor?: (id: string, color: string) => void
  onRenameLayer: (id: string, name: string) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onRemoveLayer: (id: string) => void
  onCreateGroup: (name: string, memberIds: string[]) => void
  onToggleGroup: (id: string) => void
  onSetSearchQuery: (q: string) => void
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
}

interface ContextMenuState { x: number; y: number; layerId: string }

interface DialogState {
  kind: 'prompt' | 'confirm'
  title: string
  message?: string
  defaultValue?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

function geometrySprite(kind: string, geometryType?: string): string {
  if (kind === 'group') return '📂'
  if (kind === 'raster' || geometryType === 'raster') return '▦'
  const gt = geometryType ?? ''
  if (gt.includes('Polygon') || gt.includes('MultiPolygon')) return '■'
  if (gt.includes('LineString') || gt.includes('MultiLineString')) return '━'
  if (gt.includes('Point') || gt.includes('MultiPoint')) return '●'
  return '■'
}

function statusDot(visible: boolean) {
  return visible
    ? <span className="lp-dot lp-dot--on" title="可见" />
    : <span className="lp-dot lp-dot--off" title="隐藏" />
}

function collectOrderedIds(nodes: LayerTreeNode[]): string[] {
  const ids: string[] = []
  for (const n of nodes) {
    if (n.kind === 'group') ids.push(...collectOrderedIds(n.children))
    else ids.push(n.id)
  }
  return ids
}

export const LayerPanel = memo(function LayerPanel(props: LayerPanelProps) {
  const {
    tree, selectedId, searchQuery, totalCount, visibleCount, selectedNode,
    layers, onSelectLayer, onToggleVisibility, onToggleAllVisibility, onSetOpacity,
    onSetColor, onRenameLayer, onMoveUp, onMoveDown, onRemoveLayer,
    onCreateGroup, onToggleGroup, onSetSearchQuery,
    onZoomToLayer, onExportLayer,
  } = props

  const layerDetail = layers?.find(l => l.layerKey === selectedNode?.id)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const lastClickedRef = useRef<string | null>(null)
  const dialogInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (selectedId) setSelectedIds(new Set([selectedId]))
    else setSelectedIds(new Set())
  }, [selectedId])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  useEffect(() => {
    if (!contextMenu) return
    const handler = () => closeContextMenu()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [contextMenu, closeContextMenu])

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape') {
        closeContextMenu()
        setEditingId(null)
        if (dialog) { dialog.onCancel(); setDialog(null) }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeContextMenu, dialog])

  const handleContextMenu = (e: MouseEvent, layerId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, layerId })
  }

  const handleTreeClick = (e: MouseEvent, nodeId: string) => {
    const orderedIds = collectOrderedIds(tree)
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(nodeId)) next.delete(nodeId)
        else next.add(nodeId)
        return next
      })
      lastClickedRef.current = nodeId
    } else if (e.shiftKey && lastClickedRef.current) {
      const startIdx = orderedIds.indexOf(lastClickedRef.current)
      const endIdx = orderedIds.indexOf(nodeId)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        const next = new Set(selectedIds)
        for (let i = lo; i <= hi; i++) next.add(orderedIds[i])
        setSelectedIds(next)
      }
    } else {
      onSelectLayer(nodeId)
      lastClickedRef.current = nodeId
    }
  }

  const startRename = (id: string, currentName: string) => {
    setEditingId(id)
    setEditValue(currentName)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameLayer(editingId, editValue.trim())
    }
    setEditingId(null)
    setEditValue('')
  }

  const handleRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename()
    if (e.key === 'Escape') { setEditingId(null); setEditValue('') }
  }

  const handleCreateGroup = () => {
    const memberIds = selectedIds.size > 0 ? [...selectedIds] : []
    setDialog({
      kind: 'prompt',
      title: '新建编组',
      message: '请输入编组名称，并确认编组成员。',
      defaultValue: '',
      onConfirm: (name) => {
        if (!name.trim()) return
        onCreateGroup(name.trim(), memberIds.length > 0 ? memberIds : tree.filter((n) => n.kind !== 'group').slice(0, 2).map((n) => n.id))
        setDialog(null)
      },
      onCancel: () => setDialog(null),
    })
  }

  const handleDeleteClick = () => {
    if (selectedIds.size === 0) return
    const count = selectedIds.size
    setDialog({
      kind: 'confirm',
      title: '删除图层',
      message: count === 1
        ? '确认删除这个图层？'
        : `确认删除这 ${count} 个图层？`,
      onConfirm: () => {
        for (const id of selectedIds) onRemoveLayer(id)
        setSelectedIds(new Set())
        setDialog(null)
      },
      onCancel: () => setDialog(null),
    })
  }

  const handleBulkMoveUp = () => {
    const ordered = collectOrderedIds(tree)
    const selected = ordered.filter((id) => selectedIds.has(id))
    for (const id of selected.reverse()) onMoveUp(id)
  }

  const handleBulkMoveDown = () => {
    const ordered = collectOrderedIds(tree)
    const selected = ordered.filter((id) => selectedIds.has(id))
    for (const id of [...selected].reverse()) onMoveDown(id)
  }

  const handleBulkToggleVisibility = () => {
    if (selectedIds.size === 0) {
      onToggleAllVisibility()
      return
    }
    const ids = [...selectedIds]
    for (const id of ids) onToggleVisibility(id)
  }

  const renderContextMenu = () => {
    if (!contextMenu) return null
    const id = contextMenu.layerId
    const node = findInTree(tree, id)
    return (
      <div className="lp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
        <button onClick={() => { onZoomToLayer(id); closeContextMenu() }}><LocateFixed size={13} /> 缩放到图层</button>
        <button onClick={() => { startRename(id, node?.name ?? ''); closeContextMenu() }}><Pencil size={13} /> 重命名</button>
        <button onClick={() => { onExportLayer(id); closeContextMenu() }}><Download size={13} /> 导出 GeoJSON</button>
        <hr />
        <button onClick={() => { onRemoveLayer(id); closeContextMenu() }} className="lp-context-danger"><Trash2 size={13} /> 移除图层</button>
      </div>
    )
  }

  const renderTree = (nodes: LayerTreeNode[], depth = 0) =>
    nodes.map((node) => {
      const isGroup = node.kind === 'group'
      const isSelected = selectedIds.has(node.id)
      const isEditing = editingId === node.id

      return (
        <div key={node.id}>
          <div
            className={`lp-tree-row ${isSelected ? 'lp-tree-row--selected' : ''} ${draggingId === node.id ? 'lp-tree-row--dragging' : ''}`}
            style={{ paddingLeft: 12 + depth * 16 }}
            onClick={(e) => handleTreeClick(e, node.id)}
            onDoubleClick={() => startRename(node.id, node.name)}
            onContextMenu={(e) => handleContextMenu(e, node.id)}
            draggable
            onDragStart={() => setDraggingId(node.id)}
            onDragEnd={() => setDraggingId(null)}
          >
            {isGroup ? (
              <button className="lp-expand-btn" onClick={(e) => { e.stopPropagation(); onToggleGroup(node.id) }}>
                {node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <span className="lp-expand-spacer" />
            )}

            <button className="lp-eye-btn" onClick={(e) => { e.stopPropagation(); onToggleVisibility(node.id) }} title={node.visible ? '隐藏图层' : '显示图层'}>
              {node.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>

            <span className="lp-geom-icon">{geometrySprite(node.kind, node.geometryType)}</span>

            {isEditing ? (
              <input
                className="lp-name-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleRenameKey}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="lp-name">{node.name}</span>
            )}

            {node.featureCount != null && node.featureCount > 0 && (
              <span className="lp-count">{node.featureCount}</span>
            )}

            <span className="lp-kind-tag">{kindLabel(node.kind)}</span>
            {statusDot(node.visible)}
          </div>

          {isGroup && node.expanded && node.children.length > 0 && (
            <div className="lp-group-children">
              {renderTree(node.children, depth + 1)}
            </div>
          )}
        </div>
      )
    })

  const selCount = selectedIds.size

  return (
    <div className="lp-panel">
      <div className="lp-header">
        <span className="lp-title"><Layers size={15} /> 图层</span>
        <div className="lp-header-actions">
          <button className="lp-icon-btn" title="面板选项" onClick={() => {}}>
            <ChevronDown size={14} />
          </button>
          <button className="lp-icon-btn" title="关闭面板" onClick={() => onSelectLayer(null)}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="lp-toolbar">
        <button className="lp-tool-btn" title="新建编组" onClick={handleCreateGroup}>
          <FolderPlus size={16} />
        </button>
        <button className="lp-tool-btn" title="全部显示/隐藏" onClick={handleBulkToggleVisibility}>
          <Eye size={16} />
        </button>
        <button className="lp-tool-btn" title="过滤图层" onClick={() => searchRef.current?.focus()}>
          <Filter size={16} />
        </button>
        <span className="lp-toolbar-spacer" />
        <button className="lp-tool-btn" title="下移" onClick={handleBulkMoveUp} disabled={selCount === 0}>
          <ArrowDown size={16} />
        </button>
        <button className="lp-tool-btn" title="上移" onClick={handleBulkMoveDown} disabled={selCount === 0}>
          <ArrowUp size={16} />
        </button>
        <button
          className="lp-tool-btn lp-tool-btn--danger"
          title="删除图层"
          onClick={handleDeleteClick}
          disabled={selCount === 0}
        >
          <MinusCircle size={16} />
        </button>
      </div>

      <div className="lp-search-bar">
        <Search size={14} className="lp-search-icon" />
        <input
          ref={searchRef}
          className="lp-search-input"
          placeholder="搜索 (Ctrl+K)"
          value={searchQuery}
          onChange={(e) => onSetSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="lp-search-clear" onClick={() => onSetSearchQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="lp-tree">
        {tree.length > 0 ? renderTree(tree) : (
          <div className="lp-empty">没有匹配的图层</div>
        )}
      </div>

      {selectedNode && selCount === 1 && (
        <div className="lp-properties">
          <div className="lp-props-header">图层属性</div>
          <div className="lp-props-body">
            {/* 名称 */}
            <div className="lp-prop-row">
              <span>名称</span>
              <span title={selectedNode.name}>{selectedNode.name}</span>
            </div>
            {/* 配色 */}
            {selectedNode.kind !== 'group' && (
              <div className="lp-prop-row">
                <span>配色</span>
                <div className="lp-color-picker">
                  <input
                    type="color"
                    className="lp-color-input"
                    value={selectedNode.color || LAYER_COLORS[0]}
                    onChange={(e) => onSetColor?.(selectedNode.id, e.target.value)}
                    aria-label="自定义颜色"
                  />
                  {LAYER_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`lp-color-swatch${selectedNode.color === c ? ' lp-color-swatch--active' : ''}`}
                      style={{ background: c }}
                      onClick={() => onSetColor?.(selectedNode.id, c)}
                      aria-label={`颜色 ${c}`}
                    />
                  ))}
                </div>
              </div>
            )}
            {/* 几何类型 */}
            <div className="lp-prop-row">
              <span>几何类型</span>
              <span>{kindLabel(selectedNode.kind)}{selectedNode.geometryType ? ` · ${selectedNode.geometryType}` : ''}</span>
            </div>
            {/* 要素数量 */}
            {selectedNode.featureCount != null && (
              <div className="lp-prop-row">
                <span>要素数量</span>
                <span>{selectedNode.featureCount.toLocaleString()}</span>
              </div>
            )}
            {/* 不透明度 */}
            {selectedNode.kind !== 'group' && (
              <div className="lp-prop-row">
                <span>不透明度</span>
                <input
                  type="range" min={0.05} max={1} step={0.05}
                  value={selectedNode.opacity}
                  onChange={(e) => onSetOpacity(selectedNode.id, parseFloat(e.target.value))}
                  className="lp-opacity-slider"
                />
                <span>{Math.round(selectedNode.opacity * 100)}%</span>
              </div>
            )}
            {/* 详细元数据 — 来自 LayerDescriptor */}
            {layerDetail && (
              <>
                <div className="lp-prop-divider" />
                {layerDetail.geometryType && (
                  <div className="lp-prop-row">
                    <span>几何类型</span>
                    <span>{layerDetail.geometryType}</span>
                  </div>
                )}
                {(layerDetail.srid ?? 0) > 0 && (
                  <div className="lp-prop-row">
                    <span>SRID</span>
                    <span>{layerDetail.srid}</span>
                  </div>
                )}
                {layerDetail.status && (
                  <div className="lp-prop-row">
                    <span>状态</span>
                    <span className={`lp-pill lp-pill--${layerDetail.status}`}>{layerDetail.status}</span>
                  </div>
                )}
                {layerDetail.category && (
                  <div className="lp-prop-row">
                    <span>分类</span>
                    <span>{layerDetail.category}</span>
                  </div>
                )}
                {layerDetail.sourceType && (
                  <div className="lp-prop-row">
                    <span>数据来源</span>
                    <span>{layerDetail.sourceType}</span>
                  </div>
                )}
                {layerDetail.bounds && layerDetail.bounds.length === 4 && (
                  <div className="lp-prop-row">
                    <span>边界范围</span>
                    <span className="lp-prop-mono">
                      {layerDetail.bounds[0].toFixed(4)}°, {layerDetail.bounds[1].toFixed(4)}°<br />
                      {layerDetail.bounds[2].toFixed(4)}°, {layerDetail.bounds[3].toFixed(4)}°
                    </span>
                  </div>
                )}
                {layerDetail.description && (
                  <div className="lp-prop-row lp-prop-row--block">
                    <span>描述</span>
                    <span>{layerDetail.description}</span>
                  </div>
                )}
                {(layerDetail.propertySchema ?? []).length > 0 && (
                  <div className="lp-prop-section">
                    <span className="lp-prop-section__title">
                      属性字段 ({layerDetail.propertySchema!.length})
                    </span>
                    <div className="lp-prop-fields">
                      {layerDetail.propertySchema!.slice(0, 12).map((f: { name: string; dataType: string; populatedCount: number }) => (
                        <div key={f.name} className="lp-prop-field">
                          <span className="lp-prop-field__name">{f.name}</span>
                          <span className="lp-prop-field__type">{f.dataType}</span>
                          {f.populatedCount > 0 && (
                            <span className="lp-prop-field__count">{f.populatedCount}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(layerDetail.tags ?? []).length > 0 && (
                  <div className="lp-prop-row lp-prop-row--block">
                    <span>标签</span>
                    <div className="lp-tag-list">
                      {layerDetail.tags!.slice(0, 8).map((t: string) => (
                        <span key={t} className="lp-tag">{t}</span>
                      ))}
                    </div>
                  </div>
                )}
                {(layerDetail.analysisCapabilities ?? []).length > 0 && (
                  <div className="lp-prop-row lp-prop-row--block">
                    <span>分析能力</span>
                    <div className="lp-tag-list">
                      {layerDetail.analysisCapabilities!.slice(0, 6).map((c: string) => (
                        <span key={c} className="lp-tag lp-tag--cap">{c}</span>
                      ))}
                    </div>
                  </div>
                )}
                {layerDetail.updatedAt && (
                  <div className="lp-prop-row">
                    <span>更新时间</span>
                    <span>{new Date(layerDetail.updatedAt).toLocaleString('zh-CN')}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="lp-status-bar">
        <span>{totalCount} 个图层</span>
        <span>{visibleCount} 个可见</span>
        {selCount > 0 && <span>· {selCount} 个选中</span>}
        {totalCount > 0 && (
          <span>· 共 {tree.reduce((s, n) => s + (n.featureCount ?? 0), 0)} 个要素</span>
        )}
        <span className="lp-status-spacer" />
        <span>就绪</span>
      </div>

      {renderContextMenu()}

      {dialog && (
        <div className="lp-overlay" onClick={() => { dialog.onCancel(); setDialog(null) }}>
          <div className="lp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="lp-dialog-header">
              <strong>{dialog.title}</strong>
              <button className="lp-icon-btn" onClick={() => { dialog.onCancel(); setDialog(null) }}><X size={14} /></button>
            </div>
            {dialog.message && <p className="lp-dialog-msg">{dialog.message}</p>}
            {dialog.kind === 'prompt' && (
              <input
                ref={dialogInputRef}
                className="lp-dialog-input"
                value={dialogValue}
                onChange={(e) => setDialogValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') dialog.onConfirm(dialogValue); if (e.key === 'Escape') dialog.onCancel() }}
                placeholder={dialog.defaultValue}
                autoFocus
              />
            )}
            <div className="lp-dialog-actions">
              <button className="lp-dialog-btn lp-dialog-btn--secondary" onClick={() => { dialog.onCancel(); setDialog(null) }}>取消</button>
              <button
                className="lp-dialog-btn lp-dialog-btn--primary"
                onClick={() => dialog.onConfirm(dialog.kind === 'prompt' ? dialogValue : '')}
              >
                {dialog.kind === 'confirm' ? '删除' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

function kindLabel(kind: string): string {
  switch (kind) {
    case 'artifact': return '矢量'
    case 'raster': return '栅格'
    case 'group': return '编组'
    default: return kind
  }
}

function findInTree(nodes: LayerTreeNode[], id: string): LayerTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n
    const f = findInTree(n.children, id)
    if (f) return f
  }
  return undefined
}
