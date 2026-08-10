<script setup lang="ts">
import type { PermissionKey } from '@/services/auth.service'
import type { HomeQuickControlKey } from '@/stores/app'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { useDebounceFn, useEventListener, usePreferredReducedMotion } from '@vueuse/core'
import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import DeferredRender from '@/components/DeferredRender.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useVisitorAudit } from '@/composables/useVisitorAudit'
import { UI_CONFIG } from '@/constants/ui'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import * as financeHelper from '@/utils/financeHelper'
import {
  getRealtimePeakSpeed,
  getTotalTraffic,
  isExpiringNode,
  isHighLoadNode,
} from '@/utils/nodeMetricsHelper'
import { isNodeMatchSearch } from '@/utils/nodeSearch'
import { isFreeNode } from '@/utils/tagHelper'

interface QuickControlOption {
  key: HomeQuickControlKey
  label: string
  icon: string
}

type HomeToolKey = 'nodes' | 'nodeCompare' | 'topology' | 'providerValue' | 'healthSummary' | 'snapshotExport' | 'auditLog'
type PrivateHomeToolKey = Exclude<HomeToolKey, 'nodes' | 'nodeCompare'>
type EarthScenePhase = 'inline' | 'entering' | 'immersive' | 'returning'

interface HomeToolOption {
  key: Exclude<HomeToolKey, 'nodes'>
  label: string
  icon: string
  description: string
}

defineOptions({ name: 'HomeView' })

const AuditLogPanel = defineAsyncComponent(() => import('@/components/AuditLogPanel.vue'))
const HealthSummaryPanel = defineAsyncComponent(() => import('@/components/HealthSummaryPanel.vue'))
const NodeCard = defineAsyncComponent(() => import('@/components/NodeCard.vue'))
const NodeGeneralCards = defineAsyncComponent(() => import('@/components/NodeGeneralCards.vue'))
const NodeList = defineAsyncComponent(() => import('@/components/NodeList.vue'))
const NodeComparePanel = defineAsyncComponent(() => import('@/components/NodeComparePanel.vue'))
const PingMonitorDialog = defineAsyncComponent(() => import('@/components/PingMonitorDialog.vue'))
const NodeTopologyPanel = defineAsyncComponent(() => import('@/components/NodeTopologyPanel.vue'))
const ProviderValuePanel = defineAsyncComponent(() => import('@/components/ProviderValuePanel.vue'))
const SnapshotExportPanel = defineAsyncComponent(() => import('@/components/SnapshotExportPanel.vue'))

const nodeItemStaggerMs = UI_CONFIG.motion.staggerMs
const nodeItemStaggerLimit = UI_CONFIG.motion.staggerLimit
const earthCardMotionDurationMs = UI_CONFIG.motion.earthCardMotionDurationMs
const earthCardStaggerMs = UI_CONFIG.motion.earthCardStaggerMs
const earthNodeExitBaseDelayMs = UI_CONFIG.motion.earthNodeExitBaseDelayMs
const earthCardReturnStaggerMs = UI_CONFIG.motion.earthCardReturnStaggerMs
const denseNodeAppearThreshold = UI_CONFIG.motion.denseNodeAppearThreshold
const denseNodePingAnimationThreshold = UI_CONFIG.motion.denseNodePingAnimationThreshold

const appStore = useAppStore()
const nodesStore = useNodesStore()
const router = useRouter()
const { record: recordVisitorEvent } = useVisitorAudit()
const isViewActive = ref(true)
const isEarthImmersive = ref(false)
const earthScenePhase = ref<EarthScenePhase>('inline')
const earthSceneSkipStagger = ref(false)
const homeViewRef = ref<HTMLElement | null>(null)
const preferredReducedMotion = usePreferredReducedMotion()
const earthSceneMotionAllowed = computed(() => (
  !appStore.disablePageAnimation && preferredReducedMotion.value !== 'reduce'
))

let earthSceneCompletionTimer: number | undefined
let earthSceneMaxExitDelayMs = 0
let earthSceneMaxReturnDelayMs = 0

function clearEarthSceneCompletionTimer() {
  if (earthSceneCompletionTimer === undefined)
    return
  window.clearTimeout(earthSceneCompletionTimer)
  earthSceneCompletionTimer = undefined
}

function clearEarthSceneMotionItems() {
  const root = homeViewRef.value
  if (!root)
    return

  root.querySelectorAll<HTMLElement>('[data-earth-exit-card], [data-node-motion-item]').forEach((element) => {
    delete element.dataset.earthExitActive
    delete element.dataset.earthExitOrder
    element.style.removeProperty('--earth-card-exit-delay')
    element.style.removeProperty('--earth-card-exit-rotation')
    element.style.removeProperty('--earth-card-exit-x')
    element.style.removeProperty('--earth-card-exit-y')
    element.style.removeProperty('--earth-card-return-delay')
  })
  root.querySelectorAll<HTMLElement>('[data-earth-toolbar-segment]').forEach((element) => {
    element.style.removeProperty('--earth-toolbar-exit-x')
  })
}

