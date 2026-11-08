import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Compile src to an isolated directory and set AUTH_TEST_OUTPUT to that directory.
const output = process.env.AUTH_TEST_OUTPUT
assert.ok(output, 'AUTH_TEST_OUTPUT must point to isolated compiled source')
const { apply, CredentialFile } = await import(pathToFileURL(join(output, 'index.js')))
const { CodexModelDiscovery } = await import(pathToFileURL(join(output, 'modelDiscovery.js')))
const { buildOAuthProfile } = await import(pathToFileURL(join(output, 'profiles.js')))
process.env.DSH_HOME = mkdtempSync('/tmp/opencode/auth-identity-')
process.env.DSH_AUTH_CREDENTIALS = ''
const credentialA = { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', accountId: 'synthetic-A', expires: Date.now() + 600_000 }
let credential
CredentialFile.prototype.read = async () => credential

for (const scenario of ['account switch', 'token refresh', 'logout', 'stale failure']) {
  credential = { ...credentialA, access: `${credentialA.access}-${scenario}` }
  let release
  let started
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    if (options.headers.Authorization !== 'Bearer synthetic-refreshed' && options.headers['ChatGPT-Account-Id'] === 'synthetic-A') {
      started()
      await pending
      if (scenario === 'stale failure') return new Response('', { status: 503 })
      return Response.json({ models: [{ slug: 'model-for-a', visibility: 'list' }] })
    }
    return Response.json({ models: [{ slug: 'model-for-b', visibility: 'list' }] })
  }
  let adapter
  const auth = {}
  const ctx = {
    logger: { warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'dshAuth') return auth
      if (name === 'llm') return { registerAdapter(_ids, value) { adapter = value; return () => {} } }
    },
    effect(fn) { fn().next() },
  }
  apply(ctx, { providers: ['openai-codex'], command: false })
  const old = adapter.listModels('openai-codex')
  await requested
  if (scenario === 'logout') credential = undefined
  else if (scenario === 'token refresh') credential = { ...credential, access: 'synthetic-refreshed' }
  else credential = { ...credential, accountId: 'synthetic-B' }
  // Install B first: a late A result (including failure) must not replace it.
  if (credential) assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-for-b'])
  release()
  assert.deepEqual(await old, [], `${scenario}: stale caller must receive no models`)
  if (credential) assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-for-b'])
  else assert.deepEqual(await adapter.listModels('openai-codex'), [])
  console.log(`PASS ${scenario}`)
}

// /model asks for models and providers in parallel; provider enumeration also
// invokes listModels. Exercise those two consumers against one shared fetch.
for (const outcome of ['success', 'failure']) {
  credential = { ...credentialA, access: `parallel-${outcome}` }
  CredentialFile.prototype.read = async () => credential
  let release, started, requests = 0, warnings = 0
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { started = resolve })
  globalThis.fetch = async url => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    requests++
    started()
    await pending
    if (outcome === 'failure') throw new Error('synthetic failure')
    return Response.json({ models: [{ slug: 'parallel-model', display_name: 'Parallel Model', input_modalities: ['text'], context_window: 432100 }] })
  }
  let adapter
  const ctx = {
    logger: { warn() { warnings++ }, error() {}, debug() {} },
    get(name) {
      if (name === 'dshAuth') return {}
      if (name === 'llm') return { registerAdapter(_ids, value) { adapter = value; return () => {} } }
    },
    effect(fn) { fn().next() },
  }
  apply(ctx, { providers: ['openai-codex'], command: false })
  warnings = 0
  const models = adapter.listModels('openai-codex')
  await requested
  const providers = adapter.listModels('openai-codex').then(rows => ({ names: rows.length ? ['openai-codex'] : [], rows }))
  for (let i = 0; i < 20; i++) await Promise.resolve()
  release()
  const [rows, providerRows] = await Promise.all([models, providers])
  assert.ok(rows.length > 0, `${outcome}: model consumer must not be cancelled`)
  assert.deepEqual(providerRows.names, ['openai-codex'])
  assert.deepEqual(providerRows.rows, rows)
  assert.equal(requests, 1)
  if (outcome === 'success') {
    assert.deepEqual(rows.map(row => row.id), ['parallel-model'])
    assert.equal(rows[0].name, 'Parallel Model')
    assert.deepEqual(rows[0].inputModalities, ['text'])
    assert.equal(warnings, 0)
  } else assert.equal(warnings, 1)
  console.log(`PASS parallel ${outcome}`)
}

