import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

const STABLE_STYLE = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
  html { scroll-behavior: auto !important; }
  .earth-globe-host canvas,
  .earth-globe-canvas { opacity: 0 !important; }
`

async function openStablePage(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await page.addStyleTag({ content: STABLE_STYLE })
  await page.waitForTimeout(700)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
}

async function openInteractiveHome(page: Page): Promise<Locator> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Komari (?:Visual Lab|Motion Preview)/ })).toBeVisible()

  const earthStage = page.getByTestId('earth-stage')
  await expect(earthStage).toBeVisible()
  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expect.poll(() => page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-earth-motion-state]')
    if (!root)
      return false

    const elements = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-testid="node-motion-item"], [data-testid="summary-motion-item"]',
    ))
    const targets = new Set<HTMLElement>([root])
    elements.forEach((element) => {
      targets.add(element)
      if (element.parentElement)
        targets.add(element.parentElement)
    })

    return Array.from(targets).every(element => element.getAnimations().every((animation) => {
      const effect = animation.effect as KeyframeEffect | null
      return effect?.target !== element || !['pending', 'running'].includes(animation.playState)
    }))
  })).toBe(true)
  return earthStage
}

async function clearPageFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur()
  })
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true)
}

async function expectPageScrollLocked(page: Page, locked: boolean): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    body: getComputedStyle(document.body).overflow === 'hidden',
    html: getComputedStyle(document.documentElement).overflow === 'hidden',
  }))).toEqual({ body: locked, html: locked })
}

async function expectEarthFillsViewport(page: Page, earthStage: Locator): Promise<void> {
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()

  await expect.poll(async () => {
    const box = await earthStage.boundingBox()
    if (!box || !viewport)
      return false

    return Math.abs(box.x) <= 2
      && Math.abs(box.y) <= 2
      && Math.abs(box.width - viewport.width) <= 2
      && Math.abs(box.height - viewport.height) <= 2
  }).toBe(true)
}

async function expectEarthStageTransparent(earthStage: Locator): Promise<void> {
  await expect.poll(() => earthStage.evaluate((element) => {
    const backgroundColor = getComputedStyle(element).backgroundColor.replaceAll(' ', '')
    return backgroundColor === 'transparent' || backgroundColor === 'rgba(0,0,0,0)'
  })).toBe(true)
}

async function expectEarthReturnsToRect(earthStage: Locator, expected: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>): Promise<void> {
  await expect.poll(async () => {
    const box = await earthStage.boundingBox()
    if (!box)
      return false

    return Math.abs(box.x - expected.x) <= 2
      && Math.abs(box.y - expected.y) <= 2
      && Math.abs(box.width - expected.width) <= 2
      && Math.abs(box.height - expected.height) <= 2
  }).toBe(true)
}

async function getEarthStageTransitionDuration(earthStage: Locator): Promise<number> {
  return earthStage.evaluate((element) => {
    const toMilliseconds = (value: string): number => {
      const duration = Number.parseFloat(value)
      return value.trim().endsWith('ms') ? duration : duration * 1000
    }
    return Math.max(...getComputedStyle(element).transitionDuration.split(',').map(toMilliseconds))
  })
}

async function getTransitionDelaysMs(locator: Locator): Promise<number[]> {
  return locator.evaluateAll(elements => elements.map((element) => {
    const delay = getComputedStyle(element).transitionDelay.split(',')[0] ?? '0s'
    return Number.parseFloat(delay) * (delay.endsWith('ms') ? 1 : 1000)
  }))
}

async function hasRunningEarthFrameMotion(earthFrame: Locator): Promise<boolean> {
  return earthFrame.evaluate(element => element.getAnimations().some((animation) => {
    const effect = animation.effect as KeyframeEffect | null
    const timing = effect?.getTiming()
    return effect?.target === element
      && animation.playState === 'running'
      && timing?.iterations === 1
      && typeof timing.duration === 'number'
      && timing.duration > 0
  }))
}

async function sampleEarthFrameLayout(earthFrame: Locator): Promise<Array<{ height: number, width: number }>> {
  return earthFrame.evaluate(async (element) => {
    const samples: Array<{ height: number, width: number }> = []
    for (let index = 0; index < 4; index += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      samples.push({
        height: (element as HTMLElement).offsetHeight,
        width: (element as HTMLElement).offsetWidth,
      })
    }
    return samples
  })
}

interface NodeMotionItemRect {
  domIndex: number
  height: number
  left: number
  top: number
  width: number
}

interface ActiveNodeMotionItem extends NodeMotionItemRect {
  delay: number
  opacity: number
  order: number
}

const NODE_MOTION_ITEM_SELECTOR = '[data-node-motion-item]'

async function getVisibleNodeMotionItems(page: Page): Promise<NodeMotionItemRect[]> {
  return page.evaluate((selector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element, domIndex) => {
      const rect = element.getBoundingClientRect()
      const intersectsViewport = rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth

      return intersectsViewport
        ? [{ domIndex, height: rect.height, left: rect.left, top: rect.top, width: rect.width }]
        : []
    })
  }, NODE_MOTION_ITEM_SELECTOR)
}

async function getActiveNodeMotionItems(page: Page): Promise<ActiveNodeMotionItem[]> {
  return page.evaluate((selector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element, domIndex) => {
      if (element.dataset.earthExitActive !== 'true')
        return []

      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return [{
        delay: Number.parseFloat(style.getPropertyValue('--earth-card-exit-delay')) || 0,
        domIndex,
        height: rect.height,
        left: rect.left,
        opacity: Number.parseFloat(style.opacity),
        order: Number(element.dataset.earthExitOrder ?? 0),
        top: rect.top,
        width: rect.width,
      }]
    })
  }, NODE_MOTION_ITEM_SELECTOR)
}

async function expectEarthCenteredAtCompactSize(page: Page, earthFrame: Locator): Promise<void> {
  await expect.poll(() => earthFrame.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    const expectedSize = Math.min(window.innerWidth * 0.86, window.innerHeight * 0.68, rootFontSize * 36)

    return Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) <= 2
      && Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2) <= 2
      && Math.abs(rect.width - expectedSize) <= 2
      && Math.abs(rect.height - expectedSize) <= 2
      && Math.abs(rect.width - rect.height) <= 2
  })).toBe(true)
}

async function expectNodeMotionItemsOffscreen(page: Page, expectedItems: ActiveNodeMotionItem[]): Promise<void> {
  const domIndexes = expectedItems.map(item => item.domIndex)
  await expect.poll(() => page.evaluate(({ domIndexes, selector }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    return domIndexes.every((domIndex) => {
      const element = elements[domIndex]
      if (!element)
        return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return Number.parseFloat(style.opacity) <= 0.01
        && style.pointerEvents === 'none'
        && (rect.right <= 1 || rect.left >= window.innerWidth - 1)
    })
  }, { domIndexes, selector: NODE_MOTION_ITEM_SELECTOR })).toBe(true)
}

async function expectNodeMotionItemsRestored(page: Page, expectedItems: NodeMotionItemRect[]): Promise<void> {
  await expect.poll(() => page.evaluate(({ expectedItems, selector }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    return expectedItems.every((expected) => {
      const element = elements[expected.domIndex]
      if (!element)
        return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return !element.hasAttribute('data-earth-exit-active')
        && Number.parseFloat(style.opacity) >= 0.99
        && style.pointerEvents !== 'none'
        && Math.abs(rect.left - expected.left) <= 2
        && Math.abs(rect.top - expected.top) <= 2
        && Math.abs(rect.width - expected.width) <= 2
        && Math.abs(rect.height - expected.height) <= 2
    })
  }, { expectedItems, selector: NODE_MOTION_ITEM_SELECTOR })).toBe(true)
}

async function getMaximumNodeHorizontalDelta(page: Page, expectedItems: NodeMotionItemRect[]): Promise<number> {
  return page.evaluate(({ expectedItems, selector }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    return expectedItems.reduce((maximum, expected) => {
      const element = elements[expected.domIndex]
      if (!element)
        return maximum
      return Math.max(maximum, Math.abs(element.getBoundingClientRect().left - expected.left))
    }, 0)
  }, { expectedItems, selector: NODE_MOTION_ITEM_SELECTOR })
}

async function activeNodeMotionHasZeroTransitionDelay(page: Page): Promise<boolean> {
  return page.evaluate((selector) => {
    const toMilliseconds = (value: string): number => {
      const duration = Number.parseFloat(value)
      return value.trim().endsWith('ms') ? duration : duration * 1000
    }
    const elements = Array.from(document.querySelectorAll<HTMLElement>(
      `${selector}[data-earth-exit-active="true"]`,
    ))
    return elements.length > 0 && elements.every((element) => {
      const delays = getComputedStyle(element).transitionDelay.split(',').map(toMilliseconds)
      return delays.every(delay => Math.abs(delay) <= 0.1)
    })
  }, NODE_MOTION_ITEM_SELECTOR)
}

async function hasDirectRunningOrPendingAnimation(element: Locator): Promise<boolean> {
  return element.evaluate(target => target.getAnimations().some((animation) => {
    const effect = animation.effect as KeyframeEffect | null
    return effect?.target === target && ['pending', 'running'].includes(animation.playState)
  }))
}

async function nodeMotionItemsHaveDirectRunningOrPendingAnimation(page: Page, domIndexes: number[]): Promise<boolean> {
  return page.evaluate(({ domIndexes, selector }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    return domIndexes.some((domIndex) => {
      const element = elements[domIndex]
      return element?.getAnimations().some((animation) => {
        const effect = animation.effect as KeyframeEffect | null
        return effect?.target === element && ['pending', 'running'].includes(animation.playState)
      }) ?? false
    })
  }, { domIndexes, selector: NODE_MOTION_ITEM_SELECTOR })
}

async function expectNodeMetricIcons(page: Page): Promise<void> {
  for (const metric of ['cpu', 'memory', 'disk', 'traffic'])
    await expect(page.locator(`[data-node-metric-icon="${metric}"]`).first()).toBeVisible()
}

async function expectNodePingBars(page: Page): Promise<void> {
  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  for (const metric of ['latency', 'loss']) {
    const bars = card.locator(`[data-node-ping-bars="${metric}"]`)
    await expect(bars).toBeVisible()
    await expect.poll(() => bars.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
  }
}

test('home light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expectNodePingBars(page)
  await expect(page).toHaveScreenshot('home-light-desktop.png', { fullPage: false })
})

test('home dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-dark-mobile.png', { fullPage: false })
})

test('home accessible list desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { colorVisionFriendly: true, viewMode: 'list', hideEarth: true })
  await openStablePage(page)
  await expect(page).toHaveScreenshot('home-accessible-list-desktop.png', { fullPage: false })
})

test('home cobe layout desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { earthRenderer: 'cobe' })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-cobe-desktop.png', { fullPage: false })
})

test('home tiled layout desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { earthRenderer: 'tiled' })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-tiled-desktop.png', { fullPage: false })
})

test('plain Tab toggles immersive earth and Escape exits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const inlineRect = await earthStage.boundingBox()
  if (!inlineRect)
    throw new Error('Earth stage has no inline layout box')

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expectPageScrollLocked(page, true)
  await expectEarthFillsViewport(page, earthStage)

  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expectPageScrollLocked(page, false)
  await expectEarthReturnsToRect(earthStage, inlineRect)

  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expectPageScrollLocked(page, true)
  await page.keyboard.press('Escape')
  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expectPageScrollLocked(page, false)
  await expectEarthReturnsToRect(earthStage, inlineRect)
})

test('immersive earth keeps renderer pixels continuous across the exit handoff', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')

  interface EarthExitSample {
    canvasBackingHeight: number
    canvasBackingWidth: number
    canvasHeight: number
    canvasLeft: number
    canvasTop: number
    canvasWidth: number
    flagHeight: number
    flagWidth: number
    frameHeight: number
    frameLeft: number
    frameTop: number
    frameWidth: number
    hostHeight: number
    hostLeft: number
    hostTop: number
    hostWidth: number
    placeholderHeight: number
    placeholderLeft: number
    placeholderTop: number
    placeholderWidth: number
    state: string
    visibility: string
  }

  async function captureExit(key: 'Escape' | 'Tab'): Promise<EarthExitSample[]> {
    const samplesPromise = page.evaluate(() => new Promise<EarthExitSample[]>((resolve) => {
      const stage = document.querySelector<HTMLElement>('[data-testid="earth-stage"]')
      const frame = document.querySelector<HTMLElement>('[data-testid="earth-motion-frame"]')
      if (!stage || !frame) {
        resolve([])
        return
      }

      const samples: EarthExitSample[] = []
      let inlineSamples = 0
      let ticks = 0
      const sample = () => {
        ticks += 1
        const canvas = frame.querySelector<HTMLCanvasElement>('canvas')
        const host = frame.querySelector<HTMLElement>('.earth-globe-host')
        const flag = frame.querySelector<HTMLElement>('.earth-label-flag')
        const canvasRect = canvas?.getBoundingClientRect()
        const hostRect = host?.getBoundingClientRect()
        const flagRect = flag?.getBoundingClientRect()
        const frameRect = frame.getBoundingClientRect()
        const placeholder = document.querySelector<HTMLElement>('.earth-stage-placeholder')
        const placeholderRect = placeholder?.getBoundingClientRect()
        const state = stage.dataset.state ?? ''
        samples.push({
          canvasBackingHeight: canvas?.height ?? 0,
          canvasBackingWidth: canvas?.width ?? 0,
          canvasHeight: canvasRect?.height ?? 0,
          canvasLeft: canvasRect?.left ?? 0,
          canvasTop: canvasRect?.top ?? 0,
          canvasWidth: canvasRect?.width ?? 0,
          flagHeight: flagRect?.height ?? 0,
          flagWidth: flagRect?.width ?? 0,
          frameHeight: frameRect.height,
          frameLeft: frameRect.left,
          frameTop: frameRect.top,
          frameWidth: frameRect.width,
          hostHeight: hostRect?.height ?? 0,
          hostLeft: hostRect?.left ?? 0,
          hostTop: hostRect?.top ?? 0,
          hostWidth: hostRect?.width ?? 0,
          placeholderHeight: placeholderRect?.height ?? 0,
          placeholderLeft: placeholderRect?.left ?? 0,
          placeholderTop: placeholderRect?.top ?? 0,
          placeholderWidth: placeholderRect?.width ?? 0,
          state,
          visibility: getComputedStyle(frame).visibility,
        })
        if (state === 'inline')
          inlineSamples += 1

        if (inlineSamples >= 4 || ticks >= 120) {
          resolve(samples)
          return
        }
        requestAnimationFrame(sample)
      }

      requestAnimationFrame(sample)
    }))

    await page.keyboard.press(key)
    const samples = await samplesPromise
    const firstInlineIndex = samples.findIndex(sample => sample.state === 'inline')
    const beforeTeleport = samples[firstInlineIndex - 1]
    const firstInline = samples[firstInlineIndex]
    const inlineRevealSamples = samples.filter(sample => sample.state === 'inline')
    expect(firstInlineIndex).toBeGreaterThan(0)
    expect(beforeTeleport?.state).toBe('fullscreen')
    expect(inlineRevealSamples.length).toBeGreaterThanOrEqual(3)

    const fullscreenBackingWidth = samples[0]?.canvasBackingWidth ?? 0
    const fullscreenBackingHeight = samples[0]?.canvasBackingHeight ?? 0
    expect(fullscreenBackingWidth).toBeGreaterThan(0)
    expect(fullscreenBackingHeight).toBeGreaterThan(0)
    expect(samples.every(sample => sample.canvasBackingWidth === fullscreenBackingWidth)).toBe(true)
    expect(samples.every(sample => sample.canvasBackingHeight === fullscreenBackingHeight)).toBe(true)

    // A delayed globe.gl resize used to leave the host at 474.88 px while its
    // canvas expanded to 518.97 px for one paint. Check every sampled frame.
    expect(Math.max(...samples.map(sample => Math.abs(sample.canvasLeft - sample.hostLeft)))).toBeLessThanOrEqual(1)
    expect(Math.max(...samples.map(sample => Math.abs(sample.canvasTop - sample.hostTop)))).toBeLessThanOrEqual(1)
    expect(Math.max(...samples.map(sample => Math.abs(sample.canvasWidth - sample.hostWidth)))).toBeLessThanOrEqual(1)
    expect(Math.max(...samples.map(sample => Math.abs(sample.canvasHeight - sample.hostHeight)))).toBeLessThanOrEqual(1)

    // Teleport must preserve the already-rendered endpoint, including fixed-
    // pixel HTML labels layered over the WebGL canvas.
    expect(Math.abs((beforeTeleport?.frameLeft ?? 0) - (firstInline?.frameLeft ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.frameTop ?? 0) - (firstInline?.frameTop ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.frameWidth ?? 0) - (firstInline?.frameWidth ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.frameHeight ?? 0) - (firstInline?.frameHeight ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.canvasLeft ?? 0) - (firstInline?.canvasLeft ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.canvasTop ?? 0) - (firstInline?.canvasTop ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.canvasWidth ?? 0) - (firstInline?.canvasWidth ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.canvasHeight ?? 0) - (firstInline?.canvasHeight ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((beforeTeleport?.flagWidth ?? 0) - (firstInline?.flagWidth ?? 0))).toBeLessThanOrEqual(0.25)
    expect(Math.abs((beforeTeleport?.flagHeight ?? 0) - (firstInline?.flagHeight ?? 0))).toBeLessThanOrEqual(0.25)

    expect(inlineRevealSamples[0]?.visibility).toBe('visible')
    expect(inlineRevealSamples.at(-1)?.visibility).toBe('visible')
    const settledInline = inlineRevealSamples.at(-1)
    expect(Math.abs((settledInline?.frameLeft ?? 0) - (settledInline?.placeholderLeft ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((settledInline?.frameTop ?? 0) - (settledInline?.placeholderTop ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((settledInline?.frameWidth ?? 0) - (settledInline?.placeholderWidth ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((settledInline?.frameHeight ?? 0) - (settledInline?.placeholderHeight ?? 0))).toBeLessThanOrEqual(1)
    return samples
  }

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expect(earthMotionFrame).toBeVisible()
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(false)

  await captureExit('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'inline')

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(false)
  await captureExit('Escape')
})

test('immersive earth centers compactly while visible node cards exit in order and return', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')
  const homeView = page.locator('[data-earth-motion-state]')
  const motionChrome = page.locator('[data-earth-toolbar-segment]')
  const summaryMotionItems = page.getByTestId('summary-motion-item')
  const filterChrome = page.getByTestId('earth-toolbar-filters')
  const actionChrome = page.getByTestId('earth-toolbar-actions')
  const inlineEarthRect = await earthStage.boundingBox()
  if (!inlineEarthRect)
    throw new Error('Earth stage has no inline layout box')

  const visibleNodeItems = await getVisibleNodeMotionItems(page)
  expect(visibleNodeItems.length).toBeGreaterThan(1)
  await expect(motionChrome).toHaveCount(2)
  await expect(summaryMotionItems).toHaveCount(6)
  const inlineSummaryRects = await summaryMotionItems.evaluateAll(elements => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { height: rect.height, left: rect.left, top: rect.top, width: rect.width }
  }))
  const inlineChromeRects = await motionChrome.evaluateAll(elements => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { height: rect.height, left: rect.left, top: rect.top, width: rect.width }
  }))

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'entering')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  expect(await getEarthStageTransitionDuration(earthStage)).toBe(600)
  await expect.poll(() => earthMotionFrame.evaluate((element) => {
    const animation = element.getAnimations().find((candidate) => {
      const effect = candidate.effect as KeyframeEffect | null
      return effect?.target === element && candidate.playState === 'running'
    })
    const duration = animation?.effect?.getTiming().duration
    return typeof duration === 'number' ? duration : 0
  })).toBe(600)
  const immersiveTransitionDurations = await page.evaluate(() => ({
    node: getComputedStyle(document.querySelector<HTMLElement>('[data-node-motion-item]')!).transitionDuration,
    summary: getComputedStyle(document.querySelector<HTMLElement>('[data-testid="summary-motion-item"]')!).transitionDuration,
    toolbar: getComputedStyle(document.querySelector<HTMLElement>('[data-earth-toolbar-segment]')!).transitionDuration,
  }))
  expect(immersiveTransitionDurations).toEqual({
    node: '0.4s, 0.4s',
    summary: '0.4s',
    toolbar: '0.4s, 0.4s',
  })
  const summaryExitDelays = await getTransitionDelaysMs(summaryMotionItems)
  expect(summaryExitDelays).toEqual([0, 0, 0, 0, 0, 0])
  await expect.poll(() => summaryMotionItems.evaluateAll(elements => (
    elements.every(element => element.getAttribute('data-earth-exit-active') === 'true')
  ))).toBe(true)
  const chromeExitDelays = await getTransitionDelaysMs(motionChrome)
  expect(chromeExitDelays).toEqual([0, 25])
  const transitionLayers = await page.evaluate(() => {
    const home = document.querySelector<HTMLElement>('[data-earth-motion-state]')
    const stage = document.querySelector<HTMLElement>('[data-testid="earth-stage"]')
    return {
      home: Number.parseFloat(home ? getComputedStyle(home).zIndex : '0') || 0,
      stage: Number.parseFloat(stage ? getComputedStyle(stage).zIndex : '0') || 0,
    }
  })
  expect(transitionLayers.home).toBeGreaterThan(transitionLayers.stage)
  await expect.poll(
    () => motionChrome.evaluateAll((elements, expectedRects) => elements.every((element, index) => {
      const expected = expectedRects[index]
      return Boolean(expected && Math.abs(element.getBoundingClientRect().left - expected.left) > 4)
    }), inlineChromeRects),
    { intervals: [25, 50, 75], timeout: 300 },
  ).toBe(true)

  await expect.poll(() => getActiveNodeMotionItems(page).then(items => items.length)).toBeGreaterThanOrEqual(visibleNodeItems.length)
  const activeNodeItems = await getActiveNodeMotionItems(page)
  const activeDomIndexes = new Set(activeNodeItems.map(item => item.domIndex))
  expect(visibleNodeItems.every(item => activeDomIndexes.has(item.domIndex))).toBe(true)

  const itemsInDomOrder = [...activeNodeItems].sort((left, right) => left.domIndex - right.domIndex)
  const exitOrders = itemsInDomOrder.map(item => item.order)
  const exitDelays = itemsInDomOrder.map(item => item.delay)
  expect(exitOrders).toEqual([...exitOrders].sort((left, right) => left - right))
  expect(exitDelays).toEqual([...exitDelays].sort((left, right) => left - right))
  expect(new Set(exitDelays).size).toBeGreaterThan(1)
  expect(Math.max(...exitDelays)).toBeLessThanOrEqual(200)

  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'immersive')
  await expectEarthFillsViewport(page, earthStage)
  await expectEarthStageTransparent(earthStage)
  await expectEarthCenteredAtCompactSize(page, earthMotionFrame)
  await expectNodeMotionItemsOffscreen(page, activeNodeItems)
  await expect.poll(() => summaryMotionItems.evaluateAll(elements => elements.every((element) => {
    const rect = element.getBoundingClientRect()
    return Number.parseFloat(getComputedStyle(element).opacity) <= 0.01
      && (rect.right <= 1 || rect.left >= window.innerWidth - 1)
  }))).toBe(true)
  expect(await filterChrome.evaluate(element => element.getBoundingClientRect().right <= 1)).toBe(true)
  expect(await actionChrome.evaluate(element => element.getBoundingClientRect().left >= window.innerWidth - 1)).toBe(true)
  expect(await motionChrome.evaluateAll(elements => elements.every(element => (
    Number.parseFloat(getComputedStyle(element).opacity) <= 0.01
  )))).toBe(true)
  await expectPageScrollLocked(page, true)

  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'returning')
  const chromeReturnDelays = await getTransitionDelaysMs(motionChrome)
  expect(chromeReturnDelays).toEqual([15, 0])
  const summaryReturnDelays = await getTransitionDelaysMs(summaryMotionItems)
  expect(summaryReturnDelays).toEqual([0, 0, 0, 0, 0, 0])
  const nodeReturnDelays = await page.evaluate(({ domIndexes, selector }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
    return domIndexes.map((domIndex) => {
      const element = elements[domIndex]
      return Number.parseFloat(element?.style.getPropertyValue('--earth-card-return-delay') ?? '') || 0
    })
  }, { domIndexes: activeNodeItems.map(item => item.domIndex), selector: NODE_MOTION_ITEM_SELECTOR })
  expect(new Set(nodeReturnDelays).size).toBeGreaterThan(1)
  expect(nodeReturnDelays).toEqual([...nodeReturnDelays].sort((left, right) => right - left))
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'inline')
  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expectPageScrollLocked(page, false)
  await expectEarthReturnsToRect(earthStage, inlineEarthRect)
  await expectNodeMotionItemsRestored(page, visibleNodeItems)
  await expect.poll(() => summaryMotionItems.evaluateAll((elements, expectedRects) => (
    elements.every((element, index) => {
      const expected = expectedRects[index]
      if (!expected)
        return false
      const rect = element.getBoundingClientRect()
      return Number.parseFloat(getComputedStyle(element).opacity) >= 0.99
        && Math.abs(rect.left - expected.left) <= 2
        && Math.abs(rect.top - expected.top) <= 2
        && Math.abs(rect.width - expected.width) <= 2
        && Math.abs(rect.height - expected.height) <= 2
    })
  ), inlineSummaryRects)).toBe(true)
  await expect.poll(() => motionChrome.evaluateAll((elements, expectedRects) => {
    return elements.every((element, index) => {
      const expected = expectedRects[index]
      if (!expected)
        return false
      const rect = element.getBoundingClientRect()
      return Number.parseFloat(getComputedStyle(element).opacity) >= 0.99
        && Math.abs(rect.left - expected.left) <= 2
        && Math.abs(rect.top - expected.top) <= 2
        && Math.abs(rect.width - expected.width) <= 2
        && Math.abs(rect.height - expected.height) <= 2
    })
  }, inlineChromeRects)).toBe(true)
})

test('Tab keeps native focus navigation in the node search input', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const searchInput = page.getByRole('textbox', { name: '搜索节点' })

  await searchInput.focus()
  await expect(searchInput).toBeFocused()
  await page.keyboard.press('Tab')

  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expect(searchInput).not.toBeFocused()
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true)
  await expectPageScrollLocked(page, false)
})

test('immersive earth uses a stable FLIP motion frame', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const animatedEarthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')
  await expect(earthMotionFrame).toBeVisible()
  const inlineLayout = await earthMotionFrame.evaluate(element => ({
    height: (element as HTMLElement).offsetHeight,
    width: (element as HTMLElement).offsetWidth,
  }))

  expect(await getEarthStageTransitionDuration(animatedEarthStage)).toBeGreaterThan(0)
  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(animatedEarthStage).toHaveAttribute('data-state', 'fullscreen')
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(true)

  const layoutSamples = await sampleEarthFrameLayout(earthMotionFrame)
  expect(layoutSamples[0].width).toBeGreaterThan(inlineLayout.width)
  expect(layoutSamples.every(sample => (
    sample.width === layoutSamples[0].width
    && sample.height === layoutSamples[0].height
  ))).toBe(true)
})

test('tiled immersive earth keeps its inline aspect ratio', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false, earthRenderer: 'tiled' })
  const earthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')
  const inlineLayout = await earthMotionFrame.evaluate(element => ({
    height: (element as HTMLElement).offsetHeight,
    width: (element as HTMLElement).offsetWidth,
  }))

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  const fullscreenLayout = await earthMotionFrame.evaluate(element => ({
    height: (element as HTMLElement).offsetHeight,
    width: (element as HTMLElement).offsetWidth,
  }))

  expect(Math.abs(
    inlineLayout.width / inlineLayout.height
    - fullscreenLayout.width / fullscreenLayout.height,
  )).toBeLessThan(0.01)
})

test('immersive earth reverses an entry after node cards start moving', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')
  const homeView = page.locator('[data-earth-motion-state]')
  const inlineEarthRect = await earthStage.boundingBox()
  if (!inlineEarthRect)
    throw new Error('Earth stage has no inline layout box')

  const visibleNodeItems = await getVisibleNodeMotionItems(page)
  expect(visibleNodeItems.length).toBeGreaterThan(1)

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'entering')
  await expect.poll(
    () => getMaximumNodeHorizontalDelta(page, visibleNodeItems),
    { intervals: [25, 50, 75], timeout: 900 },
  ).toBeGreaterThan(4)

  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'returning')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'inline')
  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(false)
  await expectPageScrollLocked(page, false)
  await expectEarthReturnsToRect(earthStage, inlineEarthRect)
  await expectNodeMotionItemsRestored(page, visibleNodeItems)
})

test('immersive earth reverses an exit in place', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')
  const homeView = page.locator('[data-earth-motion-state]')
  const visibleNodeItems = await getVisibleNodeMotionItems(page)
  expect(visibleNodeItems.length).toBeGreaterThan(1)

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'entering')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expect.poll(() => getActiveNodeMotionItems(page).then(items => items.length)).toBeGreaterThanOrEqual(visibleNodeItems.length)
  const activeNodeItems = await getActiveNodeMotionItems(page)
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(true)
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(false)

  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'returning')
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(true)
  await page.keyboard.press('Tab')

  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'entering')
  await expect.poll(() => activeNodeMotionHasZeroTransitionDelay(page)).toBe(true)
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'immersive')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expect.poll(() => hasRunningEarthFrameMotion(earthMotionFrame)).toBe(false)
  await expectPageScrollLocked(page, true)
  await expectEarthFillsViewport(page, earthStage)
  await expectEarthCenteredAtCompactSize(page, earthMotionFrame)
  await expectNodeMotionItemsOffscreen(page, activeNodeItems)
})

test('immersive earth switches instantly when reduced motion is preferred', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installKomariFixture(page, { disablePageAnimation: false })
  const earthStage = await openInteractiveHome(page)
  const earthMotionFrame = page.getByTestId('earth-motion-frame')
  const filterChrome = page.getByTestId('earth-toolbar-filters')
  const actionChrome = page.getByTestId('earth-toolbar-actions')
  const homeView = page.locator('[data-earth-motion-state]')
  const visibleNodeItems = await getVisibleNodeMotionItems(page)
  expect(visibleNodeItems.length).toBeGreaterThan(1)

  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'immersive')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  await expectPageScrollLocked(page, true)

  await expect.poll(() => getActiveNodeMotionItems(page).then(items => items.length)).toBeGreaterThanOrEqual(visibleNodeItems.length)
  const activeNodeItems = await getActiveNodeMotionItems(page)
  const activeDomIndexes = activeNodeItems.map(item => item.domIndex)
  expect(await hasDirectRunningOrPendingAnimation(earthMotionFrame)).toBe(false)
  expect(await hasDirectRunningOrPendingAnimation(filterChrome)).toBe(false)
  expect(await hasDirectRunningOrPendingAnimation(actionChrome)).toBe(false)
  expect(await nodeMotionItemsHaveDirectRunningOrPendingAnimation(page, activeDomIndexes)).toBe(false)

  await page.keyboard.press('Tab')
  await expect(homeView).toHaveAttribute('data-earth-motion-state', 'inline')
  await expect(earthStage).toHaveAttribute('data-state', 'inline')
  await expectPageScrollLocked(page, false)
  expect(await hasDirectRunningOrPendingAnimation(earthMotionFrame)).toBe(false)
  expect(await hasDirectRunningOrPendingAnimation(filterChrome)).toBe(false)
  expect(await hasDirectRunningOrPendingAnimation(actionChrome)).toBe(false)
  expect(await nodeMotionItemsHaveDirectRunningOrPendingAnimation(page, activeDomIndexes)).toBe(false)
})

test('immersive earth has no motion when page animation is disabled', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { disablePageAnimation: true })
  const earthStage = await openInteractiveHome(page)

  expect(await getEarthStageTransitionDuration(earthStage)).toBe(0)
  await clearPageFocus(page)
  await page.keyboard.press('Tab')
  await expect(earthStage).toHaveAttribute('data-state', 'fullscreen')
  expect(await hasRunningEarthFrameMotion(page.getByTestId('earth-motion-frame'))).toBe(false)
  await expectEarthFillsViewport(page, earthStage)
})

test('home mini card metric icons remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardSize: 'mini', hideEarth: true })
  await openStablePage(page)

  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  await expect(card.locator('[data-node-metric-icon="cpu"]')).toBeVisible()
  await expect(card.locator('[data-node-metric-icon="memory"]')).toBeVisible()
  await expect(card.locator('[data-node-metric-icon="traffic"]')).toBeVisible()
  await expect(card.getByRole('img', { name: 'CPU' })).toBeVisible()
  await expect(card.getByRole('img', { name: '内存' })).toBeVisible()
})

test('free node pricing stays semantic across home, finance, and detail', async ({ page }) => {
  const freeNodeName = '主控-洛杉矶'
  const freeNodeUuid = '00000000-0000-4000-8000-000000000001'
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { freePriceNode: true, hideEarth: true })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: `查看节点 ${freeNodeName} 详情` })
  await expect(nodeCard.getByText('免费', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('无', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('免费 / 年', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '查看剩余价值明细' }).click()
  const financeDialog = page.getByRole('dialog', { name: '价值与费用明细' })
  await expect(financeDialog.getByText(freeNodeName, { exact: true })).toHaveCount(0)
  await financeDialog.getByLabel('排除免费节点').uncheck()
  const freeNodeRow = financeDialog.getByRole('cell', { name: freeNodeName, exact: true }).locator('..')
  await expect(freeNodeRow).toBeVisible()
  await expect(freeNodeRow.getByText('免费', { exact: true })).toBeVisible()
  await expect(freeNodeRow.getByText('无', { exact: true })).toBeVisible()

  await page.goto(`/instance/${freeNodeUuid}`)
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
  await expect(page.getByText('节点价格', { exact: true })).toBeVisible()
  await expect(page.getByText('剩余价值', { exact: true })).toBeVisible()
  await expect(page.getByText('无', { exact: true })).toBeVisible()
  await expect(page.getByText('免费 / 月', { exact: true })).toHaveCount(0)
})

test('detail light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-light-desktop.png', { fullPage: false })
})

test('detail dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-dark-mobile.png', { fullPage: false })
})

test('detail ping requests stay scoped to the current node', async ({ page }) => {
  const currentUuid = '00000000-0000-4000-8000-000000000001'
  const metricCalls: Array<{ method: string, params: Record<string, unknown> }> = []
  const isPingMetricCall = (call: { method: string, params: Record<string, unknown> }): boolean => {
    const metricKeys = Array.isArray(call.params.metric_keys) ? call.params.metric_keys : []
    return call.method === 'public:getPingMetricStats'
      || metricKeys.includes('ping.latency_ms')
      || metricKeys.includes('ping.loss')
  }

  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return

    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics' || payload?.method === 'public:getPingMetricStats') {
      metricCalls.push({ method: payload.method, params: payload.params ?? {} })
    }
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)

  await expect.poll(() => metricCalls.filter(isPingMetricCall).length).toBeGreaterThan(0)
  const homeSummaryCalls = metricCalls.filter(call => call.method === 'public:queryMetrics' && isPingMetricCall(call))
  expect(homeSummaryCalls.length).toBeGreaterThan(0)
  expect(homeSummaryCalls.every(call => call.params.max_points === 150)).toBe(true)

  metricCalls.length = 0
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(`/instance/${currentUuid}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.waitForTimeout(2_000)

  const detailPingCalls = metricCalls.filter(isPingMetricCall)
  expect(detailPingCalls.length).toBeGreaterThan(0)
  expect(new Set(detailPingCalls.map(call => call.params.entity_id))).toEqual(new Set([currentUuid]))
})