function prepareEarthSceneMotion() {
  const root = homeViewRef.value
  if (!root)
    return

  clearEarthSceneMotionItems()
  earthSceneMaxExitDelayMs = 0
  earthSceneMaxReturnDelayMs = 0
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('[data-earth-exit-card], [data-node-motion-item]'),
  ).map(element => ({ element, rect: element.getBoundingClientRect() }))

  candidates.forEach(({ element }) => {
    element.dataset.earthExitActive = 'false'
  })

  const visibleItems = candidates
    .filter(({ rect }) => (
      rect.width > 0
      && rect.height > 0
      && rect.bottom >= -64
      && rect.top <= viewportHeight + 64
      && rect.right >= -64
      && rect.left <= viewportWidth + 64
    ))
    .sort((left, right) => (
      Math.abs(left.rect.top - right.rect.top) > 4
        ? left.rect.top - right.rect.top
        : left.rect.left - right.rect.left
    ))

  const viewportCenterX = viewportWidth / 2
  const centerBand = Math.min(96, viewportWidth * 0.12)
  const indexedItems = visibleItems.map((item, visualIndex) => ({ ...item, visualIndex }))
  const summaryItems = indexedItems.filter(({ element }) => !element.hasAttribute('data-node-motion-item'))
  const nodeItems = indexedItems.filter(({ element }) => element.hasAttribute('data-node-motion-item'))

  const configureItems = (items: typeof indexedItems, baseDelayMs: number) => {
    items.forEach(({ element, rect, visualIndex }, sequenceIndex) => {
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const exitToRight = centerX > viewportCenterX + centerBand
        || (Math.abs(centerX - viewportCenterX) <= centerBand && visualIndex % 2 === 1)
      const exitX = exitToRight
        ? viewportWidth - rect.left + 32
        : -(rect.right + 32)
      const exitY = Math.max(-32, Math.min(32, (centerY - viewportHeight / 2) * 0.08))
      const order = Math.min(sequenceIndex, nodeItemStaggerLimit)
      const returnOrder = Math.min(
        Math.max(items.length - 1 - sequenceIndex, 0),
        nodeItemStaggerLimit,
      )
      const exitDelayMs = baseDelayMs + order * earthCardStaggerMs
      const returnDelayMs = returnOrder * earthCardReturnStaggerMs

      earthSceneMaxExitDelayMs = Math.max(earthSceneMaxExitDelayMs, exitDelayMs)
      earthSceneMaxReturnDelayMs = Math.max(earthSceneMaxReturnDelayMs, returnDelayMs)
      element.dataset.earthExitActive = 'true'
      element.dataset.earthExitOrder = String(order)
      element.style.setProperty('--earth-card-exit-delay', `${exitDelayMs}ms`)
      element.style.setProperty('--earth-card-exit-rotation', exitToRight ? '2deg' : '-2deg')
      element.style.setProperty('--earth-card-exit-x', `${exitX}px`)
      element.style.setProperty('--earth-card-exit-y', `${exitY}px`)
      element.style.setProperty('--earth-card-return-delay', `${returnDelayMs}ms`)
    })
  }

  configureItems(summaryItems, 0)
  configureItems(nodeItems, earthNodeExitBaseDelayMs)

  root.querySelectorAll<HTMLElement>('[data-earth-toolbar-segment]').forEach((element) => {
    const rect = element.getBoundingClientRect()
    const exitsRight = element.dataset.earthToolbarSegment === 'actions'
    const exitX = exitsRight
      ? viewportWidth - rect.left + 32
      : -(rect.right + 32)
    element.style.setProperty('--earth-toolbar-exit-x', `${exitX}px`)
  })
}

function settleEarthScene(immersive: boolean) {
  clearEarthSceneCompletionTimer()
  earthScenePhase.value = immersive ? 'immersive' : 'inline'
  earthSceneSkipStagger.value = false
  if (!immersive)
    clearEarthSceneMotionItems()
}

function scheduleEarthSceneSettlement(immersive: boolean) {
  clearEarthSceneCompletionTimer()
  if (!earthSceneMotionAllowed.value) {
    settleEarthScene(immersive)
    return
  }

  const cardDelayMs = earthSceneSkipStagger.value
    ? 0
    : immersive
      ? earthSceneMaxExitDelayMs
      : earthSceneMaxReturnDelayMs
  const sceneDurationMs = Math.max(
    UI_CONFIG.motion.earthImmersiveDurationMs,
    earthCardMotionDurationMs + cardDelayMs,
  )
  earthSceneCompletionTimer = window.setTimeout(settleEarthScene, sceneDurationMs + 80, immersive)
}

function requestEarthScene(immersive: boolean) {
  if (immersive === isEarthImmersive.value)
    return
  if (immersive && earthScenePhase.value === 'inline')
    prepareEarthSceneMotion()
  isEarthImmersive.value = immersive
}

