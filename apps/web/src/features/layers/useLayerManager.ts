// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理视图状态
//
//   文件:       useLayerManager.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MapRenderLayer } from '../../app/types'

export type LayerPanelView = 'drawOrder' | 'sources' | 'selection' | 'style' | 'add' | 'labels' | 'table'
export type LayerVisibilityFilter = 'all' | 'visible' | 'hidden'

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
  labelEnabled?: boolean
  labelField?: string
}

export interface LayerLabelSetting {
  enabled: boolean
  fieldName: string
}

export interface LayerOverride {
  name?: string
  color?: string
  removed?: boolean
}

export interface LayerGroup {
  id: string
  name: string
  memberIds: string[]
  expanded: boolean
}

export interface LayerManagerPreferences {
  activeView: LayerPanelView
  visibilityFilter: LayerVisibilityFilter
  order: string[]
  groups: LayerGroup[]
  overrides: Record<string, LayerOverride>
  labelSettings: Record<string, LayerLabelSetting>
}

interface UseLayerManagerOptions {
  mapLayers: MapRenderLayer[]
  onToggleVisibility: (artifactId: string) => void
  onSetVisibility: (artifactId: string, visible: boolean) => void
  onChangeOpacity: (artifactId: string, opacity: number) => void
  preferenceKey?: string
}

const DEFAULT_LAYER_MANAGER_PREFERENCES: LayerManagerPreferences = {
  activeView: 'drawOrder',
  visibilityFilter: 'all',
  order: [],
  groups: [],
  overrides: {},
  labelSettings: {},
}

