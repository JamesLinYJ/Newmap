// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime 配置编辑器
//
//   文件:       RuntimeConfigEditor.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 维护 DebugPage 的运行时配置编辑态。draft 是用户正在编辑的本地状态，
// 只有点击保存时才提交给 AppShell，避免调试页诊断状态和配置表单互相污染。

import { useCallback, useMemo, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'

import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types'

interface RuntimeConfigEditorProps {
  runtimeConfig?: AgentRuntimeConfig
  onSaveRuntimeConfig: (config: AgentRuntimeConfig) => void
}

export function RuntimeConfigEditor({ runtimeConfig, onSaveRuntimeConfig }: RuntimeConfigEditorProps) {
  // 使用 seed 识别服务端配置版本。
  //
  // props 更新时直接派生 active editor，不用 useEffect 同步 setState，
  // 表单交互因此不会因为外部 hydrate 抖动而丢失当前字段边界。
  const runtimeConfigSeed = useMemo(() => JSON.stringify(runtimeConfig ?? null), [runtimeConfig])
  const [editor, setEditor] = useState<{
    seed: string
    draft?: AgentRuntimeConfig
    error?: string
  }>({
    seed: JSON.stringify(runtimeConfig ?? null),
    draft: runtimeConfig,
    error: undefined,
  })
  const activeEditor =
    editor.seed === runtimeConfigSeed
      ? editor
      : { seed: runtimeConfigSeed, draft: runtimeConfig, error: undefined }
  const draft = activeEditor.draft
  const error = activeEditor.error

  const setDraft = useCallback((nextDraft: AgentRuntimeConfig) => {
    setEditor((current) => ({
      ...current,
      draft: nextDraft,
      error: undefined,
    }))
  }, [])
  const setError = useCallback((nextError: string | undefined) => {
    setEditor((current) => ({
      ...current,
      error: nextError,
    }))
  }, [])

  return (
    <div className="panel__section">
      <div className="panel__subheader">
        <span>运行时默认配置</span>
        <span className="panel__muted">保存到数据库，debug 页面可细调</span>
      </div>
      {draft ? (
        <div className="runtime-config-grid">
          <label className="tool-field">
            <span className="composer__label">Loop 轨迹上限</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.loopTraceLimit}
              onChange={(event) => setDraft({ ...draft, loopTraceLimit: Number(event.target.value) || 1 })}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">主智能体名称</span>
            <input
              className="composer__input"
              value={draft.supervisor.name}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  supervisor: { ...draft.supervisor, name: event.target.value },
                })
              }}
            />
          </label>
          <label className="tool-field tool-field--full">
            <span className="composer__label">主智能体系统提示词</span>
            <textarea
              className="composer__textarea tool-field__textarea tool-field__textarea--catalog"
              value={draft.supervisor.systemPrompt}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  supervisor: { ...draft.supervisor, systemPrompt: event.target.value },
                })
              }}
            />
          </label>
          <label className="tool-field tool-field--full">
            <span className="composer__label">审批中断工具</span>
            <input
              className="composer__input"
              value={draft.supervisor.approvalInterruptTools.join(', ')}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  supervisor: {
                    ...draft.supervisor,
                    approvalInterruptTools: splitCsv(event.target.value),
                  },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">记录流上限</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.ui.transcriptMaxEntries}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  ui: { ...draft.ui, transcriptMaxEntries: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">事件分组窗口(ms)</span>
            <input
              className="composer__input"
              type="number"
              min={0}
              value={draft.ui.eventGroupingWindowMs}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  ui: { ...draft.ui, eventGroupingWindowMs: Number(event.target.value) || 0 },
                })
              }}
            />
          </label>
          <label className="tool-field tool-field--checkbox">
            <span className="composer__label">显示内部标签</span>
            <input
              type="checkbox"
              checked={draft.ui.showInternalReasoningLabels}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  ui: { ...draft.ui, showInternalReasoningLabels: event.target.checked },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">线程历史轮数</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.context.historyRunLimit}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, historyRunLimit: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">事件上下文窗口</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.context.eventWindow}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, eventWindow: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">工具调用窗口</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.context.toolCallWindow}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, toolCallWindow: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">结果产物窗口</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.context.artifactWindow}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, artifactWindow: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">告警上下文窗口</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.context.warningWindow}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, warningWindow: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">Prompt 字符上限</span>
            <input
              className="composer__input"
              type="number"
              min={1000}
              value={draft.context.promptMaxChars}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, promptMaxChars: Number(event.target.value) || 1000 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">上下文条目窗口</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.context.contextEntryWindow}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, contextEntryWindow: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">记忆文件字符上限</span>
            <input
              className="composer__input"
              type="number"
              min={0}
              value={draft.context.memoryFileCharLimit}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: { ...draft.context, memoryFileCharLimit: Number(event.target.value) || 0 },
                })
              }}
            />
          </label>
          <label className="tool-field tool-field--full">
            <span className="composer__label">Agent SDK 记忆文件</span>
            <input
              className="composer__input"
              value={draft.context.memoryFilePaths.join(', ')}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  context: {
                    ...draft.context,
                    memoryFilePaths: splitCsv(event.target.value),
                  },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">地理检索 Provider</span>
            <input
              className="composer__input"
              value={draft.geosearch.provider}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  geosearch: { ...draft.geosearch, provider: event.target.value },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">检索服务地址</span>
            <input
              className="composer__input"
              value={draft.geosearch.baseUrl}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  geosearch: { ...draft.geosearch, baseUrl: event.target.value },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">请求超时(ms)</span>
            <input
              className="composer__input"
              type="number"
              min={100}
              value={draft.geosearch.timeoutMs}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  geosearch: { ...draft.geosearch, timeoutMs: Number(event.target.value) || 1000 },
                })
              }}
            />
          </label>
          <label className="tool-field">
            <span className="composer__label">候选结果上限</span>
            <input
              className="composer__input"
              type="number"
              min={1}
              value={draft.geosearch.maxCandidates}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  geosearch: { ...draft.geosearch, maxCandidates: Number(event.target.value) || 1 },
                })
              }}
            />
          </label>
          <label className="tool-field tool-field--full">
            <span className="composer__label">检索服务 User-Agent</span>
            <input
              className="composer__input"
              value={draft.geosearch.userAgent}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  geosearch: { ...draft.geosearch, userAgent: event.target.value },
                })
              }}
            />
          </label>
          <label className="tool-field tool-field--checkbox">
            <span className="composer__label">启用远程地点检索</span>
            <input
              type="checkbox"
              checked={draft.geosearch.enabled}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  geosearch: { ...draft.geosearch, enabled: event.target.checked },
                })
              }}
            />
          </label>
          <div className="tool-field tool-field--full">
            <div className="panel__subheader">
              <span>子智能体</span>
              <button
                type="button"
                className="toolbar-button toolbar-button--ghost"
                onClick={() => {
                  setDraft({
                    ...draft,
                    subAgents: [
                      ...draft.subAgents,
                      {
                        agentId: `agent_${draft.subAgents.length + 1}`,
                        name: '新智能体',
                        role: '新角色',
                        summary: '负责新的工具职责。',
                        systemPrompt: '',
                        tools: [],
                      },
                    ],
                  })
                }}
              >
                新增子智能体
              </button>
            </div>
            <div className="runtime-config-agents">
              {draft.subAgents.map((agent, index) => (
                <article key={`${agent.agentId}:${index}`} className="runtime-config-agent">
                  <div className="runtime-config-agent__header">
                    <strong>{agent.name}</strong>
                    <button
                      type="button"
                      className="toolbar-button toolbar-button--ghost"
                      onClick={() => {
                        setDraft({
                          ...draft,
                          subAgents: draft.subAgents.filter((_, candidateIndex) => candidateIndex !== index),
                        })
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      删除
                    </button>
                  </div>
                  <div className="runtime-config-grid">
                    <label className="tool-field">
                      <span className="composer__label">智能体 ID</span>
                      <input
                        className="composer__input"
                        value={agent.agentId}
                        onChange={(event) => setDraft(updateSubAgent(draft, index, { agentId: event.target.value }))}
                      />
                    </label>
                    <label className="tool-field">
                      <span className="composer__label">名称</span>
                      <input
                        className="composer__input"
                        value={agent.name}
                        onChange={(event) => setDraft(updateSubAgent(draft, index, { name: event.target.value }))}
                      />
                    </label>
                    <label className="tool-field">
                      <span className="composer__label">角色</span>
                      <input
                        className="composer__input"
                        value={agent.role}
                        onChange={(event) => setDraft(updateSubAgent(draft, index, { role: event.target.value }))}
                      />
                    </label>
                    <label className="tool-field tool-field--full">
                      <span className="composer__label">摘要</span>
                      <input
                        className="composer__input"
                        value={agent.summary}
                        onChange={(event) => setDraft(updateSubAgent(draft, index, { summary: event.target.value }))}
                      />
                    </label>
                    <label className="tool-field tool-field--full">
                      <span className="composer__label">系统提示词</span>
                      <textarea
                        className="composer__textarea tool-field__textarea tool-field__textarea--catalog"
                        value={agent.systemPrompt ?? ''}
                        onChange={(event) => setDraft(updateSubAgent(draft, index, { systemPrompt: event.target.value }))}
                      />
                    </label>
                    <label className="tool-field tool-field--full">
                      <span className="composer__label">工具列表</span>
                      <input
                        className="composer__input"
                        value={agent.tools.join(', ')}
                        onChange={(event) => setDraft(updateSubAgent(draft, index, { tools: splitCsv(event.target.value) }))}
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="panel__empty">当前还没有运行时配置。</p>
      )}
      {error ? <div className="clarification-box clarification-box--error">{error}</div> : null}
      <div className="composer__actions">
        <button
          className="toolbar-button toolbar-button--primary"
          type="button"
          onClick={() => {
            if (!draft) {
              setError('当前没有可保存的运行时配置。')
              return
            }
            onSaveRuntimeConfig(draft)
          }}
        >
          <Save size={16} aria-hidden="true" />
          保存运行时配置
        </button>
      </div>
    </div>
  )
}

function splitCsv(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function updateSubAgent(
  config: AgentRuntimeConfig,
  index: number,
  fields: Partial<AgentRuntimeConfig['subAgents'][number]>,
) {
  return {
    ...config,
    subAgents: config.subAgents.map((item, candidateIndex) =>
      candidateIndex === index ? { ...item, ...fields } : item,
    ),
  }
}