onActivated(() => {
  isViewActive.value = true
  nextTick(() => {
    if (appStore.homeScrollPosition > 0)
      window.scrollTo({ top: appStore.homeScrollPosition, behavior: 'instant' })
  })
})

onDeactivated(() => {
  isViewActive.value = false
  isEarthImmersive.value = false
  settleEarthScene(false)
  appStore.homeScrollPosition = window.scrollY
})

onBeforeUnmount(() => {
  clearEarthSceneCompletionTimer()
  clearEarthSceneMotionItems()
})

const searchText = ref('')
const debouncedSearchText = ref('')
const activeHomeTool = ref<HomeToolKey>('nodes')
const activeQuickControl = ref<HomeQuickControlKey | null>(null)
const exchangeRates = ref(financeHelper.DEFAULT_EXCHANGE_RATES)
const excludeFreeNodes = ref(true)
const pingDialogNode = ref<NodeData | null>(null)

const interactiveTabTargetSelector = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
].join(',')

const canToggleEarthImmersive = computed(() => (
  isViewActive.value
  && !appStore.hideGeneralCard
  && !appStore.hideEarth
))

function hasOpenDialog(): boolean {
  return Boolean(document.querySelector('[role="dialog"][data-state="open"]'))
}

function isInteractiveTabTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && Boolean(element.closest(interactiveTabTargetSelector))
}

function handleHomeKeyboardShortcut(event: KeyboardEvent) {
  if (!isViewActive.value || event.defaultPrevented || event.repeat || hasOpenDialog())
    return

  if (event.key === 'Escape') {
    if (!isEarthImmersive.value)
      return
    event.preventDefault()
    requestEarthScene(false)
    return
  }

  if (
    event.key !== 'Tab'
    || event.shiftKey
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || !canToggleEarthImmersive.value
    || isInteractiveTabTarget(event.target)
  ) {
    return
  }

  event.preventDefault()
  requestEarthScene(!isEarthImmersive.value)
}

useEventListener(window, 'keydown', handleHomeKeyboardShortcut)

watch(canToggleEarthImmersive, (available) => {
  if (!available)
    requestEarthScene(false)
})

watch(isEarthImmersive, (immersive) => {
  if (!isViewActive.value && !immersive) {
    settleEarthScene(false)
    return
  }

  const previousPhase = earthScenePhase.value
  earthSceneSkipStagger.value = immersive
    ? previousPhase === 'returning'
    : previousPhase === 'entering'
  earthScenePhase.value = immersive ? 'entering' : 'returning'
  scheduleEarthSceneSettlement(immersive)
})

watch(earthSceneMotionAllowed, (motionAllowed) => {
  if (!motionAllowed)
    settleEarthScene(isEarthImmersive.value)
})

const homeToolPermissionMap: Record<PrivateHomeToolKey, PermissionKey> = {
  topology: 'nodeTopology',
  providerValue: 'providerValue',
  healthSummary: 'healthSummary',
  snapshotExport: 'snapshotExport',
  auditLog: 'auditLog',
}

const quickControlDefinitions: Record<HomeQuickControlKey, QuickControlOption> = {
  favorite: { key: 'favorite', label: '收藏', icon: 'tabler:star' },
  monthlyCost: { key: 'monthlyCost', label: '月成本', icon: 'tabler:calendar-dollar' },
  totalTraffic: { key: 'totalTraffic', label: '总流量', icon: 'tabler:database' },
  upload: { key: 'upload', label: '上行', icon: 'tabler:chevron-up' },
  download: { key: 'download', label: '下行', icon: 'tabler:chevron-down' },
  peak: { key: 'peak', label: '峰值', icon: 'tabler:activity' },
  offline: { key: 'offline', label: '离线', icon: 'tabler:plug-connected-x' },
  highLoad: { key: 'highLoad', label: '高负载', icon: 'tabler:alert-triangle' },
  expiring: { key: 'expiring', label: '即将到期', icon: 'tabler:calendar-exclamation' },
}

const homeTools = computed<HomeToolOption[]>(() => {
  if (!appStore.homeToolsEnabled)
    return []

  const tools: HomeToolOption[] = [
    { key: 'nodeCompare', label: '对比', icon: 'tabler:columns-3', description: '最多四台节点实时横向对比' },
  ]
  if (!appStore.privateFeaturesAllowed)
    return tools

  return [...tools, { key: 'topology', label: '拓扑', icon: 'tabler:route', description: 'ASN / BGP / 上游根因' }, { key: 'providerValue', label: '性价比', icon: 'tabler:scale', description: '单机资源成本对比' }, { key: 'healthSummary', label: '健康', icon: 'tabler:heartbeat', description: '日周月历史健康概览' }, { key: 'snapshotExport', label: '导出', icon: 'tabler:download', description: 'CSV / JSON 数据快照' }, { key: 'auditLog', label: '日志', icon: 'tabler:list-details', description: '管理员操作审计日志' }]
})

