/**
 * File-backed OAuth credential persistence: a pi-ai `CredentialStore` over
 * one JSON document, with named credentials per provider.
 *
 * Writes are atomic (temp file + rename) with 0700 directory / 0600 file
 * permissions best-effort on every platform. All mutations go through
 * {@link CredentialFile.modify}, which serializes read-modify-write cycles
 * per provider in-process — pi-ai runs its OAuth refresh *inside* `modify`,
 * so the exclusion here is what keeps concurrent requests from
 * double-refreshing a rotated token. The file is the single source of truth;
 * nothing here ever logs token material, and {@link CredentialFile.describe}
 * reports only non-secret metadata for status surfaces.
 *
 * @module dsh-auth/credentials
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { PiAiCredential, PiAiCredentialInfo, PiAiCredentialStore } from './pi-ai.js'

/** The stored credential shape: a pi-ai `OAuthCredential`. */
export type StoredOAuthCredential = Extract<PiAiCredential, { type: 'oauth' }>

/** On-disk document shape. */
interface ProfileRecord {
  label: string
  credential: PiAiCredential
}

interface CredentialsDocument {
  version: 2
  active: Record<string, string>
  profiles: Record<string, Record<string, ProfileRecord>>
}

/** Narrow an unknown parsed value into a stored credential, or reject it. */
export function asStoredCredential(value: unknown): StoredOAuthCredential | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['type'] !== 'oauth') return undefined
  if (typeof record['access'] !== 'string' || typeof record['refresh'] !== 'string') return undefined
  if (typeof record['expires'] !== 'number' || !Number.isFinite(record['expires'])) return undefined
  return value as StoredOAuthCredential
}

/** Default credential file location: `$DSH_HOME/dsh-auth/credentials.json` (or `~/.dsh/…`). */
export function defaultCredentialsFile(): string {
  const override = process.env['DSH_AUTH_CREDENTIALS']
  if (override !== undefined && override !== '') return override
  const root = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(root, 'dsh-auth', 'credentials.json')
}

const EMPTY_DOCUMENT: CredentialsDocument = { version: 2, active: {}, profiles: {} }

export interface CredentialProfileInfo {
  readonly provider: string
  readonly profileId: string
  readonly label: string
  readonly active: boolean
  readonly expiresAt: number
  readonly expired: boolean
}

/**
 * The credential file. IO failures throw (loud, naming the path) rather than
 * degrading to an empty store: silently treating a corrupt or unreadable
 * credential file as "signed out everywhere" would strand every route behind
 * a fresh login for no reason.
 */
export class CredentialFile implements PiAiCredentialStore {
  readonly path: string
  /** Per-provider operation chains: profile mutations never overlap. */
  private readonly chains = new Map<string, Promise<unknown>>()
  private cache: CredentialsDocument | undefined

  constructor(path: string) {
    this.path = path
  }

  /** The stored credential for one provider, possibly expired. */
  async read(providerId: string): Promise<PiAiCredential | undefined> {
    const document = await this.load()
    const profileId = document.active[providerId]
    return profileId === undefined ? undefined : document.profiles[providerId]?.[profileId]?.credential
  }

  /** Stored credential metadata without resolving or exposing secrets. */
  async list(): Promise<readonly PiAiCredentialInfo[]> {
    const document = await this.load()
    return Object.entries(document.active).flatMap(([providerId, profileId]) => {
      const credential = document.profiles[providerId]?.[profileId]?.credential
      return credential === undefined ? [] : [{ providerId, type: credential.type }]
    })
  }

