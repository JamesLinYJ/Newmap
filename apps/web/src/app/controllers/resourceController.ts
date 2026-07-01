// +-------------------------------------------------------------------------
//
//   地理智能平台 - 资源控制器
//
//   文件:       resourceController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AnalysisRun,
  ArtifactRef,
  BasemapDescriptor,
  LayerDescriptor,
  SessionRecord,
} from '@geo-agent-platform/shared-types'
import type { FileEntry } from '../../api/client'
import {
  apiBaseUrl,
  deleteAnyFile,
  deleteLayer,
  getArtifactGeoJson,
  getArtifactMetadata,
  getSession,
  importManagedLayer,
  listAllFiles,
  listBasemaps,
  listLayers,
  replaceManagedLayer,
  updateLayer,
  uploadAnyFile,
  uploadLayer,
  uploadMeteorologicalDataset,
} from '../../api/client'
import { useLayerManager } from '../../features/layers/useLayerManager'
import { artifactHasDisplaySurface } from '../../features/artifacts/artifactDisplay'
import { DEFAULT_BASEMAP } from '../../shared/constants'
import { formatUiError, reportNonBlockingError, retryAsync } from '../bootstrap'
import {
  classifyUploadFile,
  describeCollectionGeometry,
  describeRasterMetadata,
  formatFileSize,
  getUploadRelativePath,
  makeUploadReferenceId,
  parseRasterCoordinates,
  upsertUploadReference,
} from '../derivedState'
import type {
  MapLayerPreference,
  MapRenderLayer,
  UploadReference,
} from '../types'

interface ResourceControllerOptions {
  artifacts: ArtifactRef[]
  currentThreadId?: string | null
  ensureUploadThread: () => Promise<string>
  onSessionRecord: (session: SessionRecord) => void
  onShowSources: () => void
  runStatus?: AnalysisRun['status']
  session?: SessionRecord
  setUiError: (error?: string) => void
}

