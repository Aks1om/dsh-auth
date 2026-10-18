/** Account-specific ChatGPT catalog, using the same endpoint as Codex. */
import type { PiAiProvider } from './pi-ai.js'
import type { StoredOAuthCredential } from './credentials.js'

type Model = ReturnType<PiAiProvider['getModels']>[number]
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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
    if (entry.visibility === 'list') visible.add(model.id)
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
    if (this.versionUntil <= Date.now()) this.version = undefined
    this.versionUntil = Date.now() + 60 * 60_000
    return this.version ??= this.request('https://registry.npmjs.org/@openai%2Fcodex/latest', {
      signal: AbortSignal.timeout(4000),
    }).then(async response => {
      if (!response.ok) throw new Error('Could not resolve the Codex client version')
      const manifest = await response.json() as { version?: unknown }
      if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(manifest.version)) {
        throw new Error('Invalid Codex client version')
      }
      return manifest.version
    }).catch(error => { this.version = undefined; throw error })
  }

  async discover(credential: StoredOAuthCredential, provider: PiAiProvider): Promise<DiscoveredCatalog> {
    if (this.cached?.access === credential.access && this.cached.until > Date.now()) return this.cached.catalog
    if (this.pending?.access === credential.access) return this.pending.task
    const task = this.load(credential, provider).catch(error => {
      // A brief outage must not replace a successfully discovered catalog,
      // but another account must never inherit this account's cache.
      if (this.cached?.access === credential.access) return this.cached.catalog
      throw error
    })
    this.pending = { access: credential.access, task }
    try {
      const catalog = await task
      this.cached = { access: credential.access, until: Date.now() + 5 * 60_000, catalog }
      return catalog
    } finally {
      if (this.pending?.task === task) this.pending = undefined
    }
  }

  private async load(credential: StoredOAuthCredential, provider: PiAiProvider): Promise<DiscoveredCatalog> {
    const version = await this.clientVersion()
    const accountId = (credential as StoredOAuthCredential & { accountId?: string }).accountId
    const response = await this.request(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        ...(accountId === undefined ? {} : { 'ChatGPT-Account-Id': accountId }),
        originator: 'codex_cli_rs',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`ChatGPT model metadata HTTP ${response.status}`)
    return parseCodexCatalog(await response.json(), provider)
  }
}
