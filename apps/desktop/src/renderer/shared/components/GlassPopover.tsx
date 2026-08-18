// +-------------------------------------------------------------------------
//
//   地理智能平台 - Glass 风格弹出框 (Radix Popover)
//
//   文件:       GlassPopover.tsx
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-08-18):
//     作者: JamesLinYJ
//     协助: OpenAI ChatGPT:GPT-5.6 Pro
//     说明: 接入统一浮层语义，移除独立 glass-panel 配方。
// --------------------------------------------------------------------------

import * as Popover from '@radix-ui/react-popover'
import { m, AnimatePresence } from 'framer-motion'
import type { ReactNode } from 'react'

export interface GlassPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function GlassPopover({ open, onOpenChange, trigger, children, align = 'center', side = 'bottom' }: GlassPopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <AnimatePresence>
        {open && (
          <Popover.Portal forceMount>
            <Popover.Content align={align} side={side} sideOffset={8} collisionPadding={12} asChild>
              <m.div
                className="ui-popover-surface popover-content"
                data-ui-surface="glass"
                initial={{ opacity: 0, scale: 0.97, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: -4 }}
                transition={{ duration: 0.12 }}
              >
                {children}
              </m.div>
            </Popover.Content>
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  )
}