// 资源控制器持有文件、图层、artifact 水合结果和地图显示偏好。
//
// 上传 API 只写数据面；目录状态刷新仍通过 WebSocket 命令获取事实投影。
export function useResourceController({
  artifacts,
  currentThreadId,
  ensureUploadThread,
  onSessionRecord,
  onShowSources,
  runStatus,
  session,
  setUiError,
}: ResourceControllerOptions) {
  const [layers, setLayers] = useState<LayerDescriptor[]>([])
  const [basemaps, setBasemaps] = useState<BasemapDescriptor[]>([DEFAULT_BASEMAP])
  const [selectedBasemapKey, setSelectedBasemapKey] = useState('osm')
  const [artifactData, setArtifactData] = useState<Record<string, GeoJSON.FeatureCollection>>({})
  const [artifactMetadata, setArtifactMetadata] = useState<Record<string, Record<string, unknown>>>({})
  const [mapLayerPreferences, setMapLayerPreferences] = useState<Record<string, MapLayerPreference>>({})
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [uploadedLayerName, setUploadedLayerName] = useState<string>()
  const [uploadReferences, setUploadReferences] = useState<UploadReference[]>([])
  const [allFiles, setAllFiles] = useState<FileEntry[]>([])
  const [isFileSubmitting, setIsFileSubmitting] = useState(false)

  const selectedBasemap = useMemo(
    () => basemaps.find(item => item.basemapKey === selectedBasemapKey) ?? basemaps[0] ?? DEFAULT_BASEMAP,
    [basemaps, selectedBasemapKey],
  )

  const applyArtifactPayload = useCallback(async (artifactList: ArtifactRef[]) => {
    // ArtifactRef 是运行快照事实；地图需要的内容按 artifact 类型从 HTTP 数据面水合。
    const geojsonArtifacts = artifactList.filter(artifact => artifact.artifactType === 'geojson')
    const rasterArtifacts = artifactList.filter(artifact => artifact.artifactType !== 'geojson')
    const bundles = await Promise.all(
      geojsonArtifacts.map(async artifact => {
        const [data, metadataPayload] = await Promise.all([
          getArtifactGeoJson(artifact.artifactId),
          getArtifactMetadata(artifact.artifactId),
        ])
        return {
          artifactId: artifact.artifactId,
          data,
          metadata: (metadataPayload.metadata as Record<string, unknown>) ?? {},
        }
      }),
    )
    const rasterMetadata = await Promise.all(
      rasterArtifacts.map(async artifact => {
        const metadataPayload = await getArtifactMetadata(artifact.artifactId)
        return {
          artifactId: artifact.artifactId,
          metadata: (metadataPayload.metadata as Record<string, unknown>) ?? {},
        }
      }),
    )

    startTransition(() => {
      if (bundles.length) {
        setArtifactData(current => Object.fromEntries([
          ...Object.entries(current),
          ...bundles.map(bundle => [bundle.artifactId, bundle.data]),
        ]))
      }
      if (bundles.length || rasterMetadata.length) {
        setArtifactMetadata(current => Object.fromEntries([
          ...Object.entries(current),
          ...bundles.map(bundle => [bundle.artifactId, bundle.metadata]),
          ...rasterMetadata.map(bundle => [bundle.artifactId, bundle.metadata]),
        ]))
      }
    })
  }, [])

  const refreshLayers = useCallback(async (sessionId?: string | null, threadId?: string | null) => {
    const layerList = await listLayers(sessionId, threadId)
    startTransition(() => setLayers(layerList ?? []))
  }, [])

  const loadBasemaps = useCallback(async () => {
    const available = (await listBasemaps()).filter(item => item.available)
    if (!available.length) return
    startTransition(() => {
      setBasemaps(available)
      const defaultBasemap = available.find(item => item.isDefault) ?? available[0]
      setSelectedBasemapKey(current => available.some(item => item.basemapKey === current) ? current : defaultBasemap.basemapKey)
    })
  }, [])

  const clearArtifacts = useCallback(() => {
    startTransition(() => {
      setArtifactData({})
      setArtifactMetadata({})
      setMapLayerPreferences({})
      setSelectedArtifactId(undefined)
    })
  }, [])

  const clearUploads = useCallback(() => {
    startTransition(() => {
      setUploadedLayerName(undefined)
      setUploadReferences([])
      setAllFiles([])
    })
  }, [])

  useEffect(() => {
    const missing = artifacts.filter(artifact => (
      artifact.artifactType === 'geojson'
        ? !artifactData[artifact.artifactId]
        : !artifactMetadata[artifact.artifactId]
    ))
    if (!missing.length) return
    void applyArtifactPayload(missing).then(() => {
      if (missing.length === 1) startTransition(() => setSelectedArtifactId(missing[0].artifactId))
    })
  }, [applyArtifactPayload, artifactData, artifactMetadata, artifacts])

  const uploadOneFile = useCallback(async (file: File, explicitThreadId?: string | null) => {
    if (!session) throw new Error('当前会话还没有初始化，暂时不能上传文件。')
    const threadId = explicitThreadId ?? currentThreadId
    const kind = classifyUploadFile(file)
    if (!kind) throw new Error(`不支持的文件类型：${file.name}`)
    const relativePath = getUploadRelativePath(file)
    const referenceId = makeUploadReferenceId(kind, relativePath, file)
    const baseReference: UploadReference = {
      id: referenceId,
      kind,
      name: file.name,
      relativePath,
      status: 'uploading',
      detail: `${formatFileSize(file.size)} · 正在上传`,
    }
    setUploadReferences(current => upsertUploadReference(current, baseReference))

    try {
      if (kind === 'meteorology') {
        const { dataset } = await uploadMeteorologicalDataset(session.id, file, threadId)
        startTransition(() => {
          setUploadedLayerName(dataset.filename)
          setUploadReferences(current => upsertUploadReference(current, {
            ...baseReference,
            name: dataset.filename,
            status: dataset.status,
            detail: `${formatFileSize(dataset.sizeBytes)} · 气象数据`,
          }))
        })
        return { kind, name: dataset.filename }
      }

      if (kind === 'file') {
        // 同一 requestId 会在服务端落到同一存储条目，允许瞬时网络失败后安全重试。
        const requestId = `upload_${crypto.randomUUID().replaceAll('-', '')}`
        const uploaded = await retryAsync(() => uploadAnyFile(file, threadId, requestId), 2, 500)
        startTransition(() => {
          setUploadedLayerName(uploaded.name)
          setUploadReferences(current => upsertUploadReference(current, {
            ...baseReference,
            status: 'ready',
            detail: `${formatFileSize(file.size)} · 线程文件`,
          }))
        })
        return { kind, name: uploaded.name }
      }

      const descriptor = await uploadLayer(session.id, file, threadId)
      startTransition(() => {
        setUploadedLayerName(descriptor.name)
        setUploadReferences(current => upsertUploadReference(current, {
          ...baseReference,
          name: descriptor.name,
          status: 'ready',
          detail: `${descriptor.featureCount ?? 0} 个对象 · ${descriptor.geometryType}`,
        }))
      })
      return { kind, name: descriptor.name }
    } catch (error) {
      setUploadReferences(current => upsertUploadReference(current, {
        ...baseReference,
        status: 'failed',
        detail: formatUiError(error, '上传失败'),
      }))
      throw error
    }
  }, [currentThreadId, session])

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!session) return
    const uploadable = files.filter(file => classifyUploadFile(file))
    const skippedCount = files.length - uploadable.length
    if (!uploadable.length) {
      setUiError('没有找到可上传的 GeoJSON、NetCDF、GRIB、GeoTIFF、HDF5 或雷达 bz2 文件。')
      return
    }

    let resolvedThreadId: string
    try {
      resolvedThreadId = await ensureUploadThread()
    } catch (error) {
      setUiError(formatUiError(error, '上传前创建对话线程失败。'))
      return
    }

    setUiError(undefined)
    onShowSources()
    let layerUploaded = false
    let meteorologyUploaded = false
    const failures: string[] = []
    for (const file of uploadable) {
      try {
        const result = await uploadOneFile(file, resolvedThreadId)
        layerUploaded ||= result.kind === 'layer'
        meteorologyUploaded ||= result.kind === 'meteorology'
      } catch (error) {
        failures.push(`${getUploadRelativePath(file)}：${formatUiError(error, '上传失败')}`)
      }
    }

    if (layerUploaded || meteorologyUploaded) {
      try {
        const [sessionRecord, layerList] = await Promise.all([getSession(session.id), listLayers(session.id)])
        startTransition(() => {
          onSessionRecord(sessionRecord)
          setLayers(layerList ?? [])
        })
      } catch (error) {
        setUiError(formatUiError(error, '文件已上传，但数据源列表刷新失败，请手动刷新页面确认。'))
        return
      }
    }

    if (failures.length) {
      setUiError(`部分文件上传失败：${failures.slice(0, 3).join('；')}${failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : ''}`)
    } else if (skippedCount > 0) {
      setUiError(`已上传 ${uploadable.length} 个文件，跳过 ${skippedCount} 个不支持的文件。`)
    }
  }, [ensureUploadThread, onSessionRecord, onShowSources, session, setUiError, uploadOneFile])

  const importLayer = useCallback(async (file: File) => {
    try {
      setUiError(undefined)
      onShowSources()
      await importManagedLayer(file)
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层导入没成功，请再试一次。'))
    }
  }, [onShowSources, refreshLayers, setUiError])

  const toggleLayerStatus = useCallback(async (layerKey: string, nextStatus: string) => {
    try {
      setUiError(undefined)
      await updateLayer(layerKey, { status: nextStatus })
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层状态更新失败，请再试一次。'))
    }
  }, [refreshLayers, setUiError])

  const replaceLayer = useCallback(async (layerKey: string, file: File) => {
    try {
      setUiError(undefined)
      onShowSources()
      await replaceManagedLayer(layerKey, file)
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层数据替换失败，请再试一次。'))
    }
  }, [onShowSources, refreshLayers, setUiError])

  const removeLayer = useCallback(async (layerKey: string) => {
    try {
      setUiError(undefined)
      await deleteLayer(layerKey)
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层删除失败，请再试一次。'))
    }
  }, [refreshLayers, setUiError])

  const refreshAllFiles = useCallback(async (threadId?: string | null) => {
    try {
      const data = await listAllFiles(threadId || currentThreadId)
      setAllFiles(data.files ?? [])
    } catch (error) {
      reportNonBlockingError('refreshAllFiles', error)
    }
  }, [currentThreadId])

  const uploadFile = useCallback(async (file: File) => {
    setIsFileSubmitting(true)
    try {
      const resolvedThreadId = await ensureUploadThread()
      await uploadAnyFile(file, resolvedThreadId)
      await refreshAllFiles(resolvedThreadId)
    } catch (error) {
      setUiError(formatUiError(error, `上传 ${file.name} 失败`))
    } finally {
      setIsFileSubmitting(false)
    }
  }, [ensureUploadThread, refreshAllFiles, setUiError])

  const removeFile = useCallback(async (fileId: string) => {
    try {
      setUiError(undefined)
      await deleteAnyFile(fileId, currentThreadId)
      await refreshAllFiles(currentThreadId)
    } catch (error) {
      setUiError(formatUiError(error, '删除文件失败'))
    }
  }, [currentThreadId, refreshAllFiles, setUiError])

  useEffect(() => {
    if (currentThreadId) void refreshAllFiles(currentThreadId)
  }, [currentThreadId, refreshAllFiles])

  const toggleArtifactVisibility = useCallback((artifactId: string) => {
    setMapLayerPreferences(current => {
      const existing = current[artifactId]
      return {
        ...current,
        [artifactId]: {
          visible: existing ? !existing.visible : false,
          opacity: existing?.opacity ?? 0.9,
        },
      }
    })
  }, [])

  const changeArtifactOpacity = useCallback((artifactId: string, opacity: number) => {
    setMapLayerPreferences(current => ({
      ...current,
      [artifactId]: {
        visible: current[artifactId]?.visible ?? true,
        opacity,
      },
    }))
  }, [])

  const baseMapLayers = useMemo(() => artifacts
    .filter(artifact => runStatus === 'running' || !artifact.isIntermediate)
    .flatMap<MapRenderLayer>(artifact => {
      const visible = mapLayerPreferences[artifact.artifactId]?.visible ?? true
      const opacity = mapLayerPreferences[artifact.artifactId]?.opacity ?? 0.9
      const metadata = artifactMetadata[artifact.artifactId] ?? artifact.metadata
      const displayArtifact = { ...artifact, metadata }
      if (!artifactHasDisplaySurface(displayArtifact, 'map')) return []
      if (artifact.artifactType === 'geojson' && artifactData[artifact.artifactId]) {
        return [{
          kind: 'geojson',
          artifact: displayArtifact,
          data: artifactData[artifact.artifactId],
          visible,
          opacity,
          featureCount: artifactData[artifact.artifactId]?.features.length ?? 0,
          geometrySummary: describeCollectionGeometry(artifactData[artifact.artifactId]),
        }]
      }
      const coordinates = parseRasterCoordinates(metadata.coordinates)
      const imageUrl = typeof metadata.imageUrl === 'string' ? `${apiBaseUrl}${metadata.imageUrl}` : `${apiBaseUrl}${artifact.uri}`
      if (artifact.artifactType === 'raster_png' && coordinates) {
        return [{
          kind: 'raster',
          artifact: displayArtifact,
          imageUrl,
          coordinates,
          visible,
          opacity,
          featureCount: 1,
          geometrySummary: describeRasterMetadata(metadata),
        }]
      }
      return []
    }), [artifactData, artifactMetadata, artifacts, mapLayerPreferences, runStatus])

  const layerManager = useLayerManager({
    mapLayers: baseMapLayers,
    onToggleVisibility: toggleArtifactVisibility,
    onChangeOpacity: changeArtifactOpacity,
  })

  const mapLayers = useMemo(() => baseMapLayers.map(layer => {
    const override = layerManager.styleOverrides[layer.artifact.artifactId]
    if (!override?.color) return layer
    return {
      ...layer,
      artifact: {
        ...layer.artifact,
        metadata: {
          ...layer.artifact.metadata,
          color: override.color,
          layerColorOverride: true,
        },
      },
    }
  }), [baseMapLayers, layerManager.styleOverrides])

  const exportLayer = useCallback((id: string) => {
    const artifact = artifacts.find(item => item.artifactId === id)
    if (artifact) window.open(`${apiBaseUrl}${artifact.uri}`, '_blank')
  }, [artifacts])

  return {
    allFiles,
    applyArtifactPayload,
    artifactData,
    artifactMetadata,
    basemaps,
    changeArtifactOpacity,
    clearArtifacts,
    clearUploads,
    exportLayer,
    importLayer,
    isFileSubmitting,
    layerManager,
    layers,
    loadBasemaps,
    mapLayers,
    refreshLayers,
    removeFile,
    removeLayer,
    replaceLayer,
    selectedArtifactId,
    selectedBasemap,
    selectedBasemapKey,
    setSelectedArtifactId,
    setSelectedBasemapKey,
    toggleArtifactVisibility,
    toggleLayerStatus,
    uploadedLayerName,
    uploadFile,
    uploadFiles,
    uploadReferences,
  }
}
