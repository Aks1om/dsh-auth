/**
 * Headless smoke for the pure modules — no cordis, no harness, no network.
 *
 * Covers: the credential file as a pi-ai `CredentialStore` (write/read/
 * modify/delete, list metadata, the serialized modify pi-ai's refresh-under-
 * lock depends on, loud corrupt-file refusal, loud refusal of non-OAuth
 * writes), the mounted profiles (catalog identity, OAuth flow present,
 * adapter-facing defaults), the question bridge (select/text mapping,
 * waiting-panel single-flight, cancel wiring), and the service api (status/
 * login/logout over a fabricated flow).
 *
 * Run after build: `node scripts/smoke.mjs`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { CredentialFile, buildOAuthProfile, OAUTH_PROVIDER_IDS, QuestionBridge, createDshAuthApi, openerFor, CredentialGatedAdapter } =
  await import('../lib/index.js')

/** Adapter options over one profile — enough for listModels/resolveModel offline. */
function gateAdapterOptions() {
  const profiles = new Map([['openai-codex', buildOAuthProfile('openai-codex')], ['anthropic', buildOAuthProfile('anthropic')]])
  return {
    profiles: () => profiles,
    resolveApiKey: async () => undefined,
    auth: {
      credentials: { read: async () => undefined, list: async () => [], modify: async (_p, fn) => fn(undefined), delete: async () => {} },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  }
}

let passed = 0
let failed = 0
const ok = (condition, label) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-auth-smoke-'))
try {
  // ── credential store ─────────────────────────────────────────────────────
  console.log('credential store')
  const store = new CredentialFile(join(root, 'creds', 'credentials.json'))
  const firstCred = { type: 'oauth', access: 'a1', refresh: 'r1', expires: Date.now() + 3_600_000 }
  await store.modify('anthropic', async () => firstCred)
  ok((await store.read('anthropic'))?.access === 'a1', 'modify persists and read returns the credential')
  const document = JSON.parse(readFileSync(store.path, 'utf8'))
   ok(document.version === 2 && document.profiles['anthropic']?.default?.credential?.type === 'oauth', 'file shape is the versioned profile document')
   const secondId = await store.addProfile('anthropic', 'Work', { type: 'oauth', access: 'a2', refresh: 'r2', expires: Date.now() + 3_600_000 })
   ok((await store.profiles('anthropic')).length === 2, 'a provider can hold multiple named profiles')
   await store.activate('anthropic', secondId)
   ok((await store.read('anthropic'))?.access === 'a2', 'activation changes the credential used by the provider')
   await store.renameProfile('anthropic', secondId, 'Work account')
   ok((await store.profiles('anthropic')).find(row => row.profileId === secondId)?.label === 'Work account', 'profile labels can be renamed')
  await store.modify('anthropic', async () => undefined)
   ok((await store.read('anthropic'))?.access === 'a2', 'undefined from modify leaves the active profile unchanged')
  ok((await store.list()).length === 1 && (await store.list())[0].type === 'oauth', 'list reports credential metadata without secrets')
  ok((await store.describe()).length === 1, 'describe lists stored providers without secrets')

  // The exclusion pi-ai's refresh-under-lock depends on: two modifies for one
  // provider run serialized, the second seeing the first's write.
  let observed = []
  await Promise.all([
    store.modify('xai', async current => {
      observed.push(current?.access)
      await delay(15)
      return { type: 'oauth', access: 'x1', refresh: 'r', expires: Date.now() + 60_000 }
    }),
    store.modify('xai', async current => {
      observed.push(current?.access)
      return { type: 'oauth', access: 'x2', refresh: 'r', expires: Date.now() + 60_000 }
    }),
  ])
  ok(JSON.stringify(observed) === JSON.stringify([undefined, 'x1']), `concurrent modifies serialize, each seeing the last write (saw ${JSON.stringify(observed)})`)
  ok((await store.read('xai'))?.access === 'x2', 'the last modify wins on disk')

  let refusedWrite = ''
  try {
    await store.modify('xai', async () => ({ type: 'api_key', key: 'nope' }))
  } catch (error) {
    refusedWrite = error.message
  }
  ok(refusedWrite.includes('OAuth credentials only'), 'a non-OAuth credential write is refused loudly')

  ok(await (async () => { const had = (await store.read('anthropic')) !== undefined; await store.delete('anthropic'); return had })(), 'delete removes the credential')
   ok((await store.read('anthropic')) === undefined, 'deleted provider reads as nothing stored')

  const corruptPath = join(root, 'corrupt.json')
  writeFileSync(corruptPath, '{not json', { mode: 0o600 })
  let corruptRefused = false
  try {
    await new CredentialFile(corruptPath).read('anyone')
  } catch {
    corruptRefused = true
  }
  ok(corruptRefused, 'corrupt file refuses loudly instead of acting empty')

  // ── profiles ─────────────────────────────────────────────────────────────
  console.log('profiles')
  const profile = buildOAuthProfile('openai-codex')
  ok(profile.provider === 'openai-codex' && profile.displayName.length > 0, 'profile builds with catalog identity')
  ok(profile.piProvider.auth.oauth !== undefined, 'the provider keeps its OAuth flow object')
  ok(typeof profile.piProvider.auth.oauth?.name === 'string', 'the flow carries a display name')
  ok(profile.maxRequestImageBytes === 20 * 1024 * 1024, 'image budgets mirror llm-pi-ai defaults')
  ok(OAUTH_PROVIDER_IDS.length === 3, `mounted provider set is the expected trio (got ${OAUTH_PROVIDER_IDS.join(',')})`)
  let unknownProvider = ''
  try {
    buildOAuthProfile('openrouter')
  } catch (error) {
    unknownProvider = error.message
  }
  ok(unknownProvider.includes('not an OAuth provider'), 'building an unmounted provider fails loudly')

  // ── per-model overrides ─────────────────────────────────────────────────
  console.log('model overrides')
  const solBase = profile.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')
  ok(solBase !== undefined && typeof solBase?.contextWindow === 'number', 'the catalog ships a numeric context window for gpt-5.6-sol')
  const overridden = buildOAuthProfile('openai-codex', {
    'gpt-5.6-sol': { contextWindow: 1000000 },
  })
  const sol = overridden.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')
  ok(sol?.contextWindow === 1000000, 'modelOverrides contextWindow lands on the target model')
  ok(sol?.maxTokens === solBase?.maxTokens, 'untouched fields keep the installed catalog value')
  const untouched = overridden.piProvider.getModels().find(model => model.id === 'gpt-5.5')
  ok(untouched?.contextWindow === solBase?.contextWindow, 'models without an override stay on the catalog value')
  ok(overridden.piProvider.getModels().length === profile.piProvider.getModels().length, 'the model list keeps every catalog entry')
  ok(overridden.piProvider.auth.oauth !== undefined, 'the provider keeps its OAuth flow object under overrides')
  ok(profile.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')?.contextWindow === solBase?.contextWindow,
    'the installed catalog object is not mutated in place')
  let unknownOverride = ''
  try {
    buildOAuthProfile('openai-codex', { 'not-a-model': { contextWindow: 1 } })
  } catch (error) {
    unknownOverride = error.message
  }
  ok(unknownOverride.includes('does not ship in the installed catalog'), 'an override naming an unknown model fails loudly')
  // Overrides are provider-scoped: a dict that tunes a Codex model is refused
  // on a provider whose catalog does not ship it (the global-dict shape made
  // one cross-provider model id break every provider's boot).
  let crossProviderOverride = ''
  try {
    buildOAuthProfile('anthropic', { 'gpt-5.6-sol': { contextWindow: 1000000 } })
  } catch (error) {
    crossProviderOverride = error.message
  }
  ok(crossProviderOverride.includes('does not ship in the installed catalog'), 'an override naming a model another provider ships is refused on this provider')

  // ── credential-gated adapter ─────────────────────────────────────────────
  console.log('credential-gated adapter')
  const gateStore = new CredentialFile(join(root, 'gate', 'credentials.json'))
  const gated = new CredentialGatedAdapter(gateAdapterOptions(), async provider => {
    try {
      return await gateStore.read(provider) !== undefined
    } catch {
      return false
    }
  })
  const anyGptModel = (await gated.listModels('openai-codex'))[0]
  ok(anyGptModel === undefined, 'unsigned provider lists no models')
  const resolvedWhileUnsigned = await gated.resolveModel('openai-codex', 'gpt-5.6-sol')
  ok(resolvedWhileUnsigned?.id === 'gpt-5.6-sol', 'resolveModel stays ungated (saved sessions keep working)')
  await gateStore.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }))
  const listed = await gated.listModels('openai-codex')
  ok(listed.length > 0 && listed.every(m => m.provider === 'openai-codex'), `signed-in provider lists its catalog (${listed.length} models)`)
  ok((await gated.listModels('anthropic')).length === 0, 'other unsigned providers stay hidden on the same store')

  // ── question bridge ──────────────────────────────────────────────────────
  console.log('question bridge')
  const runAbort = new AbortController()
  const asked = []
  // Scripted answers for the waiting panel, consumed in order; the default
  // mirrors the old behavior (immediate cancel).
  let waitingScript = ['Cancel sign-in']
  let waitingAsked = 0
  const openedUrls = []
  const copiedTexts = []
  const helpers = {
    openUrl: url => { openedUrls.push(url); return true },
    copyText: async text => { copiedTexts.push(text); return true },
  }
  const fakeAsk = async request => {
    asked.push(request)
    const question = request.questions[0]
    if (question.id === 'dsh-auth-prompt' && question.options !== undefined) {
      return { answers: [{ id: question.id, selected: [question.options[0].label] }] }
    }
    if (question.id === 'dsh-auth-waiting') {
      waitingAsked += 1
      const pick = waitingScript[waitingAsked - 1]
      if (pick === undefined) {
        // Script exhausted: park like a human who has not answered yet —
        // only settle()'s abort resolves this, proving the retire path.
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('panel retired')), { once: true })
        })
      }
      return { answers: [{ id: question.id, selected: [pick] }] }
    }
    return { answers: [{ id: question.id, selected: [], custom: 'typed-answer' }] }
  }
  const qb = new QuestionBridge(fakeAsk, runAbort, helpers)
  const selectId = await qb.prompt({ type: 'select', message: 'Choose', options: [{ id: 'opt-2', label: 'Option Two' }, { id: 'opt-1', label: 'Option One' }] })
  ok(selectId === 'opt-2', `select prompt maps the chosen label back to its id (got ${selectId})`)
  const typed = await qb.prompt({ type: 'manual_code', message: 'Paste the code', placeholder: 'xxxx-xxxx' })
  ok(typed === 'typed-answer', 'text prompt reads the custom-answer input row')

  // auth_url: browser opens automatically, panel offers copy/reopen/cancel,
  // and each action re-asks once before the scripted cancel.
  const longUrl = 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1'
  waitingScript = ['Copy authorization link', 'Open browser again', 'Cancel sign-in']
  qb.notify({ type: 'auth_url', url: longUrl, instructions: 'A browser window should open.' })
  for (let i = 0; i < 40 && !runAbort.signal.aborted; i += 1) await delay(5)
  ok(openedUrls[0] === longUrl, 'auth_url opens the browser automatically')
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && r.questions[0]?.options?.some(o => o.label === 'Copy authorization link')), 'waiting panel offers a copy action')
  ok(runAbort.signal.aborted, 'cancel from the waiting panel aborts the run')
  ok(JSON.stringify(copiedTexts) === JSON.stringify([longUrl]), 'copy action copies the exact, unbroken URL')
  ok(openedUrls.length === 2 && openedUrls[1] === longUrl, 'reopen action opens the same URL again')
  ok(waitingAsked === 3, `the panel re-asks after each action (asked ${waitingAsked})`)
  await qb.settle()

  // device_code: verification page auto-opens, the code is the copy target,
  // and settle retires the panel without any cancel answer.
  const runAbort2 = new AbortController()
  const qb2 = new QuestionBridge(fakeAsk, runAbort2, helpers)
  waitingScript = ['Copy code']
  waitingAsked = 0
  qb2.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
  for (let i = 0; i < 40 && copiedTexts.length < 2; i += 1) await delay(5)
  ok(openedUrls[2] === 'https://auth.example/device', 'device flow opens the verification page automatically')
  ok(copiedTexts[1] === 'ABCD-1234', 'copy action on the device panel copies the user code')
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && r.questions[0]?.options?.some(o => o.label === 'Copy code')), 'device panel offers Copy code')
  await qb2.settle()

  // auto-open failure degrades to copy guidance, never a crash.
  const runAbort3 = new AbortController()
  const qb3 = new QuestionBridge(fakeAsk, runAbort3, { openUrl: () => false, copyText: async () => false })
  waitingScript = ['Cancel sign-in']
  waitingAsked = 0
  qb3.notify({ type: 'auth_url', url: 'https://auth.example/x' })
  await delay(10)
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && (r.questions[0]?.detail ?? '').includes('too long')), 'failed open degrades to copy guidance')
  await qb3.settle()

  // ── opener argv shape ────────────────────────────────────────────────────
  console.log('opener argv')
  const authorizeLikeUrl = 'https://auth.openai.com/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1'
  const opener = openerFor(authorizeLikeUrl)
  if (process.platform === 'win32') {
    ok(opener?.verbatim === true, 'win32 opener uses verbatim argv (node would not quote a space-free URL)')
    const startToken = opener?.args[3]
    ok(typeof startToken === 'string' && startToken.startsWith('start "" "') && startToken.endsWith('"'),
      `the whole start command is one token with the URL double-quoted inside (got ${JSON.stringify(startToken?.slice(0, 32))}…)`)
    // Live round-trip through a real cmd.exe: `&` inside double quotes must
    // survive the shell that `start` will run under. Echo (not start) keeps
    // this side-effect free.
    const echo = await new Promise(resolve => {
      const child = spawn('cmd.exe', ['/d', '/c', `echo "${authorizeLikeUrl}"`], { windowsVerbatimArguments: true })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.on('close', () => resolve(out.trim()))
      child.on('error', () => resolve(''))
    })
    ok(echo.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann') && echo.includes('redirect_uri=http%3A%2F%2Flocalhost%3A1455'),
      `a quoted URL survives cmd.exe parsing intact (echo returned ${echo.length} chars)`)
  } else {
    ok(opener !== undefined && !opener.verbatim && opener.args[0] === authorizeLikeUrl,
      `${process.platform} opener passes the URL as a single exec argument (no shell)`)
  }

  // ── service api ──────────────────────────────────────────────────────────
  console.log('service api')
  const apiStore = new CredentialFile(join(root, 'api', 'credentials.json'))
  const fakeProvider = {
    id: 'fake',
    name: 'Fake Provider',
    auth: {
      oauth: {
        name: 'Fake (subscription)',
        loginLabel: 'Sign in with Fake',
        async login() {
          return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }
        },
        async refresh(credential) {
          return credential
        },
        async toAuth() {
          return { headers: { authorization: 'Bearer a' } }
        },
      },
    },
  }
  const fakeProfile = { provider: 'fake', displayName: 'Fake Provider', streamIdleTimeoutMs: 300_000, retryPolicy: { mode: 'normal', maxRetries: 2, retryDelayMs: () => 1 }, configuredMaxTokens: new Map(), piProvider: fakeProvider, maxRequestImageBytes: 1, requestImagePixelBudget: 1, requestImageMaxBytes: 1 }
  const api = createDshAuthApi({
    profiles: new Map([['fake', fakeProfile]]),
    store: apiStore,
    resolveAsk: () => fakeAsk,
    logger: { warn() {} },
  })
  ok((await api.providers())[0].signedIn === false, 'status reports unsigned providers')
  const login = await api.login('fake')
  ok(login.oauthLabel === 'Fake (subscription)' && (await apiStore.read('fake'))?.access === 'a', 'login runs the flow and persists the credential')
  ok((await api.providers())[0].signedIn === true, 'status reports the signed-in provider')
  ok(await api.logout('fake'), 'logout removes the credential')
  let unknownLogin = ''
  try {
    await api.login('nobody')
  } catch (error) {
    unknownLogin = error.message
  }
  ok(unknownLogin.includes('unknown provider'), 'login names the mounted set on an unknown provider')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
