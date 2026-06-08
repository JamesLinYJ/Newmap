// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入器
//
//   文件:       Composer.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 管理聊天输入框、模式切换、上传入口和澄清选项展示。
// 输入器只发出用户动作，不派生或保存 ConversationItem。

import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { ArrowUp, FolderUp, Plus, Settings2, Square } from 'lucide-react'
import { buildFadeUpMotion } from '../../shared/motion'
import type { ActiveClarification, ChatPanelProps, ComposerMode } from './types'
import { COMPOSER_MODES } from './composerModes'

const DIRECTORY_PICKER_PROPS = { webkitdirectory: '', directory: '' } as Record<string, string>

interface ComposerProps {
  query: string
  providerLabel: string
  isSubmitting: boolean
  composerMode: ComposerMode
  modeMenuOpen: boolean
  activeClarification: ActiveClarification | null
  clarificationBusy: boolean
  tokenBudget?: ChatPanelProps['tokenBudget']
  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: ChatPanelProps['runStats']
  denialCounts?: Record<string, number>
  composerInputRef: RefObject<HTMLInputElement | null>
  firstClarificationOptionRef: RefObject<HTMLButtonElement | null>
  reducedMotion: boolean
  onQueryChange: (value: string) => void
  onSubmit: (event?: FormEvent) => void
  onInterrupt: () => void
  onUseTemplate: () => void
  onUploadFiles: (files: File[]) => void
  onSelectClarification: (label: string, optionId?: string | null) => void
  onClarificationFreeText: () => void
  onModeChange: (mode: ComposerMode) => void
  onModeMenuOpenChange: (open: boolean) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function Composer({
  query,
  providerLabel,
  isSubmitting,
  composerMode,
  modeMenuOpen,
  activeClarification,
  clarificationBusy,
  tokenBudget,
  activeSkills,
  compactionLevel,
  runStats,
  denialCounts,
  composerInputRef,
  firstClarificationOptionRef,
  reducedMotion,
  onQueryChange,
  onSubmit,
  onInterrupt,
  onUseTemplate,
  onUploadFiles,
  onSelectClarification,
  onClarificationFreeText,
  onModeChange,
  onModeMenuOpenChange,
  onCompositionStart,
  onCompositionEnd,
  onInputKeyDown,
}: ComposerProps) {
  const selectedComposerMode = COMPOSER_MODES.find((mode) => mode.id === composerMode) ?? COMPOSER_MODES[1]
  const SelectedModeIcon = selectedComposerMode.icon

  return (
    <m.form className="cc-composer" layout onSubmit={onSubmit} {...buildFadeUpMotion(reducedMotion, 0.02, 10)}>
      <input
        ref={composerInputRef}
        className="cc-composer-input"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onInputKeyDown}
        placeholder="描述你的空间分析需求…"
        autoComplete="off"
      />
      <div className={`cc-composer-mode-note cc-composer-mode-note--${composerMode}`}>
        <SelectedModeIcon size={14} />
        <span>{selectedComposerMode.label}</span>
        <small>{composerMode === 'plan' ? '待办优先 · 先出计划' : 'Todo 跟踪 · 自动推进'}</small>
      </div>
      {tokenBudget && <TokenBudgetBar budget={tokenBudget} />}
      {(activeSkills && activeSkills.length > 0) || compactionLevel || runStats || (denialCounts && Object.keys(denialCounts).length > 0) ? (
        <RunStatusBar
          activeSkills={activeSkills}
          compactionLevel={compactionLevel}
          runStats={runStats}
          denialCounts={denialCounts}
        />
      ) : null}
      {activeClarification && (
        <div className="cc-clarification-bar">
          <span className="cc-clarification-bar__question">{activeClarification.question}</span>
          <div className="cc-clarification-bar__options">
            {activeClarification.options.map((option, index) => (
              <button
                key={option.optionId ?? `${option.label}:${index}`}
                ref={index === 0 ? firstClarificationOptionRef : undefined}
                className="cc-clarification-bar__chip"
                type="button"
                disabled={clarificationBusy}
                onClick={() => onSelectClarification(option.label, option.optionId)}
              >
                {option.label}
              </button>
            ))}
            <button
              className="cc-clarification-bar__dismiss"
              type="button"
              aria-label="关闭澄清"
              onClick={onClarificationFreeText}
            >
              直接输入
            </button>
          </div>
        </div>
      )}
      <div className="cc-composer-toolbar">
        <label className="cc-composer-tool" htmlFor="chat-file-upload" aria-label="上传图层">
          <Plus size={19} />
        </label>
        <input
          id="chat-file-upload"
          type="file"
          className="cc-file-hidden"
          multiple
          accept=".geojson,.json,.gpkg,.zip,.nc,.nc4,.tif,.tiff,.grib,.grb,.grb2,.h5,.hdf5,.bz2"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            if (files.length) {
              onUploadFiles(files)
            }
            event.target.value = ''
          }}
        />
        <label className="cc-composer-tool" htmlFor="chat-folder-upload" aria-label="上传文件夹">
          <FolderUp size={18} />
        </label>
        <input
          id="chat-folder-upload"
          type="file"
          className="cc-file-hidden"
          multiple
          {...DIRECTORY_PICKER_PROPS}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            if (files.length) {
              onUploadFiles(files)
            }
            event.target.value = ''
          }}
        />
        <button className="cc-composer-tool" type="button" aria-label="使用模板" onClick={onUseTemplate}>
          <Square size={17} />
        </button>
        <span className="cc-composer-spacer" />
        <div className="cc-mode-picker">
          <button
            className={`cc-mode-trigger cc-mode-trigger--${composerMode}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
            onClick={() => onModeMenuOpenChange(!modeMenuOpen)}
          >
            <SelectedModeIcon size={14} />
            <span>{selectedComposerMode.label}</span>
          </button>
          <AnimatePresence initial={false}>
            {modeMenuOpen && (
              <m.div
                className="cc-mode-menu"
                role="menu"
                {...buildFadeUpMotion(reducedMotion, 0, 8)}
              >
                <div className="cc-mode-menu__header">
                  <span>模式</span>
                  <small>⇧ + Tab 切换</small>
                </div>
                <div className="cc-mode-menu__list">
                  {COMPOSER_MODES.map((mode) => {
                    const ModeIcon = mode.icon
                    const active = composerMode === mode.id
                    return (
                      <button
                        key={mode.id}
                        className={`cc-mode-option ${active ? 'cc-mode-option--active' : ''}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          onModeChange(mode.id)
                          onModeMenuOpenChange(false)
                        }}
                      >
                        <ModeIcon size={18} />
                        <span>
                          <strong>{mode.label}</strong>
                          <small>{mode.description}</small>
                        </span>
                        {active && <span className="cc-mode-option__check">✓</span>}
                      </button>
                    )
                  })}
                </div>
              </m.div>
            )}
          </AnimatePresence>
        </div>
        <span className="cc-provider-chip" title={providerLabel}>
          <Settings2 size={14} />
          {providerLabel}
        </span>
        <button
          className={`cc-send ${isSubmitting ? 'cc-send--interrupt' : ''}`}
          type={isSubmitting ? 'button' : 'submit'}
          disabled={!isSubmitting && !query.trim()}
          aria-label={isSubmitting ? '中断运行' : '发送'}
          onClick={isSubmitting ? onInterrupt : undefined}
        >
          {isSubmitting ? (
            <>
              <Square size={14} />
              <span>中断</span>
            </>
          ) : (
            <ArrowUp size={18} />
          )}
        </button>
      </div>
    </m.form>
  )
}

