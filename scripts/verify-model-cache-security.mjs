import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, readdirSync, readFileSync, writeFileSync, chmodSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { CodexModelDiscovery } from '../lib/modelDiscovery.js'
import { buildOAuthProfile } from '../lib/profiles.js'

const credential = { type: 'oauth', access: 'sample-access-secret', refresh: 'sample-refresh-secret', expires: 1e15 }
const provider = buildOAuthProfile('openai-codex').piProvider
const payload = { models: [{ slug: 'fixture-model', context_window: 128000, visibility: 'list' }] }
const home = () => mkdtempSync(join(tmpdir(), 'dsh-cache-security-'))
const files = dir => existsSync(dir) ? readdirSync(dir).flatMap(name => [readFileSync(join(dir, name), 'utf8')]).join('\n') : ''
let calls = []
let metadata = payload
const request = async url => { calls.push(url); return new Response(JSON.stringify(url.includes('registry.npmjs.org') ? { version: '1.2.3' } : metadata)) }
if (process.argv[2] === 'child') {
  await new CodexModelDiscovery(request).discover(credential, provider)
  console.log(JSON.stringify({ requests: calls.length }))
  process.exit(0)
}

const tests = []
const test = (name, run) => tests.push({ name, run })
test('credential-like metadata is never persisted', async () => {
  process.env.DSH_HOME = home()
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureabc123456'
  metadata = { models: [{ slug: jwt, extra: credential.refresh }] }
  await new CodexModelDiscovery(request).discover(credential, provider)
  const archive = files(join(process.env.DSH_HOME, 'dsh-auth', 'model-cache'))
  for (const secret of [jwt, credential.access, credential.refresh]) assert.ok(!archive.includes(secret), 'secret persisted')
  metadata = payload
})
test('intermediate symlink is refused', async () => {
  const root = home(), outside = home()
  process.env.DSH_HOME = root
  symlinkSync(outside, join(root, 'dsh-auth'))
  calls = []
  await new CodexModelDiscovery(request).discover(credential, provider)
  assert.equal(calls.length, 2)
  assert.deepEqual(readdirSync(outside), [])
})
test('cache target symlink and insecure intermediate are refused', async () => {
  for (const kind of ['symlink', 'permissions']) {
    const root = home(), outside = home()
    process.env.DSH_HOME = root
    mkdirSync(join(root, 'dsh-auth'), { mode: kind === 'permissions' ? 0o755 : 0o700 })
    if (kind === 'symlink') symlinkSync(outside, join(root, 'dsh-auth', 'model-cache'))
    calls = []
    await new CodexModelDiscovery(request).discover(credential, provider)
    assert.equal(calls.length, 2)
    assert.deepEqual(readdirSync(outside), [])
    assert.equal(existsSync(join(root, 'dsh-auth', 'model-cache')) && kind === 'permissions', false)
  }
})
test('root symlink and unsafe cache file never touched', async () => {
  const parent = home(), outside = home()
  const rootLink = join(parent, 'root-link')
  symlinkSync(outside, rootLink)
  process.env.DSH_HOME = rootLink
  await new CodexModelDiscovery(request).discover(credential, provider)
  assert.deepEqual(readdirSync(outside), [])
  const root = home(), dir = join(root, 'dsh-auth', 'model-cache')
  process.env.DSH_HOME = root
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(outside, 'foreign')
  writeFileSync(target, 'do not touch')
  const hash = createHash('sha256').update('https://registry.npmjs.org/@openai%2Fcodex/latest').digest('hex')
  const link = join(dir, `version-${hash}.json`)
  symlinkSync(target, link)
  calls = []
  await new CodexModelDiscovery(request).discover(credential, provider)
  assert.equal(calls.length, 2)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readFileSync(target, 'utf8'), 'do not touch')
  chmodSync(dir, 0o755)
  calls = []
  await new CodexModelDiscovery(request).discover(credential, provider)
  assert.equal(calls.length, 2)
})
test('credential prefixes and malformed context are not persisted', async () => {
  for (const row of [{ slug: 'sk-syntheticToken12345' }, { slug: 'fixture-model', display_name: credential.refresh }, { slug: 'fixture-model', context_window: 1e20 }]) {
    process.env.DSH_HOME = home()
    metadata = { models: [row] }
    await new CodexModelDiscovery(request).discover(credential, provider)
    assert.ok(!files(join(process.env.DSH_HOME, 'dsh-auth', 'model-cache')).includes('"models"'))
  }
  metadata = payload
})
test('version TTL is fixed despite repeated catalog fetches', async () => {
  process.env.DSH_HOME = home()
  const realNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  calls = []
  try {
    const discovery = new CodexModelDiscovery(request)
    for (let minute = 0; minute <= 144; minute += 6) {
      now = 1_800_000_000_000 + minute * 60_000
      await discovery.discover(credential, provider)
    }
    assert.equal(calls.filter(url => url.includes('registry.npmjs.org')).length, 3)
  } finally { Date.now = realNow }
})
test('fresh process uses persistent cache', async () => {
  const env = { ...process.env, DSH_HOME: home() }
  const run = () => {
    const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child'], { env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout).requests
  }
  assert.equal(run(), 2)
  assert.equal(run(), 0)
})
test('failed version lookup is not cached and can retry', async () => {
  process.env.DSH_HOME = home()
  let attempts = 0
  const discovery = new CodexModelDiscovery(async url => {
    if (url.includes('registry.npmjs.org') && ++attempts === 1) return new Response('', { status: 503 })
    return new Response(JSON.stringify(url.includes('registry.npmjs.org') ? { version: '1.2.3' } : payload))
  })
  await assert.rejects(discovery.discover(credential, provider))
  assert.ok((await discovery.discover(credential, provider)).visible.has('fixture-model'))
  assert.equal(attempts, 2)
})
let failures = 0
for (const { name, run } of tests) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); metadata = payload }
}
if (failures) process.exitCode = 1
