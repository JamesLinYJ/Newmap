// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoForge 分步登录页
//
//   文件:       LoginScreen.tsx
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useState, type FormEvent } from 'react'
import { KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { normalizeApiErrorMessage } from '../../api/errors'
import { signInWithEmail, signUpWithEmail } from '../../api/authClient'
import { canSubmitLoginStep, isValidEmail, type LoginFormState, type LoginStep } from './loginModel'

export interface LoginScreenProps {
  errorMessage?: string
  onAuthenticated: () => void
  initialStep?: LoginStep
  initialEmail?: string
  signIn?: typeof signInWithEmail
  signUp?: typeof signUpWithEmail
}

export function LoginScreen({
  errorMessage,
  onAuthenticated,
  initialStep = 'email',
  initialEmail = '',
  signIn = signInWithEmail,
  signUp = signUpWithEmail,
}: LoginScreenProps) {
  const [step, setStep] = useState<LoginStep>(initialStep)
  const [name, setName] = useState('')
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const state: LoginFormState = { step, name, email, password }
  const visibleError = localError ?? (errorMessage ? normalizeApiErrorMessage(errorMessage, errorMessage) : undefined)
  const emailReady = isValidEmail(email)
  const canSubmit = canSubmitLoginStep(state) && !isSubmitting

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLocalError(undefined)

    if (step === 'email') {
      if (!emailReady) {
        setLocalError('请输入有效的邮箱地址。')
        return
      }
      setPassword('')
      setStep('password')
      return
    }

    if (!canSubmitLoginStep(state)) {
      setLocalError(step === 'signup' ? '请填写名称、邮箱和至少 12 位密码。' : '请输入至少 12 位密码。')
      return
    }

    setIsSubmitting(true)
    try {
      if (step === 'signup') {
        await signUp({ name: name.trim(), email: email.trim(), password })
      } else if (step === 'password') {
        await signIn(email.trim(), password)
      }
      onAuthenticated()
    } catch (error) {
      setLocalError(normalizeApiErrorMessage(error, '认证请求失败。'))
    } finally {
      setIsSubmitting(false)
    }
  }

  function goEmail() {
    setLocalError(undefined)
    setPassword('')
    setStep('email')
  }

  function goSignup() {
    setLocalError(undefined)
    setStep('signup')
  }

  function goOptions() {
    setLocalError(undefined)
    setStep('options')
  }

  return (
    <main className="digital-cartographer dc-auth-screen">
      <div className="dc-auth-layout" aria-label="GeoForge 登录">
        <section className="dc-auth-panel" aria-labelledby="geoforge-login-title">
          <div className="dc-auth-brand">
            <span className="dc-auth-brand__mark" aria-hidden="true">G</span>
            <span>GeoForge</span>
          </div>

          <div className="dc-auth-step">
            <span className="dc-auth-step__eyebrow">
              {step === 'options' ? '登录选项' : step === 'signup' ? '创建账户' : '安全登录'}
            </span>
            <h1 id="geoforge-login-title">{stepTitle(step)}</h1>
            <p>{stepDescription(step)}</p>
          </div>

          {visibleError ? <p className="dc-auth-card__error" role="alert">{visibleError}</p> : null}

          {step === 'options' ? (
            <div className="dc-auth-options" aria-label="登录选项列表">
              <button type="button" onClick={goEmail}>
                <Mail size={20} aria-hidden="true" />
                <span><strong>邮箱密码登录</strong><small>使用 GeoForge 账号继续访问工作台。</small></span>
              </button>
              <button type="button" onClick={goSignup}>
                <ShieldCheck size={20} aria-hidden="true" />
                <span><strong>创建 GeoForge 账号</strong><small>注册后会自动创建个人工作区。</small></span>
              </button>
              <div className="dc-auth-options__note">
                <KeyRound size={18} aria-hidden="true" />
                <span>如果账号被禁用或缺少权限，请联系平台管理员处理。</span>
              </div>
            </div>
          ) : (
            <form className="dc-auth-card__form" onSubmit={event => void handleSubmit(event)}>
              {step === 'signup' ? (
                <label className="dc-auth-field">
                  <span>名称</span>
                  <input
                    value={name}
                    onChange={event => setName(event.target.value)}
                    autoComplete="name"
                    placeholder="你的名称"
                    required
                  />
                </label>
              ) : null}

              <label className="dc-auth-field">
                <span>邮箱</span>
                <input
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  readOnly={step === 'password'}
                  required
                />
              </label>

              {step === 'password' || step === 'signup' ? (
                <label className="dc-auth-field">
                  <span>密码</span>
                  <input
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    autoComplete={step === 'signup' ? 'new-password' : 'current-password'}
                    minLength={12}
                    type="password"
                    placeholder="至少 12 位"
                    required
                  />
                </label>
              ) : null}

              {step === 'email' ? (
                <p className="dc-auth-help">没有账户？<button type="button" onClick={goSignup}>创建一个</button></p>
              ) : null}

              <div className="dc-auth-actions">
                {step !== 'email' ? <button type="button" className="dc-auth-button dc-auth-button--ghost" onClick={goEmail}>后退</button> : null}
                <button type="submit" className="dc-auth-button dc-auth-button--primary" disabled={!canSubmit}>
                  {isSubmitting ? '处理中...' : step === 'email' ? '下一步' : step === 'signup' ? '创建账号' : '登录'}
                </button>
              </div>
            </form>
          )}
        </section>

        <button type="button" className="dc-auth-options-bar" onClick={step === 'options' ? goEmail : goOptions}>
          <KeyRound size={24} aria-hidden="true" />
          <span>{step === 'options' ? '返回邮箱登录' : '登录选项'}</span>
        </button>
      </div>
    </main>
  )
}

function stepTitle(step: LoginStep): string {
  if (step === 'password') return '输入密码'
  if (step === 'signup') return '创建 GeoForge 账号'
  if (step === 'options') return '选择登录方式'
  return '登录'
}

function stepDescription(step: LoginStep): string {
  if (step === 'password') return '确认密码后进入你的气象分析与地图工作区。'
  if (step === 'signup') return '使用邮箱创建账号，系统会为你准备个人工作区。'
  if (step === 'options') return '当前版本支持邮箱密码登录和公开注册。'
  return '使用 GeoForge 账号继续访问气象分析、地图浏览和安全管理功能。'
}
