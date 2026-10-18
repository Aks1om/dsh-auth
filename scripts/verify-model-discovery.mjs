import assert from 'node:assert/strict'
import { buildOAuthProfile } from '../lib/profiles.js'
import { CodexModelDiscovery, parseCodexCatalog } from '../lib/modelDiscovery.js'

const provider = buildOAuthProfile('openai-codex').piProvider
const payload = { models: [
  { slug: 'future-model', display_name: 'Future model', visibility: 'list', context_window: 500000,
    input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
  { slug: 'internal-review', visibility: 'hide', context_window: 272000 },
] }
const parsed = parseCodexCatalog(payload, provider)
assert.deepEqual([...parsed.visible], ['future-model'])
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
const failing = new CodexModelDiscovery(async () => new Response('', { status: 503 }))
await assert.rejects(failing.discover(credential, provider))
console.log('ChatGPT metadata verified: new ids/context/efforts, visibility, cache/deduplication, account isolation, failure handling')
