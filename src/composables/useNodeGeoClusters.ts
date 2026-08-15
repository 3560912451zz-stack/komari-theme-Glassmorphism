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
  nodeName: string
  code: string
  coord: [number, number]
  label: string
  asn?: string
  org?: string
  servers: number
  onlineServers: number
}

export interface ClusterSummary {
  clusters: RegionCluster[]
  totalServers: number
  onlineServers: number
}

const IP_GEO_LOOKUP_BATCH_SIZE = 8
const IP_GEO_RETRY_INTERVAL_MS = 10 * 60 * 1000
const UNKNOWN_COORD: [number, number] = [0, 0]
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/
const CITY_KEY_SEPARATOR_REGEX = /[._-]+/g
const CITY_KEY_SPACES_REGEX = /\s+/g

interface NodeClusterInfo {
  locationId: string
  code: string
  coord: [number, number]
  label: string
  asn?: string
  org?: string
}

interface ClusterCandidate {
  node: NodeData
  nodeId: string
  info: NodeClusterInfo
}

function normalizeCountryCode(value: string | undefined | null): string | null {
  const code = value?.trim().toUpperCase()
  return code && COUNTRY_CODE_REGEX.test(code) ? code : null
}

function coordinateGroupKey(coord: [number, number]): string {
  return `${coord[0].toFixed(2)}:${coord[1].toFixed(2)}`
}

function normalizeCityKey(value: string | undefined): string | null {
  const city = value
    ?.normalize('NFKC')
    .toLowerCase()
    .replace(CITY_KEY_SEPARATOR_REGEX, ' ')
    .replace(CITY_KEY_SPACES_REGEX, ' ')
    .trim()
  return city || null
}

function nodeClusterInfo(node: NodeData, nodeId: string, ipGeoMap: ReadonlyMap<string, IpGeo>): NodeClusterInfo {
  const ip = node.ipv4 || node.ipv6
  const geo = ip ? ipGeoMap.get(ip) : undefined
  const regionAlias = getRegionByAlias(node.region)
  const regionCode = getCountryCodeFromRegion(node.region) || regionAlias?.code || null
  const code = normalizeCountryCode(regionCode) || 'UN'

  if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
    const label = formatCityNameZh(geo.city) || getRegionDisplayName(node.region) || getRegionDisplayName(code) || 'Unknown location'
    const coord: [number, number] = [geo.lat, geo.lng]
    const cityKey = normalizeCityKey(geo.city)
    return {
      locationId: cityKey ? `city:${code}:${cityKey}` : `coord:${code}:${coordinateGroupKey(coord)}`,
      code,
      coord,
      label,
      asn: geo.asn,
      org: geo.org,
    }
  }

  return {
    locationId: `node:${nodeId}`,
    code,
    coord: getCoordByCode(code) ?? UNKNOWN_COORD,
    label: getRegionDisplayName(node.region) || getRegionDisplayName(code) || 'Unknown location',
  }
}

export function buildNodeGeoClusterSummary(nodes: NodeData[], ipGeoMap: ReadonlyMap<string, IpGeo>): ClusterSummary {
  let onlineServers = 0
  const candidates: ClusterCandidate[] = []

  for (const [index, node] of nodes.entries()) {
    if (node.online)
      onlineServers += 1

    const nodeId = node.uuid || `node-${index}`
    const info = nodeClusterInfo(node, nodeId, ipGeoMap)
    candidates.push({ node, nodeId, info })
  }

  const locationGroups = new Map<string, ClusterCandidate[]>()
  for (const candidate of candidates) {
    const group = locationGroups.get(candidate.info.locationId) ?? []
    group.push(candidate)
    locationGroups.set(candidate.info.locationId, group)
  }

  const clusters = Array.from(locationGroups, ([locationId, group]): RegionCluster => {
    group.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    const representative = group[0]!
    const representativeName = representative.node.name?.trim() || representative.nodeId
    const locationName = representative.info.label
    const asn = group.find(candidate => candidate.info.asn)?.info.asn
    const org = group.find(candidate => candidate.info.org)?.info.org
    return {
      id: locationId,
      nodeName: group.length > 1 ? `${locationName} (${group.length})` : representativeName,
      code: representative.info.code,
      coord: representative.info.coord,
      label: locationName,
      asn,
      org,
      servers: group.length,
      onlineServers: group.filter(candidate => candidate.node.online).length,
    }
  })

  return {
    clusters,
    totalServers: nodes.length,
    onlineServers,
  }
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

  const clusterSummary = computed<ClusterSummary>(() => buildNodeGeoClusterSummary(displayNodes.value, ipGeoMap.value))

  const regionClusters = computed<RegionCluster[]>(() => clusterSummary.value.clusters)
  const totalServers = computed(() => clusterSummary.value.totalServers)
  const onlineServers = computed(() => clusterSummary.value.onlineServers)
  const offlineServers = computed(() => totalServers.value - onlineServers.value)

  function clusterKey(cluster: RegionCluster) {
    return `${cluster.id}:${cluster.nodeName}:${cluster.code}:${cluster.coord[0]},${cluster.coord[1]}:${cluster.label}:${cluster.asn ?? ''}:${cluster.org ?? ''}:${cluster.servers}:${cluster.onlineServers}`
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
