// +-------------------------------------------------------------------------
//
//   地理智能平台 - 顶部导航栏组件
//
//   文件:       TopBar.tsx
//
//   日期:       2026年05月09日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 提供浅色 Workbench 顶部控制条。它只承接全局导航入口和运行状态，
// 不再承担旧主导航的信息架构，避免与三栏工作台骨架互相挤压。

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Database, LogOut, Menu, PanelLeft, PanelRight, Search, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import type { AuthMe } from '@geo-agent-platform/shared-types'
import type { PrimaryNav } from '../types'

interface TopBarProps {
  activeNav: PrimaryNav
  artifactCount: number; providerLabel: string; runStatusLabel: string
  authMe: AuthMe
  onNavChange: (nav: PrimaryNav) => void
  onLogout: () => Promise<void> | void
  onPrimaryAction: () => void; primaryActionLabel: string
}

const QUICK_NAV: ReadonlyArray<{ id: PrimaryNav; label: string }> = [
  { id: 'analysis', label: '分析' },
  { id: 'layers', label: '图层' },
  { id: 'tools', label: '工具' },
]

export function TopBar({
  activeNav,
  artifactCount,
  providerLabel,
  runStatusLabel,
  authMe,
  onNavChange,
  onLogout,
  onPrimaryAction,
  primaryActionLabel,
}: TopBarProps) {
  const [accountOpen, setAccountOpen] = useState(false)
  const canOpenSecurity = authMe.platformRoles.includes('platform_admin')
    || authMe.memberships.some(item => item.role === 'workspace_admin')
  const displayName = authMe.user.displayName || authMe.user.email
  const roleLabel = formatRoleLabel(authMe.platformRoles[0] ?? authMe.memberships[0]?.role)
  const workspaceLabel = authMe.defaultWorkspace?.name
    ?? shortWorkspaceId(authMe.defaultWorkspace?.workspaceId ?? authMe.memberships[0]?.workspaceId)

  return (
    <header className="workbench-chrome">
      <div className="workbench-chrome__left" aria-label="工作台控制">
        <span className="workbench-chrome__icon workbench-chrome__icon--passive" aria-hidden="true">
          <Menu size={18} />
        </span>
        <span className="workbench-chrome__icon workbench-chrome__icon--passive" aria-hidden="true">
          <PanelLeft size={17} />
        </span>
        <span className="workbench-chrome__icon workbench-chrome__icon--passive" aria-hidden="true">
          <Search size={17} />
        </span>
        <span className="workbench-chrome__divider" />
        <button className="workbench-chrome__icon" type="button" aria-label="返回" onClick={() => window.history.back()}>
          <ArrowLeft size={17} />
        </button>
        <button className="workbench-chrome__icon" type="button" aria-label="前进" onClick={() => window.history.forward()}>
          <ArrowRight size={17} />
        </button>
      </div>

      <nav className="workbench-chrome__center" aria-label="快速导航">
        {QUICK_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={activeNav === item.id ? 'workbench-chrome__nav workbench-chrome__nav--active' : 'workbench-chrome__nav'}
            onClick={() => onNavChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="workbench-chrome__right">
        <span className="workbench-chrome__icon workbench-chrome__icon--passive workbench-chrome__panel" aria-hidden="true">
          <PanelRight size={17} />
        </span>
        <span className="workbench-chrome__status">
          <Sparkles size={11}/>{runStatusLabel}
        </span>
        <span className="workbench-chrome__status workbench-chrome__status--wide">
          <Zap size={11}/>{providerLabel}
        </span>
        <span className="workbench-chrome__status">
          <Database size={11}/>{artifactCount}
        </span>
        <button className="workbench-chrome__primary" type="button" onClick={onPrimaryAction}>{primaryActionLabel}</button>
        <div className="workbench-account">
          <button
            className="workbench-account__button"
            type="button"
            aria-label={`账号菜单：${displayName}`}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen(open => !open)}
          >
            <span className="workbench-account__avatar" aria-hidden="true">{accountInitial(displayName)}</span>
            <span className="workbench-account__copy">
              <strong>{displayName}</strong>
              <small>{roleLabel}</small>
            </span>
          </button>
          {accountOpen ? (
            <div className="workbench-account__menu" role="menu">
              <div className="workbench-account__identity">
                <strong>{displayName}</strong>
                <span>{authMe.user.email}</span>
                <small>{workspaceLabel || '未绑定工作区'}</small>
              </div>
              {canOpenSecurity ? (
                <Link className="workbench-account__item" to="/security" role="menuitem" onClick={() => setAccountOpen(false)}>
                  <ShieldCheck size={15} aria-hidden="true" />
                  <span>安全管理</span>
                </Link>
              ) : null}
              <button
                className="workbench-account__item workbench-account__item--danger"
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false)
                  void onLogout()
                }}
              >
                <LogOut size={15} aria-hidden="true" />
                <span>退出登录</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}

function accountInitial(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || 'G'
}

function shortWorkspaceId(value?: string | null): string {
  if (!value) return ''
  return value.length > 14 ? `${value.slice(0, 10)}…` : value
}

function formatRoleLabel(role?: string): string {
  if (role === 'platform_admin') return '平台管理员'
  if (role === 'workspace_admin') return '工作区管理员'
  if (role === 'analyst') return '分析员'
  if (role === 'viewer') return '只读用户'
  return '已登录'
}
