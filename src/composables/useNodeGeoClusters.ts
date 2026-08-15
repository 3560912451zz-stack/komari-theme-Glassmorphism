import type { NodeData } from '@/stores/nodes'
import type { IpGeo } from '@/utils/ipGeoHelper'
import { computed, ref, watch } from 'vue'
import { useNodesStore } from '@/stores/nodes'
import { formatCityNameZh } from '@/utils/cityNameHelper'
import { getCoordByCode, getCountryCodeFromRegion } from '@/utils/geoHelper'
import { lookupIpGeo } from '@/utils/ipGeoHelper'
import { getRegionByAlias, getRegionDisplayName } from '@/utils/regionHelper'

interface UseNodeGeoClustersOptions {
  nodes?: () => NodeData[] | undefined
}

export interface RegionCluster {
  id: string
  nodeUuid: string
  nodeName: string
  code: string
  coord: [number, number]
  label: string
  asn?: string
  org?: string
  servers: number
  onlineServers: number
}

interface ClusterSummary {
  clusters: RegionCluster[]
  totalServers: number
  onlineServers: number
}

const IP_GEO_LOOKUP_BATCH_SIZE = 8
const IP_GEO_RETRY_INTERVAL_MS = 10 * 60 * 1000
const UNKNOWN_COORD: [number, number] = [0, 0]
const JITTER_BASE_DEGREES = 1.8
const JITTER_STEP_DEGREES = 0.9
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/

interface NodeClusterInfo {
  code: string
  coord: [number, number]
  label: string
  asn?: string
  org?: string
}

interface ClusterCandidate {
  node: NodeData
  info: NodeClusterInfo
}

function normalizeCountryCode(value: string | undefined | null): string | null {
  const code = value?.trim().toUpperCase()
  return code && COUNTRY_CODE_REGEX.test(code) ? code : null
}

function coordinateGroupKey(coord: [number, number]): string {
  return `${coord[0].toFixed(2)}:${coord[1].toFixed(2)}`
}

function wrapLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180
}

function spreadCoordinate(coord: [number, number], index: number): [number, number] {
  if (index === 0)
    return coord

  const radius = JITTER_BASE_DEGREES + (Math.ceil(index / 6) - 1) * JITTER_STEP_DEGREES
  const angle = (index - 1) * GOLDEN_ANGLE
  const latitudeRadians = coord[0] * Math.PI / 180
  const longitudeScale = Math.max(0.35, Math.cos(latitudeRadians))
  const latitude = Math.min(89, Math.max(-89, coord[0] + Math.sin(angle) * radius))
  const longitude = wrapLongitude(coord[1] + Math.cos(angle) * radius / longitudeScale)
  return [latitude, longitude]
}

