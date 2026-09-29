import {afterAll, expect, spyOn, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {SessionExporter} from '../src/exporter.ts'
import {hash, inspectJournal, readJournal} from '../src/journal.ts'
import powershellTelemetry from '../src/main.ts'

const temporary = mkdtempSync(join(tmpdir(), 'powershell-telemetry-v2-'))
afterAll(() => rmSync(temporary, {
  recursive: true,
  force: true,
}))
const folder = () => mkdtempSync(join(temporary, 'session-'))
test('installs the terminal bootstrap once, ahead of the existing profile, and preserves its backup', async () => {
  const profile = join(temporary, "Jaid's profile.ps1")
  const original = "function prompt { 'custom > ' }\r\n"
  writeFileSync(profile, original)
  const endpoint = 'http://localhost:3303/insert/opentelemetry/v1/traces'
  await powershellTelemetry({
    profile,
    endpoint,
  })
  const first = readFileSync(profile, 'utf8')
  await powershellTelemetry({
    profile,
    endpoint,
  })
  expect(readFileSync(profile, 'utf8')).toBe(first)
  expect(first.endsWith(original)).toBe(true)
  expect(first.match(/# Begin powershell-telemetry/g)).toHaveLength(1)
  expect(first).toContain('bootstrap.ps1')
  expect(first).toContain('-BunPath')
  expect(first).not.toContain('*>&1')
  expect(readFileSync(`${profile}.before-powershell-telemetry`, 'utf8')).toBe(original)
})
test('migrates the old footer without disturbing profile code or the original backup', async () => {
  const profile = join(temporary, 'upgrade.ps1')
  const code = 'function gcp { Set-Location $args[0] }\n'
  writeFileSync(profile, `${code}\n# Begin powershell-telemetry\n. 'old/profile.ps1'\n# End powershell-telemetry\n`)
  writeFileSync(`${profile}.before-powershell-telemetry`, code)
  await powershellTelemetry({
    profile,
    endpoint: 'http://localhost/traces',
  })
  const result = readFileSync(profile, 'utf8')
  expect(result.startsWith('# Begin powershell-telemetry')).toBe(true)
  expect(result).toContain(code)
  expect(result).not.toContain('old/profile.ps1')
  expect(readFileSync(`${profile}.before-powershell-telemetry`, 'utf8')).toBe(code)
})
test.skipIf(!Bun.which('pwsh'))('preserves BOMs and allows param blocks inside profile functions', async () => {
  const profile = join(temporary, 'bom.ps1')
  const original = '\uFEFFfunction Test-Profile {\n  param([string]$Name)\n  $Name\n}\n'
  writeFileSync(profile, original)
  await powershellTelemetry({
    profile,
    endpoint: 'http://localhost/traces',
  })
  const first = readFileSync(profile, 'utf8')
  await powershellTelemetry({
    profile,
    endpoint: 'http://localhost/traces',
  })
  expect(readFileSync(profile, 'utf8')).toBe(first)
  expect(first.startsWith('\uFEFF# Begin powershell-telemetry')).toBe(true)
  expect(first).toContain(original.slice(1))
})
test('refuses ambiguous blocks and syntax-sensitive or signed profiles without modifying them', async () => {
  for (const original of ['# Begin powershell-telemetry\nincomplete\n', 'using namespace System.Text\n', '# SIG # Begin signature block\n']) {
    const profile = join(folder(), 'profile.ps1')
    writeFileSync(profile, original)
    await expect(powershellTelemetry({
      profile,
      endpoint: 'http://localhost/traces',
    })).rejects.toThrow()
    expect(readFileSync(profile, 'utf8')).toBe(original)
  }
})
test.skipIf(process.platform !== 'win32')('recorder preserves ANSI and every Unicode byte across framing boundaries, without archiving the editor or truncating output', async () => {
  const directory = folder()
  const child = Bun.spawn(['pwsh', '-NoProfile', '-File', resolve('test/recorder.ps1'), '-Directory', directory, '-Source', resolve('src')], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) {
    throw new Error(out + err)
  }
  const result = inspectJournal(directory)
  expect(result.sessionEnded).toBe(true)
  expect(() => inspectJournal(join(directory, 'failed'))).toThrow('capture failure')
  const id = [...result.commands.keys()][0]
  const command = inspectJournal(directory, id).commands.get(id)!
  const output = Buffer.concat(command.output)
  expect(output).toEqual(readFileSync(join(directory, 'expected.bin')))
  expect(output.length).toBeGreaterThan(100_000)
  expect(command.complete?.terminalPreviewTruncated).toBe(true)
  expect(String(command.complete?.terminalPreview)).not.toContain('�')
  expect(readFileSync(join(directory, 'events.jsonl'), 'utf8')).not.toContain('unsubmitted-private-text')
  expect(result.consumedBytes).toBe(statSync(join(directory, 'events.jsonl')).size)
}, 20_000)
const archive = (output = Buffer.from('hello\u001B[2m↵\u001B[22m 🦄\n')) => {
  const directory = folder()
  const sessionId = directory.split(/[/\\]/u).at(-1)!
  const manifest = {
    version: 2 as const,
    sessionId,
    hostPid: process.pid,
    shellPid: process.pid,
    startedAt: 1000,
    endpoint: 'http://fixture.invalid/traces',
    serviceName: 'powershell-test',
    host: 'fixture',
    user: 'fixture',
  }
  const id = crypto.randomUUID().replaceAll('-', '')
  const source = [
    {
      type: 'start',
      id,
      command: 'fixture-command',
      pwd: 'C:/fixture',
      shellVersion: 'test',
      time: 1000,
    },
    {
      type: 'output',
      id,
      index: 0,
      offset: 0,
      bytes: output.length,
      data: output.toString('base64'),
      time: 1100,
    },
    {
      type: 'complete',
      id,
      time: 1200,
      resultKnown: true,
      success: true,
      resultCode: 0,
      outcome: 'success',
      durationMs: 200,
      terminalBytes: output.length,
      terminalChunks: 1,
      terminalSha256: hash(output),
      terminalPreview: 'hello',
      terminalPreviewTruncated: false,
    },
    {
      type: 'session.end',
      time: 1200,
      exitCode: 0,
    },
  ]
  const lines = source.map((record, i) => JSON.stringify({
    ...record,
    version: 2,
    sessionId,
    sequence: i + 1,
  }))
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'events.jsonl'), `${lines.join('\n')}\n`)
  return {
    directory,
    manifest,
    id,
    lines,
  }
}
type Span = {attributes: Array<{key: string
  value: Record<string, unknown>}>
name: string
parentSpanId?: string
spanId: string
traceId: string;}
const collector = () => {
  const spans: Array<Span> = []
  let status = 200
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    let data = Buffer.from(init?.body as Uint8Array)
    if (new Headers(init?.headers).get('content-encoding') === 'gzip') {
      data = Buffer.from(Bun.gunzipSync(data))
    }
    if (status === 200) {
      const body = JSON.parse(data.toString()) as {resourceSpans: Array<{scopeSpans: Array<{spans: Array<Span>}>}>}
      spans.push(...body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)))
    }
    return status === 200 ? Response.json({}) : new Response('fixture unavailable', {status})
  }) as typeof fetch
  return {
    fetcher,
    spans,
    setStatus: (value: number) => {
      status = value
    },
  }
}
const attrs = (span: Span) => Object.fromEntries(span.attributes.map(attribute => [attribute.key, Object.values(attribute.value)[0]]))
test('exports lossless hashed records alongside linked lifecycle spans through the real client', async () => {
  const source = archive(Buffer.from('é🦄'.repeat(20_000)))
  const receiver = collector()
  const exporter = new SessionExporter(source.directory, source.manifest, {
    fetch: receiver.fetcher,
    interval: false,
  })
  try {
    expect(exporter.ingest()).toBe(4)
    expect(await exporter.sync(exporter.cursor, 5000)).toBe(true)
    const started = receiver.spans.find(span => span.name === 'powershell.command.started')!
    const completed = receiver.spans.find(span => span.name === 'powershell.command')!
    expect(completed.traceId).toBe(started.traceId)
    expect(completed.parentSpanId).toBe(started.spanId)
    expect(attrs(completed)['output.capture']).toBe('terminal-vt')
    expect(attrs(completed)).not.toHaveProperty('stdout')
    for (let sequence = 1; sequence <= 4; sequence++) {
      const chunks = receiver.spans.filter(span => attrs(span)['record.sequence'] === sequence && attrs(span)['record.chunk.data'] !== undefined).map(attrs).sort((a, b) => Number(a['record.chunk.index']) - Number(b['record.chunk.index']))
      expect(chunks).toHaveLength(Number(chunks[0]['record.chunk.count']))
      const value = Buffer.concat(chunks.map(chunk => Buffer.from(String(chunk['record.chunk.data']), 'base64')))
      expect(hash(value)).toBe(String(chunks[0]['record.sha256']))
      expect(value.toString('utf8')).toBe(source.lines[sequence - 1])
      expect(value).not.toEqual(Buffer.alloc(0))
    }
  } finally {
    await exporter.close()
  }
})
test('delivery cursor and pending spans survive shutdown; rejected delivery remains visibly incomplete', async () => {
  const source = archive()
  const offline = collector()
  offline.setStatus(503)
  const first = new SessionExporter(source.directory, source.manifest, {
    fetch: offline.fetcher,
    interval: false,
  })
  first.ingest()
  const cursor = first.cursor
  expect((await first.close(50)).complete).toBe(false)
  const receiver = collector()
  const second = new SessionExporter(source.directory, source.manifest, {
    fetch: receiver.fetcher,
    interval: false,
  })
  expect(second.cursor).toBe(cursor)
  expect(second.ingest()).toBe(0)
  expect(await second.sync(cursor, 5000)).toBe(true)
  expect(receiver.spans.length).toBeGreaterThan(0)
  await second.close()
  const rejected = collector()
  rejected.setStatus(400)
  const third = new SessionExporter(source.directory, source.manifest, {
    fetch: rejected.fetcher,
    freshReplay: true,
    interval: false,
  })
  third.ingest()
  expect(await third.sync(third.cursor, 3000)).toBe(false)
  expect(third.status().deliveryIssues).toBeGreaterThan(0)
  expect((await third.close()).complete).toBe(false)
})
test('a partial journal tail is not consumed, and checksum mismatches are explicit', async () => {
  const source = archive()
  const bytes = readFileSync(join(source.directory, 'events.jsonl'))
  appendFileSync(join(source.directory, 'events.jsonl'), '{"type":')
  expect([...readJournal(source.directory)]).toHaveLength(4)
  const receiver = collector()
  const exporter = new SessionExporter(source.directory, source.manifest, {
    fetch: receiver.fetcher,
    interval: false,
  })
  exporter.ingest()
  expect(exporter.cursor).toBe(bytes.length)
  expect((await exporter.close()).complete).toBe(false)
  writeFileSync(join(source.directory, 'events.jsonl'), bytes.toString().replace(hash(Buffer.from('hello\u001B[2m↵\u001B[22m 🦄\n')), 'f'.repeat(64)))
  expect(() => inspectJournal(source.directory)).toThrow('checksum')
})
test('partial outbox admission rolls back the cursor and spans without dropping the journal record', async () => {
  const source = archive()
  const receiver = collector()
  const exporter = new SessionExporter(source.directory, source.manifest, {
    fetch: receiver.fetcher,
    interval: false,
  })
  const append = exporter.outbox.append.bind(exporter.outbox)
  let calls = 0
  const intercept = spyOn(exporter.outbox, 'append').mockImplementation(items => ++calls === 2 ? false : append(items))
  try {
    expect(exporter.ingest()).toBe(0)
    expect(exporter.cursor).toBe(0)
    expect(exporter.outbox.stats('traces').items).toBe(0)
    expect(exporter.admissionError).toContain('outbox')
    expect([...readJournal(source.directory)]).toHaveLength(4)
    intercept.mockRestore()
    expect(exporter.ingest()).toBe(4)
    expect(await exporter.sync(exporter.cursor, 5000)).toBe(true)
    expect(receiver.spans.filter(span => span.name === 'powershell.command.started')).toHaveLength(1)
  } finally {
    intercept.mockRestore(); await exporter.close()
  }
})
test('a producer that disappears without a final record cannot be reported as a complete recording', async () => {
  const source = archive()
  writeFileSync(join(source.directory, 'events.jsonl'), `${source.lines.slice(0, 2).join('\n')}\n`)
  const receiver = collector()
  const exporter = new SessionExporter(source.directory, source.manifest, {
    fetch: receiver.fetcher,
    interval: false,
  })
  exporter.ingest()
  const result = await exporter.close()
  expect(result.deliveryComplete).toBe(true)
  expect(result.recordingComplete).toBe(false)
  expect(result.complete).toBe(false)
  expect(inspectJournal(source.directory).commands.get(source.id)!.complete).toBeUndefined()
})
