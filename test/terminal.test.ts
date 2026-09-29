import {expect, test} from 'bun:test'
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {stripVTControlCharacters} from 'node:util'

import {inspectJournal, readJournal} from '../src/journal.ts'

type Span = {attributes: Array<{key: string
  value: Record<string, unknown>}>
name: string
parentSpanId?: string
spanId: string
traceId: string;}
const attributes = (span: Span) => Object.fromEntries(span.attributes.map(value => [value.key, Object.values(value.value)[0]]))
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
test.skipIf(process.platform !== 'win32')('real ConPTY: ANSI, stderr, TTYs, raw input, cancellation, shell state, redirection, full output, early starts and durable delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'powershell-terminal-test-'))
  const archiveRoot = join(root, 'sessions')
  const profile = join(root, 'profile.ps1')
  const native = join(root, 'native.ts')
  const early = join(root, 'early-arrived')
  writeFileSync(profile, "Set-PSReadLineOption -HistorySaveStyle SaveNothing -PredictionSource None\nfunction global:prompt { 'PST_TEST_PROMPT> ' }\n")
  writeFileSync(native, String.raw`
const mode = Bun.argv.at(-1)
if (mode === 'flags') {
  process.stdout.write(JSON.stringify({stdin:!!process.stdin.isTTY,stdout:!!process.stdout.isTTY,stderr:!!process.stderr.isTTY})+'\n')
} else if (mode === 'binary') {
  process.stdout.write(Buffer.from(Array.from({length:256},(_,index)=>index)))
} else if (mode === 'interactive') {
  process.stdin.setRawMode(true)
  process.stdout.write('\x1b[?1049hTUI_READY')
  const timer = setTimeout(()=>process.exit(90),10000)
  process.stdin.once('data', data => {
    clearTimeout(timer)
    process.stdin.setRawMode(false)
    process.stdout.write('INPUT_LENGTH='+data.length+'\x1b[?1049l')
    process.stdin.pause()
  })
} else if (mode === 'large') {
  process.stdout.write('🦄'.repeat(20000)+'\n')
} else {
  process.stdout.write('\x1b[38;5;45mCYAN\x1b[0m \x1b[2m↵…86\x1b[22m \x1b]8;;https://example.invalid/tool?tool_call=32\x07TOOL_LINK\x1b]8;;\x07\n')
  process.stderr.write('NATIVE_STDERR_NOT_AN_ERROR\n')
}
`)
  const received: Array<Span> = []
  let retries = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      let bytes = Buffer.from(await request.arrayBuffer())
      if (request.headers.get('content-encoding') === 'gzip') {
        bytes = Buffer.from(Bun.gunzipSync(bytes))
      }
      const body = JSON.parse(bytes.toString()) as {resourceSpans: Array<{scopeSpans: Array<{spans: Array<Span>}>}>}
      const batch = body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
      if (batch.some(span => String(attributes(span).command).includes('EARLY_MARKER')) && retries++ === 0) {
        return new Response('temporary failure', {status: 503})
      }
      received.push(...batch)
      if (batch.some(span => span.name === 'powershell.command.started' && String(attributes(span).command).includes('EARLY_MARKER'))) {
        writeFileSync(early, 'started')
      }
      return Response.json({})
    },
  })
  const child = Bun.spawn(['pwsh', '-NoLogo', '-NoProfile', '-File', resolve('src/host.ps1'), '-Endpoint', server.url.href, '-BunPath', process.execPath, '-ArchiveRoot', archiveRoot, '-ProfileFile', profile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let terminal = ''
  let errors = ''
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder
    for await (const data of stream) {
      append(decoder.decode(data, {stream: true}))
    }
  }
  const readers = [
    drain(child.stdout, text => {
      terminal += text
    }), drain(child.stderr, text => {
      errors += text
    }),
  ]
  let directory = ''
  const wait = async (predicate: () => boolean, label: string, timeout = 12_000) => {
    const deadline = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() >= deadline || child.exitCode !== null) {
        throw new Error(`${label}: exit ${child.exitCode}; ${errors}; ${terminal.slice(-3000)}`)
      }
      await Bun.sleep(20)
    }
  }
  const records = () => directory ? [...readJournal(directory)].map(value => value.record) : []
  const send = (source: string) => {
    child.stdin.write(`${source}\r`); child.stdin.flush()
  }
  const command = async (source: string) => {
    const count = records().filter(record => record.type === 'start').length
    send(source)
    await wait(() => records().filter(record => record.type === 'start').length > count, 'Command did not start')
    const start = records().findLast(record => record.type === 'start')!
    expect(start.command).toBe(source)
    await wait(() => records().some(record => record.type === 'complete' && record.id === start.id), 'Command did not finish')
    const result = records().find(record => record.type === 'complete' && record.id === start.id)!
    const output = Buffer.concat(records().filter(record => record.type === 'output' && record.id === start.id).map(record => Buffer.from(String(record.data), 'base64'))).toString('utf8')
    expect(output).not.toContain('PST_TEST_PROMPT>')
    return {
      start,
      result,
      output,
      plain: stripVTControlCharacters(output),
    }
  }
  try {
    await wait(() => terminal.includes('PST_TEST_PROMPT>'), 'No initial prompt')
    directory = join(archiveRoot, readdirSync(archiveRoot)[0])
    expect(records().some(record => record.type === 'session.ready')).toBe(true)
    const flags = await command(`& ${quote(process.execPath)} ${quote(native)} flags`)
    expect(JSON.parse(flags.plain.trim())).toEqual({
      stdin: true,
      stdout: true,
      stderr: true,
    })
    const ansi = await command(`& ${quote(process.execPath)} ${quote(native)} ansi`)
    expect(ansi.output).toContain('\u001B[')
    expect(ansi.output).toContain('\u001B[2m')
    expect(ansi.output).toContain('\u001B]8;')
    expect(ansi.output).toContain('https://example.invalid/tool?tool_call=32')
    expect(ansi.plain).toContain('NATIVE_STDERR_NOT_AN_ERROR')
    expect(ansi.output).not.toContain('\u001B[31;1mNATIVE_STDERR_NOT_AN_ERROR')
    await command('$persisted = 42; function Test-Persisted { $persisted }; "STATE_OK"')
    const state = await command('"PERSISTED:" + (Test-Persisted)')
    expect(state.plain).toContain('PERSISTED:42')
    const failure = await command('cmd /c exit 7')
    expect(failure.result.resultCode).toBe(7)
    const previous = await command('$saved = $?; "STATUS:" + $saved + ":" + $LASTEXITCODE')
    expect(previous.plain).toContain('STATUS:False:7')
    const psError = await command('Write-Error "REAL_POWERSHELL_ERROR"')
    expect(psError.result.resultCode).toBe(1)
    expect(JSON.stringify(psError.result.errors)).toContain('REAL_POWERSHELL_ERROR')
    expect(psError.output).toContain('\u001B[')
    const thrown = await command('throw "TERMINATING_ERROR"')
    expect(thrown.result.success).toBe(false)
    expect(JSON.stringify(thrown.result.errors)).toContain('TERMINATING_ERROR')
    // Like an uninstrumented shell, a no-output return retains the incoming failure status.
    expect((await command('return')).result.success).toBe(false)
    const recovery = await command('"AFTER_ERROR"')
    expect(recovery.result.success).toBe(true)
    const piped = await command(`& ${quote(process.execPath)} ${quote(native)} flags | ConvertFrom-Json | ForEach-Object { "PIPE_STDOUT:" + $_.stdout + ":STDERR:" + $_.stderr }`)
    expect(piped.plain).toContain('PIPE_STDOUT:False:STDERR:True')
    const binary = join(root, 'binary.bin')
    await command(`& ${quote(process.execPath)} ${quote(native)} binary > ${quote(binary)}`)
    expect(readFileSync(binary)).toEqual(Buffer.from(Array.from({length: 256}, (_, index) => index)))
    const assigned = await command(`$assigned = & ${quote(process.execPath)} ${quote(native)} flags; "ASSIGNED:" + (($assigned | ConvertFrom-Json).stdout)`)
    expect(assigned.plain).toContain('ASSIGNED:False')
    await command('using namespace System.Text')
    const syntax = await command('[StringBuilder]::new("USING_WORKS").ToString()')
    expect(syntax.plain).toContain('USING_WORKS')
    const parameter = await command('param([string]$value = "PARAM_WORKS"); $value')
    expect(parameter.plain).toContain('PARAM_WORKS')
    await command('Set-StrictMode -Version Latest; "STRICT_OK"')
    expect((await command('"STILL_STRICT_OK"')).result.success).toBe(true)
    await command('Set-StrictMode -Off')
    const count = records().filter(record => record.type === 'start').length
    const offset = terminal.length
    send(`& ${quote(process.execPath)} ${quote(native)} interactive`)
    await wait(() => terminal.slice(offset).includes('TUI_READY'), 'No interactive input prompt')
    child.stdin.write('private-input-not-echoed'); child.stdin.flush()
    await wait(() => records().filter(record => record.type === 'complete').length > count, 'Interactive program did not finish')
    const interactive = records().findLast(record => record.type === 'complete')!
    expect(interactive.success).toBe(true)
    expect(readFileSync(join(directory, 'events.jsonl'), 'utf8')).not.toContain('private-input-not-echoed')
    send('Start-Sleep -Seconds 30; "MUST_NOT_RUN"')
    await wait(() => records().findLast(record => record.type === 'start')?.command === 'Start-Sleep -Seconds 30; "MUST_NOT_RUN"', 'Sleep did not start')
    const canceledId = records().findLast(record => record.type === 'start')!.id
    await Bun.sleep(250)
    child.stdin.write('\u0003'); child.stdin.flush()
    await wait(() => records().some(record => record.type === 'complete' && record.id === canceledId), 'Ctrl+C did not return a prompt', 5000)
    expect(records().find(record => record.type === 'complete' && record.id === canceledId)!.success).toBe(false)
    expect((await command('"AFTER_CANCEL"')).plain).toContain('AFTER_CANCEL')
    const large = await command(`& ${quote(process.execPath)} ${quote(native)} large`)
    expect(large.result.terminalBytes).toBeGreaterThan(80_000)
    expect(large.result.terminalPreviewTruncated).toBe(true)
    // ConPTY may repaint cells. The journal retains the full VT transport, not a fabricated raw stdout stream.
    expect([...large.plain.matchAll(/🦄/gu)].length).toBeGreaterThanOrEqual(20_000)
    const earlyCommand = `"EARLY_MARKER"; $deadline = [DateTime]::UtcNow.AddSeconds(8); while (-not (Test-Path ${quote(early)})) { if ([DateTime]::UtcNow -gt $deadline) { throw "Start was not exported" }; Start-Sleep -Milliseconds 20 }`
    expect((await command(earlyCommand)).result.success).toBe(true)
    expect(retries).toBeGreaterThan(1)
    expect((await command('"SYNC:" + (Sync-PowerShellTelemetry -Timeout 5000)')).plain).toContain('SYNC:True')
    const history = await command('(Get-History -Count 1).CommandLine')
    expect(history.plain).toContain('Sync-PowerShellTelemetry -Timeout 5000')
    expect(history.plain).not.toContain('Out-PowerShellTelemetry')
    send('exit 23')
    const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)])
    expect(exited).toBe(23)
    await Promise.all(readers)
    expect(errors).toBe('')
    expect(terminal).not.toContain(']633;PST;')
    const inspected = inspectJournal(directory)
    expect(inspected.sessionEnded).toBe(true)
    expect([...inspected.commands.values()].every(command => command.complete)).toBe(true)
    const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
    expect(status.complete).toBe(true)
    expect(status.deliveryIssues).toBe(0)
    const starts = received.filter(span => span.name === 'powershell.command.started')
    const completions = received.filter(span => span.name === 'powershell.command')
    expect(completions).toHaveLength(starts.length)
    for (const span of completions) {
      expect(starts.some(start => start.spanId === span.parentSpanId && start.traceId === span.traceId)).toBe(true)
    }
  } finally {
    if (child.exitCode === null) {
      const kill = Bun.spawn(['taskkill', '/pid', String(child.pid), '/t', '/f'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await kill.exited
      await child.exited
    }
    await server.stop(true)
    // Keep failed-fixture diagnostics in out, never in the real telemetry archive.
    if (errors || child.exitCode !== 23) {
      writeFileSync(join(root, 'terminal.txt'), `${terminal}\nSTDERR\n${errors}`)
      process.stderr.write(`Terminal fixture retained at ${root}\n`)
    } else {
      rmSync(root, {
        recursive: true,
        force: true,
      })
    }
  }
}, 120_000)
test.skipIf(process.platform !== 'win32')('a real terminal frontend propagates resizing, Win32 Ctrl+C and exit codes through the recorder', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'powershell-resize-test-'))
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.arrayBuffer(); return Response.json({})
    },
  })
  try {
    const child = Bun.spawn(['pwsh', '-NoProfile', '-File', resolve('test/resize.ps1'), '-Directory', directory, '-Source', resolve('src'), '-Endpoint', server.url.href, '-BunPath', process.execPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) {
      throw new Error(out + err)
    }
    const archive = join(directory, 'sessions', readdirSync(join(directory, 'sessions'))[0])
    expect(inspectJournal(archive).sessionEnded).toBe(true)
    expect([...readJournal(archive)].some(({record}) => record.type === 'resize' && record.columns === 82 && record.rows === 22)).toBe(true)
    const ended = [...readJournal(archive)].findLast(({record}) => record.type === 'session.end')!.record
    expect(ended.exitCode).toBe(19)
  } finally {
    await server.stop(true); rmSync(directory, {
      recursive: true,
      force: true,
    })
  }
}, 45_000)
