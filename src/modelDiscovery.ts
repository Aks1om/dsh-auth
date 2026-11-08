/** Account-specific ChatGPT catalog, using the same endpoint as Codex. */
import type { PiAiProvider } from './pi-ai.js'
import type { StoredOAuthCredential } from './credentials.js'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type Model = ReturnType<PiAiProvider['getModels']>[number]
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const VERSION_TTL = 60 * 60_000
const CATALOG_TTL = 5 * 60_000
const VERSION_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest'
const MODEL_URL = 'https://chatgpt.com/backend-api/codex/models'
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(value)

// Requests from different discovery instances in this process can target the
// same file. Keep an ordering while any such request is in flight. Only a
// newer successful response may supersede an earlier successful response.
const catalogFlights = new Map<string, { next: number; committed: Map<string, number>; active: number }>()
function catalogFlight(key: string): { commit: (cacheKey: string) => boolean; release: () => void } {
  let state = catalogFlights.get(key)
  if (state === undefined) {
    state = { next: 0, committed: new Map(), active: 0 }
    catalogFlights.set(key, state)
  }
  const shared = state
  const ticket = ++shared.next
  shared.active++
  return {
    commit: cacheKey => {
      if (ticket < (shared.committed.get(cacheKey) ?? 0)) return false
      shared.committed.set(cacheKey, ticket)
      return true
    },
    release: () => {
      if (--shared.active === 0 && catalogFlights.get(key) === shared) catalogFlights.delete(key)
    },
  }
}

