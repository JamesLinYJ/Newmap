// +-------------------------------------------------------------------------
//
//   地理智能平台 - Azure Speech Provider
//
//   文件:       index.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' }
import type { ToolProvider } from '../../framework/types.js'
import { AzureSpeechService } from '../../speech/azureSpeechService.js'
import { ttsTool } from './mediaTools.js'

const provider: ToolProvider = {
  manifest,
  tools: () => [ttsTool],
  async onInstall(ctx) {
    const speech = new AzureSpeechService({
      AZURE_SPEECH_KEY: ctx.config.AZURE_SPEECH_KEY,
      AZURE_SPEECH_REGION: ctx.config.AZURE_SPEECH_REGION ?? 'eastasia',
      AZURE_SPEECH_ENDPOINT: ctx.config.AZURE_SPEECH_ENDPOINT ?? 'https://eastasia.api.cognitive.microsoft.com',
      AZURE_SPEECH_DEFAULT_LANGUAGE: ctx.config.AZURE_SPEECH_DEFAULT_LANGUAGE ?? 'zh-CN',
      AZURE_SPEECH_SUPPORTED_LANGUAGES: ctx.config.AZURE_SPEECH_SUPPORTED_LANGUAGES ?? 'zh-CN,en-US,ja-JP,ko-KR',
      AZURE_SPEECH_DEFAULT_VOICE: ctx.config.AZURE_SPEECH_DEFAULT_VOICE ?? 'zh-CN-XiaoxiaoNeural',
    })
    speech.defaultVoice()
    ctx.log('info', 'Azure Speech 媒体工具已加载')
  },
}

export default provider
