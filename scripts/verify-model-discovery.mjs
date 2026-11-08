import assert from 'node:assert/strict'
import { buildOAuthProfile } from '../lib/profiles.js'
import { CodexModelDiscovery, parseCodexCatalog } from '../lib/modelDiscovery.js'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-model-fixture-'))

const provider = buildOAuthProfile('openai-codex').piProvider
const payload = { models: [
  { slug: 'future-model', display_name: 'Future model', visibility: 'list', context_window: 500000,
    input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
  { slug: 'new-default-visible-model', display_name: 'New default-visible model', context_window: 128000 },
  { slug: 'internal-review', visibility: 'hide', context_window: 272000 },
] }
const parsed = parseCodexCatalog(payload, provider)
assert.deepEqual([...parsed.visible], ['future-model', 'new-default-visible-model'])
const newModel = parsed.provider.getModels().find(model => model.id === 'future-model')
assert.equal(newModel.contextWindow, 500000)
assert.equal(newModel.thinkingLevelMap.max, 'max')
assert.equal(newModel.thinkingLevelMap.medium, null)
assert.deepEqual(newModel.input, ['text', 'image'])
assert.ok(parsed.provider.getModels().some(model => model.id === provider.getModels()[0].id), 'saved catalog routes remain resolvable')
assert.throws(() => parseCodexCatalog({ models: [{ slug: 'hidden', visibility: 'hide' }] }, provider), /no picker-visible/)

const requests = []
const discovery = new CodexModelDiscovery(async (url, options) => {
  requests.push({ url, options })
  return new Response(JSON.stringify(url.includes('registry.npmjs.org') ? { version: '9.8.7' } : payload), { status: 200 })
})
const credential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', accountId: 'test-account', expires: Date.now() + 60000 }
const [first, second] = await Promise.all([discovery.discover(credential, provider), discovery.discover(credential, provider)])
assert.equal(first, second)
assert.equal(requests.length, 2, 'concurrent model/provider reads share one discovery request')
assert.ok(requests[1].url.endsWith('client_version=9.8.7'))
assert.equal(requests[1].options.headers['ChatGPT-Account-Id'], 'test-account')
assert.equal(requests[0].options.headers, undefined, 'the public version lookup never receives OAuth credentials')
await discovery.discover(credential, provider)
assert.equal(requests.length, 2, 'the catalog is cached')
await discovery.discover({ ...credential, access: 'different-account' }, provider)
assert.equal(requests.length, 3, 'account changes invalidate the catalog')
const warm = new CodexModelDiscovery(async () => { throw new Error('unexpected network') })
assert.deepEqual([...((await warm.discover(credential, provider)).visible)], [...first.visible], 'new instance reads real cached routes')
const cacheDir = join(process.env.DSH_HOME, 'dsh-auth', 'model-cache')
const hash = createHash('sha256').update(JSON.stringify(['https://chatgpt.com/backend-api/codex/models', '9.8.7', credential.access, credential.accountId, process.env.DSH_AUTH_CREDENTIALS ?? ''])).digest('hex')
const catalogFile = join(cacheDir, `catalog-${hash}.json`)
const serialized = readFileSync(catalogFile, 'utf8')
assert.ok(!serialized.includes(credential.access) && !serialized.includes(credential.refresh) && !serialized.includes(credential.accountId))
const bad = JSON.parse(serialized)
bad.data.models[0].access_token = 'should-not-be-accepted'
writeFileSync(catalogFile, JSON.stringify(bad), { mode: 0o600 })
let fetches = 0
const refetch = new CodexModelDiscovery(async () => { fetches++; return new Response(JSON.stringify(payload)) })
await refetch.discover(credential, provider)
assert.equal(fetches, 1, 'unknown secret fields invalidate disk cache')
const expired = JSON.parse(readFileSync(catalogFile, 'utf8'))
expired.time = Date.now() - 300_001
writeFileSync(catalogFile, JSON.stringify(expired))
await new CodexModelDiscovery(async () => { fetches++; return new Response(JSON.stringify(payload)) }).discover(credential, provider)
assert.equal(fetches, 2, 'expired cache is fetched again')
writeFileSync(catalogFile, '{broken')
await new CodexModelDiscovery(async () => { fetches++; return new Response(JSON.stringify(payload)) }).discover(credential, provider)
assert.equal(fetches, 3, 'corrupt cache is fetched again')
chmodSync(catalogFile, 0o644)
await new CodexModelDiscovery(async () => { fetches++; return new Response(JSON.stringify(payload)) }).discover(credential, provider)
assert.equal(fetches, 4, 'non-private cache is ignored')
await Promise.all(Array.from({ length: 5 }, () => new CodexModelDiscovery(async () => new Response(JSON.stringify(payload))).discover({ ...credential, access: 'concurrent-token' }, provider)))
await new CodexModelDiscovery(async () => { throw new Error('unexpected network') }).discover({ ...credential, access: 'concurrent-token' }, provider)
const versionHash = createHash('sha256').update('https://registry.npmjs.org/@openai%2Fcodex/latest').digest('hex')
const versionFile = join(cacheDir, `version-${versionHash}.json`)
const oldVersion = JSON.parse(readFileSync(versionFile, 'utf8'))
oldVersion.time = Date.now() - 3_600_001
writeFileSync(versionFile, JSON.stringify(oldVersion))
const upgradeRequests = []
await new CodexModelDiscovery(async url => {
  upgradeRequests.push(url)
  return new Response(JSON.stringify(url.includes('registry.npmjs.org') ? { version: '9.8.8' } : payload))
}).discover(credential, provider)
assert.equal(upgradeRequests.length, 2, 'expired version refresh and changed version invalidate catalog')
assert.ok(upgradeRequests[1].endsWith('client_version=9.8.8'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-model-failure-'))
const failing = new CodexModelDiscovery(async () => new Response('', { status: 503 }))
await assert.rejects(failing.discover(credential, provider))
console.log('ChatGPT metadata verified: new ids/context/efforts, visibility, cache/deduplication, account isolation, failure handling')
