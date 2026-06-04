// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图图层管理器 Hook
//
//   文件:       useLayerManager.ts
//
//   日期:       2026年05月26日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 管理地图上实际渲染的图层：可见性、不透明度、排序、编组、重命名、搜索。
// 数据源单一：mapLayers（MapRenderLayer[]），与地图 1:1 对应。

import { useCallback, useMemo, useRef, useState } from 'react'

export interface LayerTreeNode {
  id: string
  name: string
  kind: 'artifact' | 'raster' | 'group'
  visible: boolean
  expanded: boolean
  children: LayerTreeNode[]
  order: number
  opacity: number
  color?: string
  featureCount?: number
  geometryType?: string
}

interface MapRenderLayer {
  kind: 'geojson' | 'raster'
  artifact: { artifactId: string; name: string; artifactType: string }
  data?: { features?: Array<{ geometry?: { type: string } }> }
  imageUrl?: string
  visible: boolean
  opacity: number
  featureCount: number
  geometrySummary: string
}

interface LayerManagerState {
  selectedId: string | null
  layerOrder: Record<string, number>
  layerVisible: Record<string, boolean>
  layerOpacity: Record<string, number>
  layerColor: Record<string, string>
  customNames: Record<string, string>
  groupExpanded: Record<string, boolean>
  groups: Record<string, string[]>
  searchQuery: string
}

interface UseLayerManagerInput {
  mapLayers: MapRenderLayer[]
  onToggleVisibility: (artifactId: string) => void
  onChangeOpacity: (artifactId: string, opacity: number) => void
}

interface UseLayerManagerOutput {
  tree: LayerTreeNode[]
  selectedId: string | null
  searchQuery: string
  totalCount: number
  visibleCount: number
  selectedNode: LayerTreeNode | undefined
  selectLayer: (id: string | null) => void
  toggleVisibility: (id: string) => void
  toggleAllVisibility: () => void
  setOpacity: (id: string, opacity: number) => void
  setColor: (id: string, color: string) => void
  renameLayer: (id: string, name: string) => void
  moveUp: (id: string) => void
  moveDown: (id: string) => void
  removeLayer: (id: string) => void
  createGroup: (name: string, memberIds: string[]) => void
  toggleGroup: (id: string) => void
  setSearchQuery: (q: string) => void
}

function buildFlatNodes(input: UseLayerManagerInput, state: LayerManagerState): LayerTreeNode[] {
  const nodes: LayerTreeNode[] = []
  let order = 0

  for (const ml of input.mapLayers) {
    const id = ml.artifact.artifactId
    nodes.push({
      id,
      name: state.customNames[id] ?? ml.artifact.name,
      kind: ml.kind === 'raster' ? 'raster' : 'artifact',
      visible: state.layerVisible[id] ?? ml.visible,
      expanded: true,
      children: [],
      order: state.layerOrder[id] ?? order++,
      opacity: state.layerOpacity[id] ?? ml.opacity,
      featureCount: ml.featureCount,
      geometryType: ml.kind === 'raster' ? 'raster'
        : ml.data?.features?.[0]?.geometry?.type ?? ml.geometrySummary,
    })
  }

  return nodes
}

function nestNodes(
  flat: LayerTreeNode[],
  groups: Record<string, string[]>,
  expanded: Record<string, boolean>,
  customNames: Record<string, string>,
  order: Record<string, number>,
): LayerTreeNode[] {
  const groupedIds = new Set<string>()
  const groupNodes: LayerTreeNode[] = []

  for (const [gid, memberIds] of Object.entries(groups)) {
    if (!memberIds.length) continue
    const members = flat.filter((n) => memberIds.includes(n.id))
    if (!members.length) continue
    for (const m of members) groupedIds.add(m.id)
    groupNodes.push({
      id: gid, name: customNames[gid] ?? '编组', kind: 'group',
      visible: members.every((m) => m.visible),
      expanded: expanded[gid] ?? true,
      children: members.map((m) => ({ ...m, expanded: true })),
      order: order[gid] ?? members.reduce((min, m) => Math.min(min, m.order), Infinity),
      opacity: 1,
      featureCount: members.reduce((s, m) => s + (m.featureCount ?? 0), 0),
      geometryType: members.find((m) => m.geometryType)?.geometryType,
    })
  }

  const ungrouped = flat.filter((n) => !groupedIds.has(n.id))
  return [...ungrouped, ...groupNodes].sort((a, b) => a.order - b.order)
}

