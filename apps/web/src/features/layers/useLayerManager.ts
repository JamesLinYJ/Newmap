// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理视图状态
//
//   文件:       useLayerManager.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useCallback, useMemo, useState } from 'react'
import type { MapRenderLayer } from '../../app/types'

export interface LayerTreeNode {
  id: string
  name: string
  type: 'group' | 'layer'
  layerKind?: MapRenderLayer['kind']
  artifactType?: string
  sourceUri?: string
  visible: boolean
  opacity: number
  color?: string
  fieldNames?: string[]
  attributeRows?: Array<Record<string, unknown>>
  metadataRows?: Array<{ key: string; value: string }>
  artifactId?: string
  featureCount?: number
  geometrySummary?: string
  children?: LayerTreeNode[]
  expanded?: boolean
}

interface UseLayerManagerOptions {
  mapLayers: MapRenderLayer[]
  onToggleVisibility: (artifactId: string) => void
  onChangeOpacity: (artifactId: string, opacity: number) => void
}

interface LayerOverride {
  name?: string
  color?: string
  removed?: boolean
}

interface LayerGroup {
  id: string
  name: string
  memberIds: string[]
  expanded: boolean
}

// 图层管理器只维护前端编辑态，不改变 artifact 和图层事实源。
//
// 透明度、显隐继续回调给资源控制器，保证地图渲染和面板显示使用同一份偏好。
export function useLayerManager({
  mapLayers,
  onToggleVisibility,
  onChangeOpacity,
}: UseLayerManagerOptions) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [order, setOrder] = useState<string[]>([])
  const [groups, setGroups] = useState<LayerGroup[]>([])
  const [overrides, setOverrides] = useState<Record<string, LayerOverride>>({})

  const layerIds = useMemo(() => mapLayers.map(layer => layer.artifact.artifactId), [mapLayers])

  const orderedLayers = useMemo(() => {
    const known = new Set(layerIds)
    const orderedIds = [
      ...order.filter(id => known.has(id)),
      ...layerIds.filter(id => !order.includes(id)),
    ]
    const layerById = new Map(mapLayers.map(layer => [layer.artifact.artifactId, layer]))
    return orderedIds
      .map(id => layerById.get(id))
      .filter((layer): layer is MapRenderLayer => Boolean(layer))
      .filter(layer => !overrides[layer.artifact.artifactId]?.removed)
  }, [layerIds, mapLayers, order, overrides])

  const filteredLayers = useMemo(() => {
    const normalized = searchQuery.trim().toLocaleLowerCase()
    if (!normalized) return orderedLayers
    return orderedLayers.filter(layer => {
      const override = overrides[layer.artifact.artifactId]
      const name = override?.name ?? layer.artifact.name
      return [
        name,
        layer.artifact.artifactType,
        layer.geometrySummary,
      ].some(value => value.toLocaleLowerCase().includes(normalized))
    })
  }, [orderedLayers, overrides, searchQuery])

  const tree = useMemo<LayerTreeNode[]>(() => {
    const layerNodes = filteredLayers.map(layer => {
      const id = layer.artifact.artifactId
      const override = overrides[id]
      return {
        id,
        artifactId: id,
        name: override?.name ?? layer.artifact.name,
        type: 'layer' as const,
        layerKind: layer.kind,
        artifactType: layer.artifact.artifactType,
        sourceUri: layer.artifact.uri,
        visible: layer.visible,
        opacity: layer.opacity,
        color: override?.color ?? readLayerColor(layer),
        fieldNames: readFieldNames(layer),
        attributeRows: readAttributeRows(layer),
        metadataRows: readMetadataRows(layer),
        featureCount: layer.featureCount,
        geometrySummary: layer.geometrySummary,
      }
    })

    if (!groups.length) return layerNodes

    const groupedIds = new Set(groups.flatMap(group => group.memberIds))
    const groupedNodes = groups
      .map(group => ({
        id: group.id,
        name: group.name,
        type: 'group' as const,
        visible: group.memberIds.some(id => layerNodes.find(node => node.id === id)?.visible),
        opacity: 1,
        expanded: group.expanded,
        children: group.expanded
          ? layerNodes.filter(node => group.memberIds.includes(node.id))
          : [],
      }))
      .filter(group => group.children.length || group.memberIds.some(id => layerIds.includes(id)))

    return [
      ...groupedNodes,
      ...layerNodes.filter(node => !groupedIds.has(node.id)),
    ]
  }, [filteredLayers, groups, layerIds, overrides])

  const flatNodes = useMemo(() => flattenTree(tree), [tree])
  const selectedNode = useMemo(
    () => flatNodes.find(node => node.id === selectedId),
    [flatNodes, selectedId],
  )
  const styleOverrides = useMemo(() => Object.fromEntries(
    Object.entries(overrides)
      .filter(([, override]) => override.color)
      .map(([id, override]) => [id, { color: override.color }]),
  ) as Record<string, { color?: string }>, [overrides])

  const selectLayer = useCallback((id: string | null) => setSelectedId(id), [])

  const toggleVisibility = useCallback((id: string) => {
    const group = groups.find(item => item.id === id)
    if (group) {
      group.memberIds.forEach(memberId => onToggleVisibility(memberId))
      return
    }
    onToggleVisibility(id)
  }, [groups, onToggleVisibility])

  const toggleAllVisibility = useCallback(() => {
    filteredLayers.forEach(layer => onToggleVisibility(layer.artifact.artifactId))
  }, [filteredLayers, onToggleVisibility])

  const setOpacity = useCallback((id: string, opacity: number) => {
    const group = groups.find(item => item.id === id)
    if (group) {
      group.memberIds.forEach(memberId => onChangeOpacity(memberId, opacity))
      return
    }
    onChangeOpacity(id, opacity)
  }, [groups, onChangeOpacity])

  const setColor = useCallback((id: string, color: string) => {
    setOverrides(current => ({
      ...current,
      [id]: { ...current[id], color },
    }))
  }, [])

  const renameLayer = useCallback((id: string, name: string) => {
    setGroups(current => current.map(group => group.id === id ? { ...group, name } : group))
    setOverrides(current => ({
      ...current,
      [id]: { ...current[id], name },
    }))
  }, [])

  const moveBy = useCallback((id: string, delta: number) => {
    setOrder(current => {
      const base = [
        ...current.filter(item => layerIds.includes(item)),
        ...layerIds.filter(item => !current.includes(item)),
      ]
      const index = base.indexOf(id)
      if (index < 0) return base
      const nextIndex = Math.max(0, Math.min(base.length - 1, index + delta))
      if (nextIndex === index) return base
      const next = [...base]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)
      return next
    })
  }, [layerIds])

  const removeLayer = useCallback((id: string) => {
    setOverrides(current => ({
      ...current,
      [id]: { ...current[id], removed: true },
    }))
    setSelectedId(current => current === id ? null : current)
  }, [])

  const createGroup = useCallback((name: string, memberIds: string[]) => {
    const cleanMemberIds = memberIds.filter(id => layerIds.includes(id))
    if (!name.trim() || !cleanMemberIds.length) return
    setGroups(current => [
      ...current,
      {
        id: `group_${crypto.randomUUID().replaceAll('-', '')}`,
        name: name.trim(),
        memberIds: cleanMemberIds,
        expanded: true,
      },
    ])
  }, [layerIds])

  const toggleGroup = useCallback((id: string) => {
    setGroups(current => current.map(group => (
      group.id === id ? { ...group, expanded: !group.expanded } : group
    )))
  }, [])

  return {
    tree,
    selectedId,
    searchQuery,
    totalCount: orderedLayers.length,
    visibleCount: orderedLayers.filter(layer => layer.visible).length,
    selectedNode,
    selectLayer,
    toggleVisibility,
    toggleAllVisibility,
    setOpacity,
    setColor,
    renameLayer,
    moveUp: (id: string) => moveBy(id, -1),
    moveDown: (id: string) => moveBy(id, 1),
    removeLayer,
    createGroup,
    toggleGroup,
    setSearchQuery,
    styleOverrides,
  }
}

