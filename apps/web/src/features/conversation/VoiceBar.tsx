/** 语音条组件 — 初始仅显示按钮，生成后才展示完整播放条 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, Play, Pause, ChevronDown, ChevronUp, Volume2 } from 'lucide-react'
import { apiBaseUrl } from '../../api/client'

interface VoiceBarProps {
  text: string
  messageId: string
  initialAudioUrl?: string | null
}

type VoiceState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export function VoiceBar({ text, initialAudioUrl }: VoiceBarProps) {
  const [state, setState] = useState<VoiceState>(() => initialAudioUrl ? 'ready' : 'idle')
  const [audioUrl, setAudioUrl] = useState<string | null>(() => initialAudioUrl ? `${apiBaseUrl}${initialAudioUrl}` : null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [showText, setShowText] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

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
      setState('playing')
    } catch {
      setState('idle')
    }
  }, [text, audioUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrentTime(audio.currentTime)
    const onEnd = () => { setState('ready'); setCurrentTime(0) }
    const onLoaded = () => setDuration(audio.duration)
    const onPlay = () => setState('playing')
    const onPause = () => setState('paused')
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
    }
  }, [audioUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioUrl || state !== 'playing') {
      return
    }
    void audio.play().catch(() => setState('ready'))
  }, [audioUrl, state])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (state === 'playing') {
      audio.pause()
    } else {
      audio.play()
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

  // 未生成语音时只显示按钮
  if (state === 'idle') {
    return (
      <button
        className="voice-trigger"
        onClick={generateAudio}
        aria-label="生成语音播报"
        title="生成语音播报"
      >
        <Volume2 size={14} />
        <span className="voice-trigger__label">播报</span>
      </button>
    )
  }

  return (
    <div className="voice-bar">
      <div className="voice-bar__row">
        <button
          className="voice-bar__btn"
          onClick={state === 'loading' ? undefined : togglePlay}
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

        <div className="voice-bar__wave" onClick={handleProgressClick}>
          <div className="voice-bar__wave-bars">
            {Array.from({ length: 16 }).map((_, i) => (
              <span
                key={i}
                className={`voice-bar__bar ${state === 'playing' && i < (currentTime / Math.max(duration, 1)) * 16 ? 'voice-bar__bar--active' : ''}`}
                style={{
                  height: state === 'playing' ? `${12 + Math.sin(i * 1.2) * 10}px` : `${8 + Math.sin(i * 1.2) * 6}px`,
                }}
              />
            ))}
          </div>
          <div className="voice-bar__progress" style={{ width: `${pct}%` }} />
        </div>

        <span className="voice-bar__time">{fmtTime(duration > 0 ? (state === 'playing' ? currentTime : duration) : 0)}</span>

        <button
          className="voice-bar__expand"
          onClick={() => setShowText(!showText)}
          aria-label={showText ? '收起文字' : '展开文字'}
        >
          {showText ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {showText && <div className="voice-bar__text">{text}</div>}

      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
    </div>
  )
}