function filterTree(nodes: LayerTreeNode[], query: string): LayerTreeNode[] {
  if (!query) return nodes
  const q = query.toLowerCase()
  return nodes.filter((n) => {
    if (n.name.toLowerCase().includes(q)) return true
    if (n.kind === 'group') return n.children.some((c) => c.name.toLowerCase().includes(q))
    return false
  })
}

function collectLeaves(nodes: LayerTreeNode[]): LayerTreeNode[] {
  const r: LayerTreeNode[] = []
  for (const n of nodes) {
    if (n.kind === 'group') r.push(...collectLeaves(n.children))
    else r.push(n)
  }
  return r
}

function findInTree(nodes: LayerTreeNode[], id: string): LayerTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n
    const f = findInTree(n.children, id)
    if (f) return f
  }
  return undefined
}

export function useLayerManager(input: UseLayerManagerInput): UseLayerManagerOutput {
  const { mapLayers, onToggleVisibility, onChangeOpacity } = input
  const [state, setState] = useState<LayerManagerState>({
    selectedId: null, layerOrder: {}, layerVisible: {}, layerOpacity: {},
    layerColor: {}, customNames: {}, groupExpanded: {}, groups: {}, searchQuery: '',
  })
  const stateRef = useRef(state)
  stateRef.current = state

  const flatNodes = useMemo(() => buildFlatNodes({ mapLayers, onToggleVisibility, onChangeOpacity }, state), [mapLayers, state, onToggleVisibility, onChangeOpacity])

  const tree = useMemo(() => {
    const nested = nestNodes(flatNodes, state.groups, state.groupExpanded, state.customNames, state.layerOrder)
    return filterTree(nested, state.searchQuery)
  }, [flatNodes, state.groups, state.groupExpanded, state.customNames, state.layerOrder, state.searchQuery])

  const totalCount = useMemo(() => {
    const leaves = collectLeaves(nestNodes(flatNodes, state.groups, state.groupExpanded, state.customNames, state.layerOrder))
    return leaves.length
  }, [flatNodes, state])

  const visibleCount = useMemo(() => {
    const leaves = collectLeaves(nestNodes(flatNodes, state.groups, state.groupExpanded, state.customNames, state.layerOrder))
    return leaves.filter((n) => n.visible).length
  }, [flatNodes, state])

  const selectedNode = useMemo(() => {
    if (!state.selectedId) return undefined
    return findInTree(tree, state.selectedId)
  }, [tree, state.selectedId])

  const patchState = useCallback((patch: Partial<LayerManagerState>) => {
    setState((prev) => ({ ...prev, ...patch }))
  }, [])

  const selectLayer = useCallback((id: string | null) => patchState({ selectedId: id }), [patchState])

  const toggleVisibility = useCallback((id: string) => {
    const ml = mapLayers.find((l) => l.artifact.artifactId === id)
    if (ml) {
      onToggleVisibility(id)
      setState((prev) => ({ ...prev, layerVisible: { ...prev.layerVisible, [id]: !ml.visible } }))
    }
  }, [mapLayers, onToggleVisibility])

  const toggleAllVisibility = useCallback(() => {
    const leaves = collectLeaves(
      nestNodes(flatNodes, stateRef.current.groups, stateRef.current.groupExpanded, stateRef.current.customNames, stateRef.current.layerOrder),
    )
    const anyVisible = leaves.some((n) => stateRef.current.layerVisible[n.id] ?? n.visible)
    for (const n of leaves) {
      const ml = mapLayers.find((l) => l.artifact.artifactId === n.id)
      if (ml && ml.visible === anyVisible) onToggleVisibility(n.id)
    }
  }, [flatNodes, mapLayers, onToggleVisibility])

  const setOpacity = useCallback((id: string, opacity: number) => {
    onChangeOpacity(id, opacity)
    setState((prev) => ({ ...prev, layerOpacity: { ...prev.layerOpacity, [id]: opacity } }))
  }, [onChangeOpacity])

  const renameLayer = useCallback((id: string, name: string) => {
    setState((prev) => ({ ...prev, customNames: { ...prev.customNames, [id]: name } }))
  }, [])

  const moveUp = useCallback((id: string) => {
    setState((prev) => {
      const sorted = [...flatNodes].sort((a, b) => (prev.layerOrder[a.id] ?? a.order) - (prev.layerOrder[b.id] ?? b.order))
      const idx = sorted.findIndex((n) => n.id === id)
      if (idx <= 0) return prev
      const cur = sorted[idx]; const above = sorted[idx - 1]
      return { ...prev, layerOrder: { ...prev.layerOrder, [cur.id]: above.order - 1, [above.id]: cur.order } }
    })
  }, [flatNodes])

  const moveDown = useCallback((id: string) => {
    setState((prev) => {
      const sorted = [...flatNodes].sort((a, b) => (prev.layerOrder[a.id] ?? a.order) - (prev.layerOrder[b.id] ?? b.order))
      const idx = sorted.findIndex((n) => n.id === id)
      if (idx < 0 || idx >= sorted.length - 1) return prev
      const cur = sorted[idx]; const below = sorted[idx + 1]
      return { ...prev, layerOrder: { ...prev.layerOrder, [cur.id]: below.order + 1, [below.id]: cur.order } }
    })
  }, [flatNodes])

  const removeLayer = useCallback((id: string) => {
    setState((prev) => {
      const nextGroups = { ...prev.groups }
      delete nextGroups[id]
      for (const gid of Object.keys(nextGroups)) nextGroups[gid] = nextGroups[gid].filter((mid) => mid !== id)
      return { ...prev, groups: nextGroups, selectedId: prev.selectedId === id ? null : prev.selectedId }
    })
  }, [])

  const createGroup = useCallback((name: string, memberIds: string[]) => {
    const groupId = `group:${Date.now()}`
    setState((prev) => ({
      ...prev,
      groups: { ...prev.groups, [groupId]: memberIds },
      customNames: { ...prev.customNames, [groupId]: name },
      groupExpanded: { ...prev.groupExpanded, [groupId]: true },
    }))
  }, [])

  const toggleGroup = useCallback((id: string) => {
    setState((prev) => ({ ...prev, groupExpanded: { ...prev.groupExpanded, [id]: !(prev.groupExpanded[id] ?? true) } }))
  }, [])

  const setSearchQuery = useCallback((q: string) => patchState({ searchQuery: q }), [patchState])

  const setColor = useCallback((id: string, color: string) => {
    patchState(prev => ({
      layerColor: { ...prev.layerColor, [id]: color },
    }))
  }, [patchState])

  // Inject stored colors into tree nodes
  const treeWithColors = useMemo(() => {
    const colors = state.layerColor
    if (!colors || Object.keys(colors).length === 0) return tree
    const applyColor = (nodes: LayerTreeNode[]): LayerTreeNode[] =>
      nodes.map(n => ({
        ...n,
        color: colors[n.id] || n.color,
        children: applyColor(n.children),
      }))
    return applyColor(tree)
  }, [tree, state])

  return {
    tree: treeWithColors, selectedId: state.selectedId, searchQuery: state.searchQuery,
    totalCount, visibleCount, selectedNode,
    selectLayer, toggleVisibility, toggleAllVisibility, setOpacity, setColor,
    renameLayer, moveUp, moveDown, removeLayer, createGroup, toggleGroup, setSearchQuery,
  }
}
