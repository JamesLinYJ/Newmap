// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入框
//
//   文件:       Composer.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useEffect, useRef, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { Check, ChevronDown, ClipboardList, Sparkles, Square, Upload, Zap } from 'lucide-react'
import { AppIcon } from '../../shared/components/AppIcon'
import { COMPOSER_MODES } from './composerModes'
import type { ChatPanelProps, ComposerMode } from './types'

interface ComposerProps {
  query: string
  providerLabel: string
  isSubmitting: boolean
  composerMode: ComposerMode
  tokenBudget?: ChatPanelProps['tokenBudget']
  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: ChatPanelProps['runStats']
  denialCounts?: Record<string, number>
  composerInputRef: RefObject<HTMLTextAreaElement | null>
  onQueryChange: (value: string) => void
  onSubmit: (event?: FormEvent) => void
  onInterrupt?: () => void
  onUseTemplate: () => void
  onUploadFiles: (files: File[]) => void
  modeMenuOpen: boolean
  onModeMenuOpenChange: (open: boolean) => void
  onComposerModeChange: (mode: ComposerMode) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
}

// Composer 只维护用户正在编辑的输入态和按钮交互。
//
// 提交后是否清空由 AppShell 在 run:start 被接受前处理，避免输入框自行伪造提交成功。
export function Composer({
  query,
  providerLabel,
  isSubmitting,
  composerMode,
  tokenBudget,
  activeSkills,
  compactionLevel,
  runStats,
  denialCounts,
  composerInputRef,
  onQueryChange,
  onSubmit,
  onInterrupt,
  onUseTemplate,
  onUploadFiles,
  modeMenuOpen,
  onModeMenuOpenChange,
  onComposerModeChange,
  onCompositionStart,
  onCompositionEnd,
  onInputKeyDown,
}: ComposerProps) {
  const mode = COMPOSER_MODES.find(item => item.id === composerMode) ?? COMPOSER_MODES[0]
  const modeShortLabel = mode.id === 'auto' ? '自动' : '计划'
  const ModeTriggerIcon = mode.id === 'plan' ? ClipboardList : Zap
  const canSubmit = Boolean(query.trim()) && !isSubmitting
  const modePickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const input = composerInputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`
  }, [composerInputRef, query])

  useEffect(() => {
    if (!modeMenuOpen) return

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!modePickerRef.current?.contains(event.target as Node)) {
        onModeMenuOpenChange(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onModeMenuOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [modeMenuOpen, onModeMenuOpenChange])

  return (
    <form className="cc-composer" onSubmit={onSubmit}>
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

        <div className="cc-mode-picker" ref={modePickerRef}>
          <button
            className={`cc-mode-trigger cc-mode-trigger--${composerMode}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
            aria-label={`切换执行方式，当前为${mode.label}`}
            onClick={() => onModeMenuOpenChange(!modeMenuOpen)}
          >
            <ModeTriggerIcon className="cc-mode-trigger__icon" size={14} />
            <span className="cc-mode-trigger__label">{modeShortLabel}</span>
            <ChevronDown size={13} />
          </button>
          {modeMenuOpen ? (
            <div className="cc-mode-menu" role="menu" aria-label="切换执行方式">
              <div className="cc-mode-menu__head">
                <span>Modes</span>
                <span className="cc-mode-menu__shortcut" aria-hidden="true">
                  <kbd>Shift</kbd>
                  <span>+</span>
                  <kbd>Tab</kbd>
                  <span>切换</span>
                </span>
              </div>
              <div className="cc-mode-list">
                {COMPOSER_MODES.map((item) => {
                  const selected = item.id === composerMode
                  const Icon = item.id === 'plan' ? ClipboardList : Zap
                  return (
                    <button
                      key={item.id}
                      className={`cc-mode-option${selected ? ' cc-mode-option--selected' : ''}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        onComposerModeChange(item.id)
                        onModeMenuOpenChange(false)
                      }}
                    >
                      <span className="cc-mode-option__icon"><Icon size={18} /></span>
                      <span className="cc-mode-option__copy">
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className="cc-mode-option__check" aria-hidden="true">
                        {selected ? <Check size={18} /> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
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
