import type { PublicSettings } from '@/utils/api'
import type { Client, NodeStatus } from '@/utils/rpc'

const GIB = 1024 ** 3
const TIB = 1024 ** 4
const now = new Date()
const nowIso = now.toISOString()
const expiresIso = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()

interface MockNodeDefinition {
  arch?: string
  cpu: number
  cpuCores: number
  cpuName: string
  diskRatio: number
  gpu?: boolean
  memoryGiB: number
  memoryRatio: number
  name: string
  offline?: boolean
  region: string
  trafficRatio?: number
}

const definitions: MockNodeDefinition[] = [
  {
    name: 'Los Angeles Core',
    region: 'US',
    cpuName: 'Intel Xeon Gold 6152',
    cpuCores: 4,
    cpu: 12.8,
    memoryGiB: 8,
    memoryRatio: 0.34,
    diskRatio: 0.26,
  },
  {
    name: 'Hong Kong Edge - Long Name Demo',
    region: 'HK',
    cpuName: 'AMD EPYC 7551',
    cpuCores: 2,
    cpu: 21.6,
    memoryGiB: 4,
    memoryRatio: 0.48,
    diskRatio: 0.42,
  },
  {
    name: 'Tokyo High CPU',
    region: 'JP',
    cpuName: 'AMD EPYC 7B13',
    cpuCores: 8,
    cpu: 94.7,
    memoryGiB: 16,
    memoryRatio: 0.67,
    diskRatio: 0.31,
  },
  {
    name: 'Singapore A100',
    region: 'SG',
    cpuName: 'AMD EPYC 9654',
    cpuCores: 16,
    cpu: 36.4,
    memoryGiB: 32,
    memoryRatio: 0.58,
    diskRatio: 0.37,
    gpu: true,
  },
  {
    name: 'Frankfurt Storage',
    region: 'DE',
    cpuName: 'Intel Xeon E5-2680 v4',
    cpuCores: 4,
    cpu: 18.2,
    memoryGiB: 8,
    memoryRatio: 0.41,
    diskRatio: 0.79,
  },
  {
    name: 'London Offline',
    region: 'GB',
    cpuName: 'Intel N100',
    cpuCores: 2,
    cpu: 0,
    memoryGiB: 4,
    memoryRatio: 0,
    diskRatio: 0.22,
    offline: true,
  },
  {
    name: 'Taipei Traffic Alert',
    region: 'TW',
    cpuName: 'Ampere Altra Max M128-30',
    cpuCores: 8,
    cpu: 43.5,
    memoryGiB: 16,
    memoryRatio: 0.52,
    diskRatio: 0.46,
    trafficRatio: 0.93,
    arch: 'aarch64',
  },
  {
    name: 'Sydney IPv6',
    region: 'AU',
    cpuName: 'AMD Ryzen 9 9950X',
    cpuCores: 6,
    cpu: 27.3,
    memoryGiB: 12,
    memoryRatio: 0.45,
    diskRatio: 0.33,
  },
]

