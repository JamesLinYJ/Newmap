// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入框
//
//   文件:       Composer.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useEffect, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { m } from 'framer-motion'
import { Check, ChevronDown, Sparkles, Square, Upload, Zap } from 'lucide-react'
import { AppIcon } from '../../shared/components/AppIcon'
import { buildFadeUpMotion } from '../../shared/motion'
import { COMPOSER_MODES } from './composerModes'
import type { ActiveClarification, ChatPanelProps, ComposerMode } from './types'

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
  composerInputRef: RefObject<HTMLTextAreaElement | null>
  firstClarificationOptionRef: RefObject<HTMLButtonElement | null>
  reducedMotion: boolean
  onQueryChange: (value: string) => void
  onSubmit: (event?: FormEvent) => void
  onInterrupt?: () => void
  onUseTemplate: () => void
  onUploadFiles: (files: File[]) => void
  onSelectClarification: (value: string, id?: string | null) => void
  onClarificationFreeText: () => void
  onModeChange: (mode: ComposerMode) => void
  onModeMenuOpenChange: (open: boolean) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

// Composer 只维护用户正在编辑的输入态和按钮交互。
//
// 提交后是否清空由 AppShell 在 run:start 被接受前处理，避免输入框自行伪造提交成功。
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
  const mode = COMPOSER_MODES.find(item => item.id === composerMode) ?? COMPOSER_MODES[0]
  const modeShortLabel = mode.id === 'auto' ? '自动' : '计划'
  const canSubmit = Boolean(query.trim()) && !isSubmitting

  useEffect(() => {
    const input = composerInputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`
  }, [composerInputRef, query])

  return (
    <form className="cc-composer" onSubmit={onSubmit}>
      {activeClarification ? (
        <div className="cc-clarification-bar">
          <span className="cc-clarification-bar__question">{activeClarification.question}</span>
          <div className="cc-clarification-bar__options">
            {activeClarification.options.map((option, index) => (
              <button
                key={option.optionId ?? option.label}
                ref={index === 0 ? firstClarificationOptionRef : undefined}
                className="cc-clarification-bar__chip"
                type="button"
                disabled={clarificationBusy}
                onClick={() => onSelectClarification(option.label, option.optionId)}
              >
                {option.label}
              </button>
            ))}
            {activeClarification.allowFreeText ? (
              <button className="cc-clarification-bar__dismiss" type="button" disabled={clarificationBusy} onClick={onClarificationFreeText}>
                我补充说明
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <textarea
        id="analysis-query-input"
        ref={composerInputRef}
        className="cc-composer-input"
        value={query}
        aria-label="输入空间分析需求"
        placeholder="输入消息..."
        rows={1}
        wrap="soft"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onInputKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        disabled={isSubmitting}
      />

      <div className={`cc-composer-mode-note cc-composer-mode-note--${composerMode}`}>
        <span><Zap size={14} /> {mode.label}</span>
        <small>{mode.badge}</small>
      </div>

      <div className="cc-composer-toolbar">
        <FileUploadButton onUploadFiles={onUploadFiles} disabled={isSubmitting} />
        <button
          className="cc-composer-tool cc-composer-tool--template"
          type="button"
          onClick={onUseTemplate}
          disabled={isSubmitting}
          title="填入示例问题"
          aria-label="填入示例问题"
        >
          <Sparkles size={16} />
        </button>
        {onInterrupt && isSubmitting ? (
          <button className="cc-composer-tool cc-composer-tool--interrupt" type="button" onClick={onInterrupt} title="中断运行" aria-label="中断运行">
            <Square size={16} />
          </button>
        ) : null}

        <span className="cc-composer-spacer" />

        <span className="cc-composer-provider" title={providerLabel}>
          {providerLabel}
        </span>

        <div className="cc-mode-picker">
          <button
            className={`cc-mode-trigger cc-mode-trigger--${composerMode}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
            aria-label={`切换执行方式，当前为${mode.label}`}
            onClick={() => onModeMenuOpenChange(!modeMenuOpen)}
          >
            <span className="cc-mode-trigger__label">{modeShortLabel}</span>
            <ChevronDown size={13} />
          </button>
          {modeMenuOpen ? (
            <m.div className="cc-mode-menu" role="menu" {...buildFadeUpMotion(reducedMotion, 0, 6)}>
              <div className="cc-mode-menu__header">
                <strong>执行方式</strong>
                <small>{providerLabel}</small>
              </div>
              <div className="cc-mode-menu__list">
                {COMPOSER_MODES.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={item.id === composerMode}
                    className={`cc-mode-option${item.id === composerMode ? ' cc-mode-option--active' : ''}`}
                    onClick={() => {
                      onModeChange(item.id)
                      onModeMenuOpenChange(false)
                    }}
                  >
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                    {item.id === composerMode ? <Check className="cc-mode-option__check" size={14} /> : null}
                  </button>
                ))}
              </div>
            </m.div>
          ) : null}
        </div>

        <button
          className="cc-composer-tool cc-composer-tool--send"
          type="submit"
          disabled={!canSubmit}
          title={isSubmitting ? '运行中' : '发送'}
          aria-label={isSubmitting ? '运行中' : '发送'}
        >
          <AppIcon name="send" size={17} />
        </button>
      </div>

      <ComposerDiagnostics
        tokenBudget={tokenBudget}
        activeSkills={activeSkills}
        compactionLevel={compactionLevel}
        runStats={runStats}
        denialCounts={denialCounts}
      />
    </form>
  )
}

function FileUploadButton({
  disabled,
  onUploadFiles,
}: {
  disabled: boolean
  onUploadFiles: (files: File[]) => void
}) {
  return (
    <label className={`cc-composer-tool${disabled ? ' cc-composer-tool--disabled' : ''}`} title="上传文件" aria-label="上传文件">
      <Upload size={16} />
      <input
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) onUploadFiles(files)
          event.currentTarget.value = ''
        }}
      />
    </label>
  )
}

function ComposerDiagnostics({
  tokenBudget,
  activeSkills,
  compactionLevel,
  runStats,
  denialCounts,
}: {
  tokenBudget?: ChatPanelProps['tokenBudget']
  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: ChatPanelProps['runStats']
  denialCounts?: Record<string, number>
}) {
  const denialTotal = Object.values(denialCounts ?? {}).reduce((sum, value) => sum + value, 0)
  if (!tokenBudget && !activeSkills?.length && !compactionLevel && !runStats && !denialTotal) return null

  return (
    <div className="cc-composer-diagnostics" aria-label="运行诊断摘要">
      {tokenBudget ? <span>上下文 {Math.round((tokenBudget.used / tokenBudget.max) * 100)}%</span> : null}
      {activeSkills?.length ? <span>技能 {activeSkills.length}</span> : null}
      {compactionLevel ? <span>压缩 {compactionLevel}</span> : null}
      {runStats ? <span>工具 {runStats.toolSuccesses}/{runStats.toolAttempts}</span> : null}
      {denialTotal ? <span>拒绝 {denialTotal}</span> : null}
    </div>
  )
}
