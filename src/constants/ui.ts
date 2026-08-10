export const UI_CONFIG = {
  virtualList: {
    nodeThreshold: 30,
    nodeRowHeight: 68,
    overscan: 8,
  },
  motion: {
    staggerMs: 35,
    staggerLimit: 12,
    earthImmersiveDurationMs: 600,
    earthImmersiveEasing: 'cubic-bezier(0.3, 0.7, 0.3, 1)',
    earthCardMotionDurationMs: 400,
    earthCardStaggerMs: 25,
    earthNodeExitBaseDelayMs: 20,
    earthCardReturnStaggerMs: 15,
    denseNodeAppearThreshold: 30,
    denseNodePingAnimationThreshold: 60,
  },
} as const
