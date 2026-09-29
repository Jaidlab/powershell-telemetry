import type {Manifest} from './journal.ts'
import type {Attributes, TraceContext} from 'victoria-bun-client'

import {mkdirSync, renameSync, statSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import VictoriaClient from 'victoria-bun-client'
import SqliteOutbox from 'victoria-bun-client/sqlite'

import {hash, readJournal, utf8Preview} from './journal.ts'

type Command = {command: string
  context: TraceContext
  pwd: string
  shellVersion: string
  time: number}

export const atomicJson = (file: string, value: unknown) => {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), {mode: 0o600})
  renameSync(temporary, file)
}

export class SessionExporter {
  admissionError: string | undefined
  readonly client: VictoriaClient
  readonly outbox: SqliteOutbox
  readonly statusFile: string
  #deliveryIssues = 0
  readonly #directory: string
  readonly #manifest: Manifest

  constructor(directory: string, manifest: Manifest, options: {fetch?: typeof fetch
    freshReplay?: boolean
    interval?: false | number} = {}) {
    this.#directory = directory
    this.#manifest = manifest
    const suffix = options.freshReplay ? `replay-${crypto.randomUUID()}` : 'delivery'
    this.statusFile = join(directory, options.freshReplay ? `${suffix}.status.json` : 'status.json')
    mkdirSync(directory, {
      recursive: true,
      mode: 0o700,
    })
    this.outbox = new SqliteOutbox({
      path: join(directory, `${suffix}.sqlite`),
      maxBytes: 256 * 1024 * 1024,
      maxItems: 100_000,
    })
    this.outbox.database.exec('CREATE TABLE IF NOT EXISTS powershell_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.#deliveryIssues = this.get<number>('deliveryIssues', 0)
    this.client = new VictoriaClient({
      serviceName: manifest.serviceName,
      endpoints: {traces: manifest.endpoint},
      outbox: this.outbox,
      interval: options.interval ?? 100,
      maxAttributeBytes: 16_384,
      maxItemBytes: 128_000,
      maxBatchBytes: 512_000,
      maxAge: Number.MAX_SAFE_INTEGER,
      compression: 'gzip',
      fetch: options.fetch,
      resource: {
        'host.name': manifest.host,
        'user.name': manifest.user,
        'process.pid': manifest.shellPid,
        'process.runtime.name': 'PowerShell',
        'service.instance.id': manifest.sessionId,
      },
      onEvent: event => {
        if (event.type === 'rejected' || event.type === 'expired') {
          this.#deliveryIssues += event.records ?? 1
          this.set('deliveryIssues', this.#deliveryIssues)
        }
      },
    })
  }

  get cursor() {
    return this.get<number>('cursor', 0)
  }

  get ended() {
    return this.get<boolean>('ended', false)
  }

  async close(timeout = 1000) {
    const before = this.status()
    const report = await this.client.shutdown({timeout})
    const status = {
      ...before,
      ...report,
      time: Date.now(),
      stopped: true,
      deliveryComplete: report.complete,
      deliveryIssues: this.#deliveryIssues,
      complete: report.complete && before.sessionEnded && before.journalCursor === before.journalBytes && !this.#deliveryIssues && !before.captureFailed && !before.admissionError,
    }
    atomicJson(this.statusFile, status)
    return status
  }
  get<Value>(key: string): Value | undefined
  get<Value>(key: string, fallback: Value): Value
  get<Value>(key: string, fallback?: Value): Value | undefined {
    const row = this.outbox.database.query<{value: string}, [string]>('SELECT value FROM powershell_state WHERE key = ?').get(key)
    return row ? JSON.parse(row.value) as Value : fallback
  }

  ingest(limit = 128) {
    let count = 0
    for (const {record, bytes, end} of readJournal(this.#directory, this.cursor, limit)) {
      if (record.sessionId !== this.#manifest.sessionId || record.sequence !== this.get<number>('sequence', 0) + 1) {
        throw new Error('Session identity or journal sequence does not match the export cursor.')
      }
      try {
        this.outbox.transaction(() => {
          const recordHash = hash(bytes)
          const index: Attributes = {
            'powershell.telemetry.version': 2,
            'session.id': record.sessionId,
            'record.id': `${record.sessionId}:${record.sequence}`,
            'record.sequence': record.sequence,
            'record.sha256': recordHash,
            'record.bytes': bytes.length,
            ...record.id ? {'command.id': record.id} : {},
          }
          let command = this.get<Command | undefined>(`command:${record.id}`)
          if (record.type === 'start') {
            if (!record.id || command || typeof record.command !== 'string') {
              throw new Error('Invalid or repeated command start.')
            }
            const started = this.client.startSpan('powershell.command.started', {
              startTime: record.time,
              attributes: {
                ...index,
                phase: 'started',
                command: utf8Preview(record.command),
                'command.truncated': Buffer.byteLength(record.command) > 4096,
                pwd: utf8Preview(String(record.pwd)),
                host: this.#manifest.host,
                user: this.#manifest.user,
                'output.capture': 'terminal-vt',
                'shell.version': String(record.shellVersion ?? ''),
              },
            })
            if (!started.end('unset', {}, record.time)) {
              throw new Error('Start span could not enter the durable outbox.')
            }
            command = {
              command: record.command,
              pwd: String(record.pwd),
              shellVersion: String(record.shellVersion ?? ''),
              time: record.time,
              context: {
                traceId: started.traceId,
                spanId: started.spanId,
              },
            }
            this.set(`command:${record.id}`, command)
          } else if (record.type === 'complete') {
            if (!command) {
              throw new Error('Completion has no recorded start.')
            }
            const completed = this.client.startSpan('powershell.command', {
              startTime: command.time,
              parent: command.context,
              attributes: {
                ...index,
                phase: 'completed',
                command: utf8Preview(command.command),
                pwd: utf8Preview(command.pwd),
                host: this.#manifest.host,
                user: this.#manifest.user,
                'shell.version': command.shellVersion,
                'output.capture': 'terminal-vt',
                'result.known': record.resultKnown === true,
                outcome: String(record.outcome),
                duration_ms: Number(record.durationMs),
                'terminal.preview': String(record.terminalPreview ?? ''),
                'terminal.preview.truncated': record.terminalPreviewTruncated === true,
                'terminal.bytes': Number(record.terminalBytes),
                'terminal.chunks': Number(record.terminalChunks),
                'terminal.sha256': String(record.terminalSha256),
                'capture.failed': Boolean(record.captureError || record.lostRecords),
                ...typeof record.resultCode === 'number' ? {result_code: record.resultCode} : {},
                ...typeof record.success === 'boolean' ? {success: record.success} : {},
                ...typeof record.nativeExitCode === 'number' ? {'native.exit_code': record.nativeExitCode} : {},
                ...typeof record.shellExitCode === 'number' ? {'shell.exit_code': record.shellExitCode} : {},
              },
            })
            if (!completed.end(record.resultKnown ? (record.success ? 'ok' : 'error') : 'unset', {}, record.time)) {
              throw new Error('Completion span could not enter the durable outbox.')
            }
            this.set(`completed:${record.id}`, true)
          }
          // Every canonical record is exported losslessly, not only its convenient query attributes.
          // Chunk IDs and hashes survive replay even when an HTTP acknowledgment was lost.
          const chunkBytes = 6144
          const chunks = Math.ceil(bytes.length / chunkBytes)
          for (let i = 0; i < chunks; i++) {
            const chunk = this.client.startSpan(record.type === 'output' ? 'powershell.command.output' : 'powershell.record.chunk', {
              startTime: record.time,
              parent: command?.context,
              attributes: {
                ...index,
                phase: record.type === 'output' ? 'output' : 'record',
                'record.type': record.type,
                'record.chunk.index': i,
                'record.chunk.count': chunks,
                'record.chunk.encoding': 'base64',
                'record.chunk.data': bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes).toString('base64'),
                ...record.type === 'output' ? {
                  'terminal.offset': Number(record.offset),
                  'terminal.chunk.index': Number(record.index),
                  'terminal.chunk.bytes': Number(record.bytes),
                } : {},
              },
            })
            if (!chunk.end('unset', {}, record.time)) {
              throw new Error('Payload chunk could not enter the durable outbox.')
            }
          }
          if (record.captureError || record.lostRecords) {
            this.set('captureFailed', true)
          }
          if (record.type === 'session.end') {
            this.set('ended', true)
          }
          this.set('sequence', record.sequence)
          this.set('cursor', end)
        })
        this.admissionError = undefined
        count++
      } catch (error) {
        this.admissionError = Error.isError(error) ? error.message : String(error)
        break // Keep the cursor before this record; do not discard output under backpressure.
      }
    }
    return count
  }

  publishStatus() {
    atomicJson(this.statusFile, this.status())
  }

  set(key: string, value: unknown) {
    this.outbox.database.query('INSERT OR REPLACE INTO powershell_state VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  status() {
    const report = this.client.status()
    const issues = this.#deliveryIssues
    const captureFailed = this.get<boolean>('captureFailed', false)
    const bytes = statSync(join(this.#directory, 'events.jsonl')).size
    return {
      ...report,
      time: Date.now(),
      version: 2,
      agentPid: process.pid,
      archivePath: this.#directory,
      journalBytes: bytes,
      journalCursor: this.cursor,
      journalSequence: this.get<number>('sequence', 0),
      sessionEnded: this.ended,
      deliveryComplete: report.complete,
      recordingComplete: this.ended && !captureFailed,
      deliveryIssues: issues,
      captureFailed,
      admissionError: this.admissionError,
      complete: report.complete && this.cursor === bytes && !issues && !captureFailed && !this.admissionError,
    }
  }

  async sync(through: number, timeout: number) {
    const complete = await this.client.sync({
      timeout,
      required: false,
    })
    return complete && this.cursor >= through && !this.#deliveryIssues && !this.get<boolean>('captureFailed', false) && !this.admissionError
  }
}
