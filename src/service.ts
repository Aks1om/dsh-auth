/**
 * The `ctx.dshAuth` service: the programmatic surface over this plugin's
 * mounted OAuth routes. UIs (the dsh-tui /provider wizard, a web settings
 * page) enumerate providers with masked sign-in state and drive login/logout
 * without touching the credential file or the pi-ai flow objects; the `/auth`
 * command in `command.ts` is a thin textual veneer over the same api.
 *
 * @module dsh-auth/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { asStoredCredential, CredentialFile, type StoredOAuthCredential } from './credentials.js'
import { oauthOf } from './profiles.js'
import { QuestionBridge, type AskFn } from './interaction.js'
import type { PiAiProvider } from './pi-ai.js'

/**
 * The constructed catalog provider one mounted route carries. 0.1.5 made
 * `ResolvedPiAiProviderProfile.piProvider` optional (a stored route that
 * cannot be constructed stays editable without one); this plugin mounts only
 * constructible routes, so an absent provider here is a mount defect —
 * surfaced loudly rather than as an `undefined` dereference mid-flow.
 */
function mountedProvider(profile: ResolvedPiAiProviderProfile): PiAiProvider {
  if (profile.piProvider === undefined) {
    throw new Error(`dsh-auth: provider "${profile.provider}" mounted without a constructed catalog provider`)
  }
  return profile.piProvider
}

/** One provider's sign-in state; never carries token material. */
export interface DshAuthSignInStatus {
  provider: string
  /** Route display name (selectors, pickers). */
  label: string
  /** The OAuth flow's own name, e.g. "OpenAI (ChatGPT Plus/Pro)". */
  oauthLabel: string
  /** The flow's login-call-to-action label, when it ships one. */
  loginLabel: string | undefined
  signedIn: boolean
  expiresAt: number | undefined
  /** Signed in, but the stored access token has expired (refresh may still work). */
  expired: boolean
}

/** The outcome of a successful login. */
export interface DshAuthLoginResult {
  provider: string
  oauthLabel: string
  expiresAt: number
}

/** The service api consumed by commands and UIs. */
export interface DshAuthApi {
  /** Every mounted provider with masked sign-in state. */
  providers(): Promise<readonly DshAuthSignInStatus[]>
  /**
   * Run one provider's OAuth login. `provider` omitted asks the interactive
   * surface to choose among providers not currently signed in.
   * @throws Error when no interactive surface is present, the provider is
   *   unknown, a login is already running, or the flow itself fails.
   */
  login(provider?: string, signal?: AbortSignal): Promise<DshAuthLoginResult>
  /** Remove one provider's stored credential; resolves whether one existed. */
  logout(provider: string): Promise<boolean>
}

/** Cordis service holder; `api` is set by the plugin's apply. */
export class DshAuthService extends Service {
  api: DshAuthApi | undefined

  constructor(ctx: Context) {
    super(ctx, 'dshAuth')
  }
}

/** Everything the api factory needs; all cordis surface is injected, so tests run without a host. */
export interface DshAuthApiDeps {
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  store: CredentialFile
  /** The interactive ask surface, resolved per call so mounting order never matters. */
  resolveAsk: () => AskFn | undefined
  logger: { warn(message: string): void }
}

/** Select a provider interactively among `candidates`. */
async function chooseProvider(ask: AskFn, candidates: readonly DshAuthSignInStatus[], signal: AbortSignal | undefined): Promise<string> {
  const answer = await ask({
    questions: [{
      id: 'dsh-auth-provider',
      header: 'dsh-auth',
      question: 'Sign in with which provider?',
      options: candidates.map(row => ({ label: row.oauthLabel, description: row.provider })),
    }],
    signal,
  })
  const row = answer.answers[0]
  const label = row?.selected[0]
  const chosen = candidates.find(candidate => candidate.oauthLabel === label)
  if (chosen === undefined) throw new Error('dsh-auth: no provider was chosen')
  return chosen.provider
}

/**
 * The api implementation. One login runs per provider at a time (an in-flight
 * map, not a global lock: providers sign in independently); a second login
 * attempt for the same provider fails fast instead of stacking two flows.
 */
export function createDshAuthApi(deps: DshAuthApiDeps): DshAuthApi {
  const inflight = new Map<string, Promise<DshAuthLoginResult>>()

  const statusOf = async (): Promise<readonly DshAuthSignInStatus[]> => {
    const described = new Map((await deps.store.describe()).map(row => [row.provider, row]))
    return [...deps.profiles.entries()].map(([id, profile]) => {
      const oauth = oauthOf(mountedProvider(profile))
      const row = described.get(id)
      return {
        provider: id,
        label: profile.displayName,
        oauthLabel: oauth.name,
        loginLabel: oauth.loginLabel,
        signedIn: row !== undefined && !row.expired,
        expiresAt: row?.expiresAt,
        expired: row?.expired ?? false,
      }
    })
  }

  const loginOne = async (provider: string, ask: AskFn, signal: AbortSignal | undefined): Promise<DshAuthLoginResult> => {
    const profile = deps.profiles.get(provider)
    if (profile === undefined) {
      throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
    }
    const oauth = oauthOf(mountedProvider(profile))
    const runAbort = new AbortController()
    if (signal !== undefined) {
      if (signal.aborted) runAbort.abort(signal.reason)
      else signal.addEventListener('abort', () => runAbort.abort(signal.reason), { once: true })
    }
    const bridge = new QuestionBridge(ask, runAbort)
    try {
      const returned = await oauth.login(bridge)
      const normalized = asStoredCredential(returned)
      if (normalized === undefined) {
        throw new Error(`dsh-auth: the ${oauth.name} flow returned an unusable credential; nothing was stored`)
      }
      const stored: StoredOAuthCredential = normalized
      await deps.store.modify(provider, async () => stored)
      return { provider, oauthLabel: oauth.name, expiresAt: stored.expires }
    } finally {
      await bridge.settle()
    }
  }

  return {
    providers: statusOf,
    login: async (provider, signal) => {
      const ask = deps.resolveAsk()
      let target = provider
      if (target === undefined) {
        if (ask === undefined) {
          throw new Error('dsh-auth: provider selection needs an interactive surface; name the provider: /auth login <provider>')
        }
        const statuses = await statusOf()
        const candidates = statuses.filter(row => !row.signedIn)
        if (candidates.length === 0) throw new Error('dsh-auth: every mounted provider is already signed in')
        target = await chooseProvider(ask, candidates, signal)
      } else if (!deps.profiles.has(target)) {
        throw new Error(`dsh-auth: unknown provider "${target}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
      }
      if (ask === undefined) {
        throw new Error(
          `dsh-auth: signing in to "${target}" needs an interactive surface (run inside dsh-tui or the web client); `
          + 'this plugin refuses to assume a browser on this machine',
        )
      }
      const existing = inflight.get(target)
      if (existing !== undefined) {
        throw new Error(`dsh-auth: a login for "${target}" is already running`)
      }
      const run = loginOne(target, ask, signal).finally(() => { inflight.delete(target) })
      inflight.set(target, run)
      return run
    },
    logout: async provider => {
      if (!deps.profiles.has(provider)) {
        throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
      }
      const existed = (await deps.store.read(provider)) !== undefined
      await deps.store.delete(provider)
      return existed
    },
  }
}
