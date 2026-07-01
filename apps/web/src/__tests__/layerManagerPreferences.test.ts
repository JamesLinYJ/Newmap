// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理偏好规则测试
//
//   文件:       layerManagerPreferences.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest'
import {
  readLayerManagerPreferences,
  sanitizeLayerManagerPreferences,
  writeLayerManagerPreferences,
  type LayerManagerPreferences,
} from '../features/layers/useLayerManager'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('layer manager preferences', () => {
  it('drops unknown panel and filter values when reading persisted state', () => {
    // 本地偏好只是工作区编辑态；读取时必须清洗，不能让旧值驱动不存在的 UI 视图。
    const preferences = sanitizeLayerManagerPreferences({
      activeView: 'legacyPanel',
      visibilityFilter: 'selectedOnly',
      order: ['layer_2', 17],
      groups: [{ id: 'group_1', name: '气象产品', memberIds: ['layer_1'], expanded: false }],
      overrides: {
        layer_1: { name: '雷达回波', color: '#1188ff', removed: true },
        layer_2: 'bad',
      },
      labelSettings: {
        layer_1: { enabled: true, fieldName: 'name' },
      },
    })

    expect(preferences.activeView).toBe('drawOrder')
    expect(preferences.visibilityFilter).toBe('all')
    expect(preferences.order).toEqual(['layer_2', '17'])
    expect(preferences.groups).toEqual([{ id: 'group_1', name: '气象产品', memberIds: ['layer_1'], expanded: false }])
    expect(preferences.overrides.layer_1).toEqual({ name: '雷达回波', color: '#1188ff', removed: true })
    expect(preferences.overrides.layer_2).toBeUndefined()
    expect(preferences.labelSettings.layer_1).toEqual({ enabled: true, fieldName: 'name' })
  })

  it('persists preferences by thread and run scoped storage key', () => {
    installWindowStorage()
    const preferences: LayerManagerPreferences = {
      activeView: 'sources',
      visibilityFilter: 'visible',
      order: ['layer_a'],
      groups: [],
      overrides: { layer_a: { color: '#0ea5e9' } },
      labelSettings: { layer_a: { enabled: true, fieldName: 'station' } },
    }

    writeLayerManagerPreferences('thread_1:run_1', preferences)
    writeLayerManagerPreferences('thread_1:run_2', { ...preferences, activeView: 'table' })

    expect(readLayerManagerPreferences('thread_1:run_1')).toMatchObject({
      activeView: 'sources',
      visibilityFilter: 'visible',
      order: ['layer_a'],
      overrides: { layer_a: { color: '#0ea5e9' } },
      labelSettings: { layer_a: { enabled: true, fieldName: 'station' } },
    })
    expect(readLayerManagerPreferences('thread_1:run_2').activeView).toBe('table')
  })
})

function installWindowStorage() {
  const store = new Map<string, string>()
  const localStorage: Storage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  })
}
