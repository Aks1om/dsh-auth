/**
 * dsh-auth — subscription OAuth sign-in as LLM provider routes.
 *
 * One cordis plugin mounts the pi-ai catalog providers that ship OAuth flows
 * (ChatGPT/Codex, Claude Pro/Max, SuperGrok) as `llm` registry routes, so
 * their models appear in every model picker the moment the plugin loads —
 * signing in is the only missing credential. `PiAiAdapter` runs with this
 * plugin's file-backed pi-ai `CredentialStore` injected
 * (`PiAiAuthInjection`): requests resolve the stored OAuth credential through
 * the provider's own auth and rotate refresh tokens under the store's lock.
 * Login/logout run over the `userQuestions` seam, so they work on any
 * interactive surface and refuse cleanly where none exists (TUI-RUN-001).
 *
 * ```yaml
 * - id: dsh-auth
 *   name: 'dsh-auth'
 *   config:
 *     providers: [openai-codex, anthropic, xai]   # subset of the mounted set
 *     # credentialsFile: /secure/path/credentials.json   # default $DSH_HOME/dsh-auth/
 *     # Per-provider catalog overrides, keyed by provider id then model id:
 *     # any optional field keeps the installed catalog's value. The example
 *     # below tunes the Codex `gpt-5.6-sol` context window to 1M tokens.
 *     # modelOverrides:
 *     #   openai-codex:
 *     #     gpt-5.6-sol:
 *     #       contextWindow: 1000000
 * ```
 *
 * Routes register individually: a route another adapter family already owns
 * (an llm-pi-ai settings profile for the same provider) is refused by the
 * registry — that refusal is logged and the remaining routes still mount.
 *
 * @module dsh-auth
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { LlmAdapter, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { CredentialFile, defaultCredentialsFile } from './credentials.js'
import { buildOAuthProfile, OAUTH_PROVIDER_IDS, type ModelOverride } from './profiles.js'
import type { AskFn } from './interaction.js'
import { createDshAuthApi, DshAuthService } from './service.js'
import { createAuthCommandHandler } from './command.js'
import type { PiAiAuthContext } from './pi-ai.js'

export const name = 'dsh-auth'
/**
 * Deliberately empty. A hard code-level inject would deadlock any
 * composition lacking the `llm`/`commands` services at boot ("pending
 * (waiting for service: …)") — the failure mode dsh-tui documented for its
 * own optional rows (#183). Both services resolve per call through
 * `ctx.get` in {@link apply}; compositions that guarantee them (the
 * dsh-tui patch row, this package's bundle patch) declare the inject at the
 * *entry* level, where a stale patch cannot deadlock a newer boot.
 */
export const inject: readonly string[] = []

/** The slice of the llm registry this plugin uses (structural, rc.6-stable). */
interface LlmRegistryLike {
  registerAdapter(providers: readonly string[], adapter: LlmAdapter): () => void
}

/** The slice of the commands registry this plugin uses (structural). */
interface CommandsLike {
  register(descriptor: {
    name: string
    description: string
    handler: (invocation: CommandInvocation) => Promise<CommandResult>
  }): () => void
}

/** Plugin configuration. */
export interface Config {
  /** Provider routes to mount; every entry must ship an OAuth flow in the installed pi-ai catalog. */
  providers?: string[]
  /** Register the standalone `/auth` command; disable when the host supplies a unified account manager. */
  command?: boolean
  /** Credential file override; default `$DSH_HOME/dsh-auth/credentials.json`. */
  credentialsFile?: string
  /**
   * Per-provider catalog overrides, keyed by provider id then model id (see
   * {@link ModelOverride}). A provider key naming a provider that is not
   * among the mounted set — or a model id the provider's catalog does not
   * ship — is refused, never skipped, so a typo lands as a boot error.
   */
  modelOverrides?: Record<string, Record<string, ModelOverride>>
}

const modelOverride = z.object({
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  providers: z.array(z.string()).default([...OAUTH_PROVIDER_IDS]),
  command: z.boolean().default(true),
  credentialsFile: z.string(),
  modelOverrides: z.dict(z.dict(modelOverride)),
})

