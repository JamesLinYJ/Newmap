// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理面板
//
//   文件:       LayerManagerPanel.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Filter,
  FolderPlus,
  Grid2X2Plus,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  Palette,
  Pencil,
  Pin,
  Search,
  Table2,
  Tags,
  Trash2,
  X,
} from 'lucide-react'
import type { LayerTreeNode } from './useLayerManager'

interface LayerPanelProps {
  tree: LayerTreeNode[]
  selectedId: string | null
  searchQuery: string
  totalCount: number
  visibleCount: number
  selectedNode?: LayerTreeNode
  onSelectLayer: (id: string | null) => void
  onToggleVisibility: (id: string) => void
  onToggleAllVisibility: () => void
  onSetOpacity: (id: string, opacity: number) => void
  onRenameLayer: (id: string, name: string) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onRemoveLayer: (id: string) => void
  onCreateGroup: (name: string, memberIds: string[]) => void
  onToggleGroup: (id: string) => void
  onSetSearchQuery: (query: string) => void
  onSetColor: (id: string, color: string) => void
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
}

// 面板复用图层 hook 的视图状态，不直接访问地图实例。
//
// 所有影响地图的动作通过回调回到资源控制器，避免 UI 自行伪造渲染状态。
export function LayerPanel({
  tree,
  selectedId,
  searchQuery,
  totalCount,
  visibleCount,
  selectedNode,
  onSelectLayer,
  onToggleVisibility,
  onToggleAllVisibility,
  onSetOpacity,
  onRenameLayer,
  onMoveUp,
  onMoveDown,
  onRemoveLayer,
  onCreateGroup,
  onToggleGroup,
  onSetSearchQuery,
  onSetColor,
  onZoomToLayer,
  onExportLayer,
}: LayerPanelProps) {
  const [groupName, setGroupName] = useState('')
  const selectableLayerIds = useMemo(() => collectLayerIds(tree), [tree])
  const hasLayers = tree.length > 0
  const selectedIsRaster = selectedNode?.type === 'layer' && selectedNode.layerKind === 'raster'

  return (
    <section className="arcgis-layer-panel" aria-label="图层管理">
      <header className="arcgis-layer-panel__titlebar">
        <div>
          <h3>内容</h3>
          <span>{visibleCount}/{totalCount} 个图层正在显示</span>
        </div>
        <div className="arcgis-layer-panel__window-actions" aria-hidden="true">
          <ChevronDown size={16} />
          <Pin size={15} />
          <X size={16} />
        </div>
      </header>

      <div className="arcgis-layer-panel__search-row">
        <Filter size={18} aria-hidden="true" />
        <label className="arcgis-layer-panel__search">
          <span className="sr-only">搜索图层</span>
          <input value={searchQuery} placeholder="搜索" onChange={(event) => onSetSearchQuery(event.target.value)} />
          <Search size={18} aria-hidden="true" />
        </label>
        <ChevronDown size={16} aria-hidden="true" />
      </div>

      <div className="arcgis-layer-panel__toolbar" aria-label="图层管理视图切换">
        {[
          { label: '绘制顺序', icon: Layers3, active: true },
          { label: '数据源', icon: Database },
          { label: '选择', icon: MapIcon },
          { label: '编辑', icon: Pencil },
          { label: '添加', icon: Grid2X2Plus },
          { label: '标注', icon: Tags },
          { label: '表格', icon: Table2 },
        ].map(({ label, icon: Icon, active }) => (
          <button key={label} type="button" className={active ? 'is-active' : ''} title={label} aria-label={label}>
            <Icon size={20} />
          </button>
        ))}
      </div>

      <div className="arcgis-layer-panel__section-title">绘制顺序</div>

      <div className="arcgis-layer-panel__tree" role="tree" aria-label="地图图层树">
        <div className="arcgis-layer-panel__map-root" role="treeitem" aria-expanded="true">
          <ChevronDown size={15} aria-hidden="true" />
          <span className="arcgis-layer-panel__map-icon" aria-hidden="true" />
          <strong>地图</strong>
        </div>
        {hasLayers ? tree.map(node => (
          <LayerNodeView
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelectLayer={onSelectLayer}
            onToggleVisibility={onToggleVisibility}
            onToggleGroup={onToggleGroup}
          />
        )) : (
          <div className="arcgis-layer-panel__empty">
            <strong>暂无可管理图层</strong>
            <span>生成地图 artifact 后，图层会出现在这里。</span>
          </div>
        )}
        <label className="arcgis-layer-node arcgis-layer-node--basemap">
          <input type="checkbox" checked readOnly />
          <span className="arcgis-layer-node__symbol arcgis-layer-node__symbol--terrain" />
          <strong>世界地形图</strong>
        </label>
        <label className="arcgis-layer-node arcgis-layer-node--basemap">
          <input type="checkbox" checked readOnly />
          <span className="arcgis-layer-node__symbol arcgis-layer-node__symbol--hillshade" />
          <strong>全球山影</strong>
        </label>
      </div>

      <div className="arcgis-layer-panel__selected">
        <div className="arcgis-layer-panel__selected-heading">
          <div>
            <strong>所选图层</strong>
            <span>{selectedNode?.name ?? '未选择图层'}</span>
          </div>
          <small>{selectedNode ? formatLayerKind(selectedNode) : '请选择绘制顺序中的图层'}</small>
        </div>
        <div className="arcgis-layer-panel__selected-actions">
          <button type="button" onClick={onToggleAllVisibility} disabled={!selectableLayerIds.length}>批量显隐</button>
          <button type="button" onClick={() => selectedNode && onMoveUp(selectedNode.id)} disabled={!selectedNode}>上移</button>
          <button type="button" onClick={() => selectedNode && onMoveDown(selectedNode.id)} disabled={!selectedNode}>下移</button>
          <button type="button" onClick={() => selectedNode && onZoomToLayer(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'group'}>
            <LocateFixed size={13} /> 定位
          </button>
          <button type="button" onClick={() => selectedNode && onExportLayer(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'group'}>
            <Download size={13} /> 导出
          </button>
          <button type="button" onClick={() => selectedNode && onRemoveLayer(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'group'}>
            <Trash2 size={13} /> 移除
          </button>
        </div>
        {selectedNode ? (
          <div className="arcgis-layer-panel__selected-editor">
            <label>
              <span>名称</span>
              <input value={selectedNode.name} onChange={(event) => onRenameLayer(selectedNode.id, event.target.value)} />
            </label>
            <label>
              <span>透明度 {Math.round(selectedNode.opacity * 100)}%</span>
              <input
                type="range"
                min={10}
                max={100}
                value={Math.round(selectedNode.opacity * 100)}
                onChange={(event) => onSetOpacity(selectedNode.id, Number(event.target.value) / 100)}
              />
            </label>
            {selectedNode.type === 'layer' ? (
              <label>
                <span>{selectedIsRaster ? '栅格色调' : '符号颜色'}</span>
                <input
                  type="color"
                  value={selectedNode.color ?? '#2563eb'}
                  onChange={(event) => onSetColor(selectedNode.id, event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}
      </div>

      {selectedNode?.type === 'layer' ? <LayerDetails node={selectedNode} /> : null}

      <div className="arcgis-layer-panel__grouping">
        <label>
          <span>新建分组</span>
          <input value={groupName} placeholder="例如：强降水产品" onChange={(event) => setGroupName(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            onCreateGroup(groupName, selectedNode?.type === 'layer' ? [selectedNode.id] : selectableLayerIds)
            setGroupName('')
          }}
          disabled={!groupName.trim() || !selectableLayerIds.length}
        >
          <FolderPlus size={15} /> 建立分组
        </button>
      </div>
    </section>
  )
}

interface LayerNodeViewProps {
  node: LayerTreeNode
  depth: number
  selectedId: string | null
  onSelectLayer: (id: string | null) => void
  onToggleVisibility: (id: string) => void
  onToggleGroup: (id: string) => void
}

function LayerNodeView({
  node,
  depth,
  selectedId,
  onSelectLayer,
  onToggleVisibility,
  onToggleGroup,
}: LayerNodeViewProps) {
  const isGroup = node.type === 'group'
  const style = !isGroup
    ? { '--layer-color': node.color ?? '#2563eb' } as CSSProperties
    : undefined

  return (
    <div
      className={`arcgis-layer-node-wrap${node.id === selectedId ? ' is-selected' : ''}`}
      role="treeitem"
      aria-selected={node.id === selectedId}
      aria-expanded={isGroup ? Boolean(node.expanded) : undefined}
      style={{ marginLeft: depth * 14 }}
    >
      <div className="arcgis-layer-node">
        <button
          type="button"
          className="arcgis-layer-node__twisty"
          onClick={() => isGroup ? onToggleGroup(node.id) : onSelectLayer(node.id)}
          aria-label={isGroup ? '展开或折叠分组' : '选择图层'}
        >
          {isGroup ? (node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span />}
        </button>
        <input
          className="arcgis-layer-node__checkbox"
          type="checkbox"
          checked={node.visible}
          onChange={() => onToggleVisibility(node.id)}
          aria-label={`${node.visible ? '隐藏' : '显示'}${node.name}`}
        />
        <button type="button" className="arcgis-layer-node__label" onClick={() => onSelectLayer(node.id)}>
          <span className={isGroup ? 'arcgis-layer-node__folder' : 'arcgis-layer-node__symbol'} style={style}>
            {isGroup ? null : <Palette size={12} />}
          </span>
          <strong>{node.name}</strong>
        </button>
      </div>
      {!isGroup ? <LayerLegend node={node} /> : null}

      {isGroup && node.expanded && node.children?.length ? (
        <div role="group">
          {node.children.map(child => (
            <LayerNodeView
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelectLayer={onSelectLayer}
              onToggleVisibility={onToggleVisibility}
              onToggleGroup={onToggleGroup}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function LayerLegend({ node }: { node: LayerTreeNode }) {
  if (node.layerKind === 'raster' || /\.(tif|tiff|png|jpg|jpeg)$/i.test(node.name)) {
    return (
      <div className="arcgis-layer-legend arcgis-layer-legend--raster">
        <strong>RGB</strong>
        {[
          ['红色', 'R / Band 1', '#ff1d1d'],
          ['绿色', 'G / Band 2', '#00f028'],
          ['蓝色', 'B / Band 3', '#1947ff'],
        ].map(([label, value, color]) => (
          <span key={label}>
            <i style={{ background: color }} />
            <em>{label}：</em>
            <b>{value}</b>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="arcgis-layer-legend">
      <span>
        <i style={{ background: node.color ?? '#f5b5cf' }} />
        <b>{node.featureCount ?? 0} 对象 · {node.geometrySummary ?? '地图图层'}</b>
      </span>
    </div>
  )
}

function LayerDetails({ node }: { node: LayerTreeNode }) {
  const fields = useMemo(() => node.fieldNames ?? [], [node.fieldNames])
  const rows = useMemo(() => node.attributeRows ?? [], [node.attributeRows])
  const columns = useMemo(() => {
    const names = new Set<string>()
    if (rows.length) names.add('OBJECTID')
    fields.forEach(field => names.add(field))
    rows.forEach(row => Object.keys(row).forEach(key => names.add(key)))
    return [...names].slice(0, 10)
  }, [fields, rows])

  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>图层属性</strong>
        <span>{formatLayerKind(node)} · {node.artifactType ?? 'artifact'}</span>
      </header>

      <dl className="arcgis-layer-details__grid">
        <div>
          <dt>图层名称</dt>
          <dd>{node.name}</dd>
        </div>
        <div>
          <dt>数据类型</dt>
          <dd>{formatLayerKind(node)}</dd>
        </div>
        <div>
          <dt>对象数量</dt>
          <dd>{node.layerKind === 'raster' ? '1 张栅格' : `${node.featureCount ?? 0} 个要素`}</dd>
        </div>
        <div>
          <dt>空间摘要</dt>
          <dd>{node.geometrySummary ?? '暂无空间摘要'}</dd>
        </div>
        <div className="arcgis-layer-details__wide">
          <dt>数据来源</dt>
          <dd>{node.sourceUri ?? '当前运行 artifact'}</dd>
        </div>
      </dl>

      {node.metadataRows?.length ? (
        <section className="arcgis-layer-details__metadata" aria-label="图层元数据">
          <h4>详细元数据</h4>
          <dl>
            {node.metadataRows.map(row => (
              <div key={row.key}>
                <dt>{row.key}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {fields.length ? (
        <section className="arcgis-layer-details__fields" aria-label="字段">
          <h4>字段</h4>
          <div>
            {fields.map(field => <span key={field}>{field}</span>)}
          </div>
        </section>
      ) : null}

      {rows.length && columns.length ? (
        <section className="arcgis-layer-details__table" aria-label="属性表预览">
          <h4>属性表预览</h4>
          <div className="arcgis-layer-table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map(column => <th key={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={String(row.OBJECTID ?? index)}>
                    {columns.map(column => <td key={column}>{formatCell(row[column])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <p className="arcgis-layer-details__empty-table">
          {node.layerKind === 'raster' ? '栅格图层没有要素属性表，详情以元数据和栅格统计为准。' : '当前图层没有可预览的属性记录。'}
        </p>
      )}
    </div>
  )
}

function formatLayerKind(node: LayerTreeNode) {
  if (node.type === 'group') return '图层组'
  if (node.layerKind === 'raster') return '栅格图层'
  if (node.layerKind === 'geojson') return '矢量图层'
  return '地图图层'
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4)
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function collectLayerIds(nodes: LayerTreeNode[]): string[] {
  return nodes.flatMap(node => (
    node.type === 'layer'
      ? [node.id]
      : collectLayerIds(node.children ?? [])
  ))
}