const updateDebouncedSearch = useDebounceFn((value: string) => {
  debouncedSearchText.value = value
}, 300)

watch(searchText, (value) => {
  updateDebouncedSearch(value)
})

const groups = computed(() => [
  { tab: '全部节点', name: 'all' },
  ...nodesStore.groups.map(g => ({ tab: g, name: g })),
])

const quickControlKeys = computed<HomeQuickControlKey[]>(() => appStore.homeQuickControlOrder.filter(key => key !== 'monthlyCost'))
const quickControls = computed(() => quickControlKeys.value.map(key => quickControlDefinitions[key]))
const showQuickControls = computed(() => appStore.homeQuickControlsEnabled && quickControls.value.length > 0)

watch(
  () => [appStore.homeQuickControlOrder.join('|'), appStore.homeQuickControlsEnabled] as const,
  () => {
    if (!appStore.homeQuickControlsEnabled) {
      activeQuickControl.value = null
      return
    }

    if (activeQuickControl.value && !quickControlKeys.value.includes(activeQuickControl.value))
      activeQuickControl.value = null
  },
  { immediate: true },
)

onMounted(async () => {
  excludeFreeNodes.value = financeHelper.shouldExcludeFreeNodes()
  const { rates } = await financeHelper.getDailyExchangeRates()
  exchangeRates.value = rates
})

watch(
  [() => nodesStore.groups, () => appStore.nodeSelectedGroup],
  ([gs, cur]) => {
    if (cur !== 'all' && !gs.includes(cur)) {
      appStore.nodeSelectedGroup = 'all'
    }
  },
  { immediate: true },
)

function getNodeMonthlyCostCNY(node: NodeData): number {
  if (excludeFreeNodes.value && isFreeNode(node))
    return 0

  return financeHelper.calculateMonthlyCostCNY(node, exchangeRates.value)
}

function sortNodesByComputedValue(nodes: NodeData[], selector: (node: NodeData) => number): NodeData[] {
  return nodes
    .map(node => ({ node, value: selector(node) }))
    .sort((a, b) => b.value - a.value)
    .map(item => item.node)
}

function placeOfflineNodesLast(nodes: NodeData[]): NodeData[] {
  if (!appStore.offlineNodesLast)
    return nodes

  return [...nodes].sort((a, b) => {
    if (a.online === b.online)
      return 0
    return a.online ? -1 : 1
  })
}

function getQuickControlNodes(nodes: NodeData[], control: HomeQuickControlKey | null): NodeData[] {
  let result: NodeData[]

  switch (control) {
    case 'favorite':
      return nodes.filter(node => appStore.isFavoriteNode(node.uuid))
    case 'monthlyCost':
      result = sortNodesByComputedValue(nodes, getNodeMonthlyCostCNY)
      break
    case 'totalTraffic':
      result = sortNodesByComputedValue(nodes, getTotalTraffic)
      break
    case 'upload':
      result = [...nodes].sort((a, b) => (b.net_out || 0) - (a.net_out || 0))
      break
    case 'download':
      result = [...nodes].sort((a, b) => (b.net_in || 0) - (a.net_in || 0))
      break
    case 'peak':
      result = sortNodesByComputedValue(nodes, getRealtimePeakSpeed)
      break
    case 'offline':
      return nodes.filter(node => !node.online)
    case 'highLoad':
      result = nodes.filter(node => isHighLoadNode(node, appStore.homeHighLoadThreshold))
      break
    case 'expiring':
      result = nodes.filter(node => isExpiringNode(node, appStore.homeExpiringDays))
      break
    default:
      result = nodes
      break
  }

  return placeOfflineNodesLast(result)
}

function getQuickControlCount(nodes: NodeData[], control: HomeQuickControlKey): number {
  switch (control) {
    case 'favorite':
      return nodes.reduce((count, node) => count + (appStore.isFavoriteNode(node.uuid) ? 1 : 0), 0)
    case 'offline':
      return nodes.reduce((count, node) => count + (node.online ? 0 : 1), 0)
    case 'highLoad':
      return nodes.reduce((count, node) => count + (isHighLoadNode(node, appStore.homeHighLoadThreshold) ? 1 : 0), 0)
    case 'expiring':
      return nodes.reduce((count, node) => count + (isExpiringNode(node, appStore.homeExpiringDays) ? 1 : 0), 0)
    default:
      return nodes.length
  }
}

const groupNodeList = computed(() => {
  const selectedGroup = appStore.nodeSelectedGroup
  if (selectedGroup === 'all')
    return nodesStore.visibleNodes
  return nodesStore.visibleNodes.filter(node => node.groups.includes(selectedGroup))
})

const nodeList = computed(() => {
  let filtered = groupNodeList.value
  if (debouncedSearchText.value.trim()) {
    filtered = filtered.filter(n => isNodeMatchSearch(n, debouncedSearchText.value))
  }
  return getQuickControlNodes(filtered, activeQuickControl.value)
})