export type { DshAuthApi, DshAuthLoginResult, DshAuthSignInStatus, DshAuthService } from './service.js'
export { createDshAuthApi } from './service.js'
export { QuestionBridge, describeEvent } from './interaction.js'
export type { AskFn, QuestionBridgeHelpers } from './interaction.js'
export { copyToClipboard, openInBrowser, openerFor } from './opener.js'
export { CredentialFile, defaultCredentialsFile } from './credentials.js'
export type { CredentialProfileInfo } from './credentials.js'
export { OAUTH_PROVIDER_IDS, buildOAuthProfile, type ModelOverride } from './profiles.js'
import { CodexModelDiscovery } from './modelDiscovery.js'
import { asStoredCredential } from './credentials.js'

/**
 * The ambient auth context providers may consult while resolving their own
 * auth. `env()` answers from the process environment; `fileExists()` answers
 * about the host process's filesystem (the paths a provider asks about —
 * `~/.aws/credentials` and friends — are facts about where this process
 * runs, not about the project under edit).
 */
function hostAuthContext(): PiAiAuthContext {
  return {
    env: async name => process.env[name],
    fileExists: path => Promise.resolve(
      path.startsWith('~/') ? existsSync(join(homedir(), path.slice(2))) : existsSync(path),
    ),
  }
}

/**
 * The adapter the plugin registers: a {@link PiAiAdapter} whose *advisory
 * catalog* is credential-gated. A provider with no stored OAuth credential
 * lists no models — its rows never reach any model picker, which is the
 * whole point: picking a model that would only fail with "not signed in"
 * is noise. The gate only shapes `listModels`; `resolveModel` and requests
 * are untouched, so a model id already saved in a session (or named
 * explicitly) keeps resolving exactly as the registry contract promises
 * ("advisory and never changes routing").
 *
 * An expired-but-stored credential still lists: token refresh runs on the
 * next request, and a picker that hid a refreshable provider would look
 * signed-out when it is not.
 */
interface CatalogOperation { sequence: number; startEpoch: number; epoch?: number; identity?: string }