// 图层管理器只维护前端编辑态，不改变 artifact 和图层事实源。
//
// 透明度、显隐继续回调给资源控制器，保证地图渲染和面板显示使用同一份偏好。
export function useLayerManager({
  mapLayers,
  onToggleVisibility,
  onSetVisibility,
  onChangeOpacity,
  preferenceKey,
}: UseLayerManagerOptions) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [preferences, setPreferences] = useState<LayerManagerPreferences>(() => readLayerManagerPreferences(preferenceKey))

  useEffect(() => {
    setPreferences(readLayerManagerPreferences(preferenceKey))
  }, [preferenceKey])

  useEffect(() => {
    writeLayerManagerPreferences(preferenceKey, preferences)
  }, [preferenceKey, preferences])

  const layerIds = useMemo(() => mapLayers.map(layer => layer.artifact.artifactId), [mapLayers])
  const { activeView, groups, labelSettings, order, overrides, visibilityFilter } = preferences

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
    return orderedLayers.filter(layer => {
      if (visibilityFilter === 'visible' && !layer.visible) return false
      if (visibilityFilter === 'hidden' && layer.visible) return false
      if (!normalized) return true
      const override = overrides[layer.artifact.artifactId]
      const name = override?.name ?? layer.artifact.name
      return [
        name,
        layer.artifact.artifactType,
        layer.geometrySummary,
      ].some(value => value.toLocaleLowerCase().includes(normalized))
    })
  }, [orderedLayers, overrides, searchQuery, visibilityFilter])

  const tree = useMemo<LayerTreeNode[]>(() => {
    const layerNodes = filteredLayers.map(layer => {
      const id = layer.artifact.artifactId
      const override = overrides[id]
      const fields = readFieldNames(layer)
      const label = labelSettings[id]
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
        fieldNames: fields,
        attributeRows: readAttributeRows(layer),
        metadataRows: readMetadataRows(layer),
        featureCount: layer.featureCount,
        geometrySummary: layer.geometrySummary,
        labelEnabled: Boolean(label?.enabled),
        labelField: label?.fieldName && fields.includes(label.fieldName) ? label.fieldName : fields[0],
      }
    })

    if (!groups.length) return layerNodes

    const groupedIds = new Set(groups.flatMap(group => group.memberIds))
    const groupedNodes = groups.flatMap(group => {
      const children = group.expanded
        ? layerNodes.filter(node => group.memberIds.includes(node.id))
        : []
      if (!children.length && !group.memberIds.some(id => layerIds.includes(id))) return []
      return [{
        id: group.id,
        name: group.name,
        type: 'group' as const,
        visible: group.memberIds.some(id => layerNodes.find(node => node.id === id)?.visible),
        opacity: 1,
        expanded: group.expanded,
        children,
      }]
    })

    return [
      ...groupedNodes,
      ...layerNodes.filter(node => !groupedIds.has(node.id)),
    ]
  }, [filteredLayers, groups, labelSettings, layerIds, overrides])

  const flatNodes = useMemo(() => flattenTree(tree), [tree])
  const selectedNode = useMemo(
    () => flatNodes.find(node => node.id === selectedId),
    [flatNodes, selectedId],
  )
  const visibleById = useMemo(
    () => new Map(orderedLayers.map(layer => [layer.artifact.artifactId, layer.visible])),
    [orderedLayers],
  )
  const styleOverrides = useMemo(() => Object.fromEntries(
    orderedLayers.map(layer => {
      const id = layer.artifact.artifactId
      const override = overrides[id]
      const label = labelSettings[id]
      return [id, {
        ...(override?.color ? { color: override.color } : {}),
        ...(label?.enabled && label.fieldName ? { labelEnabled: true, labelField: label.fieldName } : {}),
      }]
    }).filter(([, value]) => Object.keys(value as Record<string, unknown>).length),
  ) as Record<string, { color?: string; labelEnabled?: boolean; labelField?: string }>, [labelSettings, orderedLayers, overrides])
  const renderLayers = useMemo(
    () => orderedLayers.map(layer => applyLayerPresentation(layer, overrides[layer.artifact.artifactId], labelSettings[layer.artifact.artifactId])),
    [labelSettings, orderedLayers, overrides],
  )

  const updatePreferences = useCallback((updater: (current: LayerManagerPreferences) => LayerManagerPreferences) => {
    setPreferences(current => sanitizeLayerManagerPreferences(updater(current)))
  }, [])

  const selectLayer = useCallback((id: string | null) => setSelectedId(id), [])

  const setActiveView = useCallback((view: LayerPanelView) => {
    updatePreferences(current => ({ ...current, activeView: view }))
  }, [updatePreferences])

  const setVisibilityFilter = useCallback((filter: LayerVisibilityFilter) => {
    updatePreferences(current => ({ ...current, visibilityFilter: filter }))
  }, [updatePreferences])

  const toggleVisibility = useCallback((id: string) => {
    const group = groups.find(item => item.id === id)
    if (group) {
      const visibleMembers = group.memberIds.filter(memberId => visibleById.get(memberId) === true)
      const nextVisible = visibleMembers.length === 0
      group.memberIds
        .filter(memberId => visibleById.has(memberId))
        .forEach(memberId => onSetVisibility(memberId, nextVisible))
      return
    }
    onToggleVisibility(id)
  }, [groups, onSetVisibility, onToggleVisibility, visibleById])

  const toggleAllVisibility = useCallback(() => {
    if (!filteredLayers.length) return
    const nextVisible = !filteredLayers.every(layer => layer.visible)
    filteredLayers.forEach(layer => onSetVisibility(layer.artifact.artifactId, nextVisible))
  }, [filteredLayers, onSetVisibility])

  const setOpacity = useCallback((id: string, opacity: number) => {
    const group = groups.find(item => item.id === id)
    if (group) {
      group.memberIds.forEach(memberId => onChangeOpacity(memberId, opacity))
      return
    }
    onChangeOpacity(id, opacity)
  }, [groups, onChangeOpacity])

  const setColor = useCallback((id: string, color: string) => {
    updatePreferences(current => ({
      ...current,
      overrides: {
        ...current.overrides,
        [id]: { ...current.overrides[id], color },
      },
    }))
  }, [updatePreferences])

  const renameLayer = useCallback((id: string, name: string) => {
    updatePreferences(current => ({
      ...current,
      groups: current.groups.map(group => group.id === id ? { ...group, name } : group),
      overrides: {
        ...current.overrides,
        ...(layerIds.includes(id) ? { [id]: { ...current.overrides[id], name } } : {}),
      },
    }))
  }, [layerIds, updatePreferences])

  const moveBy = useCallback((id: string, delta: number) => {
    updatePreferences(current => {
      const base = [
        ...current.order.filter(item => layerIds.includes(item)),
        ...layerIds.filter(item => !current.order.includes(item)),
      ]
      const index = base.indexOf(id)
      if (index < 0) return current
      const nextIndex = Math.max(0, Math.min(base.length - 1, index + delta))
      if (nextIndex === index) return current
      const next = [...base]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)
      return { ...current, order: next }
    })
  }, [layerIds, updatePreferences])

  const removeLayer = useCallback((id: string) => {
    updatePreferences(current => ({
      ...current,
      overrides: {
        ...current.overrides,
        [id]: { ...current.overrides[id], removed: true },
      },
    }))
    setSelectedId(current => current === id ? null : current)
  }, [updatePreferences])

  const createGroup = useCallback((name: string, memberIds: string[]) => {
    const cleanMemberIds = memberIds.filter(id => layerIds.includes(id))
    if (!name.trim() || !cleanMemberIds.length) return
    updatePreferences(current => ({
      ...current,
      groups: [
        ...current.groups,
        {
          id: `group_${crypto.randomUUID().replaceAll('-', '')}`,
          name: name.trim(),
          memberIds: cleanMemberIds,
          expanded: true,
        },
      ],
    }))
  }, [layerIds, updatePreferences])

  const toggleGroup = useCallback((id: string) => {
    updatePreferences(current => ({
      ...current,
      groups: current.groups.map(group => (
        group.id === id ? { ...group, expanded: !group.expanded } : group
      )),
    }))
  }, [updatePreferences])

  const setLabelEnabled = useCallback((id: string, enabled: boolean) => {
    const node = flatNodes.find(item => item.id === id)
    const fieldName = node?.labelField ?? node?.fieldNames?.[0] ?? ''
    updatePreferences(current => ({
      ...current,
      labelSettings: {
        ...current.labelSettings,
        [id]: { fieldName, enabled: enabled && Boolean(fieldName) },
      },
    }))
  }, [flatNodes, updatePreferences])

  const setLabelField = useCallback((id: string, fieldName: string) => {
    updatePreferences(current => ({
      ...current,
      labelSettings: {
        ...current.labelSettings,
        [id]: { enabled: current.labelSettings[id]?.enabled ?? true, fieldName },
      },
    }))
  }, [updatePreferences])

  return {
    tree,
    selectedId,
    searchQuery,
    totalCount: orderedLayers.length,
    visibleCount: orderedLayers.filter(layer => layer.visible).length,
    selectedNode,
    activeView,
    visibilityFilter,
    preferences,
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
    setActiveView,
    setVisibilityFilter,
    setLabelEnabled,
    setLabelField,
    styleOverrides,
    renderLayers,
  }
}