// The cache is advisory. Reject insecure, future-dated, oversized or malformed
// entries and treat every filesystem failure exactly like a cache miss.
function cacheDirectory(): string {
  return join(resolve(process.env['DSH_HOME'] || join(homedir(), '.dsh')), 'dsh-auth', 'model-cache')
}
function secureDirectory(create: boolean): string {
  const root = resolve(process.env['DSH_HOME'] || join(homedir(), '.dsh'))
  // An absent root is a miss, not an invitation to create arbitrary parents.
  const rootStat = lstatSync(root)
  const owned = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid()
  if (!rootStat.isDirectory() || !owned(rootStat.uid) || (rootStat.mode & 0o022) !== 0 || realpathSync(root) !== root) throw new Error('Unsafe cache root')
  let current = root
  for (const part of ['dsh-auth', 'model-cache']) {
    current = join(current, part)
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stat = lstatSync(current)
    if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & 0o077) !== 0 || realpathSync(current) !== current) throw new Error('Unsafe cache directory')
  }
  return current
}
function cacheRead(key: string, ttl: number): { data: unknown; time: number } | undefined {
  try {
    const dir = secureDirectory(false)
    const path = join(dir, `${key}.json`)
    const file = lstatSync(path)
    if (!file.isFile() || (typeof process.getuid === 'function' && file.uid !== process.getuid()) || (file.mode & 0o077) !== 0 || file.size > 2_000_000) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'data,time' || typeof record.time !== 'number' || !Number.isFinite(record.time) || record.time > Date.now() || Date.now() - record.time >= ttl) return undefined
    return { data: record.data, time: record.time }
  } catch { return undefined }
}
function cacheWrite(key: string, data: unknown): void {
  let temporary: string | undefined
  try {
    const dir = secureDirectory(true)
    const target = join(dir, `${key}.json`)
    try {
      const existing = lstatSync(target)
      if (!existing.isFile() || (typeof process.getuid === 'function' && existing.uid !== process.getuid()) || (existing.mode & 0o077) !== 0) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    temporary = join(dir, `.${randomBytes(16).toString('hex')}.tmp`)
    writeFileSync(temporary, JSON.stringify({ time: Date.now(), data }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
  } catch { /* Never make discovery depend on disk caching. */ }
  finally { if (temporary !== undefined) try { unlinkSync(temporary) } catch { /* renamed or unavailable */ } }
}

// Persist only the fields consumed by parseCodexCatalog, never arbitrary server
// metadata. Strictly validate cached records as well as newly received data.
function sanitizedCatalog(value: unknown, secrets: readonly string[]): { models: Record<string, unknown>[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  if (Object.keys(root).join(',') !== 'models' || !Array.isArray(root.models) || root.models.length > 2000) return undefined
  const models: Record<string, unknown>[] = []
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[\p{L}\p{N} ._+()/-]+$/u.test(v)
    && !/(?:^|[^a-z0-9])(?:bearer|sk[-_]|sess[-_]|token[-_]|[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/iu.test(v)
    && !secrets.some(s => s.length > 0 && v.includes(s))
  for (const raw of root.models) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const row = raw as Record<string, unknown>
    if (Object.keys(row).some(k => !['slug', 'display_name', 'visibility', 'context_window', 'input_modalities', 'supported_reasoning_levels'].includes(k)) || !text(row.slug)) return undefined
    if (row.display_name !== undefined && !text(row.display_name)) return undefined
    if (row.visibility !== undefined && !text(row.visibility)) return undefined
    if (row.context_window !== undefined && (typeof row.context_window !== 'number' || !Number.isSafeInteger(row.context_window) || row.context_window <= 0 || row.context_window > 100_000_000)) return undefined
    if (row.input_modalities !== undefined && (!Array.isArray(row.input_modalities) || row.input_modalities.some(v => v !== 'text' && v !== 'image'))) return undefined
    if (row.supported_reasoning_levels !== undefined) {
      // Preserve safe future enum values: both fresh and cached payloads go
      // through the same parser, which derives reasoning from the full list.
      // Never persist arbitrary metadata or credential-looking strings.
      if (!Array.isArray(row.supported_reasoning_levels) || row.supported_reasoning_levels.some(v => !v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).join(',') !== 'effort' || !text(v.effort) || !/^[a-z][a-z0-9_-]*$/iu.test(v.effort) || ['constructor', 'prototype', '__proto__'].includes(v.effort.toLowerCase()))) return undefined
    }
    models.push(row)
  }
  return { models }
}

function projectCatalog(value: unknown): unknown {
  const rows = (value as { models?: unknown } | null)?.models
  if (!Array.isArray(rows)) return undefined
  return { models: rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const source = row as Record<string, unknown>
    return Object.fromEntries(['slug', 'display_name', 'visibility', 'context_window', 'input_modalities', 'supported_reasoning_levels']
      .filter(key => source[key] !== undefined).map(key => [key, key === 'supported_reasoning_levels' && Array.isArray(source[key])
        ? source[key].map((level: unknown) => ({ effort: (level as { effort?: unknown } | null)?.effort })) : source[key]]))
  }) }
}

export interface DiscoveredCatalog {
  provider: PiAiProvider
  visible: ReadonlySet<string>
}

/** Translate server metadata into descriptors the installed wire adapter can use. */
export function parseCodexCatalog(value: unknown, provider: PiAiProvider): DiscoveredCatalog {
  const rows = (value as { models?: unknown } | null)?.models
  if (!Array.isArray(rows)) throw new Error('Invalid ChatGPT model metadata')
  const known = new Map(provider.getModels().map(model => [model.id, model]))
  const template = provider.getModels()[0]
  if (template === undefined) throw new Error('ChatGPT wire adapter has no model template')
  const visible = new Set<string>()
  const models = new Map<string, Model>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    if (typeof entry.slug !== 'string' || entry.slug === '') continue
    const original = known.get(entry.slug)
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.flatMap(level => {
          if (level === null || typeof level !== 'object') return []
          const effort = (level as { effort?: unknown }).effort
          return typeof effort === 'string' ? [effort] : []
        })
      : []
    const thinkingLevelMap = Object.fromEntries(LEVELS.map(level => [level, efforts.includes(level) ? level : null]))
    const modalities = Array.isArray(entry.input_modalities)
      ? entry.input_modalities.filter((input): input is 'text' | 'image' => input === 'text' || input === 'image')
      : original?.input ?? ['text', 'image']
    const context = typeof entry.context_window === 'number' && entry.context_window > 0
      ? entry.context_window : original?.contextWindow ?? template.contextWindow
    const model: Model = {
      ...(original ?? template),
      id: entry.slug,
      name: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
      input: modalities.length > 0 ? modalities : ['text'],
      contextWindow: context,
      // The endpoint does not advertise output pricing or a maximum output.
      // Keep known values, but do not invent another model's prices for new ids.
      maxTokens: original?.maxTokens ?? Math.min(template.maxTokens, context),
      cost: original?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: efforts.length > 0,
      thinkingLevelMap,
    }
    models.set(model.id, model)
    // The endpoint may omit visibility for models that are available to the
    // signed-in account. Only an explicit `hide` should suppress a model from
    // the picker; requiring exactly `list` silently drops new visibility
    // states and leaves otherwise usable models undiscoverable.
    if (entry.visibility !== 'hide') visible.add(model.id)
  }
  if (visible.size === 0) throw new Error('ChatGPT model metadata has no picker-visible models')
  // Older saved sessions may still name a retired model; keep it resolvable,
  // while the picker offers only the currently advertised account catalog.
  for (const [id, model] of known) if (!models.has(id)) models.set(id, model)
  return { provider: { ...provider, getModels: () => [...models.values()] }, visible }
}

export class CodexModelDiscovery {
  private version: Promise<string> | undefined
  private versionUntil = 0
  private cached: { access: string; until: number; catalog: DiscoveredCatalog } | undefined
  private pending: { access: string; task: Promise<DiscoveredCatalog> } | undefined

  constructor(private readonly request: typeof fetch = fetch) {}

  private clientVersion(): Promise<string> {
    // Server catalogs are version-gated. Query the official client's current
    // version instead of freezing a version that hides newly released models.
    if (this.version !== undefined && this.versionUntil > Date.now()) return this.version
    this.version = undefined
    const key = `version-${digest(VERSION_URL)}`
    const saved = cacheRead(key, VERSION_TTL)
    if (saved !== undefined && validVersion(saved.data)) {
      this.versionUntil = saved.time + VERSION_TTL
      return this.version = Promise.resolve(saved.data)
    }
    // Keep concurrent calls deduplicated while the request is pending.
    this.versionUntil = Infinity
    return this.version = this.request(VERSION_URL, {
      signal: AbortSignal.timeout(4000),
    }).then(async response => {
      if (!response.ok) throw new Error('Could not resolve the Codex client version')
      const manifest = await response.json() as { version?: unknown }
      if (!validVersion(manifest.version)) {
        throw new Error('Invalid Codex client version')
      }
      cacheWrite(key, manifest.version)
      this.versionUntil = Date.now() + VERSION_TTL
      return manifest.version
    }).catch(error => { this.version = undefined; this.versionUntil = 0; throw error })
  }

  async discover(credential: StoredOAuthCredential, provider: PiAiProvider): Promise<DiscoveredCatalog> {
    const accountId = (credential as StoredOAuthCredential & { accountId?: string }).accountId
    const credentialsOverride = process.env['DSH_AUTH_CREDENTIALS'] ?? ''
    const directory = cacheDirectory()
    const identity = digest(JSON.stringify([credential.access, accountId, credentialsOverride, directory]))
    if (this.cached?.access === identity && this.cached.until > Date.now()) return this.cached.catalog
    if (this.pending?.access === identity) return this.pending.task
    // Reserve before version lookup: an older lookup may itself finish last.
    const flight = catalogFlight(identity)
    const task = this.load(credential, provider, directory, credentialsOverride, flight, catalog => {
      this.cached = { access: identity, until: Date.now() + CATALOG_TTL, catalog }
    }).finally(flight.release).catch(error => {
      // A brief outage must not replace a successfully discovered catalog,
      // but another account must never inherit this account's cache.
      if (this.cached?.access === identity) return this.cached.catalog
      throw error
    })
    this.pending = { access: identity, task }
    try {
      return await task
    } finally {
      if (this.pending?.task === task) this.pending = undefined
    }
  }

  private async load(
    credential: StoredOAuthCredential,
    provider: PiAiProvider,
    directory: string,
    credentialsOverride: string,
    flight: ReturnType<typeof catalogFlight>,
    publishCache: (catalog: DiscoveredCatalog) => void,
  ): Promise<DiscoveredCatalog> {
    const version = await this.clientVersion()
    const accountId = (credential as StoredOAuthCredential & { accountId?: string }).accountId
    // Token digest is intentionally conservative: a refresh misses rather than
    // trusting an unverified accountId or sharing across credential profiles.
    const key = `catalog-${digest(JSON.stringify([MODEL_URL, version, credential.access, accountId, credentialsOverride]))}`
    const secrets = [credential.access, credential.refresh, accountId ?? '']
    const sameContext = (): boolean => cacheDirectory() === directory && (process.env['DSH_AUTH_CREDENTIALS'] ?? '') === credentialsOverride
    const saved = sameContext() ? sanitizedCatalog(cacheRead(key, CATALOG_TTL)?.data, secrets) : undefined
    if (saved !== undefined) {
      try {
        const catalog = parseCodexCatalog(saved, provider)
        publishCache(catalog)
        return catalog
      } catch { /* invalid cache: fetch */ }
    }
    const response = await this.request(`${MODEL_URL}?client_version=${encodeURIComponent(version)}`, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        ...(accountId === undefined ? {} : { 'ChatGPT-Account-Id': accountId }),
        originator: 'codex_cli_rs',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`ChatGPT model metadata HTTP ${response.status}`)
    const payload: unknown = await response.json()
    const catalog = parseCodexCatalog(payload, provider)
    const clean = sanitizedCatalog(projectCatalog(payload), secrets)
    if (flight.commit(key)) {
      if (sameContext() && clean !== undefined) cacheWrite(key, clean)
      publishCache(catalog)
    }
    return catalog
  }
}
