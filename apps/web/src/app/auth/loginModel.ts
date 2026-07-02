// +-------------------------------------------------------------------------
//
//   地理智能平台 - 登录流程模型
//
//   文件:       loginModel.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export type LoginStep = 'email' | 'password' | 'signup' | 'options'

export interface LoginFormState {
  step: LoginStep
  name: string
  email: string
  password: string
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim())
}

export function canSubmitLoginStep(state: LoginFormState): boolean {
  if (state.step === 'email') return isValidEmail(state.email)
  if (state.step === 'password') return isValidEmail(state.email) && state.password.length >= 12
  if (state.step === 'signup') return Boolean(state.name.trim()) && isValidEmail(state.email) && state.password.length >= 12
  return false
}