  /**
   * Serialized read-modify-write for one provider. `fn` sees the current
   * credential; returning a new credential persists it, returning
   * `undefined` leaves the entry unchanged. Resolves with the post-write
   * credential. Rejections from `fn` propagate without touching the file.
   */
  async modify(
    providerId: string,
    fn: (current: PiAiCredential | undefined) => Promise<PiAiCredential | undefined>,
  ): Promise<PiAiCredential | undefined> {
    return this.chain(providerId, async () => {
      const document = await this.load()
      const profileId = await this.ensureActive(document, providerId)
      const current = profileId === undefined ? undefined : document.profiles[providerId]?.[profileId]?.credential
      const replacement = await fn(current)
      if (replacement === undefined || replacement === current) return current
      if (replacement.type !== 'oauth') {
        throw new Error(`dsh-auth: refusing to store a "${replacement.type}" credential for "${providerId}" — this store holds OAuth credentials only`)
      }
      if (profileId === undefined) {
        const profiles = { ...document.profiles, [providerId]: { default: { label: 'Default', credential: replacement } } }
        await this.save({ ...document, profiles, active: { ...document.active, [providerId]: 'default' } })
        return replacement
      }
      await this.save(this.withCredential(document, providerId, profileId, replacement))
      return replacement
    })
  }

  /** Remove one provider's credential (logout). */
  async delete(providerId: string): Promise<void> {
    await this.chain(providerId, async () => {
      const document = await this.load()
      const profileId = document.active[providerId]
      if (profileId === undefined) return
      const profiles = { ...document.profiles }
      delete profiles[providerId]
      const active = { ...document.active }
      delete active[providerId]
      await this.save({ ...document, profiles, active })
    })
  }

  async profiles(providerId: string): Promise<readonly CredentialProfileInfo[]> {
    const document = await this.load()
    const active = document.active[providerId]
    const now = Date.now()
    return Object.entries(document.profiles[providerId] ?? {}).map(([profileId, profile]) => ({
      provider: providerId,
      profileId,
      label: profile.label,
      active: profileId === active,
      expiresAt: (profile.credential as StoredOAuthCredential).expires,
      expired: (profile.credential as StoredOAuthCredential).expires <= now,
    }))
  }

  async addProfile(providerId: string, label: string, credential: StoredOAuthCredential): Promise<string> {
    return this.chain(providerId, async () => {
      const document = await this.load()
      const profileId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const providerProfiles = { ...(document.profiles[providerId] ?? {}), [profileId]: { label, credential } }
      const profiles = { ...document.profiles, [providerId]: providerProfiles }
      const active = document.active[providerId] === undefined
        ? { ...document.active, [providerId]: profileId }
        : document.active
      await this.save({ ...document, profiles, active })
      return profileId
    })
  }

  async activate(providerId: string, profileId: string): Promise<void> {
    await this.chain(providerId, async () => {
      const document = await this.load()
      if (document.profiles[providerId]?.[profileId] === undefined) {
        throw new Error(`dsh-auth: unknown profile "${profileId}" for "${providerId}"`)
      }
      await this.save({ ...document, active: { ...document.active, [providerId]: profileId } })
    })
  }

  async deleteProfile(providerId: string, profileId: string): Promise<boolean> {
    return this.chain(providerId, async () => {
      const document = await this.load()
      const providerProfiles = document.profiles[providerId]
      if (providerProfiles?.[profileId] === undefined) return false
      const remaining = { ...providerProfiles }
      delete remaining[profileId]
      const profiles = { ...document.profiles }
      const active = { ...document.active }
      if (Object.keys(remaining).length === 0) {
        delete profiles[providerId]
        delete active[providerId]
      } else {
        profiles[providerId] = remaining
        if (active[providerId] === profileId) active[providerId] = Object.keys(remaining)[0]!
      }
      await this.save({ ...document, profiles, active })
      return true
    })
  }

  async renameProfile(providerId: string, profileId: string, label: string): Promise<void> {
    await this.chain(providerId, async () => {
      const document = await this.load()
      const current = document.profiles[providerId]?.[profileId]
      if (current === undefined) throw new Error(`dsh-auth: unknown profile "${profileId}" for "${providerId}"`)
      await this.save({ ...document, profiles: {
        ...document.profiles,
        [providerId]: { ...document.profiles[providerId], [profileId]: { ...current, label } },
      } })
    })
  }

