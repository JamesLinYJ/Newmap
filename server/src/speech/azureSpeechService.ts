// +-------------------------------------------------------------------------
//
//   地理智能平台 - Azure Speech 服务
//
//   文件:       azureSpeechService.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Azure Speech 的订阅 key 只存在服务端。前端通过 WS 取得短期
// authorization token，TTS 也只在服务端 SDK 内完成并写入 runtime artifact。

import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk'
import type { Env } from '../framework/env.js'
import type { SpeechAuthorization, SpeechLanguageOption } from '../schemas/types.js'

const TOKEN_REUSE_MS = 9 * 60 * 1000

interface CachedAuthorization {
  value: SpeechAuthorization
  usableUntilMs: number
}

export class AzureSpeechService {
  private cachedAuthorization: CachedAuthorization | null = null

  constructor(private readonly env: Pick<Env,
    'AZURE_SPEECH_KEY'
    | 'AZURE_SPEECH_REGION'
    | 'AZURE_SPEECH_ENDPOINT'
    | 'AZURE_SPEECH_DEFAULT_LANGUAGE'
    | 'AZURE_SPEECH_SUPPORTED_LANGUAGES'
    | 'AZURE_SPEECH_DEFAULT_VOICE'
  >) {}

  async issueAuthorization(): Promise<SpeechAuthorization> {
    const config = this.requireConfig()
    const now = Date.now()
    if (this.cachedAuthorization && this.cachedAuthorization.usableUntilMs > now) {
      return this.cachedAuthorization.value
    }

    const response = await fetch(`${config.endpoint}/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.key,
        'Content-Length': '0',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Azure Speech 授权失败：HTTP ${response.status}`)
    }

    const authorizationToken = (await response.text()).trim()
    if (!authorizationToken) {
      throw new Error('Azure Speech 授权失败：返回 token 为空')
    }

    const expiresAt = new Date(now + TOKEN_REUSE_MS).toISOString()
    const value = {
      authorizationToken,
      region: config.region,
      endpoint: config.endpoint,
      expiresAt,
      defaultLanguage: config.defaultLanguage,
      supportedLanguages: config.supportedLanguages,
    }
    this.cachedAuthorization = { value, usableUntilMs: now + TOKEN_REUSE_MS }
    return value
  }

  async synthesizeTextToFile(input: {
    text: string
    voice?: string | null
    outputPath: string
  }): Promise<{ voice: string; mimeType: string; outputFormat: string }> {
    const config = this.requireConfig()
    const text = input.text.trim()
    if (!text) throw new Error('语音合成文本不能为空')

    const voice = input.voice?.trim() || config.defaultVoice
    const speechConfig = speechsdk.SpeechConfig.fromSubscription(config.key, config.region)
    speechConfig.speechSynthesisVoiceName = voice
    speechConfig.speechSynthesisOutputFormat = speechsdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3
    const audioConfig = speechsdk.AudioConfig.fromAudioFileOutput(input.outputPath)
    const synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig)

    try {
      await new Promise<void>((resolve, reject) => {
        synthesizer.speakTextAsync(
          text,
          result => {
            if (result.reason === speechsdk.ResultReason.SynthesizingAudioCompleted) {
              closeSynthesisResult(result)
              resolve()
              return
            }
            const detail = result.errorDetails?.trim() || `reason=${result.reason}`
            closeSynthesisResult(result)
            reject(new Error(`Azure Speech 合成失败：${detail}`))
          },
          error => reject(new Error(`Azure Speech 合成失败：${formatSdkError(error)}`)),
        )
      })
    } finally {
      synthesizer.close()
    }

    return {
      voice,
      mimeType: 'audio/mpeg',
      outputFormat: 'Audio24Khz48KBitRateMonoMp3',
    }
  }

  defaultVoice(): string {
    return this.env.AZURE_SPEECH_DEFAULT_VOICE
  }

  private requireConfig() {
    const key = this.env.AZURE_SPEECH_KEY?.trim()
    if (!key) throw new Error('AZURE_SPEECH_KEY 未配置，无法使用 Azure Speech')
    const region = this.env.AZURE_SPEECH_REGION.trim()
    const endpoint = normalizeEndpoint(this.env.AZURE_SPEECH_ENDPOINT, region)
    return {
      key,
      region,
      endpoint,
      defaultLanguage: this.env.AZURE_SPEECH_DEFAULT_LANGUAGE.trim() || 'zh-CN',
      supportedLanguages: parseSupportedLanguages(this.env.AZURE_SPEECH_SUPPORTED_LANGUAGES),
      defaultVoice: this.env.AZURE_SPEECH_DEFAULT_VOICE.trim() || 'zh-CN-XiaoxiaoNeural',
    }
  }
}

function normalizeEndpoint(value: string, region: string): string {
  const endpoint = value.trim() || `https://${region}.api.cognitive.microsoft.com`
  return endpoint.replace(/\/+$/u, '')
}

function parseSupportedLanguages(value: string): SpeechLanguageOption[] {
  const locales = value.split(',').map(item => item.trim()).filter(Boolean)
  const uniqueLocales = Array.from(new Set(locales.length ? locales : ['zh-CN']))
  return uniqueLocales.map(locale => ({ locale, label: languageLabel(locale) }))
}

function languageLabel(locale: string): string {
  const labels: Record<string, string> = {
    'zh-CN': '中文（普通话）',
    'en-US': '英语（美国）',
    'ja-JP': '日语',
    'ko-KR': '韩语',
  }
  return labels[locale] ?? locale
}

function formatSdkError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function closeSynthesisResult(result: speechsdk.SpeechSynthesisResult): void {
  (result as unknown as { close?: () => void }).close?.()
}