const isDenseNodeGrid = computed(() => appStore.nodeViewMode === 'card' && nodeList.value.length > denseNodeAppearThreshold)
const enableNodeCardTransition = computed(() => !appStore.disablePageAnimation && !isDenseNodeGrid.value)
const reduceDenseNodeEffects = computed(() => appStore.nodeViewMode === 'card' && nodeList.value.length > denseNodePingAnimationThreshold)
const deferNodeCards = computed(() => appStore.nodeViewMode === 'card' && nodeList.value.length > UI_CONFIG.virtualList.nodeThreshold)
const deferredNodeCardHeight = computed(() => ({ mini: 220, compact: 270, comfortable: 310, large: 350 }[appStore.nodeCardSize]))

const quickControlCounts = computed<Record<HomeQuickControlKey, number>>(() => {
  let base = groupNodeList.value
  if (debouncedSearchText.value.trim())
    base = base.filter(n => isNodeMatchSearch(n, debouncedSearchText.value))

  const counts = {} as Record<HomeQuickControlKey, number>
  for (const key of quickControlKeys.value)
    counts[key] = getQuickControlCount(base, key)
  return counts
})

const emptyDescription = computed(() => {
  if (debouncedSearchText.value.trim())
    return '没有匹配的节点'
  if (activeQuickControl.value)
    return '当前快捷筛选下暂无节点'
  return '暂无节点'
})

function clearSearch() {
  searchText.value = ''
  debouncedSearchText.value = ''
}

const nodeListSortResetKey = computed(() => {
  return `${appStore.nodeSelectedGroup}|${debouncedSearchText.value.trim()}|${activeQuickControl.value ?? 'all'}`
})

function handleNodeClick(node: NodeData) {
  router.push({ name: 'instance-detail', params: { id: node.uuid } })
}

function openPingDialog(node: NodeData) {
  pingDialogNode.value = node
}

function getNodeItemTransitionKey(node: NodeData): string {
  return `${appStore.nodeSelectedGroup}-${activeQuickControl.value ?? 'all'}-${node.uuid}`
}

function getNodeItemTransitionStyle(index: number): Record<string, string> {
  return {
    '--node-item-delay': `${Math.min(index, nodeItemStaggerLimit) * nodeItemStaggerMs}ms`,
  }
}

function setQuickControl(key: HomeQuickControlKey) {
  activeQuickControl.value = activeQuickControl.value === key ? null : key
  void recordVisitorEvent({
    event: 'filter_change',
    path: '/',
    route: 'home',
    target: activeQuickControl.value ?? 'all',
    detail: { active: Boolean(activeQuickControl.value), result_count: nodeList.value.length },
  })
}

function setNodeViewMode(mode: 'card' | 'list') {
  if (appStore.nodeViewMode === mode)
    return
  appStore.nodeViewMode = mode
  void recordVisitorEvent({
    event: 'view_mode_change',
    path: '/',
    route: 'home',
    target: mode,
  })
}

async function toggleHomeTool(key: Exclude<HomeToolKey, 'nodes'>) {
  if (!homeTools.value.some(tool => tool.key === key))
    return
  if (activeHomeTool.value === key) {
    activeHomeTool.value = 'nodes'
    return
  }

  const permission = key === 'nodeCompare' ? null : homeToolPermissionMap[key]
  if (permission) {
    const granted = await appStore.requireLoginPermission(permission, { force: true })
    if (!granted) {
      activeHomeTool.value = 'nodes'
      window.$message?.warning('登录状态已过期，请重新登录后使用高级工具。')
      return
    }
  }

  activeHomeTool.value = key
  void recordVisitorEvent({
    event: 'home_tool_open',
    path: '/',
    route: 'home',
    target: key,
  })
}

watch(homeTools, (tools) => {
  if (activeHomeTool.value !== 'nodes' && !tools.some(tool => tool.key === activeHomeTool.value))
    activeHomeTool.value = 'nodes'
}, { immediate: true })

watch(() => appStore.homeAdvancedToolsVisible, (visible) => {
  if (!visible)
    activeHomeTool.value = 'nodes'
})

watch(() => appStore.nodeSelectedGroup, (next, previous) => {
  if (next === previous)
    return
  void recordVisitorEvent({
    event: 'group_change',
    path: '/',
    route: 'home',
    target: next,
    detail: { visible_nodes: groupNodeList.value.length },
  })
})

watch(debouncedSearchText, (next, previous) => {
  const keyword = next.trim()
  if (keyword === previous.trim())
    return
  void recordVisitorEvent({
    event: keyword ? 'search' : 'search_clear',
    path: '/',
    route: 'home',
    detail: {
      keyword_length: keyword.length,
      result_count: nodeList.value.length,
    },
  })
})

const activeToolTitle = computed(() => {
  if (activeHomeTool.value === 'nodes')
    return ''
  return homeTools.value.find(tool => tool.key === activeHomeTool.value)?.description ?? ''
})