  /** Non-secret metadata for every stored credential, for status surfaces. */
  async describe(): Promise<readonly { provider: string; expiresAt: number; expired: boolean }[]> {
    const document = await this.load()
    const now = Date.now()
    return Object.entries(document.active).flatMap(([provider, profileId]) => {
      const credential = document.profiles[provider]?.[profileId]?.credential
      return credential?.type === 'oauth'
        ? [{ provider, expiresAt: credential.expires, expired: credential.expires <= now }]
        : []
    })
  }

  /** Run one operation after every earlier operation for the same provider. */
  private chain<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(provider) ?? Promise.resolve()).then(operation, operation)
    this.chains.set(provider, run.then(() => undefined, () => undefined))
    return run
  }

  private async load(): Promise<CredentialsDocument> {
    if (this.cache !== undefined) return this.cache
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        this.cache = EMPTY_DOCUMENT
        return this.cache
      }
      throw new Error(`dsh-auth: cannot read credential file ${this.path}: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      throw new Error(
        `dsh-auth: credential file ${this.path} is not valid JSON (${String(error)}); `
        + 'fix or remove the file by hand — it will not be overwritten silently',
      )
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`dsh-auth: credential file ${this.path} has an unexpected shape; fix or remove it by hand`)
    }
    const record = parsed as Record<string, unknown>
    if (record['version'] === 1 && typeof record['providers'] === 'object' && record['providers'] !== null) {
      const profiles: CredentialsDocument['profiles'] = {}
      const active: CredentialsDocument['active'] = {}
      for (const [provider, value] of Object.entries(record['providers'] as Record<string, unknown>)) {
        const credential = asStoredCredential(value)
        if (credential === undefined) throw new Error(`dsh-auth: credential file ${this.path} holds an invalid entry for "${provider}"`)
        const profileId = 'default'
        profiles[provider] = { [profileId]: { label: 'Default', credential } }
        active[provider] = profileId
      }
      this.cache = { version: 2, active, profiles }
      return this.cache
    }
    if (record['version'] !== 2 || typeof record['profiles'] !== 'object' || record['profiles'] === null
      || typeof record['active'] !== 'object' || record['active'] === null) {
      throw new Error(`dsh-auth: credential file ${this.path} has an unexpected shape; fix or remove it by hand`)
    }
    const profiles: CredentialsDocument['profiles'] = {}
    for (const [provider, value] of Object.entries(record['profiles'] as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) throw new Error(`dsh-auth: invalid profiles for "${provider}"`)
      const rows: Record<string, ProfileRecord> = {}
      for (const [profileId, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>)['label'] !== 'string') {
          throw new Error(`dsh-auth: invalid profile "${profileId}" for "${provider}"`)
        }
        const credential = asStoredCredential((raw as Record<string, unknown>)['credential'])
        if (credential === undefined) throw new Error(`dsh-auth: invalid credential for profile "${profileId}"`)
        rows[profileId] = { label: String((raw as Record<string, unknown>)['label']), credential }
      }
      profiles[provider] = rows
    }
    this.cache = { version: 2, active: { ...(record['active'] as Record<string, string>) }, profiles }
    return this.cache
  }

  private async ensureActive(document: CredentialsDocument, providerId: string): Promise<string | undefined> {
    const current = document.active[providerId]
    if (current !== undefined) return current
    const first = Object.keys(document.profiles[providerId] ?? {})[0]
    if (first !== undefined) {
      document.active[providerId] = first
      return first
    }
    return undefined
  }

  private withCredential(document: CredentialsDocument, providerId: string, profileId: string, credential: PiAiCredential): CredentialsDocument {
    const current = document.profiles[providerId]?.[profileId]
    if (current === undefined) throw new Error(`dsh-auth: unknown profile "${profileId}" for "${providerId}"`)
    return { ...document, profiles: {
      ...document.profiles,
      [providerId]: { ...document.profiles[providerId], [profileId]: { ...current, credential } },
    } }
  }

  private async save(document: CredentialsDocument): Promise<void> {
    const text = JSON.stringify(document, null, 2) + '\n'
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${Math.random().toString(36).slice(2)}.tmp`)
    try {
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch (error: unknown) {
      throw new Error(`dsh-auth: cannot write credential file ${this.path}: ${String(error)}`)
    }
    this.cache = document
  }
}
