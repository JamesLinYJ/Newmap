// +-------------------------------------------------------------------------
//
//   地理智能平台 - Glass 风格对话框 (Radix Dialog)
//
//   文件:       GlassDialog.tsx
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-08-18):
//     作者: JamesLinYJ
//     协助: OpenAI ChatGPT:GPT-5.6 Pro
//     说明: 接入统一浮层语义，避免弹窗继续维护独立玻璃配方。
// --------------------------------------------------------------------------

import * as Dialog from '@radix-ui/react-dialog'
import { AnimatePresence, m } from 'framer-motion'
import type { ReactNode } from 'react'

export interface GlassDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  children: ReactNode
  /** 点击遮罩是否关闭，默认 true */
  modal?: boolean
}

export function GlassDialog({ open, onOpenChange, title, description, children, modal = true }: GlassDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <m.div
                className="ui-dialog-overlay alert-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <m.div
                className="ui-dialog-surface alert"
                data-ui-surface="glass"
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: 'spring', stiffness: 360, damping: 36 }}
              >
                {title && (
                  <Dialog.Title asChild>
                    <h2 className="ui-dialog-title">{title}</h2>
                  </Dialog.Title>
                )}
                {description && (
                  <Dialog.Description asChild>
                    <p className="ui-dialog-description">{description}</p>
                  </Dialog.Description>
                )}
                {children}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

export function GlassDialogActions({ children }: { children: ReactNode }) {
  return <div className="ui-dialog-actions alert-actions">{children}</div>
}

export { Dialog }
