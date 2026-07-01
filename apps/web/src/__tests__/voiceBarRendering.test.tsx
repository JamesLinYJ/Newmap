// +-------------------------------------------------------------------------
//
//   地理智能平台 - 语音条渲染测试
//
//   文件:       voiceBarRendering.test.tsx
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationEntryView } from '../features/conversation/ConversationEntry'
import type { ConversationEntry } from '../features/conversation/items'

describe('voice bar rendering', () => {
  it('renders Azure text_to_speech audio artifacts as a playable voice bar', () => {
    // Azure Speech 工具返回 audio_mp3 artifact；时间线必须渲染播放条，
    // 不能退化成只有下载说明的普通文本。
    const html = renderToStaticMarkup(
      <ConversationEntryView
        entry={speechEntry}
        entryVariants={{}}
        reducedMotion
        expandedIds={new Set()}
        onToggleExpanded={() => undefined}
        onSelectArtifact={() => undefined}
      />,
    )

    expect(html).toContain('cc-voice-bar')
    expect(html).toContain('语音播报')
    expect(html).toContain('/api/v1/results/artifact_voice/file')
    expect(html).toContain('你好，GeoForge 语音条测试。')
  })
})

const speechEntry: ConversationEntry = {
  id: 'tool:call_voice',
  kind: 'command_batch',
  timestamp: '2026-07-01T00:00:00.000Z',
  title: '文本转语音',
  body: '语音合成完成',
  status: 'completed',
  artifactId: 'artifact_voice',
  commands: [{
    id: 'call_voice',
    title: '文本转语音',
    status: 'completed',
    body: JSON.stringify({
      operation: 'text_to_speech',
      uri: '/api/v1/results/artifact_voice/file',
      voice: 'zh-CN-XiaoxiaoNeural',
    }),
    toolName: 'text_to_speech',
    commandText: JSON.stringify({ text: '你好，GeoForge 语音条测试。' }),
    details: {
      args: { text: '你好，GeoForge 语音条测试。' },
      result: {
        operation: 'text_to_speech',
        uri: '/api/v1/results/artifact_voice/file',
        voice: 'zh-CN-XiaoxiaoNeural',
      },
      artifacts: [{
        artifactId: 'artifact_voice',
        artifactType: 'audio_mp3',
        name: '语音合成-artifact_voice.mp3',
        uri: '/api/v1/results/artifact_voice/file',
        metadata: { mimeType: 'audio/mpeg' },
      }],
    },
  }],
  details: null,
}