export function readLayerManagerPreferences(preferenceKey?: string): LayerManagerPreferences {
  if (!preferenceKey || typeof window === 'undefined') {
    return DEFAULT_LAYER_MANAGER_PREFERENCES
  }
  try {
    const raw = window.localStorage.getItem(storageKey(preferenceKey))
    if (!raw) return DEFAULT_LAYER_MANAGER_PREFERENCES
    return sanitizeLayerManagerPreferences(JSON.parse(raw))
  } catch {
    return DEFAULT_LAYER_MANAGER_PREFERENCES
  }
}

export function writeLayerManagerPreferences(preferenceKey: string | undefined, preferences: LayerManagerPreferences) {
  if (!preferenceKey || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(preferenceKey), JSON.stringify(sanitizeLayerManagerPreferences(preferences)))
  } catch {
    // localStorage 可能被浏览器策略禁用；图层面板仍可在当前会话内工作。
  }
}

export function sanitizeLayerManagerPreferences(value: unknown): LayerManagerPreferences {
  if (!isRecord(value)) return DEFAULT_LAYER_MANAGER_PREFERENCES
  const activeView = isLayerPanelView(value.activeView) ? value.activeView : DEFAULT_LAYER_MANAGER_PREFERENCES.activeView
  const visibilityFilter = isVisibilityFilter(value.visibilityFilter) ? value.visibilityFilter : DEFAULT_LAYER_MANAGER_PREFERENCES.visibilityFilter
  return {
    activeView,
    visibilityFilter,
    order: Array.isArray(value.order) ? value.order.map(String) : [],
    groups: Array.isArray(value.groups) ? value.groups.flatMap(readLayerGroup) : [],
    overrides: readRecord(value.overrides, readLayerOverride),
    labelSettings: readRecord(value.labelSettings, readLayerLabelSetting),
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

function applyLayerPresentation(
  layer: MapRenderLayer,
  override: LayerOverride | undefined,
  label: LayerLabelSetting | undefined,
): MapRenderLayer {
  if (!override?.color && !(label?.enabled && label.fieldName)) {
    return layer
  }
  return {
    ...layer,
    artifact: {
      ...layer.artifact,
      metadata: {
        ...layer.artifact.metadata,
        ...(override?.color ? { color: override.color, layerColorOverride: true } : {}),
        ...(label?.enabled && label.fieldName ? { labelEnabled: true, labelField: label.fieldName } : {}),
      },
    },
  }
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} 项`
  if (typeof value === 'object' && value) return `${Object.keys(value).length} 个字段`
  return String(value)
}

function storageKey(preferenceKey: string) {
  return `geoforge.layer-manager.${preferenceKey}`
}

function readLayerGroup(value: unknown): LayerGroup[] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return []
  return [{
    id: value.id,
    name: value.name,
    memberIds: Array.isArray(value.memberIds) ? value.memberIds.map(String) : [],
    expanded: value.expanded !== false,
  }]
}

function readLayerOverride(value: unknown): LayerOverride | undefined {
  if (!isRecord(value)) return undefined
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.color === 'string' ? { color: value.color } : {}),
    ...(typeof value.removed === 'boolean' ? { removed: value.removed } : {}),
  }
}

function readLayerLabelSetting(value: unknown): LayerLabelSetting | undefined {
  if (!isRecord(value)) return undefined
  return {
    enabled: value.enabled === true,
    fieldName: typeof value.fieldName === 'string' ? value.fieldName : '',
  }
}

function readRecord<T>(value: unknown, reader: (item: unknown) => T | undefined): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .flatMap(([key, item]) => {
        const parsed = reader(item)
        return parsed ? [[key, parsed] as const] : []
      }),
  )
}

function isLayerPanelView(value: unknown): value is LayerPanelView {
  return value === 'drawOrder' || value === 'sources' || value === 'selection' || value === 'style' || value === 'add' || value === 'labels' || value === 'table'
}

function isVisibilityFilter(value: unknown): value is LayerVisibilityFilter {
  return value === 'all' || value === 'visible' || value === 'hidden'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
