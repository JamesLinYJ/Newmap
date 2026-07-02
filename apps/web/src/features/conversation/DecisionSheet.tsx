// +-------------------------------------------------------------------------
//
//   地理智能平台 - 用户决策底部浮层
//
//   文件:       DecisionSheet.tsx
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// DecisionSheet 是计划入口、澄清和审批的统一交互面。
// 组件只维护当前选择编辑态；决策事实来自后端 DecisionRequest 或本地执行模式选择。

import { useEffect, useMemo, useState } from 'react'
import { m } from 'framer-motion'
import { Check, X } from 'lucide-react'
import type { DecisionRequest } from '@geo-agent-platform/shared-types'
import { buildFadeUpMotion } from '../../shared/motion'

interface DecisionSheetProps {
  decision: DecisionRequest
  busy: boolean
  reducedMotion: boolean
  onSubmit: (decisionId: string, optionId?: string | null, text?: string | null) => void
  onClose: () => void
}

export function DecisionSheet({
  decision,
  busy,
  reducedMotion,
  onSubmit,
  onClose,
}: DecisionSheetProps) {
  const freeTextId = `${decision.decisionId}:free_text`
  const defaultOptionId = useMemo(
    () => typeof decision.payload.defaultOptionId === 'string'
      ? decision.payload.defaultOptionId
      : decision.options.find(option => option.optionId)?.optionId ?? (decision.allowFreeText ? freeTextId : null),
    [decision.allowFreeText, decision.options, decision.payload.defaultOptionId, freeTextId],
  )
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(defaultOptionId)
  const [freeText, setFreeText] = useState('')

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const isFreeText = selectedOptionId === freeTextId
  const canSubmit = !busy && (isFreeText ? Boolean(freeText.trim()) : Boolean(selectedOptionId))
  const submitLabel = decision.kind === 'execution_mode'
    ? '应用选择'
    : decision.kind === 'approval'
      ? '提交审批'
      : '提交回答'

  return (
    <m.div
      className="cc-decision-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${decision.decisionId}-title`}
      {...buildFadeUpMotion(reducedMotion, 0, 18)}
    >
      <div className="cc-decision-sheet__head">
        <div>
          <strong id={`${decision.decisionId}-title`}>{decision.title}</strong>
          {decision.description ? <span>{decision.description}</span> : null}
        </div>
        <button className="cc-decision-sheet__close" type="button" onClick={onClose} aria-label="关闭决策面板">
          <X size={18} />
        </button>
      </div>

      <div className="cc-decision-sheet__question">{decision.question}</div>

      <div className="cc-decision-sheet__options" role="radiogroup" aria-label={decision.question}>
        {decision.options.map((option, index) => {
          const optionId = option.optionId ?? `option_${index + 1}`
          const checked = selectedOptionId === optionId
          return (
            <button
              key={optionId}
              className={`cc-decision-option${checked ? ' cc-decision-option--selected' : ''}`}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={busy}
              onClick={() => setSelectedOptionId(optionId)}
            >
              <span className="cc-decision-option__radio">
                {checked ? <Check size={13} /> : null}
              </span>
              <span className="cc-decision-option__copy">
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
            </button>
          )
        })}

        {decision.allowFreeText ? (
          <button
            className={`cc-decision-option${isFreeText ? ' cc-decision-option--selected' : ''}`}
            type="button"
            role="radio"
            aria-checked={isFreeText}
            disabled={busy}
            onClick={() => setSelectedOptionId(freeTextId)}
          >
            <span className="cc-decision-option__radio">
              {isFreeText ? <Check size={13} /> : null}
            </span>
            <span className="cc-decision-option__copy">
              <strong>其他补充</strong>
              <small>输入你想补充的具体要求。</small>
            </span>
          </button>
        ) : null}
      </div>

      {isFreeText ? (
        <textarea
          className="cc-decision-sheet__text"
          value={freeText}
          rows={3}
          disabled={busy}
          placeholder="输入补充说明..."
          onChange={(event) => setFreeText(event.target.value)}
        />
      ) : null}

      <div className="cc-decision-sheet__actions">
        <button className="cc-decision-submit" type="button" disabled={!canSubmit} onClick={() => {
          if (isFreeText) onSubmit(decision.decisionId, null, freeText.trim())
          else onSubmit(decision.decisionId, selectedOptionId, null)
        }}>
          {submitLabel}
        </button>
        <span>Esc 关闭</span>
      </div>
    </m.div>
  )
}
