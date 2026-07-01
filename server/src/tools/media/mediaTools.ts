// +-------------------------------------------------------------------------
//
//   地理智能平台 - Azure Speech 媒体工具
//
//   文件:       mediaTools.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 媒体工具只负责 Agent 可见的薄适配。语音合成、授权和配置边界由
// AzureSpeechService 负责，避免工具 handler 内散落密钥和 SDK 细节。

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDef } from '../../framework/types.js'
import { getEnv } from '../../framework/env.js'
import { AzureSpeechService } from '../../speech/azureSpeechService.js'
import { makeId } from '../../utils/ids.js'
import { TEXT_TO_SPEECH_PROMPT } from './prompt.js'

export const ttsDefinition = {
  name: 'text_to_speech',
  label: '文本转语音',
  description: '将文本合成为语音音频 artifact。',
  prompt: TEXT_TO_SPEECH_PROMPT,
  group: '媒体',
  tags: ['media', 'speech', 'tts'],
  isReadOnly: false,
  isDestructive: false,
  jsonSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, description: '要合成语音的正文。' },
      voice: { type: 'string', description: '可选 Azure Speech 音色名称，例如 zh-CN-XiaoxiaoNeural。' },
    },
    required: ['text'],
  },
} satisfies Omit<ToolDef, 'handler'>

export const ttsTool: ToolDef = {
  ...ttsDefinition,
  async handler(args, ctx) {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) throw new Error('text 参数不能为空')

    const runtimeRoot = ctx.runtimeRoot ?? getEnv().RUNTIME_ROOT
    const artifactId = makeId('artifact')
    const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.mp3`)
    const outputPath = resolveRuntimePath(runtimeRoot, relativePath)
    await mkdir(path.dirname(outputPath), { recursive: true })

    const speech = new AzureSpeechService(getEnv())
    const synthesis = await speech.synthesizeTextToFile({
      text,
      voice: typeof args.voice === 'string' ? args.voice : null,
      outputPath,
    })

    const name = `语音合成-${artifactId}.mp3`
    return {
      message: `语音合成完成：${name}`,
      payload: {
        operation: 'text_to_speech',
        artifactId,
        uri: `/api/v1/results/${artifactId}/file`,
        downloadUrl: `/api/v1/artifacts/${artifactId}/download`,
        mimeType: synthesis.mimeType,
        voice: synthesis.voice,
        textLength: text.length,
      },
      warnings: [],
      valueRefs: [{
        refId: makeId('ref'),
        kind: 'audio_artifact',
        label: name,
        value: { artifactId, uri: `/api/v1/results/${artifactId}/file` },
        metadata: { mimeType: synthesis.mimeType, voice: synthesis.voice },
      }],
      artifacts: [{
        artifactId,
        artifactType: 'audio_mp3',
        name,
        uri: `/api/v1/results/${artifactId}/file`,
        relativePath,
        metadata: {
          relativePath,
          mimeType: synthesis.mimeType,
          voice: synthesis.voice,
          outputFormat: synthesis.outputFormat,
          downloadUrl: `/api/v1/artifacts/${artifactId}/download`,
        },
      }],
      resultId: makeId('result'),
      source: 'azure_speech',
      provenance: { provider: 'azure_speech', operation: 'text_to_speech' },
    }
  },
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('语音 artifact 路径越出 runtime 根目录')
  }
  return target
}
