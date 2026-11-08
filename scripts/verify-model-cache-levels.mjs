import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const output = process.env.AUTH_TEST_OUTPUT
assert.ok(output, 'AUTH_TEST_OUTPUT must point to isolated compiled source')
const { CodexModelDiscovery } = await import(pathToFileURL(join(output, 'modelDiscovery.js')))
const { buildOAuthProfile } = await import(pathToFileURL(join(output, 'profiles.js')))
const provider = buildOAuthProfile('openai-codex').piProvider
const credential = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1e15 }
const level = effort => ({ effort })
let calls = 0
const request = async url => {
  calls++
  return Response.json(String(url).includes('registry.npmjs.org') ? { version: '1.2.3' } : JSON.parse(process.env.FIXTURE_PAYLOAD))
}
if (process.argv[2] === 'child') {
  const catalog = await new CodexModelDiscovery(request).discover(credential, provider)
  const models = catalog.provider.getModels().map(({ id, name, input, contextWindow, reasoning, thinkingLevelMap }) => ({ id, name, input, contextWindow, reasoning, thinkingLevelMap }))
  console.log(JSON.stringify({ calls, visible: [...catalog.visible], models }))
  process.exit(0)
}
const root = () => mkdtempSync('/tmp/opencode/auth-levels-')
const cache = home => join(home, 'dsh-auth', 'model-cache')
const catalogFiles = home => readdirSync(cache(home)).filter(name => name.startsWith('catalog-'))
const run = env => {
  const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const fixture = models => ({ ...process.env, DSH_HOME: root(), FIXTURE_PAYLOAD: JSON.stringify({ models }) })
const rows = [
  { slug: 'mixed-model', display_name: 'Mixed Model', context_window: 123456, input_modalities: ['text'], supported_reasoning_levels: [level('low'), level('future-level'), level('max')] },
  { slug: 'unknown-model', context_window: 321000, supported_reasoning_levels: [level('future_level')] },
  { slug: 'known-model', supported_reasoning_levels: [level('high')] },
  { slug: 'empty-model', supported_reasoning_levels: [] },
  { slug: 'hidden-model', visibility: 'hide', supported_reasoning_levels: [level('next')] },
]
{
  const env = fixture(rows)
  const cold = run(env), warm = run(env)
  assert.equal(cold.calls, 2)
  assert.equal(warm.calls, 0, 'whole multi-model catalog must be cached across processes')
  assert.deepEqual({ ...cold, calls: 0 }, warm, 'fresh and warm descriptors and visibility must match')
  assert.equal(cold.models.find(item => item.id === 'unknown-model').reasoning, true)
  assert.equal(catalogFiles(env.DSH_HOME).length, 1)
  const saved = JSON.parse(readFileSync(join(cache(env.DSH_HOME), catalogFiles(env.DSH_HOME)[0]), 'utf8'))
  assert.deepEqual(saved.data.models, rows)
}
{
  const env = fixture([{ slug: 'only-unknown', supported_reasoning_levels: [level('future-level')] }])
  const cold = run(env), warm = run(env)
  assert.equal(warm.calls, 0)
  assert.deepEqual({ ...cold, calls: 0 }, warm)
}
for (const context_window of [0, -1, 1.5, 100_000_001, null]) {
  const env = fixture([{ slug: 'invalid-context', context_window, supported_reasoning_levels: [level('future-level')] }])
  run(env)
  assert.deepEqual(catalogFiles(env.DSH_HOME), [], 'invalid context must still reject cache')
  assert.equal(run(env).calls, 1)
}
for (const unknown of [123, null, { nested: 'value' }, '', 'bad value', 'x'.repeat(129), 'sk-syntheticSecret123', 'fixture-refresh', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureabc123456', '__proto__', 'constructor', 'prototype']) {
  const env = fixture([{ slug: 'fixture-model', supported_reasoning_levels: [level('low'), level(unknown)] }])
  run(env)
  assert.deepEqual(catalogFiles(env.DSH_HOME), [], 'unsafe or malformed effort must reject cache')
  assert.equal(run(env).calls, 1, 'unsafe or malformed effort must cause cache miss')
  const archive = readdirSync(cache(env.DSH_HOME)).map(name => readFileSync(join(cache(env.DSH_HOME), name), 'utf8')).join('\n')
  if (typeof unknown === 'string' && unknown) assert.ok(!archive.includes(unknown))
}
{
  const poisoned = JSON.parse('{"effort":"future-level","__proto__":{"effort":"fixture-refresh"},"extra":"fixture-refresh"}')
  const env = fixture([{ slug: 'fixture-model', supported_reasoning_levels: [level('low'), poisoned], extra: 'fixture-refresh' }])
  const cold = run(env), warm = run(env)
  assert.equal(warm.calls, 0)
  assert.deepEqual({ ...cold, calls: 0 }, warm)
  const saved = readFileSync(join(cache(env.DSH_HOME), catalogFiles(env.DSH_HOME)[0]), 'utf8')
  assert.ok(!saved.includes('__proto__') && !saved.includes('fixture-refresh') && !saved.includes('extra'))
}
{
  const env = fixture([{ slug: 'fixture-model', supported_reasoning_levels: [level('low')] }])
  run(env)
  const file = join(cache(env.DSH_HOME), catalogFiles(env.DSH_HOME)[0])
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.data.models[0].supported_reasoning_levels = [level('future-level')]
  writeFileSync(file, JSON.stringify(saved))
  assert.equal(run(env).calls, 0, 'read validator accepts safe unknown levels')
  saved.data.models[0].supported_reasoning_levels = [level('sk-syntheticSecret123')]
  writeFileSync(file, JSON.stringify(saved))
  assert.equal(run(env).calls, 1, 'read validator rejects credential-like levels')
  saved.data.models[0].supported_reasoning_levels = [JSON.parse('{"effort":"low","__proto__":{}}')]
  writeFileSync(file, JSON.stringify(saved))
  assert.equal(run(env).calls, 1, 'read validator rejects unwhitelisted effort properties')
}
console.log('PASS cache reasoning levels: whole-catalog equivalence, forward compatibility and fail-closed security')
