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
import { asStoredCredential, CredentialFile, type CredentialProfileInfo, type StoredOAuthCredential } from './credentials.js'
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
  profiles: readonly CredentialProfileInfo[]
  activeProfileId: string | undefined
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
  profiles(provider: string): Promise<readonly CredentialProfileInfo[]>
  /** Interactive account picker used by the bare `/auth` command. */
  interactive(signal?: AbortSignal): Promise<{ provider: string; profileId: string; action: 'activated' | 'signed-in' }>
  /**
   * Run one provider's OAuth login. `provider` omitted asks the interactive
   * surface to choose among providers not currently signed in.
   * @throws Error when no interactive surface is present, the provider is
   *   unknown, a login is already running, or the flow itself fails.
   */
  login(provider?: string, signal?: AbortSignal, label?: string): Promise<DshAuthLoginResult>
  /** Remove one provider's stored credential; resolves whether one existed. */
  logout(provider: string, profileId?: string): Promise<boolean>
  activate(provider: string, profileId: string): Promise<void>
  rename(provider: string, profileId: string, label: string): Promise<void>
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
    return Promise.all([...deps.profiles.entries()].map(async ([id, profile]) => {
      const oauth = oauthOf(mountedProvider(profile))
      const row = described.get(id)
      const profileRows = await deps.store.profiles(id)
      return {
        provider: id,
        label: profile.displayName,
        oauthLabel: oauth.name,
        loginLabel: oauth.loginLabel,
        signedIn: row !== undefined && !row.expired,
        expiresAt: row?.expiresAt,
        expired: row?.expired ?? false,
        profiles: profileRows,
        activeProfileId: profileRows.find(profile => profile.active)?.profileId,
      }
    }))
  }

  const loginOne = async (provider: string, ask: AskFn, signal: AbortSignal | undefined, requestedLabel?: string): Promise<DshAuthLoginResult> => {
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
       const existing = await deps.store.profiles(provider)
       const label = requestedLabel?.trim() || 'Default'
        if (existing.length === 0 || (existing.length === 1 && existing[0]?.label === 'Default' && requestedLabel === undefined)) {
          await deps.store.modify(provider, async () => stored)
        } else {
          const profileId = await deps.store.addProfile(provider, label, stored)
          await deps.store.activate(provider, profileId)
        }
      return { provider, oauthLabel: oauth.name, expiresAt: stored.expires }
    } finally {
      await bridge.settle()
    }
  }

  const login = async (provider?: string, signal?: AbortSignal, label?: string): Promise<DshAuthLoginResult> => {
    const ask = deps.resolveAsk()
    let target = provider
    if (target === undefined) {
      if (ask === undefined) {
        throw new Error('dsh-auth: provider selection needs an interactive surface; run /auth inside the TUI')
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
    if (existing !== undefined) throw new Error(`dsh-auth: a login for "${target}" is already running`)
    const run = loginOne(target, ask, signal, label).finally(() => { inflight.delete(target) })
    inflight.set(target, run)
    return run
  }

  const interactive = async (signal?: AbortSignal) => {
    const ask = deps.resolveAsk()
    if (ask === undefined) throw new Error('dsh-auth: interactive account selection needs a TUI question surface')
    const statuses = await statusOf()
    const providerAnswer = await ask({
      questions: [{
        id: 'dsh-auth-manage-provider',
        header: 'Accounts',
        question: 'Choose a provider',
        options: statuses.map(row => ({ label: row.label, description: row.oauthLabel })),
      }],
      signal,
    })
    const selectedProvider = statuses.find(row => row.label === providerAnswer.answers[0]?.selected[0])
    if (selectedProvider === undefined) throw new Error('dsh-auth: no provider was chosen')

    const profiles = await deps.store.profiles(selectedProvider.provider)
    if (profiles.length === 0) {
      await login(selectedProvider.provider, signal, 'Default')
      const created = await deps.store.profiles(selectedProvider.provider)
      const active = created.find(profile => profile.active) ?? created[0]
      if (active === undefined) throw new Error('dsh-auth: login completed without a saved profile')
      return { provider: selectedProvider.provider, profileId: active.profileId, action: 'signed-in' as const }
    }

    const addLabel = 'Add another account'
    const options = [
      ...profiles.map(profile => ({
        label: `${profile.label}${profile.active ? ' (active)' : ''}`,
        description: profile.profileId,
      })),
      { label: addLabel, description: `Sign in to ${selectedProvider.label} with another account` },
    ]
    const profileAnswer = await ask({
      questions: [{
        id: 'dsh-auth-manage-profile',
        header: selectedProvider.label,
        question: 'Choose an account',
        options,
      }],
      signal,
    })
    const selected = profileAnswer.answers[0]?.selected[0]
    if (selected === addLabel) {
      const usedLabels = new Set(profiles.map(profile => profile.label))
      let number = profiles.length + 1
      while (usedLabels.has(`Account ${number}`)) number += 1
      await login(selectedProvider.provider, signal, `Account ${number}`)
      const created = await deps.store.profiles(selectedProvider.provider)
      const active = created.find(profile => profile.active)
      if (active === undefined) throw new Error('dsh-auth: login completed without a saved profile')
      return { provider: selectedProvider.provider, profileId: active.profileId, action: 'signed-in' as const }
    }
    const chosen = profiles.find(profile => `${profile.label}${profile.active ? ' (active)' : ''}` === selected)
    if (chosen === undefined) throw new Error('dsh-auth: no account was chosen')
    await deps.store.activate(selectedProvider.provider, chosen.profileId)
    return { provider: selectedProvider.provider, profileId: chosen.profileId, action: 'activated' as const }
  }

  return {
    providers: statusOf,
    profiles: provider => deps.store.profiles(provider),
    login,
    interactive,
    activate: (provider, profileId) => deps.store.activate(provider, profileId),
    rename: (provider, profileId, label) => deps.store.renameProfile(provider, profileId, label),
    logout: async (provider, profileId) => {
      if (!deps.profiles.has(provider)) {
        throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${[...deps.profiles.keys()].join(', ')})`)
      }
       const existed = profileId === undefined
         ? (await deps.store.read(provider)) !== undefined
         : await deps.store.deleteProfile(provider, profileId)
       if (profileId === undefined) await deps.store.delete(provider)
      return existed
    },
  }
}
