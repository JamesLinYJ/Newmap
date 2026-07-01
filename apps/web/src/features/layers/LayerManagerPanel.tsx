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
  Eye,
  EyeOff,
  Filter,
  FolderPlus,
  Grid2X2Plus,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  Palette,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Table2,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import type { LayerPanelView, LayerTreeNode, LayerVisibilityFilter } from './useLayerManager'

interface LayerPanelProps {
  tree: LayerTreeNode[]
  selectedId: string | null
  searchQuery: string
  totalCount: number
  visibleCount: number
  selectedNode?: LayerTreeNode
  activeView: LayerPanelView
  visibilityFilter: LayerVisibilityFilter
  referenceLayers: LayerDescriptor[]
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
  onSetActiveView: (view: LayerPanelView) => void
  onSetVisibilityFilter: (filter: LayerVisibilityFilter) => void
  onSetLabelEnabled: (id: string, enabled: boolean) => void
  onSetLabelField: (id: string, fieldName: string) => void
  onImportManagedLayer: (file: File) => void
  onReplaceManagedLayer: (layerKey: string, file: File) => void
  onToggleReferenceLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteReferenceLayer: (layerKey: string) => void
  onRefreshReferenceLayers: () => void
  onClose: () => void
}

const PANEL_VIEWS: ReadonlyArray<{ id: LayerPanelView; label: string; icon: typeof Layers3 }> = [
  { id: 'drawOrder', label: '绘制顺序', icon: Layers3 },
  { id: 'sources', label: '数据源', icon: Database },
  { id: 'selection', label: '选择', icon: MapIcon },
  { id: 'style', label: '样式', icon: Pencil },
  { id: 'add', label: '添加', icon: Grid2X2Plus },
  { id: 'labels', label: '标注', icon: Tags },
  { id: 'table', label: '属性表', icon: Table2 },
]

