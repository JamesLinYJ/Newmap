// +-------------------------------------------------------------------------
//
//   地理智能平台 - 动效公共参数
//
//   文件:       motion.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { MotionProps, Transition, Variants } from 'framer-motion'

export const motionSpring = {
  gentle: {
    type: 'spring',
    stiffness: 260,
    damping: 30,
    mass: 0.92,
  } satisfies Transition,
  soft: {
    type: 'spring',
    stiffness: 180,
    damping: 28,
    mass: 1,
  } satisfies Transition,
}

// 动效工具只描述 UI 入场和按压反馈，不承载业务状态。
//
// reduced motion 下保留最终布局，取消位移和弹簧，避免玻璃背景出现闪烁感。
export function buildListVariants(
  reducedMotion: boolean,
  staggerChildren = 0.04,
  delayChildren = 0,
): Variants {
  if (reducedMotion) {
    return {
      hidden: {},
      visible: {},
      exit: {},
    }
  }

  return {
    hidden: {},
    visible: {
      transition: {
        staggerChildren,
        delayChildren,
      },
    },
    exit: {},
  }
}

export function buildListItemVariants(reducedMotion: boolean, y = 12): Variants {
  if (reducedMotion) {
    return {
      hidden: { opacity: 1 },
      visible: { opacity: 1 },
      exit: { opacity: 1 },
    }
  }

  return {
    hidden: { opacity: 0, y },
    visible: {
      opacity: 1,
      y: 0,
      transition: motionSpring.gentle,
    },
    exit: {
      opacity: 0,
      y: Math.max(4, Math.round(y / 2)),
      transition: { duration: 0.16, ease: 'easeOut' },
    },
  }
}

export function buildFadeUpMotion(
  reducedMotion: boolean,
  delay = 0,
  y = 12,
): MotionProps {
  if (reducedMotion) {
    return {
      initial: false,
      animate: { opacity: 1 },
    }
  }

  return {
    initial: { opacity: 0, y },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: Math.max(4, Math.round(y / 2)) },
    transition: { ...motionSpring.gentle, delay },
  }
}

export function buildFadeMotion(reducedMotion: boolean, delay = 0): MotionProps {
  if (reducedMotion) {
    return {
      initial: false,
      animate: { opacity: 1 },
    }
  }

  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.2, ease: 'easeOut', delay },
  }
}

export function buildPressMotion(reducedMotion: boolean): MotionProps {
  if (reducedMotion) return {}
  return {
    whileTap: { scale: 0.975 },
    transition: { duration: 0.12, ease: 'easeOut' },
  }
}