// Inspect the actual installed provider, not a subsequent picker call (which
// could silently repair a stale reset by rediscovering the current account).
for (const scenario of ['gate read', 'initial read', 'initial read rejects', 'final read', 'error read', 'error read rejects', 'logout during read']) {
  credential = { ...credentialA, access: `read-race-${scenario}` }
  const b = { ...credential, accountId: 'synthetic-B' }
  let calls = 0
  let release
  let started
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { started = resolve })
  CredentialFile.prototype.read = async () => {
    const snapshot = credential
    calls++
    const blocked = scenario === 'gate read' ? 1 : scenario === 'final read' || scenario.startsWith('error read') ? 3 : 2
    if (calls === blocked) {
      started()
      await pending
      if (scenario.endsWith('read rejects')) throw new Error('synthetic read failure')
    }
    return snapshot
  }
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    if (options.headers['ChatGPT-Account-Id'] === 'synthetic-A' && scenario.startsWith('error read')) return new Response('', { status: 503 })
    return Response.json({ models: [{ slug: options.headers['ChatGPT-Account-Id'] === 'synthetic-A' ? 'model-for-a' : 'model-for-b' }] })
  }
  let adapter
  const ctx = {
    logger: { warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'dshAuth') return {}
      if (name === 'llm') return { registerAdapter(_ids, value) { adapter = value; return () => {} } }
    },
    effect(fn) { fn().next() },
  }
  apply(ctx, { providers: ['openai-codex'], command: false })
  const old = adapter.listModels('openai-codex')
  await requested
  credential = scenario === 'logout during read' ? undefined : b
  if (credential) assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-for-b'])
  else assert.deepEqual(await adapter.listModels('openai-codex'), [])
  release()
  assert.deepEqual(await old, [], `${scenario}: stale caller`)
  const parent = Object.getPrototypeOf(Object.getPrototypeOf(adapter))
  const installed = await parent.listModels.call(adapter, 'openai-codex')
  if (credential) assert.ok(installed.some(x => x.id === 'model-for-b'), `${scenario}: B provider must stay installed`)
  else assert.ok(!installed.some(x => x.id === 'model-for-a'), `${scenario}: A must not be installed after logout`)
  if (credential) assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-for-b'], `${scenario}: stale fallback must not suppress B`)
  console.log(`PASS ${scenario}`)
}

for (const scenario of ['same identity reordered gate', 'ABA reordered gate']) {
  credential = { ...credentialA, access: `ordering-${scenario}` }
  const a = credential
  let calls = 0, release, started
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { started = resolve })
  CredentialFile.prototype.read = async () => {
    const snapshot = credential
    if (++calls === 1) { started(); await pending }
    return snapshot
  }
  globalThis.fetch = async (url, options) => String(url).includes('registry.npmjs.org')
    ? Response.json({ version: '9.8.7' })
    : Response.json({ models: [{ slug: options.headers['ChatGPT-Account-Id'] === 'synthetic-A' ? 'model-for-a' : 'model-for-b' }] })
  let adapter
  const ctx = {
    logger: { warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'dshAuth') return {}
      if (name === 'llm') return { registerAdapter(_ids, value) { adapter = value; return () => {} } }
    },
    effect(fn) { fn().next() },
  }
  apply(ctx, { providers: ['openai-codex'], command: false })
  const old = adapter.listModels('openai-codex')
  await requested
  if (scenario.startsWith('ABA')) {
    credential = { ...a, accountId: 'synthetic-B' }
    assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-for-b'])
    credential = a
  }
  assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-for-a'])
  release()
  const oldModels = await old
  assert.deepEqual(oldModels.map(x => x.id), scenario.startsWith('ABA') ? [] : ['model-for-a'])
  console.log(`PASS ${scenario}`)
}

// A late response must not poison either cache after an observed A -> B -> A.
{
  process.env.DSH_HOME = mkdtempSync('/tmp/opencode/auth-aba-cache-')
  credential = { ...credentialA, access: 'aba-cache-token' }
  const a = credential
  CredentialFile.prototype.read = async () => credential
  let release, started, requests = 0
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    if (options.headers['ChatGPT-Account-Id'] === 'synthetic-B') return Response.json({ models: [{ slug: 'model-b' }] })
    if (++requests === 1) { started(); await pending; return Response.json({ models: [{ slug: 'old-a' }] }) }
    return Response.json({ models: [{ slug: 'new-a' }] })
  }
  let adapter
  const ctx = {
    logger: { warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'dshAuth') return {}
      if (name === 'llm') return { registerAdapter(_ids, value) { adapter = value; return () => {} } }
    },
    effect(fn) { fn().next() },
  }
  apply(ctx, { providers: ['openai-codex'], command: false })
  const old = adapter.listModels('openai-codex')
  await requested
  credential = { ...a, accountId: 'synthetic-B' }
  assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['model-b'])
  credential = a
  assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['new-a'])
  release()
  assert.deepEqual(await old, [])
  const hash = createHash('sha256').update(JSON.stringify(['https://chatgpt.com/backend-api/codex/models', '9.8.7', a.access, a.accountId, ''])).digest('hex')
  const disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-auth', 'model-cache', `catalog-${hash}.json`), 'utf8'))
  assert.deepEqual(disk.data.models.map(x => x.slug), ['new-a'], 'older completion must not overwrite disk')
  assert.deepEqual((await adapter.listModels('openai-codex')).map(x => x.id), ['new-a'], 'next picker must use fresh in-memory cache')
  assert.equal(requests, 2)
  console.log('PASS observed ABA late response and both caches')
}