function uuidFor(index: number): string {
  return `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function createClient(definition: MockNodeDefinition, index: number): Client {
  const uuid = uuidFor(index)
  const diskTotal = (index % 3 + 1) * 80 * GIB

  return {
    uuid,
    name: definition.name,
    cpu_name: definition.cpuName,
    virtualization: index % 3 === 0 ? 'docker' : 'kvm',
    arch: definition.arch ?? 'x86_64',
    cpu_cores: definition.cpuCores,
    cpu_physical_cores: Math.max(1, Math.floor(definition.cpuCores / 2)),
    os: index % 2 === 0 ? 'Ubuntu 24.04 LTS' : 'Debian GNU/Linux 12',
    kernel_version: '6.8.0-local-preview',
    gpu_name: definition.gpu ? 'NVIDIA A100 80GB PCIe' : '',
    ipv4: `192.0.2.${index + 20}`,
    ipv6: `2001:db8:${index + 1}::20`,
    region: definition.region,
    public_remark: 'Local preview fixture',
    mem_total: definition.memoryGiB * GIB,
    swap_total: index % 3 === 0 ? 2 * GIB : 0,
    disk_total: diskTotal,
    version: '1.2.6-preview',
    weight: index,
    price: 5.9 + index * 1.5,
    billing_cycle: 365,
    auto_renewal: index % 2 === 0,
    currency: 'USD',
    expired_at: expiresIso,
    group: index < 4 ? 'Preview Production' : 'Preview Edge',
    tags: index % 2 === 0 ? 'core<jade>;preview<blue>' : 'edge<orange>',
    hidden: false,
    traffic_limit: 2 * TIB,
    traffic_limit_type: 'sum',
    created_at: nowIso,
    updated_at: nowIso,
  }
}

function createStatus(definition: MockNodeDefinition, index: number): NodeStatus {
  const uuid = uuidFor(index)
  const client = createClient(definition, index)
  const online = !definition.offline
  const trafficRatio = definition.trafficRatio ?? 0.12 + index * 0.055
  const netTotal = Math.round(client.traffic_limit * trafficRatio)

  return {
    client: uuid,
    time: nowIso,
    cpu: online ? definition.cpu : 0,
    gpu: definition.gpu ? 68.5 : 0,
    gpu_count: definition.gpu ? 1 : 0,
    gpu_average_usage: definition.gpu ? 68.5 : 0,
    gpu_detailed_info: definition.gpu
      ? [{ name: 'NVIDIA A100', utilization: 68.5, memory_total: 80 * GIB, memory_used: 48 * GIB, temperature: 59 }]
      : [],
    ram: online ? Math.round(client.mem_total * definition.memoryRatio) : 0,
    ram_total: client.mem_total,
    swap: online && client.swap_total ? 320 * 1024 ** 2 : 0,
    swap_total: client.swap_total,
    load: online ? 0.24 + index * 0.17 : 0,
    load5: online ? 0.18 + index * 0.12 : 0,
    load15: online ? 0.12 + index * 0.09 : 0,
    temp: online ? 38 + index * 3 : 0,
    disk: Math.round(client.disk_total * definition.diskRatio),
    disk_total: client.disk_total,
    net_in: online ? 96_000 + index * 58_000 : 0,
    net_out: online ? 68_000 + index * 43_000 : 0,
    net_total_up: Math.round(netTotal * 0.42),
    net_total_down: Math.round(netTotal * 0.58),
    traffic_up: online ? (index + 1) * 2 * GIB : 0,
    traffic_down: online ? (index + 1) * 4 * GIB : 0,
    process: online ? 74 + index * 8 : 0,
    connections: online ? 150 + index * 31 : 0,
    connections_udp: online ? 9 + index * 2 : 0,
    online,
    uptime: online ? (index + 2) * 86_400 : 0,
    message: definition.offline ? 'Previewing an offline node' : '',
    updated_at: nowIso,
    ping: {
      1: {
        name: 'Preview probe',
        latest: online ? 38 + index * 11 : -1,
        avg: online ? 45 + index * 10 : -1,
        tail: online ? 72 + index * 13 : -1,
        loss: online ? index * 1.2 : 100,
        min: online ? 26 + index * 7 : -1,
        max: online ? 104 + index * 15 : -1,
      },
    },
  }
}

export const mockClients = Object.fromEntries(
  definitions.map((definition, index) => [uuidFor(index), createClient(definition, index)]),
) as Record<string, Client>

export const mockStatuses = Object.fromEntries(
  definitions.map((definition, index) => [uuidFor(index), createStatus(definition, index)]),
) as Record<string, NodeStatus>

export const mockPublicSettings: PublicSettings = {
  allow_cors: true,
  custom_body: '',
  custom_head: '',
  description: 'Local node-card motion preview',
  disable_password_login: false,
  oauth_enable: false,
  oauth_provider: null,
  ping_record_preserve_time: 0,
  private_site: false,
  record_enabled: false,
  record_preserve_time: 0,
  sitename: 'Komari Motion Preview',
  theme: 'Glassmorphism',
  theme_settings: {
    dataUpdateInterval: 60,
    rpcTransportMode: 'http',
    defaultViewMode: 'card',
    nodeCardSize: 'compact',
    earthRenderer: 'realistic',
    hideEarth: false,
    stopEarth: false,
    visitorInfoEnabled: false,
    disablePageAnimation: false,
    homeQuickControlsEnabled: true,
    homeToolsEnabled: false,
    cityTranslationCache: '{"v":1,"entries":{}}',
  },
  visitor_audit_enabled: false,
}