function TokenBudgetBar({ budget }: { budget: NonNullable<ChatPanelProps['tokenBudget']> }) {
  const pct = budget.max > 0 ? Math.min((budget.used / budget.max) * 100, 100) : 0
  const fillClass = ({
    normal: 'cc-token-fill--normal',
    warning: 'cc-token-fill--warning',
    critical: 'cc-token-fill--critical',
    exceeded: 'cc-token-fill--exceeded',
  } as Record<string, string>)[budget.status] ?? 'cc-token-fill--normal'

  return (
    <div className="cc-token-budget">
      <div className="cc-token-budget__info">
        <span>Token 预算</span>
        <span className={budget.status === 'exceeded' || budget.status === 'critical' ? 'cc-token-budget__used--alert' : ''}>
          {budget.used.toLocaleString()} / {budget.max.toLocaleString()}
        </span>
      </div>
      <div className="cc-token-budget__bar">
        <div className={`cc-token-budget__fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function RunStatusBar({ activeSkills, compactionLevel, runStats, denialCounts }: {
  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: NonNullable<ChatPanelProps['runStats']>
  denialCounts?: Record<string, number>
}) {
  const denialItems = denialCounts && Object.keys(denialCounts).length > 0
    ? Object.entries(denialCounts).filter(([, count]) => count > 0)
    : []

  return (
    <div className="cc-run-status">
      {activeSkills && activeSkills.length > 0 && (
        <span className="cc-run-status__item">
          <Settings2 size={12} />
          {activeSkills.join(', ')}
        </span>
      )}
      {compactionLevel && (
        <span className="cc-run-status__item">
          压缩: {compactionLevel}
        </span>
      )}
      {runStats && (
        <span className="cc-run-status__item">
          工具: {runStats.toolSuccesses}/{runStats.toolAttempts} 成功
          · Token: {runStats.tokensUsed.toLocaleString()}
        </span>
      )}
      {denialItems.length > 0 && (
        <span className="cc-run-status__item cc-run-status__item--warning">
          拒绝: {denialItems.map(([tool, count]) => `${tool} ${count}`).join(', ')}
        </span>
      )}
    </div>
  )
}