const nodeCardGridClass = computed(() => {
  const sizeClass: Record<typeof appStore.nodeCardSize, string> = {
    mini: 'gap-3 sm:grid-cols-[repeat(auto-fill,minmax(270px,1fr))]',
    compact: 'gap-3 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]',
    comfortable: 'gap-4 sm:grid-cols-[repeat(auto-fill,minmax(360px,1fr))]',
    large: 'gap-5 sm:grid-cols-[repeat(auto-fill,minmax(420px,1fr))]',
  }
  return ['grid grid-cols-1', sizeClass[appStore.nodeCardSize]]
})
</script>

<template>
  <div
    ref="homeViewRef"
    class="home-view"
    :data-earth-motion-state="earthScenePhase"
    :class="[
      !appStore.disablePageAnimation && 'home-view--motion',
      isEarthImmersive && 'home-view--earth-immersive',
      earthSceneSkipStagger && 'home-view--earth-reversing',
    ]"
    :style="{
      '--earth-scene-duration': `${UI_CONFIG.motion.earthImmersiveDurationMs}ms`,
      '--earth-scene-easing': UI_CONFIG.motion.earthImmersiveEasing,
      '--earth-card-motion-duration': `${earthCardMotionDurationMs}ms`,
      '--earth-card-stagger': `${earthCardStaggerMs}ms`,
      '--earth-card-return-stagger': `${earthCardReturnStaggerMs}ms`,
    }"
  >
    <div v-if="appStore.alertEnabled && appStore.alertContent" class="alert px-4">
      <Alert class="border-none bg-background/60 backdrop-blur-xs rounded-md">
        <AlertTitle v-if="appStore.alertTitle">
          {{ appStore.alertTitle }}
        </AlertTitle>
        <AlertDescription>
          <MarkdownRenderer :content="appStore.alertContent" />
        </AlertDescription>
      </Alert>
    </div>

    <NodeGeneralCards
      v-if="!appStore.hideGeneralCard"
      v-model:immersive="isEarthImmersive"
      :nodes="groupNodeList"
      :globe-nodes="groupNodeList"
      :transition-key="appStore.nodeSelectedGroup"
    />

    <div class="node-info p-4 pt-0 flex flex-col gap-4 relative z-1 pointer-events-none" :class="!!appStore.hideGeneralCard && 'pt-4'">
      <div class="nodes min-w-0">
        <Tabs v-model="appStore.nodeSelectedGroup" class="w-full flex-col gap-4">
          <div
            class="flex flex-col gap-2 xl:flex-row xl:items-center"
          >
            <div
              data-node-motion-chrome="filters"
              data-earth-toolbar-segment="filters"
              data-testid="earth-toolbar-filters"
              class="home-controls-scroll min-w-0 overflow-x-auto overscroll-x-contain rounded-sm pointer-events-auto touch-pan-x"
            >
              <div class="flex w-max gap-2">
                <TabsList class="w-max h-8 bg-background/50 backdrop-blur-xl rounded-md pointer-events-auto">
                  <TabsTrigger
                    v-for="g in groups" :key="g.name" :value="g.name"
                    class="h-6.5 flex-none shrink-0 text-xs border-none data-[state=active]:text-selection shadow-none rounded-sm"
                  >
                    {{ g.tab }}
                  </TabsTrigger>
                </TabsList>

                <div
                  v-if="showQuickControls && activeHomeTool === 'nodes'"
                  class="flex h-8 w-max items-center gap-1 rounded-md bg-background/50 px-1 backdrop-blur-xl pointer-events-auto"
                >
                  <button
                    v-for="control in quickControls" :key="control.key"
                    type="button"
                    class="inline-flex h-6.5 flex-none shrink-0 items-center gap-1 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    :class="activeQuickControl === control.key ? 'bg-background text-selection shadow-sm' : ''"
                    :aria-pressed="activeQuickControl === control.key"
                    :aria-label="`切换到${control.label}节点，${quickControlCounts[control.key] ?? 0} 台`"
                    @click="setQuickControl(control.key)"
                  >
                    <Icon :icon="control.icon" :width="12" :height="12" />
                    <span>{{ control.label }}</span>
                    <span class="rounded-full bg-slate-500/10 px-1 text-[10px] tabular-nums text-foreground/65">
                      {{ quickControlCounts[control.key] ?? 0 }}
                    </span>
                  </button>
                </div>
              </div>
            </div>
            <div
              data-node-motion-chrome="actions"
              data-earth-toolbar-segment="actions"
              data-testid="earth-toolbar-actions"
              class="search flex min-w-0 flex-wrap gap-2 items-center justify-end pointer-events-auto max-sm:justify-start xl:ml-auto"
            >
              <div v-if="homeTools.length && appStore.homeAdvancedToolsVisible" class="flex h-8 items-center gap-1 rounded-md bg-background/50 p-0.5 backdrop-blur-xs">
                <Button
                  v-for="tool in homeTools" :key="tool.key"
                  variant="ghost" size="icon"
                  class="size-7 rounded-sm text-muted-foreground shadow-none hover:bg-background/60"
                  :class="[activeHomeTool === tool.key ? '!text-selection !bg-background' : '']"
                  :aria-label="`${tool.label}：${tool.description}`"
                  :aria-pressed="activeHomeTool === tool.key"
                  :title="tool.description"
                  @click="toggleHomeTool(tool.key)"
                >
                  <Icon :icon="tool.icon" :width="14" :height="14" />
                </Button>
              </div>

              <Button
                variant="outline" size="icon" aria-label="卡片视图"
                class="w-8 h-8 border-none bg-background/50 backdrop-blur-xs shadow-none hover:bg-background/60 rounded-md"
                :class="[appStore.nodeViewMode === 'card' ? '!text-selection !bg-background' : '']"
                @click="setNodeViewMode('card')"
              >
                <Icon icon="tabler:layout-grid" :width="14" :height="14" />
              </Button>
              <Button
                variant="outline" size="icon" aria-label="列表视图"
                class="w-8 h-8 border-none bg-background/50 backdrop-blur-xs shadow-none hover:bg-background/60 rounded-md"
                :class="[appStore.nodeViewMode === 'list' ? '!text-selection !bg-background' : '']"
                @click="setNodeViewMode('list')"
              >
                <Icon icon="tabler:table" :width="14" :height="14" />
              </Button>
              <div class="relative z-1 h-8" :class="searchText ? 'w-full sm:w-60' : 'w-8'">
                <div class="absolute top-0 right-0 w-full">
                  <Input
                    v-model="searchText" placeholder="搜索名称、地区、IP、CPU"
                    aria-label="搜索节点"
                    class="transition-all border-none shadow-none h-8 bg-background/50 backdrop-blur-xs rounded-md hover:!bg-background/60 focus:!pl-7.5 focus:placeholder:!text-muted-foreground focus:!bg-background/80 focus:!ring-slate-500/10"
                    :class="searchText ? '!w-full sm:!w-60 !pl-7.5 pr-7 placeholder:!text-muted-foreground' : 'w-8 placeholder:text-transparent focus:!w-52 sm:focus:!w-60'"
                    @keydown.esc.prevent="clearSearch"
                  />
                  <Icon
                    icon="tabler:search" :width="14" :height="14"
                    class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  />
                  <button
                    v-if="searchText"
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="清空搜索"
                    @click="clearSearch"
                  >
                    <Icon icon="tabler:x" :width="14" :height="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <TabsContent v-for="g in groups" :key="g.name" :value="g.name" class="pointer-events-auto">
            <div v-if="activeHomeTool !== 'nodes'" class="mb-4 rounded-lg bg-background/50 px-3 py-2 text-sm text-muted-foreground">
              {{ activeToolTitle }} · 当前分组：{{ g.tab }}（{{ groupNodeList.length }} 台）
            </div>
            <NodeTopologyPanel v-if="activeHomeTool === 'topology'" :nodes="groupNodeList" />
            <NodeComparePanel v-else-if="activeHomeTool === 'nodeCompare'" :nodes="groupNodeList" />
            <ProviderValuePanel v-else-if="activeHomeTool === 'providerValue'" :nodes="groupNodeList" />
            <HealthSummaryPanel v-else-if="activeHomeTool === 'healthSummary'" :nodes="groupNodeList" />
            <SnapshotExportPanel v-else-if="activeHomeTool === 'snapshotExport'" :nodes="groupNodeList" />
            <AuditLogPanel v-else-if="activeHomeTool === 'auditLog'" />
            <TransitionGroup
              v-else-if="nodeList.length !== 0 && appStore.nodeViewMode === 'card'"
              :appear="enableNodeCardTransition"
              :css="enableNodeCardTransition"
              name="node-card-switch"
              tag="div"
              :class="nodeCardGridClass"
            >
              <div
                v-for="(node, index) in nodeList"
                :key="`${getNodeItemTransitionKey(node)}:${deferNodeCards ? 'deferred' : 'full'}`"
                class="min-w-0"
                :style="getNodeItemTransitionStyle(index)"
              >
                <div
                  data-testid="node-motion-item"
                  data-node-motion-item
                  data-earth-exit-card="node"
                  class="earth-node-card-motion h-full"
                >
                  <DeferredRender
                    :enabled="deferNodeCards"
                    :idle-delay="800 + index * 70"
                    :min-height="deferredNodeCardHeight"
                  >
                    <NodeCard
                      :node="node"
                      :reduce-motion="reduceDenseNodeEffects"
                      :ping-enabled="isViewActive"
                      @click="handleNodeClick(node)"
                      @ping-click="openPingDialog(node)"
                    />
                  </DeferredRender>
                </div>
              </div>
            </TransitionGroup>
            <NodeList
              v-else-if="nodeList.length !== 0 && appStore.nodeViewMode === 'list'"
              :nodes="nodeList"
              :transition-key="appStore.nodeSelectedGroup"
              :sort-reset-key="nodeListSortResetKey"
              :ping-enabled="isViewActive"
              @click="handleNodeClick"
              @ping-click="openPingDialog"
            />
            <div v-else class="text-muted-foreground text-center py-8">
              <Empty :description="emptyDescription" />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
    <PingMonitorDialog
      v-if="pingDialogNode"
      :open="Boolean(pingDialogNode)"
      :uuid="pingDialogNode.uuid"
      :node-name="pingDialogNode.name"
      @update:open="!$event && (pingDialogNode = null)"
    />
  </div>
