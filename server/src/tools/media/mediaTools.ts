// 媒体工具 → Python sidecar HTTP 代理
import type { ToolDef } from '../../tools.js'
import { makeId } from '../../utils/ids.js'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8012'

export const ttsTool: ToolDef = {
  name: 'text_to_speech', label: '文本转语音',
  description: '将文本合成为语音音频文件。',
  group: '媒体', toolKind: 'registry', tags: ['media', 'tts'],
  isReadOnly: true, isDestructive: false, isConcurrencySafe: true,

  jsonSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要合成的文本' },
      voice: { type: 'string', description: '音色 ID' },
    },
    required: ['text'],
  },

  async handler(args, _runtime) {
    const text = args.text as string
    const res = await fetch(`${WORKER_URL}/media/tts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: args.voice }), signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`TTS error: ${res.status}`)
    const result = await res.json() as Record<string, unknown>
    return {
      message: `语音合成完成`,
      payload: result, warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'media_worker',
    }
  },
}

export const digitalHumanTool: ToolDef = {
  name: 'generate_digital_human', label: '生成数字人视频',
  description: '用音频驱动数字形象生成说话视频。',
  group: '媒体', toolKind: 'registry', tags: ['media', 'avatar'],
  isReadOnly: false, isDestructive: true, isConcurrencySafe: false,

  jsonSchema: {
    type: 'object',
    properties: {
      audioPath: { type: 'string', description: '音频文件路径' },
      avatarPath: { type: 'string', description: '形象文件路径（可选）' },
    },
    required: ['audioPath'],
  },

  async handler(args, _runtime) {
    const res = await fetch(`${WORKER_URL}/media/avatar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) throw new Error(`Avatar error: ${res.status}`)
    const result = await res.json() as Record<string, unknown>
    return {
      message: `数字人视频已生成`,
      payload: result, warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'media_worker',
    }
  },
}
