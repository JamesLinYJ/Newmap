// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端动效令牌
//
//   文件:       motion.ts
//
//   日期:       2026年04月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 集中定义主工作台与调试页共享的 iOS 风格动效节奏。
// 这里只放运行时可复用的 motion token 和基础动画构造器，
// 避免组件各自散落写一套 easing、duration 和 spring 参数。

import type { TargetAndTransition, Transition, Variants } from 'framer-motion'

export const motionDuration = {
  fast: 0.18,
  base: 0.26,
  slow: 0.34,
} as const

export const motionEase = {
  iosIn: [0.32, 0, 0.67, 0] as const,
  iosOut: [0.22, 1, 0.36, 1] as const,
  iosInOut: [0.32, 0.72, 0, 1] as const,
} as const

export const motionSpring = {
  gentle: {
    type: 'spring',
    stiffness: 220,
    damping: 28,
    mass: 0.9,
  } satisfies Transition,
  snappy: {
    type: 'spring',
    stiffness: 310,
    damping: 26,
    mass: 0.76,
  } satisfies Transition,
  sheet: {
    type: 'spring',
    stiffness: 260,
    damping: 30,
    mass: 1,
  } satisfies Transition,
} as const

export function buildFadeUpMotion(reducedMotion: boolean, delay = 0, distance = 18) {
  if (reducedMotion) {
    return {
      initial: { opacity: 0 } satisfies TargetAndTransition,
      animate: { opacity: 1 } satisfies TargetAndTransition,
      exit: { opacity: 0 } satisfies TargetAndTransition,
      transition: { duration: 0.12, delay, ease: motionEase.iosOut } satisfies Transition,
    }
  }

  return {
    initial: { opacity: 0, y: distance, scale: 0.985 } satisfies TargetAndTransition,
    animate: { opacity: 1, y: 0, scale: 1 } satisfies TargetAndTransition,
    exit: { opacity: 0, y: Math.max(10, distance - 4), scale: 0.992 } satisfies TargetAndTransition,
    transition: { ...motionSpring.gentle, delay } satisfies Transition,
  }
}

export function buildFadeMotion(reducedMotion: boolean, delay = 0) {
  if (reducedMotion) {
    return {
      initial: { opacity: 0 } satisfies TargetAndTransition,
      animate: { opacity: 1 } satisfies TargetAndTransition,
      exit: { opacity: 0 } satisfies TargetAndTransition,
      transition: { duration: 0.1, delay } satisfies Transition,
    }
  }

  return {
    initial: { opacity: 0 } satisfies TargetAndTransition,
    animate: { opacity: 1 } satisfies TargetAndTransition,
    exit: { opacity: 0 } satisfies TargetAndTransition,
    transition: { duration: motionDuration.base, delay, ease: motionEase.iosOut } satisfies Transition,
  }
}

export function buildScaleInMotion(reducedMotion: boolean, delay = 0) {
  if (reducedMotion) {
    return buildFadeMotion(true, delay)
  }

  return {
    initial: { opacity: 0, scale: 0.97 } satisfies TargetAndTransition,
    animate: { opacity: 1, scale: 1 } satisfies TargetAndTransition,
    exit: { opacity: 0, scale: 0.985 } satisfies TargetAndTransition,
    transition: { ...motionSpring.snappy, delay } satisfies Transition,
  }
}

export function buildPressMotion(reducedMotion: boolean) {
  return reducedMotion ? {} : { whileTap: { scale: 0.985 } }
}

export function buildListVariants(reducedMotion: boolean, staggerChildren = 0.05, delayChildren = 0) {
  if (reducedMotion) {
    return {
      hidden: { opacity: 1 },
      visible: { opacity: 1, transition: { staggerChildren: 0, delayChildren: 0 } },
    } satisfies Variants
  }

  return {
    hidden: { opacity: 1 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren,
        delayChildren,
      },
    },
  } satisfies Variants
}

export function buildListItemVariants(reducedMotion: boolean, distance = 12) {
  if (reducedMotion) {
    return {
      hidden: { opacity: 0 },
      visible: { opacity: 1, transition: { duration: 0.1 } },
      exit: { opacity: 0, transition: { duration: 0.08 } },
    } satisfies Variants
  }

  return {
    hidden: { opacity: 0, y: distance, scale: 0.99 },
    visible: { opacity: 1, y: 0, scale: 1, transition: motionSpring.gentle },
    exit: { opacity: 0, y: Math.max(8, distance - 4), scale: 0.992, transition: { duration: 0.16, ease: motionEase.iosIn } },
  } satisfies Variants
}