function flattenTree(nodes: LayerTreeNode[]): LayerTreeNode[] {
  return nodes.flatMap(node => [node, ...(node.children ? flattenTree(node.children) : [])])
}

function readLayerColor(layer: MapRenderLayer): string | undefined {
  const color = layer.artifact.metadata?.color
  return typeof color === 'string' ? color : undefined
}

function readFieldNames(layer: MapRenderLayer): string[] {
  if (!layer.data) return []
  const fields = new Set<string>()
  for (const feature of layer.data.features.slice(0, 200)) {
    const props = feature.properties
    if (!props) continue
    Object.keys(props).forEach(key => fields.add(key))
    if (fields.size >= 30) break
  }
  return [...fields]
}

function readAttributeRows(layer: MapRenderLayer): Array<Record<string, unknown>> {
  if (!layer.data) return []
  return layer.data.features.slice(0, 20).map((feature, index) => ({
    OBJECTID: index + 1,
    ...(feature.properties ?? {}),
  }))
}

function readMetadataRows(layer: MapRenderLayer): Array<{ key: string; value: string }> {
  const metadata = layer.artifact.metadata ?? {}
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 24)
    .map(([key, value]) => ({
      key,
      value: formatMetadataValue(value),
    }))
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} 项`
  if (typeof value === 'object' && value) return `${Object.keys(value).length} 个字段`
  return String(value)
}
