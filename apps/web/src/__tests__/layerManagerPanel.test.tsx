// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理面板渲染测试
//
//   文件:       layerManagerPanel.test.tsx
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import { LayerPanel } from '../features/layers/LayerManagerPanel'
import type { LayerPanelView } from '../features/layers/useLayerManager'

const noop = () => {}

describe('LayerPanel', () => {
  it('renders all seven layer manager views as real toolbar buttons', () => {
    // 工具栏是视图状态入口，不能退回装饰图标。
    const html = renderLayerPanel('drawOrder')

    for (const label of ['绘制顺序', '数据源', '选择', '样式', '添加', '标注', '属性表']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('图层管理')
  })

  it('renders source layer actions from real reference layer data', () => {
    const html = renderLayerPanel('sources')

    expect(html).toContain('数据源')
    expect(html).toContain('杭州市行政区划')
    expect(html).toContain('MultiPolygon · 13 要素 · 已启用')
    expect(html).toContain('导入 GeoJSON')
    expect(html).toContain('刷新')
    expect(html).toContain('停用')
    expect(html).toContain('替换')
    expect(html).toContain('删除')
  })

  it('shows explicit disabled reasons for unsupported style and label states', () => {
    expect(renderLayerPanel('style')).toContain('请选择一个结果图层后再调整样式')
    expect(renderLayerPanel('labels')).toContain('请选择一个矢量结果图层')
  })

  it('does not render non-existent basemap placeholders as manageable layers', () => {
    // 图层树只能展示真实结果图层；底图切换由地图画布负责，不能伪造成可管理图层。
    const html = renderLayerPanel('drawOrder')

    expect(html).not.toContain('世界地形图')
    expect(html).not.toContain('全球山影')
    expect(html).toContain('底图由地图画布的底图按钮管理')
  })
})

function renderLayerPanel(activeView: LayerPanelView) {
  return renderToStaticMarkup(
    <LayerPanel
      tree={[]}
      selectedId={null}
      searchQuery=""
      totalCount={0}
      visibleCount={0}
      activeView={activeView}
      visibilityFilter="all"
      referenceLayers={[referenceLayer]}
      onSelectLayer={noop}
      onToggleVisibility={noop}
      onToggleAllVisibility={noop}
      onSetOpacity={noop}
      onRenameLayer={noop}
      onMoveUp={noop}
      onMoveDown={noop}
      onRemoveLayer={noop}
      onCreateGroup={noop}
      onToggleGroup={noop}
      onSetSearchQuery={noop}
      onSetColor={noop}
      onZoomToLayer={noop}
      onExportLayer={noop}
      onSetActiveView={noop}
      onSetVisibilityFilter={noop}
      onSetLabelEnabled={noop}
      onSetLabelField={noop}
      onImportManagedLayer={noop}
      onReplaceManagedLayer={noop}
      onToggleReferenceLayerStatus={noop}
      onDeleteReferenceLayer={noop}
      onRefreshReferenceLayers={noop}
      onClose={noop}
    />,
  )
}

const referenceLayer: LayerDescriptor = {
  layerKey: 'hangzhou_districts',
  name: '杭州市行政区划',
  description: '系统内置杭州市区县边界。',
  sourceType: 'system',
  workspaceId: null,
  createdByUserId: null,
  visibility: 'public',
  readonly: true,
  category: 'boundary',
  geometryType: 'MultiPolygon',
  status: 'active',
  srid: 4326,
  featureCount: 13,
  bounds: [118.345, 29.1888, 120.7219, 30.5665],
  tags: ['杭州', '行政区划'],
  analysisCapabilities: ['query', 'spatial_join'],
  sourceConfigSummary: null,
  sessionId: null,
  threadId: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  propertySchema: [
    { name: 'name', dataType: 'string', populatedCount: 13, sampleValues: ['上城区'] },
  ],
  updatedAt: '2026-07-01T00:00:00.000Z',
} satisfies LayerDescriptor
