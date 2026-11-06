// CI only (see .github/workflows/publik-build.yml). Not part of the app.
//
// Starts the packaged app with the publik telemetry endpoint pointed at a
// listener on this machine, and checks what the app sends:
//   - normal start: one correct `app_opened` request must arrive;
//   - start with DO_NOT_TRACK=1: no request may arrive.
// Nothing here talks to publikhq.com.
//
// usage: node publik-telemetry-smoke.cjs <app executable> [app arguments...]
'use strict'

const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const [exe, ...appArgs] = process.argv.slice(2)
if (!exe) {
  console.error('usage: node publik-telemetry-smoke.cjs <app executable> [app arguments...]')
  process.exit(2)
}

const WANT_VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version
const WANT_OS = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ALLOWED_FIELDS = ['v', 'app', 'install_id', 'event', 'app_version', 'os', 'arch']
const OPEN_WAIT_MS = 30000 // how long a normal start may take to send app_opened
const QUIET_WAIT_MS = 12000 // how long the opted-out start is watched

const requests = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(204)
    res.end()
  })
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopApp(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL') // the whole process group
  } catch {}
}

// What is wrong with a recorded request, or null when it is a correct app_opened.
function fault(request) {
  if (request.method !== 'POST') return `method is ${request.method}`
  if (request.url !== '/api/v1/telemetry') return `path is ${request.url}`
  if (request.headers.origin) return 'the request has an Origin header (it must come from native code)'
  if (!/^application\/json/.test(request.headers['content-type'] || '')) return 'content-type is not application/json'
  let body
  try {
    body = JSON.parse(request.body)
  } catch {
    return 'the body is not JSON'
  }
  const extra = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key))
  if (extra.length) return `fields outside the contract: ${extra.join(', ')}`
  if (body.v !== 1) return `v is ${body.v}`
  if (body.app !== 'nitroai') return `app is ${body.app}`
  if (body.event !== 'app_opened') return `event is ${body.event}`
  if (body.app_version !== WANT_VERSION) return `app_version is ${body.app_version}, expected ${WANT_VERSION}`
  if (body.os !== WANT_OS) return `os is ${body.os}, expected ${WANT_OS}`
  if (!UUID_V4.test(body.install_id || '')) return 'install_id is not a lowercase UUID v4'
  if (body.arch !== undefined && !['arm64', 'x64'].includes(body.arch)) return `arch is ${body.arch}`
  return null
}

// One start of the app. Resolves to the requests that arrived during it.
async function run(port, extraEnv, waitMs, stopEarly) {
  const first = requests.length
  const env = {
    ...process.env,
    PUBLIK_TELEMETRY_URL: `http://127.0.0.1:${port}/api/v1/telemetry`,
    PUBLIK_TELEMETRY_DEBUG: '1',
    ...extraEnv,
  }
  delete env.PUBLIK_API_KEY
  if (!('DO_NOT_TRACK' in extraEnv)) delete env.DO_NOT_TRACK
  const child = spawn(exe, appArgs, { env, stdio: 'inherit', detached: process.platform !== 'win32' })
  let exited = null
  child.on('error', (err) => {
    exited = `could not start: ${err.message}`
  })
  child.on('exit', (code, signal) => {
    exited = `exit code ${code}, signal ${signal}`
  })
  const end = Date.now() + waitMs
  while (Date.now() < end) {
    if (stopEarly && requests.length > first) break
    if (exited && !stopEarly) break
    await sleep(250)
  }
  await sleep(500)
  const stillUp = exited === null
  stopApp(child)
  await sleep(1500)
  return { seen: requests.slice(first), stillUp, exited }
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  console.log(`listener on 127.0.0.1:${port}; app: ${exe}; expected version ${WANT_VERSION}, os ${WANT_OS}`)
  let failed = false

  const open = await run(port, {}, OPEN_WAIT_MS, true)
  const good = open.seen.filter((request) => fault(request) === null)
  for (const request of open.seen) console.log(`received: ${request.method} ${request.url} ${request.body}${fault(request) ? '  <-- ' + fault(request) : ''}`)
  if (good.length === 1 && open.seen.length === 1 && open.stillUp) {
    console.log('PASS  normal start: one correct app_opened arrived and the app stayed up')
  } else {
    failed = true
    console.log(`FAIL  normal start: ${open.seen.length} request(s), ${good.length} correct app_opened, app ${open.stillUp ? 'stayed up' : 'stopped (' + open.exited + ')'}`)
  }

  const quiet = await run(port, { DO_NOT_TRACK: '1' }, QUIET_WAIT_MS, false)
  if (quiet.seen.length === 0 && quiet.stillUp) {
    console.log('PASS  DO_NOT_TRACK=1: the app stayed up and no request arrived')
  } else {
    failed = true
    console.log(`FAIL  DO_NOT_TRACK=1: ${quiet.seen.length} request(s) arrived, app ${quiet.stillUp ? 'stayed up' : 'stopped (' + quiet.exited + ')'}`)
  }

  server.close()
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