// 面板复用图层 hook 的视图状态，不直接访问地图实例。
//
// 所有影响地图或参考图层的动作通过回调回到资源控制器，避免 UI 自行伪造渲染状态。
export function LayerPanel({
  tree,
  selectedId,
  searchQuery,
  totalCount,
  visibleCount,
  selectedNode,
  activeView,
  visibilityFilter,
  referenceLayers,
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
  onSetActiveView,
  onSetVisibilityFilter,
  onSetLabelEnabled,
  onSetLabelField,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleReferenceLayerStatus,
  onDeleteReferenceLayer,
  onRefreshReferenceLayers,
  onClose,
}: LayerPanelProps) {
  const [groupName, setGroupName] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [selectedReferenceKey, setSelectedReferenceKey] = useState<string | null>(null)
  const selectableLayerIds = useMemo(() => collectLayerIds(tree), [tree])
  const selectedReferenceLayer = useMemo(
    () => referenceLayers.find(layer => layer.layerKey === selectedReferenceKey),
    [referenceLayers, selectedReferenceKey],
  )

  return (
    <section className={`arcgis-layer-panel${pinned ? ' arcgis-layer-panel--pinned' : ''}`} aria-label="图层管理">
      <header className="arcgis-layer-panel__titlebar">
        <div>
          <h3>图层管理</h3>
          <span>{visibleCount}/{totalCount} 个结果图层正在显示 · {referenceLayers.length} 个数据源</span>
        </div>
        <div className="arcgis-layer-panel__window-actions">
          <button type="button" aria-label={collapsed ? '展开图层管理面板' : '折叠图层管理面板'} title={collapsed ? '展开' : '折叠'} onClick={() => setCollapsed(current => !current)}>
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
          <button type="button" aria-label={pinned ? '取消固定图层管理面板' : '固定图层管理面板'} title={pinned ? '取消固定' : '固定'} onClick={() => setPinned(current => !current)}>
            {pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <button type="button" aria-label="关闭图层管理面板" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      {!collapsed ? (
        <>
          <div className="arcgis-layer-panel__search-row">
            <button type="button" className="arcgis-layer-panel__filter-button" aria-label="打开图层过滤" onClick={() => setFilterOpen(current => !current)}>
              <Filter size={18} aria-hidden="true" />
            </button>
            <label className="arcgis-layer-panel__search">
              <span className="sr-only">搜索图层</span>
              <input value={searchQuery} placeholder="搜索结果图层、类型或空间摘要" onChange={(event) => onSetSearchQuery(event.target.value)} />
              <Search size={18} aria-hidden="true" />
            </label>
            <button type="button" className="arcgis-layer-panel__filter-button" aria-label="切换过滤条件" onClick={() => setFilterOpen(current => !current)}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>

          {filterOpen ? (
            <div className="arcgis-layer-panel__filters" aria-label="过滤条件">
              {([
                ['all', '全部'],
                ['visible', '仅显示'],
                ['hidden', '仅隐藏'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={visibilityFilter === value ? 'is-active' : ''}
                  onClick={() => onSetVisibilityFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="arcgis-layer-panel__toolbar" aria-label="图层管理视图切换">
            {PANEL_VIEWS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={activeView === id ? 'is-active' : ''}
                title={label}
                aria-label={label}
                aria-pressed={activeView === id}
                onClick={() => onSetActiveView(id)}
              >
                <Icon size={20} />
              </button>
            ))}
          </div>

          {activeView === 'drawOrder' ? (
            <DrawOrderView
              tree={tree}
              selectedId={selectedId}
              selectedNode={selectedNode}
              selectableLayerIds={selectableLayerIds}
              groupName={groupName}
              onGroupNameChange={setGroupName}
              onSelectLayer={onSelectLayer}
              onToggleVisibility={onToggleVisibility}
              onToggleAllVisibility={onToggleAllVisibility}
              onSetOpacity={onSetOpacity}
              onRenameLayer={onRenameLayer}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
              onRemoveLayer={onRemoveLayer}
              onCreateGroup={onCreateGroup}
              onToggleGroup={onToggleGroup}
              onSetColor={onSetColor}
              onZoomToLayer={onZoomToLayer}
              onExportLayer={onExportLayer}
            />
          ) : null}

          {activeView === 'sources' ? (
            <SourcesView
              referenceLayers={referenceLayers}
              selectedReferenceKey={selectedReferenceKey}
              onSelectReference={setSelectedReferenceKey}
              onImportManagedLayer={onImportManagedLayer}
              onReplaceManagedLayer={onReplaceManagedLayer}
              onToggleReferenceLayerStatus={onToggleReferenceLayerStatus}
              onDeleteReferenceLayer={onDeleteReferenceLayer}
              onRefreshReferenceLayers={onRefreshReferenceLayers}
            />
          ) : null}

          {activeView === 'selection' ? (
            <SelectionView
              selectedNode={selectedNode}
              selectedReferenceLayer={selectedReferenceLayer}
              onZoomToLayer={onZoomToLayer}
              onExportLayer={onExportLayer}
            />
          ) : null}

          {activeView === 'style' ? (
            <StyleView selectedNode={selectedNode} onSetColor={onSetColor} onSetOpacity={onSetOpacity} />
          ) : null}

          {activeView === 'add' ? <AddView onImportManagedLayer={onImportManagedLayer} /> : null}

          {activeView === 'labels' ? (
            <LabelsView selectedNode={selectedNode} onSetLabelEnabled={onSetLabelEnabled} onSetLabelField={onSetLabelField} />
          ) : null}

          {activeView === 'table' ? <TableView selectedNode={selectedNode} selectedReferenceLayer={selectedReferenceLayer} /> : null}
        </>
      ) : null}
    </section>
  )
}

interface DrawOrderViewProps {
  tree: LayerTreeNode[]
  selectedId: string | null
  selectedNode?: LayerTreeNode
  selectableLayerIds: string[]
  groupName: string
  onGroupNameChange: (value: string) => void
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
  onSetColor: (id: string, color: string) => void
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
}

function DrawOrderView({
  tree,
  selectedId,
  selectedNode,
  selectableLayerIds,
  groupName,
  onGroupNameChange,
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
  onSetColor,
  onZoomToLayer,
  onExportLayer,
}: DrawOrderViewProps) {
  return (
    <>
      <div className="arcgis-layer-panel__section-title">绘制顺序</div>
      <div className="arcgis-layer-panel__tree" role="tree" aria-label="地图图层树">
        <div className="arcgis-layer-panel__map-root" role="treeitem" aria-expanded="true">
          <ChevronDown size={15} aria-hidden="true" />
          <span className="arcgis-layer-panel__map-icon" aria-hidden="true" />
          <strong>地图</strong>
        </div>
        {tree.length ? tree.map(node => (
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
            <span>生成地图结果后，结果图层会出现在这里。底图由地图画布的底图按钮管理，不作为结果图层显示。</span>
          </div>
        )}
      </div>

      <SelectedLayerEditor
        selectedNode={selectedNode}
        selectableLayerIds={selectableLayerIds}
        groupName={groupName}
        onGroupNameChange={onGroupNameChange}
        onToggleAllVisibility={onToggleAllVisibility}
        onSetOpacity={onSetOpacity}
        onRenameLayer={onRenameLayer}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onRemoveLayer={onRemoveLayer}
        onCreateGroup={onCreateGroup}
        onSetColor={onSetColor}
        onZoomToLayer={onZoomToLayer}
        onExportLayer={onExportLayer}
      />
    </>
  )
}

function SelectedLayerEditor({
  selectedNode,
  selectableLayerIds,
  groupName,
  onGroupNameChange,
  onToggleAllVisibility,
  onSetOpacity,
  onRenameLayer,
  onMoveUp,
  onMoveDown,
  onRemoveLayer,
  onCreateGroup,
  onSetColor,
  onZoomToLayer,
  onExportLayer,
}: Omit<DrawOrderViewProps, 'tree' | 'selectedId' | 'onSelectLayer' | 'onToggleVisibility' | 'onToggleGroup'>) {
  const selectedIsRaster = selectedNode?.type === 'layer' && selectedNode.layerKind === 'raster'
  const selectedIsGroup = selectedNode?.type === 'group'
  return (
    <>
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
          <button type="button" onClick={() => selectedNode && onMoveUp(selectedNode.id)} disabled={!selectedNode || selectedIsGroup}>上移</button>
          <button type="button" onClick={() => selectedNode && onMoveDown(selectedNode.id)} disabled={!selectedNode || selectedIsGroup}>下移</button>
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

      <div className="arcgis-layer-panel__grouping">
        <label>
          <span>新建分组</span>
          <input value={groupName} placeholder="例如：强降水产品" onChange={(event) => onGroupNameChange(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            onCreateGroup(groupName, selectedNode?.type === 'layer' ? [selectedNode.id] : selectableLayerIds)
            onGroupNameChange('')
          }}
          disabled={!groupName.trim() || !selectableLayerIds.length}
        >
          <FolderPlus size={15} /> 建立分组
        </button>
      </div>
    </>
  )
}

function SourcesView({
  referenceLayers,
  selectedReferenceKey,
  onSelectReference,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleReferenceLayerStatus,
  onDeleteReferenceLayer,
  onRefreshReferenceLayers,
}: {
  referenceLayers: LayerDescriptor[]
  selectedReferenceKey: string | null
  onSelectReference: (layerKey: string) => void
  onImportManagedLayer: (file: File) => void
  onReplaceManagedLayer: (layerKey: string, file: File) => void
  onToggleReferenceLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteReferenceLayer: (layerKey: string) => void
  onRefreshReferenceLayers: () => void
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>数据源</strong>
        <span>{referenceLayers.length} 个参考图层</span>
      </header>
      <div className="arcgis-layer-panel__selected-actions">
        <label className="arcgis-layer-panel__file-action">
          <Upload size={13} /> 导入 GeoJSON
          <input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => consumeFileInput(event.currentTarget, onImportManagedLayer)} />
        </label>
        <button type="button" onClick={onRefreshReferenceLayers}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>
      {referenceLayers.length ? (
        <div className="arcgis-layer-source-list">
          {referenceLayers.map(layer => {
            const active = layer.status === 'active'
            return (
              <article key={layer.layerKey} className={`arcgis-layer-source${selectedReferenceKey === layer.layerKey ? ' is-selected' : ''}`}>
                <button type="button" className="arcgis-layer-source__main" onClick={() => onSelectReference(layer.layerKey)}>
                  <strong>{layer.name}</strong>
                  <span>{layer.geometryType} · {layer.featureCount ?? 0} 要素 · {active ? '已启用' : '已停用'}</span>
                </button>
                <div className="arcgis-layer-source__meta">
                  <span>{layer.sourceType}</span>
                  <span>{layer.category || 'general'}</span>
                  <span>SRID {layer.srid}</span>
                  <span>{formatLayerBounds(layer.bounds)}</span>
                </div>
                <div className="arcgis-layer-panel__selected-actions">
                  <button type="button" onClick={() => onToggleReferenceLayerStatus(layer.layerKey, active ? 'inactive' : 'active')}>
                    {active ? <EyeOff size={13} /> : <Eye size={13} />} {active ? '停用' : '启用'}
                  </button>
                  <label className="arcgis-layer-panel__file-action">
                    <Upload size={13} /> 替换
                    <input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => consumeFileInput(event.currentTarget, file => onReplaceManagedLayer(layer.layerKey, file))} />
                  </label>
                  <button type="button" onClick={() => onDeleteReferenceLayer(layer.layerKey)}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
                {selectedReferenceKey === layer.layerKey ? <ReferenceLayerDetails layer={layer} /> : null}
              </article>
            )
          })}
        </div>
      ) : (
        <p className="arcgis-layer-details__empty-table">当前没有参考图层。可以导入 GeoJSON 建立数据源。</p>
      )}
    </div>
  )
}

function SelectionView({
  selectedNode,
  selectedReferenceLayer,
  onZoomToLayer,
  onExportLayer,
}: {
  selectedNode?: LayerTreeNode
  selectedReferenceLayer?: LayerDescriptor
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>选择</strong>
        <span>{selectedNode ? '结果图层' : selectedReferenceLayer ? '参考图层' : '未选择'}</span>
      </header>
      {selectedNode ? (
        <>
          <LayerDetails node={selectedNode} compact />
          <div className="arcgis-layer-panel__selected-actions">
            <button type="button" onClick={() => onZoomToLayer(selectedNode.id)} disabled={selectedNode.type === 'group'}><LocateFixed size={13} /> 定位</button>
            <button type="button" onClick={() => onExportLayer(selectedNode.id)} disabled={selectedNode.type === 'group'}><Download size={13} /> 导出</button>
            <button type="button" onClick={() => navigator.clipboard?.writeText(selectedNode.id)}>复制图层标识</button>
          </div>
        </>
      ) : selectedReferenceLayer ? (
        <ReferenceLayerDetails layer={selectedReferenceLayer} />
      ) : (
        <p className="arcgis-layer-details__empty-table">请选择一个结果图层或数据源图层。</p>
      )}
    </div>
  )
}

function StyleView({
  selectedNode,
  onSetColor,
  onSetOpacity,
}: {
  selectedNode?: LayerTreeNode
  onSetColor: (id: string, color: string) => void
  onSetOpacity: (id: string, opacity: number) => void
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>样式</strong>
        <span>{selectedNode?.name ?? '未选择图层'}</span>
      </header>
      {selectedNode?.type === 'layer' ? (
        <div className="arcgis-layer-panel__selected-editor">
          <label>
            <span>{selectedNode.layerKind === 'raster' ? '栅格色调' : '符号颜色'}</span>
            <input type="color" value={selectedNode.color ?? '#2563eb'} onChange={(event) => onSetColor(selectedNode.id, event.target.value)} />
          </label>
          <label>
            <span>透明度 {Math.round(selectedNode.opacity * 100)}%</span>
            <input type="range" min={10} max={100} value={Math.round(selectedNode.opacity * 100)} onChange={(event) => onSetOpacity(selectedNode.id, Number(event.target.value) / 100)} />
          </label>
          <p className="arcgis-layer-details__empty-table">
            {selectedNode.layerKind === 'raster' ? '栅格暂支持整体透明度和色调调整。分级渲染需要后端提供栅格统计后再启用。' : '矢量图层支持统一颜色、透明度和属性字段标注。'}
          </p>
        </div>
      ) : (
        <p className="arcgis-layer-details__empty-table">请选择一个结果图层后再调整样式。图层组不支持直接设置符号。</p>
      )}
    </div>
  )
}

function AddView({ onImportManagedLayer }: { onImportManagedLayer: (file: File) => void }) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>添加图层</strong>
        <span>GeoJSON / JSON</span>
      </header>
      <p className="arcgis-layer-details__empty-table">导入的文件会进入参考图层目录，并可被后续空间查询和图层列表读取。</p>
      <label className="arcgis-layer-panel__large-file-action">
        <Upload size={16} /> 选择 GeoJSON 文件
        <input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => consumeFileInput(event.currentTarget, onImportManagedLayer)} />
      </label>
    </div>
  )
}

function LabelsView({
  selectedNode,
  onSetLabelEnabled,
  onSetLabelField,
}: {
  selectedNode?: LayerTreeNode
  onSetLabelEnabled: (id: string, enabled: boolean) => void
  onSetLabelField: (id: string, fieldName: string) => void
}) {
  const fields = selectedNode?.fieldNames ?? []
  const canLabel = selectedNode?.type === 'layer' && selectedNode.layerKind === 'geojson' && fields.length > 0
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>标注</strong>
        <span>{selectedNode?.name ?? '未选择图层'}</span>
      </header>
      {canLabel && selectedNode ? (
        <div className="arcgis-layer-panel__selected-editor">
          <label>
            <span>启用标签</span>
            <input type="checkbox" checked={Boolean(selectedNode.labelEnabled)} onChange={(event) => onSetLabelEnabled(selectedNode.id, event.target.checked)} />
          </label>
          <label>
            <span>标签字段</span>
            <select value={selectedNode.labelField ?? fields[0]} onChange={(event) => onSetLabelField(selectedNode.id, event.target.value)}>
              {fields.map(field => <option key={field} value={field}>{field}</option>)}
            </select>
          </label>
          <p className="arcgis-layer-details__empty-table">标签会以地图 symbol layer 渲染，只读取当前图层已有属性字段。</p>
        </div>
      ) : (
        <p className="arcgis-layer-details__empty-table">
          {!selectedNode ? '请选择一个矢量结果图层。' : selectedNode.layerKind === 'raster' ? '栅格图层没有要素字段，不能生成标签。' : '当前图层没有可用字段。'}
        </p>
      )}
    </div>
  )
}

function TableView({
  selectedNode,
  selectedReferenceLayer,
}: {
  selectedNode?: LayerTreeNode
  selectedReferenceLayer?: LayerDescriptor
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>属性表</strong>
        <span>{selectedNode?.name ?? selectedReferenceLayer?.name ?? '未选择图层'}</span>
      </header>
      {selectedNode?.type === 'layer' ? (
        <LayerDetails node={selectedNode} />
      ) : selectedReferenceLayer ? (
        <ReferenceLayerDetails layer={selectedReferenceLayer} />
      ) : (
        <p className="arcgis-layer-details__empty-table">请选择一个图层查看字段和属性。</p>
      )}
    </div>
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

function LayerDetails({ node, compact = false }: { node: LayerTreeNode; compact?: boolean }) {
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
    <div className={compact ? 'arcgis-layer-details arcgis-layer-details--compact' : 'arcgis-layer-details'}>
      <header>
        <strong>图层属性</strong>
        <span>{formatLayerKind(node)} · {node.artifactType ?? 'artifact'}</span>
      </header>

      <dl className="arcgis-layer-details__grid">
        <div><dt>图层名称</dt><dd>{node.name}</dd></div>
        <div><dt>数据类型</dt><dd>{formatLayerKind(node)}</dd></div>
        <div><dt>对象数量</dt><dd>{node.layerKind === 'raster' ? '1 张栅格' : `${node.featureCount ?? 0} 个要素`}</dd></div>
        <div><dt>空间摘要</dt><dd>{node.geometrySummary ?? '暂无空间摘要'}</dd></div>
        <div className="arcgis-layer-details__wide"><dt>数据来源</dt><dd>{node.sourceUri ?? '当前运行 artifact'}</dd></div>
      </dl>

      {node.metadataRows?.length ? <MetadataRows rows={node.metadataRows} /> : null}
      {fields.length ? <FieldChips fields={fields} /> : null}
      <AttributePreview rows={rows} columns={columns} emptyLabel={node.layerKind === 'raster' ? '栅格图层没有要素属性表，详情以元数据和栅格统计为准。' : '当前图层没有可预览的属性记录。'} />
    </div>
  )
}

function ReferenceLayerDetails({ layer }: { layer: LayerDescriptor }) {
  return (
    <>
      <dl className="arcgis-layer-details__grid">
        <div><dt>图层名称</dt><dd>{layer.name}</dd></div>
        <div><dt>状态</dt><dd>{layer.status === 'active' ? '已启用' : '已停用'}</dd></div>
        <div><dt>几何类型</dt><dd>{layer.geometryType}</dd></div>
        <div><dt>对象数量</dt><dd>{layer.featureCount ?? 0} 个要素</dd></div>
        <div><dt>坐标系</dt><dd>SRID {layer.srid}</dd></div>
        <div><dt>范围</dt><dd>{formatLayerBounds(layer.bounds)}</dd></div>
        <div className="arcgis-layer-details__wide"><dt>描述</dt><dd>{layer.description || '暂无描述'}</dd></div>
      </dl>
      {layer.tags.length ? <FieldChips title="标签" fields={layer.tags} /> : null}
      {layer.analysisCapabilities.length ? <FieldChips title="分析能力" fields={layer.analysisCapabilities} /> : null}
      {layer.propertySchema.length ? (
        <section className="arcgis-layer-details__metadata" aria-label="字段">
          <h4>字段</h4>
          <dl>
            {layer.propertySchema.slice(0, 16).map(field => (
              <div key={field.name}>
                <dt>{field.name}</dt>
                <dd>{field.dataType} · {field.populatedCount} 条 · {field.sampleValues.slice(0, 3).join('、') || '无样例'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  )
}

function MetadataRows({ rows }: { rows: Array<{ key: string; value: string }> }) {
  return (
    <section className="arcgis-layer-details__metadata" aria-label="图层元数据">
      <h4>详细元数据</h4>
      <dl>
        {rows.map(row => (
          <div key={row.key}>
            <dt>{row.key}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function FieldChips({ fields, title = '字段' }: { fields: string[]; title?: string }) {
  return (
    <section className="arcgis-layer-details__fields" aria-label={title}>
      <h4>{title}</h4>
      <div>{fields.map(field => <span key={field}>{field}</span>)}</div>
    </section>
  )
}

function AttributePreview({ rows, columns, emptyLabel }: { rows: Array<Record<string, unknown>>; columns: string[]; emptyLabel: string }) {
  if (!rows.length || !columns.length) {
    return <p className="arcgis-layer-details__empty-table">{emptyLabel}</p>
  }
  return (
    <section className="arcgis-layer-details__table" aria-label="属性表预览">
      <h4>属性表预览</h4>
      <div className="arcgis-layer-table-scroll">
        <table>
          <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
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
  )
}

function formatLayerKind(node: LayerTreeNode) {
  if (node.type === 'group') return '图层组'
  if (node.layerKind === 'raster') return '栅格图层'
  if (node.layerKind === 'geojson') return '矢量图层'
  return '地图图层'
}

function formatLayerBounds(bounds?: [number, number, number, number] | null) {
  if (!bounds) return '暂无范围'
  return `${bounds[0].toFixed(4)}, ${bounds[1].toFixed(4)} ~ ${bounds[2].toFixed(4)}, ${bounds[3].toFixed(4)}`
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

function consumeFileInput(input: HTMLInputElement, onFile: (file: File) => void) {
  const file = input.files?.[0]
  if (file) onFile(file)
  input.value = ''
}
