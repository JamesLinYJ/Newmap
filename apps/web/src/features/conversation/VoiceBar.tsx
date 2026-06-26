// +-------------------------------------------------------------------------
//
//   地理智能平台 - 语音结果播放条
//
//   文件:       VoiceBar.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

interface VoiceBarProps {
  text: string
  messageId: string
  initialAudioUrl?: string | null
}

// 语音工具的可见结果仍是普通工具输出；这里仅在有 artifact URL 时提供播放控件。
export function VoiceBar({ text, messageId, initialAudioUrl }: VoiceBarProps) {
  return (
    <div className="cc-voice-bar" data-message-id={messageId}>
      <div className="cc-voice-bar__copy">
        <strong>语音播报</strong>
        <span>{text || '语音文本为空'}</span>
      </div>
      {initialAudioUrl ? (
        <audio controls preload="none" src={initialAudioUrl} />
      ) : (
        <span className="cc-voice-bar__empty">暂无音频文件</span>
      )}
    </div>
  )
}