export class CredentialGatedAdapter extends PiAiAdapter {
  constructor(
    options: PiAiAdapterOptions,
    private readonly hasCredential: (provider: string, operation?: CatalogOperation) => Promise<boolean>,
    private readonly prepareCatalog?: (provider: string, operation?: CatalogOperation) => Promise<ReadonlySet<string> | undefined>,
    private readonly beginCatalog?: (provider: string) => CatalogOperation | undefined,
    private readonly isCurrentCatalog?: (provider: string, operation?: CatalogOperation) => boolean,
  ) {
    super(options)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const operation = this.beginCatalog?.(provider)
    if (!(await this.hasCredential(provider, operation)) || this.isCurrentCatalog?.(provider, operation) === false) return []
    const visible = await this.prepareCatalog?.(provider, operation)
    const models = await super.listModels(provider)
    if (this.isCurrentCatalog?.(provider, operation) === false) return []
    return visible === undefined ? models : models.filter(model => visible.has(model.id))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmModelInfo> {
    const operation = this.beginCatalog?.(provider)
    if (operation !== undefined) await this.hasCredential(provider, operation)
    await this.prepareCatalog?.(provider, operation)
    return super.resolveModel(provider, model, signal)
  }
}

/** Mount the routes, the service, and the command. */
export function apply(ctx: Context, config: Config): void {
  const configured = config.providers ?? [...OAUTH_PROVIDER_IDS]
  const unknown = configured.filter(id => !(OAUTH_PROVIDER_IDS as readonly string[]).includes(id))
  if (unknown.length > 0 || configured.length === 0) {
    throw new Error(
      `dsh-auth: providers must be a non-empty subset of [${OAUTH_PROVIDER_IDS.join(', ')}]; got [${configured.join(', ')}]`,
    )
  }
  // Overrides are provider-scoped: a provider key outside the mounted set is
  // refused, never skipped, so a typo lands at boot instead of silently
  // serving the installed catalog.
  const overrides = config.modelOverrides ?? {}
  const unknownOverridden = Object.keys(overrides).filter(id => !configured.includes(id))
  if (unknownOverridden.length > 0) {
    throw new Error(
      `dsh-auth: modelOverrides names provider "${unknownOverridden[0]}", which is not among the mounted providers [${configured.join(', ')}]`,
    )
  }
  // Profile construction validates the installed catalog loudly: a pi-ai
  // downgrade that dropped a provider fails the boot that asked for it, and
  // a per-model miss is refused per route (see buildOAuthProfile).
  let profiles = new Map(configured.map(id => [id, buildOAuthProfile(id, overrides[id])]))
  const store = new CredentialFile(config.credentialsFile ?? defaultCredentialsFile())
  const discovery = new CodexModelDiscovery()
  const baseCodex = profiles.get('openai-codex')
  let fallbackUntil = 0
  let fallbackIdentity: string | undefined
  let catalogIdentity: string | undefined
  let sequence = 0
  let observedSequence = 0
  let transitionSequence = 0
  let epoch = 0
  let observedIdentity: string | undefined
  const beginCatalog = (provider: string): CatalogOperation | undefined => provider === 'openai-codex' ? { sequence: ++sequence, startEpoch: epoch } : undefined
  const isCurrentCatalog = (provider: string, operation?: CatalogOperation): boolean => provider !== 'openai-codex'
    || (operation?.epoch !== undefined && operation.epoch === epoch && operation.identity === observedIdentity)
  // Match the effective identity used by discovery's in-process cache.
  const identity = (credential: NonNullable<ReturnType<typeof asStoredCredential>>): string => JSON.stringify([
    credential.access, credential.accountId, process.env['DSH_AUTH_CREDENTIALS'] ?? '',
    join(resolve(process.env['DSH_HOME'] || join(homedir(), '.dsh')), 'dsh-auth', 'model-cache'),
  ])
  // Sequence orders observations, not calls: equal identities share an epoch.
  // An older delayed read cannot reverse a newer observed transition, including
  // logout or A -> B -> A. The store itself exposes no revisioned snapshot.
  const observe = (operation: CatalogOperation, value: string | undefined): boolean => {
    const sharedTransition = operation.epoch === undefined && operation.startEpoch + 1 === epoch && value === observedIdentity
    if ((operation.sequence < transitionSequence && !sharedTransition) || (operation.epoch !== undefined && operation.epoch !== epoch)) return false
    if (value !== observedIdentity) {
      if (operation.sequence < observedSequence) return false
      observedIdentity = value
      transitionSequence = operation.sequence
      epoch++
    }
    observedSequence = Math.max(observedSequence, operation.sequence)
    operation.epoch = epoch
    operation.identity = value
    return true
  }
  const noModels: ReadonlySet<string> = new Set()
  const prepareCatalog = async (provider: string, operation?: CatalogOperation): Promise<ReadonlySet<string> | undefined> => {
    if (provider !== 'openai-codex' || baseCodex?.piProvider === undefined) return undefined
    let credential = await store.read(provider).then(asStoredCredential, () => undefined)
    if (!isCurrentCatalog(provider, operation) || credential === undefined || identity(credential) !== operation?.identity) return noModels
    let currentIdentity = identity(credential)
    // Do not reset a published provider based on an asynchronous read alone.
    // If another identity's catalog is installed during a fallback interval,
    // suppress picker rows until this identity can be discovered again.
    if (fallbackIdentity === currentIdentity && fallbackUntil > Date.now()) {
      return catalogIdentity !== undefined && catalogIdentity !== currentIdentity ? noModels : undefined
    }
    try {
      if (credential.expires <= Date.now()) {
        await store.modify(provider, async current => {
          const stored = asStoredCredential(current)
          if (stored === undefined || stored.expires > Date.now()) return current
          return baseCodex.piProvider!.auth.oauth!.refresh(stored, AbortSignal.timeout(8000))
        })
        if (!isCurrentCatalog(provider, operation)) return noModels
        credential = asStoredCredential(await store.read(provider))
        if (!isCurrentCatalog(provider, operation) || credential === undefined || operation === undefined || !observe(operation, identity(credential))) return noModels
        currentIdentity = identity(credential)
      }
      const discovered = await discovery.discover(credential, baseCodex.piProvider)
      if (!isCurrentCatalog(provider, operation)) return noModels
      // A login/logout or account switch during fetch must not install another
      // account's metadata into this route.
      const current = asStoredCredential(await store.read(provider))
      if (!isCurrentCatalog(provider, operation) || current === undefined || identity(current) !== currentIdentity) return noModels
      if (profiles.get(provider)?.piProvider !== discovered.provider) {
        profiles = new Map(profiles).set(provider, { ...baseCodex, piProvider: discovered.provider })
      }
      catalogIdentity = currentIdentity
      return discovered.visible
    } catch {
      // A stale failure must not erase a newer account's installed catalog.
      if (!isCurrentCatalog(provider, operation)) return noModels
      const current = await store.read(provider).then(asStoredCredential, () => undefined)
      if (!isCurrentCatalog(provider, operation) || current === undefined || identity(current) !== currentIdentity) return noModels
      if (fallbackIdentity === currentIdentity && fallbackUntil > Date.now() && catalogIdentity === undefined) return undefined
      profiles = new Map(profiles).set(provider, baseCodex)
      catalogIdentity = undefined
      fallbackIdentity = currentIdentity
      fallbackUntil = Date.now() + 60_000
      ctx.logger.warn('ChatGPT model metadata unavailable; using the installed catalog temporarily')
      return undefined
    }
  }

  // Fail closed on store trouble: a credential file that cannot be read
  // must not surface forty models that would all fail at request time.
  const hasCredential = async (provider: string, operation?: CatalogOperation): Promise<boolean> => {
    try {
      const stored = await store.read(provider)
      if (operation !== undefined) {
        const credential = asStoredCredential(stored)
        return observe(operation, credential === undefined ? undefined : identity(credential)) && credential !== undefined
      }
      return stored !== undefined
    } catch {
      return false
    }
  }

  const adapter = new CredentialGatedAdapter({
    // One immutable map for the plugin's lifetime: the snapshot memoizes on
    // identity, and route changes here always mean a plugin remount anyway.
    profiles: () => profiles,
    // No route ever names an api-key credential, so the override stays
    // undefined and every request authenticates through the collection's
    // own auth — the OAuth credential this plugin's store holds.
    resolveApiKey: async () => undefined,
    auth: {
      credentials: store,
      authContext: hostAuthContext(),
    },
    resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`dsh-auth: replay state on assistant history for ${provider}/${model} degraded: ${reason}`)
    },
  }, hasCredential, prepareCatalog, beginCatalog, isCurrentCatalog)

  // The service is a thin holder so UIs can find the api without importing
  // the plugin module; the defensive get-then-create matches how the TUI
  // mounts userQuestions.
  const service = (ctx.get('dshAuth') as DshAuthService | undefined) ?? new DshAuthService(ctx)
  const api = createDshAuthApi({
    profiles,
    store,
    resolveAsk: () => {
      const questions = ctx.get('userQuestions')
      return questions === undefined ? undefined : request => questions.ask(request)
    },
    logger: ctx.logger,
  })
  service.api = api

  ctx.effect(function* () {
    const releases: (() => void)[] = []
    // Runtime service resolution (never a code-level inject — see `inject`):
    // absent services keep this plugin inert and logged, not the whole boot
    // tree deadlocked.
    const llm = ctx.get('llm') as LlmRegistryLike | undefined
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (llm === undefined) {
      ctx.logger.warn('dsh-auth: no llm service mounted — provider routes stay unregistered')
    } else {
      // Individual registrations: one conflicting route must not strand the
      // rest (the registry keeps the previous owner serving).
      for (const id of configured) {
        try {
          releases.push(llm.registerAdapter([id], adapter))
        } catch (error: unknown) {
          ctx.logger.error(
            `dsh-auth: route "${id}" was not registered: ${error instanceof Error ? error.message : String(error)} `
            + '(another adapter family may own it — check the llm-pi-ai settings section)',
          )
        }
      }
    }
    const active = new Set<Promise<unknown>>()
    if (commands === undefined) {
      ctx.logger.warn('dsh-auth: no commands service mounted — the /auth command stays unregistered')
    } else if (config.command === false) {
      ctx.logger.debug('dsh-auth: command registration disabled by host; use its unified account manager')
    } else {
      const handler = createAuthCommandHandler(api)
      releases.push(commands.register({
        name: 'auth',
        description: 'Choose an OAuth provider/account, or manage sign-in status',
        handler: invocation => {
          const operation = handler(invocation)
          active.add(operation)
          void operation.then(() => active.delete(operation), () => active.delete(operation))
          return operation
        },
      }))
    }
    // Drain before releasing: LIFO composite teardown lets no new invocation
    // enter while already-started logins finish their final write.
    yield async () => { await Promise.allSettled([...active]) }
    yield () => {
      for (const release of releases) release()
    }
  }, 'dsh-auth lifecycle')
}