for (const outcome of ['newer succeeds', 'newer fails']) {
  process.env.DSH_HOME = mkdtempSync('/tmp/opencode/auth-cache-flight-')
  const a = { ...credentialA, access: `flight-${outcome}` }
  let release, started, requests = 0
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { started = resolve })
  const request = async url => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    if (++requests === 1) { started(); await pending; return Response.json({ models: [{ slug: 'first-flight' }] }) }
    if (outcome === 'newer fails') throw new Error('synthetic failure')
    return Response.json({ models: [{ slug: 'second-flight' }] })
  }
  const provider = buildOAuthProfile('openai-codex').piProvider
  const first = new CodexModelDiscovery(request)
  const second = new CodexModelDiscovery(request)
  const old = first.discover(a, provider)
  await requested
  if (outcome === 'newer fails') await assert.rejects(second.discover(a, provider), /synthetic failure/)
  else assert.deepEqual([...(await second.discover(a, provider)).visible], ['second-flight'])
  release()
  await old
  const expected = outcome === 'newer fails' ? 'first-flight' : 'second-flight'
  const hash = createHash('sha256').update(JSON.stringify(['https://chatgpt.com/backend-api/codex/models', '9.8.7', a.access, a.accountId, ''])).digest('hex')
  const disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-auth', 'model-cache', `catalog-${hash}.json`), 'utf8'))
  assert.deepEqual(disk.data.models.map(x => x.slug), [expected])
  assert.deepEqual([...(await first.discover(a, provider)).visible], [expected])
  assert.equal(requests, 2)
  console.log(`PASS separate instances ${outcome}`)
}

{
  process.env.DSH_HOME = mkdtempSync('/tmp/opencode/auth-pending-flight-')
  const a = { ...credentialA, access: 'pending-token' }
  const b = { ...a, accountId: 'synthetic-B' }
  let releaseOld, releaseNew, oldStarted, newStarted, requestsA = 0
  const oldHold = new Promise(resolve => { releaseOld = resolve })
  const newHold = new Promise(resolve => { releaseNew = resolve })
  const oldReady = new Promise(resolve => { oldStarted = resolve })
  const newReady = new Promise(resolve => { newStarted = resolve })
  const request = async (url, options) => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    if (options.headers['ChatGPT-Account-Id'] === 'synthetic-B') return Response.json({ models: [{ slug: 'pending-b' }] })
    if (++requestsA === 1) { oldStarted(); await oldHold; throw new Error('old failure') }
    newStarted(); await newHold
    return Response.json({ models: [{ slug: 'pending-new-a' }] })
  }
  const provider = buildOAuthProfile('openai-codex').piProvider
  const discovery = new CodexModelDiscovery(request)
  const old = discovery.discover(a, provider)
  const oldRejected = assert.rejects(old, /old failure/)
  await oldReady
  await discovery.discover(b, provider)
  const newer = discovery.discover(a, provider)
  await newReady
  releaseOld()
  await oldRejected
  const joined = discovery.discover(a, provider)
  releaseNew()
  const [result, joinedResult] = await Promise.all([newer, joined])
  assert.equal(result, joinedResult)
  assert.deepEqual([...result.visible], ['pending-new-a'])
  assert.equal(requestsA, 2, 'old failure must not clear newer pending request')
  console.log('PASS stale failure preserves newer pending discovery')
}

{
  const rootA = mkdtempSync('/tmp/opencode/auth-context-a-')
  const rootB = mkdtempSync('/tmp/opencode/auth-context-b-')
  process.env.DSH_HOME = rootA
  process.env.DSH_AUTH_CREDENTIALS = 'synthetic-context-a'
  const a = { ...credentialA, access: 'context-token' }
  let started, release
  const ready = new Promise(resolve => { started = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const provider = buildOAuthProfile('openai-codex').piProvider
  const requestA = async url => {
    if (String(url).includes('registry.npmjs.org')) return Response.json({ version: '9.8.7' })
    started(); await hold
    return Response.json({ models: [{ slug: 'context-a-model' }] })
  }
  const requestB = async url => String(url).includes('registry.npmjs.org')
    ? Response.json({ version: '9.8.7' }) : Response.json({ models: [{ slug: 'context-b-model' }] })
  const old = new CodexModelDiscovery(requestA).discover(a, provider)
  await ready
  process.env.DSH_HOME = rootB
  process.env.DSH_AUTH_CREDENTIALS = 'synthetic-context-b'
  assert.deepEqual([...(await new CodexModelDiscovery(requestB).discover(a, provider)).visible], ['context-b-model'])
  release()
  await old
  const hashB = createHash('sha256').update(JSON.stringify(['https://chatgpt.com/backend-api/codex/models', '9.8.7', a.access, a.accountId, 'synthetic-context-b'])).digest('hex')
  const disk = JSON.parse(readFileSync(join(rootB, 'dsh-auth', 'model-cache', `catalog-${hashB}.json`), 'utf8'))
  assert.deepEqual(disk.data.models.map(x => x.slug), ['context-b-model'])
  console.log('PASS changed cache context does not receive old response')
}
