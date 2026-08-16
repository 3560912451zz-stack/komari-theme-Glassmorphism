import type { NodeData } from '@/stores/nodes'
import type { IpGeo } from '@/utils/ipGeoHelper'
import { computed, ref, watch } from 'vue'
import { getNodeIps, lookupNodeGeo } from '@/services/provider.service'
import { useNodesStore } from '@/stores/nodes'
import { formatCityNameZh } from '@/utils/cityNameHelper'
import { getCoordByCode, getCountryCodeFromRegion } from '@/utils/geoHelper'
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
const CITY_DIACRITIC_REGEX = /\p{Mark}/gu

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
  if (!code || !COUNTRY_CODE_REGEX.test(code))
    return null

  return getRegionByAlias(code)?.code || (getCoordByCode(code) ? code : null)
}

function regionKey(region: string | undefined | null): string {
  const alias = getRegionByAlias(region ?? '')
  const code = normalizeCountryCode(getCountryCodeFromRegion(region) || alias?.code)
  return code || region?.trim().toLowerCase() || 'unknown'
}

function preferredNodeIp(node: NodeData): string | null {
  return getNodeIps(node)[0] ?? null
}

function nodeGeoKey(node: NodeData, ip: string): string {
  return JSON.stringify([
    node.uuid,
    node.ipv4?.trim() || '',
    node.ipv6?.trim() || '',
    ip.trim(),
    regionKey(node.region),
  ])
}

function coordinateGroupKey(coord: [number, number]): string {
  return `${coord[0].toFixed(2)}:${coord[1].toFixed(2)}`
}

function normalizeCityKey(value: string | undefined): string | null {
  const city = value
    ?.normalize('NFKD')
    .replace(CITY_DIACRITIC_REGEX, '')
    .toLowerCase()
    .replace(CITY_KEY_SEPARATOR_REGEX, ' ')
    .replace(CITY_KEY_SPACES_REGEX, ' ')
    .trim()
  return city || null
}

function nodeClusterInfo(node: NodeData, nodeId: string, ipGeoMap: ReadonlyMap<string, IpGeo>): NodeClusterInfo {
  const ip = preferredNodeIp(node)
  const geo = ip ? ipGeoMap.get(nodeGeoKey(node, ip)) : undefined
  const regionAlias = getRegionByAlias(node.region)
  const regionCode = getCountryCodeFromRegion(node.region) || regionAlias?.code || null
  const configuredCode = normalizeCountryCode(regionCode)
  const geoCode = normalizeCountryCode(geo?.countryCode)
  const code = configuredCode || geoCode || 'UN'
  // Keep the configured country and the resolved coordinate as one unit. If a
  // provider omits country_code (or reports another country), fall back to the
  // configured country's representative coordinate instead of moving its flag.
  const geoCountryMatchesRegion = !configuredCode || geoCode === configuredCode

  if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng) && geoCountryMatchesRegion) {
    const city = geo.city?.trim()
    const label = geo.cityZh || formatCityNameZh(city) || city || getRegionDisplayName(node.region) || getRegionDisplayName(code) || 'Unknown location'
    const coord: [number, number] = [geo.lat, geo.lng]
    const cityKey = normalizeCityKey(city)
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

  function activeNodeGeoKeys(nodes: NodeData[]): Set<string> {
    return new Set(nodes.flatMap((node) => {
      const ip = preferredNodeIp(node)
      return ip ? [nodeGeoKey(node, ip)] : []
    }))
  }

  function pruneGeoState(nodes: NodeData[]): void {
    const activeKeys = activeNodeGeoKeys(nodes)
    const next = new Map([...ipGeoMap.value].filter(([key]) => activeKeys.has(key)))
    if (next.size !== ipGeoMap.value.size)
      ipGeoMap.value = next

    for (const key of failedIpAttempts.keys()) {
      if (!activeKeys.has(key))
        failedIpAttempts.delete(key)
    }
  }

  async function resolveNodeCities(nodes: NodeData[], generation: number): Promise<void> {
    const targets: Array<{ key: string, node: NodeData }> = []
    const seenKeys = new Set<string>()
    const now = Date.now()

    for (const node of nodes) {
      const ip = preferredNodeIp(node)
      if (!ip)
        continue

      const key = nodeGeoKey(node, ip)
      if (seenKeys.has(key) || ipGeoMap.value.has(key))
        continue

      const failedAt = failedIpAttempts.get(key)
      if (failedAt && now - failedAt < IP_GEO_RETRY_INTERVAL_MS)
        continue

      seenKeys.add(key)
      targets.push({ key, node: { ...node, ipv4: node.ipv4?.trim(), ipv6: node.ipv6?.trim() } as NodeData })
    }

    for (let i = 0; i < targets.length; i += IP_GEO_LOOKUP_BATCH_SIZE) {
      const batch = targets.slice(i, i + IP_GEO_LOOKUP_BATCH_SIZE)
      const results = await Promise.all(batch.map(async ({ key, node }) => {
        const geo = await lookupNodeGeo(node)
        return { key, geo }
      }))

      if (generation !== resolveGeneration)
        return

      const activeKeys = activeNodeGeoKeys(displayNodes.value)
      const resolved = results.filter((result): result is { key: string, geo: IpGeo } => result.geo !== null && activeKeys.has(result.key))

      for (const { key, geo } of results) {
        if (!activeKeys.has(key))
          continue
        if (geo)
          failedIpAttempts.delete(key)
        else
          failedIpAttempts.set(key, Date.now())
      }

      if (!resolved.length)
        continue

      const next = new Map(ipGeoMap.value)
      for (const { key, geo } of resolved) {
        next.set(key, geo)
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
    .map(node => `${node.uuid}:${node.ipv4 || ''}:${node.ipv6 || ''}:${regionKey(node.region)}`)
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
