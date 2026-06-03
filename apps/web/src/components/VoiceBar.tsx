/** 语音条组件 — 钉钉/微信风格，内嵌在消息气泡中 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, Play, Pause, ChevronDown, ChevronUp, Volume2 } from 'lucide-react'
import { apiBaseUrl } from '../api'

interface VoiceBarProps {
  text: string
  messageId: string
  autoGenerate?: boolean
}

type VoiceState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export function VoiceBar({ text, messageId, autoGenerate }: VoiceBarProps) {
  const [state, setState] = useState<VoiceState>(autoGenerate ? 'loading' : 'idle')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [showText, setShowText] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressRef = useRef<HTMLDivElement | null>(null)

  // 懒加载或自动生成音频
  const generateAudio = useCallback(async () => {
    if (audioUrl) return
    setState('loading')
    try {
      const resp = await fetch(`${apiBaseUrl}/api/v1/media/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setAudioUrl(`${apiBaseUrl}${data.audio_url}`)
      setDuration(data.duration_ms || 0)
      setState('ready')
    } catch {
      setState('idle')
    }
  }, [text, audioUrl])

  // 自动生成
  useEffect(() => {
    if (autoGenerate) generateAudio()
  }, [autoGenerate, generateAudio])

  // 音频事件
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrentTime(audio.currentTime)
    const onEnd = () => { setState('ready'); setCurrentTime(0) }
    const onLoaded = () => setDuration(audio.duration)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('loadedmetadata', onLoaded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [audioUrl])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio || !audioUrl) return
    if (state === 'playing') {
      audio.pause()
      setState('paused')
    } else {
      audio.play()
      setState('playing')
    }
  }

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = pct * duration
    setCurrentTime(audio.currentTime)
  }

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="voice-bar">
      <div className="voice-bar__row">
        {/* 播放按钮 */}
        <button
          className="voice-bar__btn"
          onClick={state === 'ready' || state === 'paused' || state === 'playing' ? togglePlay : generateAudio}
          disabled={state === 'loading'}
          aria-label={state === 'playing' ? '暂停' : '播放'}
        >
          {state === 'loading' ? (
            <LoaderCircle size={16} className="voice-bar__spinner" />
          ) : state === 'playing' ? (
            <Pause size={14} />
          ) : (
            <Play size={14} className="ml-px" />
          )}
        </button>

        {/* 波形+进度条 */}
        <div className="voice-bar__wave" ref={progressRef} onClick={handleProgressClick}>
          <div className="voice-bar__wave-bars">
            {Array.from({ length: 16 }).map((_, i) => (
              <span
                key={i}
                className={`voice-bar__bar ${state === 'playing' && i < (currentTime / Math.max(duration, 1)) * 16 ? 'voice-bar__bar--active' : ''}`}
                style={{
                  animationDelay: state === 'playing' ? `${i * 0.07}s` : '0s',
                  height: state === 'playing' ? `${12 + Math.sin(i * 1.2) * 10}px` : `${8 + Math.sin(i * 1.2) * 6}px`,
                }}
              />
            ))}
          </div>
          <div className="voice-bar__progress" style={{ width: `${pct}%` }} />
        </div>

        {/* 时长 */}
        <span className="voice-bar__time">{fmtTime(duration > 0 ? (state === 'playing' ? currentTime : duration) : 0)}</span>

        {/* 展开文字 */}
        <button
          className="voice-bar__expand"
          onClick={() => setShowText(!showText)}
          aria-label={showText ? '收起文字' : '展开文字'}
        >
          {showText ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        <Volume2 size={14} className="voice-bar__icon" />
      </div>

      {/* 文字区域 */}
      {showText && (
        <div className="voice-bar__text">{text}</div>
      )}

      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
    </div>
  )
}
