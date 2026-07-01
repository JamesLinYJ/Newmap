// +-------------------------------------------------------------------------
//
//   地理智能平台 - Azure Speech 服务测试
//
//   文件:       azureSpeechService.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

const sdkMock = vi.hoisted(() => ({
  fromSubscription: vi.fn(),
  fromAudioFileOutput: vi.fn(),
  synthesizer: vi.fn(),
  speakTextAsync: vi.fn(),
  closeSynthesizer: vi.fn(),
  closeResult: vi.fn(),
}))

vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: {
    fromSubscription: sdkMock.fromSubscription.mockImplementation(() => ({
      speechSynthesisVoiceName: '',
      speechSynthesisOutputFormat: null,
    })),
  },
  AudioConfig: {
    fromAudioFileOutput: sdkMock.fromAudioFileOutput.mockImplementation((outputPath: string) => ({ outputPath })),
  },
  SpeechSynthesizer: sdkMock.synthesizer.mockImplementation(function SpeechSynthesizerMock() {
    return {
      speakTextAsync: (text: string, success: (result: { reason: number; close: () => void }) => void) => {
        sdkMock.speakTextAsync(text)
        success({ reason: 8, close: sdkMock.closeResult })
      },
      close: sdkMock.closeSynthesizer,
    }
  }),
  SpeechSynthesisOutputFormat: {
    Audio24Khz48KBitRateMonoMp3: 6,
  },
  ResultReason: {
    SynthesizingAudioCompleted: 8,
  },
}))

import { AzureSpeechService } from './azureSpeechService.js'

describe('AzureSpeechService', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('issues short-lived authorization without exposing the subscription key', async () => {
    const fetchMock = vi.fn(async () => new Response('short_lived_token', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new AzureSpeechService(env())

    const first = await service.issueAuthorization()
    const second = await service.issueAuthorization()

    expect(first.authorizationToken).toBe('short_lived_token')
    expect(JSON.stringify(first)).not.toContain('secret_key')
    expect(first.supportedLanguages.map(item => item.locale)).toEqual(['zh-CN', 'en-US'])
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://eastasia.api.cognitive.microsoft.com/sts/v1.0/issueToken',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'secret_key' }),
      }),
    )
  })

  it('fails authorization explicitly when speech configuration is missing', async () => {
    const service = new AzureSpeechService({ ...env(), AZURE_SPEECH_KEY: undefined })
    await expect(service.issueAuthorization()).rejects.toThrow('AZURE_SPEECH_KEY 未配置')
  })

  it('fails authorization explicitly when Azure rejects the token request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })))
    const service = new AzureSpeechService(env())
    await expect(service.issueAuthorization()).rejects.toThrow('Azure Speech 授权失败：HTTP 401')
  })

  it('synthesizes text through the Azure Speech SDK instead of returning a fake artifact', async () => {
    const service = new AzureSpeechService(env())
    const result = await service.synthesizeTextToFile({
      text: '你好，欢迎使用 GeoForge。',
      outputPath: 'C:/runtime/artifacts/run_1/audio.mp3',
    })

    expect(sdkMock.fromSubscription).toHaveBeenCalledWith('secret_key', 'eastasia')
    expect(sdkMock.fromAudioFileOutput).toHaveBeenCalledWith('C:/runtime/artifacts/run_1/audio.mp3')
    expect(sdkMock.speakTextAsync).toHaveBeenCalledWith('你好，欢迎使用 GeoForge。')
    expect(sdkMock.closeResult).toHaveBeenCalled()
    expect(sdkMock.closeSynthesizer).toHaveBeenCalled()
    expect(result).toMatchObject({
      voice: 'zh-CN-XiaoxiaoNeural',
      mimeType: 'audio/mpeg',
      outputFormat: 'Audio24Khz48KBitRateMonoMp3',
    })
  })
})

function env() {
  return {
    AZURE_SPEECH_KEY: 'secret_key',
    AZURE_SPEECH_REGION: 'eastasia',
    AZURE_SPEECH_ENDPOINT: 'https://eastasia.api.cognitive.microsoft.com/',
    AZURE_SPEECH_DEFAULT_LANGUAGE: 'zh-CN',
    AZURE_SPEECH_SUPPORTED_LANGUAGES: 'zh-CN,en-US',
    AZURE_SPEECH_DEFAULT_VOICE: 'zh-CN-XiaoxiaoNeural',
  }
}
