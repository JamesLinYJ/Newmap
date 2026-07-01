// +-------------------------------------------------------------------------
//
//   地理智能平台 - 语音输入状态
//
//   文件:       useSpeechRecognition.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 前端只持有短期 Azure Speech authorization token。订阅 key 留在服务端，
// 识别结果只进入用户可见输入框，不自动提交消息。

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { SpeechLanguageOption } from '@geo-agent-platform/shared-types'
import { getSpeechAuthorization } from '../../api/client'

const MAX_RECOGNITION_MS = 8 * 60 * 1000

export type SpeechRecognitionStatus = 'idle' | 'authorizing' | 'recognizing' | 'stopping' | 'error'

interface UseSpeechRecognitionOptions {
  query: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  onQueryChange: (value: string) => void
}

export function useSpeechRecognition({
  query,
  inputRef,
  onQueryChange,
}: UseSpeechRecognitionOptions) {
  const [status, setStatus] = useState<SpeechRecognitionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [interimText, setInterimText] = useState('')
  const [language, setLanguage] = useState('zh-CN')
  const [languages, setLanguages] = useState<SpeechLanguageOption[]>([
    { locale: 'zh-CN', label: '中文（普通话）' },
  ])
  const recognizerRef = useRef<any | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const queryRef = useRef(query)
  const languageRef = useRef(language)
  const operationRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    queryRef.current = query
  }, [query])

  useEffect(() => {
    languageRef.current = language
  }, [language])

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const closeRecognizer = useCallback((recognizer: any | null) => {
    clearTimer()
    if (recognizerRef.current === recognizer) {
      recognizerRef.current = null
    }
    recognizer?.close?.()
  }, [clearTimer])

  const stopRecognition = useCallback(() => {
    operationRef.current += 1
    const recognizer = recognizerRef.current
    if (!recognizer) {
      clearTimer()
      setInterimText('')
      setStatus('idle')
      return
    }

    setStatus('stopping')
    clearTimer()
    recognizer.stopContinuousRecognitionAsync(
      () => {
        closeRecognizer(recognizer)
        if (mountedRef.current) {
          setInterimText('')
          setStatus('idle')
        }
      },
      (sdkError: unknown) => {
        closeRecognizer(recognizer)
        if (mountedRef.current) {
          setInterimText('')
          setError(`停止语音识别失败：${formatSpeechError(sdkError)}`)
          setStatus('error')
        }
      },
    )
  }, [clearTimer, closeRecognizer])

  const insertTranscript = useCallback((transcript: string) => {
    const text = transcript.trim()
    if (!text) return

    const input = inputRef.current
    const current = queryRef.current
    const start = input?.selectionStart ?? current.length
    const end = input?.selectionEnd ?? current.length
    const next = insertAtSelection(current, start, end, text)
    onQueryChange(next)

    requestAnimationFrame(() => {
      if (!inputRef.current) return
      const caret = caretAfterInsert(current, start, end, text)
      inputRef.current.focus()
      inputRef.current.setSelectionRange(caret, caret)
    })
  }, [inputRef, onQueryChange])

  const startRecognition = useCallback(async () => {
    if (recognizerRef.current || status === 'authorizing' || status === 'recognizing') return
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持麦克风语音识别。')
      setStatus('error')
      return
    }

    setStatus('authorizing')
    setError(null)
    setInterimText('')
    const operationId = operationRef.current + 1
    operationRef.current = operationId

    try {
      const authorization = await getSpeechAuthorization()
      if (operationRef.current !== operationId || !mountedRef.current) {
        return
      }
      const nextLanguages = authorization.supportedLanguages.length
        ? authorization.supportedLanguages
        : [{ locale: authorization.defaultLanguage, label: authorization.defaultLanguage }]
      setLanguages(nextLanguages)
      if (!nextLanguages.some(item => item.locale === languageRef.current)) {
        setLanguage(authorization.defaultLanguage)
        languageRef.current = authorization.defaultLanguage
      }

      const speechsdk = await import('microsoft-cognitiveservices-speech-sdk')
      if (operationRef.current !== operationId || !mountedRef.current) {
        return
      }
      const speechConfig = speechsdk.SpeechConfig.fromAuthorizationToken(
        authorization.authorizationToken,
        authorization.region,
      )
      speechConfig.speechRecognitionLanguage = languageRef.current || authorization.defaultLanguage
      const audioConfig = speechsdk.AudioConfig.fromDefaultMicrophoneInput()
      const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig)
      recognizerRef.current = recognizer

      recognizer.recognizing = (_sender: unknown, event: any) => {
        const text = event.result?.text?.trim()
        if (mountedRef.current) setInterimText(text ?? '')
      }
      recognizer.recognized = (_sender: unknown, event: any) => {
        if (event.result?.reason === speechsdk.ResultReason.RecognizedSpeech) {
          insertTranscript(event.result.text ?? '')
        }
        if (mountedRef.current) setInterimText('')
      }
      recognizer.canceled = (_sender: unknown, event: any) => {
        closeRecognizer(recognizer)
        if (mountedRef.current) {
          setInterimText('')
          setError(`语音识别已取消：${event.errorDetails || event.reason || '未知原因'}`)
          setStatus('error')
        }
      }
      recognizer.sessionStopped = () => {
        closeRecognizer(recognizer)
        if (mountedRef.current) {
          setInterimText('')
          setStatus('idle')
        }
      }

      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, reject)
      })
      if (mountedRef.current && operationRef.current === operationId && recognizerRef.current === recognizer) {
        setStatus('recognizing')
        timeoutRef.current = window.setTimeout(() => {
          setError('单次语音识别已达到 8 分钟上限，请重新开始。')
          stopRecognition()
        }, MAX_RECOGNITION_MS)
      } else {
        closeRecognizer(recognizer)
      }
    } catch (speechError) {
      closeRecognizer(recognizerRef.current)
      if (mountedRef.current) {
        setInterimText('')
        setError(`启动语音识别失败：${formatSpeechError(speechError)}`)
        setStatus('error')
      }
    }
  }, [closeRecognizer, insertTranscript, stopRecognition, status])

  useEffect(() => () => {
    mountedRef.current = false
    const recognizer = recognizerRef.current
    recognizerRef.current = null
    clearTimer()
    recognizer?.close?.()
  }, [clearTimer])

  return {
    status,
    error,
    interimText,
    language,
    languages,
    isRecognizing: status === 'recognizing' || status === 'authorizing',
    setLanguage,
    startRecognition,
    stopRecognition,
    clearSpeechError: () => setError(null),
  }
}

function insertAtSelection(current: string, start: number, end: number, text: string): string {
  const prefix = current.slice(0, start)
  const suffix = current.slice(end)
  const leading = prefix && !/[\s\n]$/u.test(prefix) ? ' ' : ''
  const trailing = suffix && !/^[\s\n，。！？,.!?]/u.test(suffix) ? ' ' : ''
  return `${prefix}${leading}${text}${trailing}${suffix}`
}

function caretAfterInsert(current: string, start: number, end: number, text: string): number {
  const prefix = current.slice(0, start)
  const suffix = current.slice(end)
  const leading = prefix && !/[\s\n]$/u.test(prefix) ? 1 : 0
  const trailing = suffix && !/^[\s\n，。！？,.!?]/u.test(suffix) ? 1 : 0
  return start + leading + text.trim().length + trailing
}

function formatSpeechError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
