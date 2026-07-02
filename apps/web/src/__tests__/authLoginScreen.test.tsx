// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoForge 登录页渲染测试
//
//   文件:       authLoginScreen.test.tsx
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoginScreen } from '../app/auth/LoginScreen'
import { canSubmitLoginStep } from '../app/auth/loginModel'

const noop = () => undefined

describe('LoginScreen', () => {
  it('renders the email-first Microsoft-style flow without tabs', () => {
    const html = renderToStaticMarkup(<LoginScreen onAuthenticated={noop} />)

    expect(html).toContain('GeoForge')
    expect(html).toContain('<h1 id="geoforge-login-title">登录</h1>')
    expect(html).toContain('placeholder="you@example.com"')
    expect(html).toContain('下一步')
    expect(html).toContain('创建一个')
    expect(html).toContain('登录选项')
    expect(html).not.toContain('role="tablist"')
  })

  it('renders password, signup and options as real states', () => {
    const passwordHtml = renderToStaticMarkup(
      <LoginScreen onAuthenticated={noop} initialStep="password" initialEmail="user@example.com" />,
    )
    const signupHtml = renderToStaticMarkup(<LoginScreen onAuthenticated={noop} initialStep="signup" />)
    const optionsHtml = renderToStaticMarkup(<LoginScreen onAuthenticated={noop} initialStep="options" />)

    expect(passwordHtml).toContain('输入密码')
    expect(passwordHtml).toContain('后退')
    expect(passwordHtml).toContain('disabled=""')
    expect(signupHtml).toContain('创建 GeoForge 账号')
    expect(signupHtml).toContain('你的名称')
    expect(optionsHtml).toContain('邮箱密码登录')
    expect(optionsHtml).toContain('联系平台管理员')
  })

  it('keeps submit buttons disabled until each step has enough input', () => {
    expect(canSubmitLoginStep({ step: 'email', name: '', email: 'bad', password: '' })).toBe(false)
    expect(canSubmitLoginStep({ step: 'email', name: '', email: 'user@example.com', password: '' })).toBe(true)
    expect(canSubmitLoginStep({ step: 'password', name: '', email: 'user@example.com', password: 'short' })).toBe(false)
    expect(canSubmitLoginStep({ step: 'password', name: '', email: 'user@example.com', password: 'long-enough-pass' })).toBe(true)
    expect(canSubmitLoginStep({ step: 'signup', name: '', email: 'user@example.com', password: 'long-enough-pass' })).toBe(false)
    expect(canSubmitLoginStep({ step: 'signup', name: 'James', email: 'user@example.com', password: 'long-enough-pass' })).toBe(true)
  })

  it('normalizes proxy failures before rendering auth errors', () => {
    const html = renderToStaticMarkup(
      <LoginScreen onAuthenticated={noop} errorMessage="Bad Gateway" />,
    )

    expect(html).toContain('GeoForge API 未连接，请启动 Node API 服务。')
    expect(html).not.toContain('Bad Gateway')
  })
})