</template>

<style scoped>
.home-view--motion {
  animation: home-view-enter 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.home-view[data-earth-motion-state='entering'],
.home-view[data-earth-motion-state='returning'] {
  position: relative;
  z-index: 71;
  pointer-events: none;
}

@keyframes home-view-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.home-controls-scroll {
  scrollbar-width: none;
}

.home-controls-scroll::-webkit-scrollbar {
  display: none;
}

.home-view--motion :deep([data-node-motion-chrome]) {
  backface-visibility: hidden;
  transition:
    opacity var(--earth-card-motion-duration, 400ms) ease,
    transform var(--earth-card-motion-duration, 400ms) var(--earth-scene-easing, cubic-bezier(0.3, 0.7, 0.3, 1));
  transition-delay: var(--earth-chrome-return-delay, 0ms);
}

.home-view--motion :deep([data-node-motion-chrome='filters']) {
  --earth-chrome-exit-delay: 0ms;
  --earth-chrome-return-delay: var(--earth-card-return-stagger, 15ms);
}

.home-view--motion :deep([data-node-motion-chrome='actions']) {
  --earth-chrome-exit-delay: var(--earth-card-stagger, 25ms);
  --earth-chrome-return-delay: 0ms;
}

.home-view--motion :deep([data-node-motion-item]) {
  backface-visibility: hidden;
  transform-origin: center;
  transition:
    opacity var(--earth-card-motion-duration, 400ms) ease var(--earth-card-return-delay, 0ms),
    transform var(--earth-card-motion-duration, 400ms) var(--earth-scene-easing, cubic-bezier(0.3, 0.7, 0.3, 1))
      var(--earth-card-return-delay, 0ms) !important;
}

.home-view:not(.home-view--motion) :deep([data-node-motion-item]) {
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}

.home-view--earth-immersive :deep([data-node-motion-chrome]) {
  opacity: 0;
  pointer-events: none;
  transition-delay: var(--earth-chrome-exit-delay, 0ms);
}

.home-view--earth-immersive :deep([data-node-motion-chrome='filters']) {
  transform: translate3d(var(--earth-toolbar-exit-x, calc(-100vw - 2rem)), 0, 0);
}

.home-view--earth-immersive :deep([data-node-motion-chrome='actions']) {
  transform: translate3d(var(--earth-toolbar-exit-x, calc(100vw + 2rem)), 0, 0);
}

.home-view--earth-immersive :deep([data-node-motion-item][data-earth-exit-active='true']) {
  opacity: 0;
  pointer-events: none;
  transform: translate3d(var(--earth-card-exit-x, calc(-100vw - 100%)), var(--earth-card-exit-y, 0), 0)
    rotate(var(--earth-card-exit-rotation, -2deg)) !important;
  transition-delay: var(--earth-card-exit-delay, 20ms) !important;
}

.home-view--earth-reversing :deep([data-node-motion-item][data-earth-exit-active='true']),
.home-view--earth-reversing :deep([data-node-motion-chrome]) {
  transition-delay: 0s !important;
}

.node-card-switch-enter-active,
.node-card-switch-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 180ms ease;
}

.node-card-switch-enter-active {
  transition-delay: var(--node-item-delay, 0ms);
}

.node-card-switch-move {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.node-card-switch-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
  filter: blur(3px);
}

.node-card-switch-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.99);
  filter: blur(2px);
}

@media (prefers-reduced-motion: reduce) {
  .home-view--motion {
    animation: none;
  }

  .node-card-switch-enter-active,
  .node-card-switch-leave-active,
  .node-card-switch-move {
    transition: none;
    transition-delay: 0ms;
  }

  .node-card-switch-enter-from,
  .node-card-switch-leave-to {
    opacity: 1;
    transform: none;
    filter: none;
  }

  .home-view--motion :deep([data-node-motion-chrome]),
  .home-view--motion :deep([data-node-motion-item]) {
    transition: none !important;
    transition-delay: 0s !important;
  }

  .home-view--earth-immersive :deep([data-node-motion-chrome]),
  .home-view--earth-immersive :deep([data-node-motion-item][data-earth-exit-active='true']) {
    opacity: 0;
    transform: none !important;
  }
}
</style>