export function useNodeGeoClusters(options: UseNodeGeoClustersOptions = {}) {
  const nodesStore = useNodesStore()

  const displayNodes = computed(() => options.nodes?.() ?? nodesStore.visibleNodes)
  const ipGeoMap = ref(new Map<string, IpGeo>())
  const failedIpAttempts = new Map<string, number>()
  let resolveGeneration = 0

  function activeIpSet(nodes: NodeData[]): Set<string> {
    return new Set(nodes
      .map(node => node.ipv4 || node.ipv6 || '')
      .filter(Boolean))
  }

  function pruneGeoState(nodes: NodeData[]): void {
    const activeIps = activeIpSet(nodes)
    const next = new Map([...ipGeoMap.value].filter(([ip]) => activeIps.has(ip)))
    if (next.size !== ipGeoMap.value.size)
      ipGeoMap.value = next

    for (const ip of failedIpAttempts.keys()) {
      if (!activeIps.has(ip))
        failedIpAttempts.delete(ip)
    }
  }

  async function resolveNodeCities(nodes: NodeData[], generation: number): Promise<void> {
    const ips: string[] = []
    const seenIps = new Set<string>()
    const now = Date.now()

    for (const node of nodes) {
      const ip = node.ipv4 || node.ipv6
      if (!ip || seenIps.has(ip) || ipGeoMap.value.has(ip))
        continue

      const failedAt = failedIpAttempts.get(ip)
      if (failedAt && now - failedAt < IP_GEO_RETRY_INTERVAL_MS)
        continue

      seenIps.add(ip)
      ips.push(ip)
    }

    for (let i = 0; i < ips.length; i += IP_GEO_LOOKUP_BATCH_SIZE) {
      const batch = ips.slice(i, i + IP_GEO_LOOKUP_BATCH_SIZE)
      const results = await Promise.all(batch.map(async (ip) => {
        const geo = await lookupIpGeo(ip)
        return { ip, geo }
      }))

      if (generation !== resolveGeneration)
        return

      const activeIps = activeIpSet(displayNodes.value)
      const resolved = results.filter((result): result is { ip: string, geo: IpGeo } => result.geo !== null && activeIps.has(result.ip))

      for (const { ip, geo } of results) {
        if (!activeIps.has(ip))
          continue
        if (geo)
          failedIpAttempts.delete(ip)
        else
          failedIpAttempts.set(ip, Date.now())
      }

      if (!resolved.length)
        continue

      const next = new Map(ipGeoMap.value)
      for (const { ip, geo } of resolved) {
        next.set(ip, geo)
      }
      ipGeoMap.value = next
    }
  }

  function nodeClusterInfo(node: NodeData): NodeClusterInfo {
    const ip = node.ipv4 || node.ipv6
    const geo = ip ? ipGeoMap.value.get(ip) : undefined
    const regionAlias = getRegionByAlias(node.region)
    const regionCode = getCountryCodeFromRegion(node.region) || regionAlias?.code || null
    const code = normalizeCountryCode(regionCode) || 'UN'

    if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
      const label = formatCityNameZh(geo.city) || getRegionDisplayName(node.region) || getRegionDisplayName(code) || 'Unknown location'
      return {
        code,
        coord: [geo.lat, geo.lng],
        label,
        asn: geo.asn,
        org: geo.org,
      }
    }

    return {
      code,
      coord: getCoordByCode(code) ?? UNKNOWN_COORD,
      label: getRegionDisplayName(node.region) || getRegionDisplayName(code) || 'Unknown location',
    }
  }

  const clusterSummary = computed<ClusterSummary>(() => {
    let onlineServers = 0
    const candidates: ClusterCandidate[] = []

    for (const node of displayNodes.value) {
      if (node.online)
        onlineServers += 1

      const info = nodeClusterInfo(node)
      candidates.push({ node, info })
    }

    const coordinateGroups = new Map<string, ClusterCandidate[]>()
    for (const candidate of candidates) {
      const key = coordinateGroupKey(candidate.info.coord)
      const group = coordinateGroups.get(key) ?? []
      group.push(candidate)
      coordinateGroups.set(key, group)
    }

    const jitterByNode = new Map<string, [number, number]>()
    for (const group of coordinateGroups.values()) {
      group.sort((a, b) => a.node.uuid.localeCompare(b.node.uuid))
      group.forEach((candidate, index) => {
        jitterByNode.set(candidate.node.uuid, spreadCoordinate(candidate.info.coord, index))
      })
    }

    const clusters = candidates.map((candidate, index): RegionCluster => {
      const nodeId = candidate.node.uuid || `node-${index}`
      return {
        id: nodeId,
        nodeUuid: nodeId,
        nodeName: candidate.node.name?.trim() || nodeId,
        code: candidate.info.code,
        coord: jitterByNode.get(candidate.node.uuid) ?? candidate.info.coord,
        label: candidate.info.label,
        asn: candidate.info.asn,
        org: candidate.info.org,
        servers: 1,
        onlineServers: candidate.node.online ? 1 : 0,
      }
    })

    return {
      clusters,
      totalServers: displayNodes.value.length,
      onlineServers,
    }
  })

  const regionClusters = computed<RegionCluster[]>(() => clusterSummary.value.clusters)
  const totalServers = computed(() => clusterSummary.value.totalServers)
  const onlineServers = computed(() => clusterSummary.value.onlineServers)
  const offlineServers = computed(() => totalServers.value - onlineServers.value)

  function clusterKey(cluster: RegionCluster) {
    return `${cluster.id}:${cluster.nodeName}:${cluster.code}:${cluster.coord[0]},${cluster.coord[1]}:${cluster.label}:${cluster.asn ?? ''}:${cluster.org ?? ''}:${cluster.onlineServers}`
  }

  const nodeIpSignature = computed(() => displayNodes.value
    .map(node => `${node.uuid}:${node.ipv4 || node.ipv6 || ''}`)
    .join('|'))

  watch(nodeIpSignature, () => {
    resolveGeneration += 1
    pruneGeoState(displayNodes.value)
    void resolveNodeCities(displayNodes.value, resolveGeneration)
  }, { immediate: true })

  return {
    displayNodes,
    regionClusters,
    totalServers,
    onlineServers,
    offlineServers,
    clusterKey,
  }
}
