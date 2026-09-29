import {createHash} from 'node:crypto'
import {closeSync, openSync, readSync} from 'node:fs'
import {join} from 'node:path'

export type JournalRecord = Record<string, unknown> & {
  id?: string
  sequence: number
  sessionId: string
  time: number
  type: 'barrier' | 'capture.error' | 'complete' | 'output' | 'resize' | 'session.end' | 'session.ready' | 'start'
  version: 2
}
export type Manifest = {
  endpoint: string
  host: string
  hostPid: number
  serviceName: string
  sessionId: string
  shellPid: number
  startedAt: number
  user: string
  version: 2
}
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export const utf8Preview = (value: string, maxBytes = 4096) => {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) {
    return value
  }
  let end = maxBytes
  while (end && (bytes[end] & 0xC0) === 0x80) {
    end--
  }
  return bytes.subarray(0, end).toString('utf8')
}

/** A torn final line is never treated as a complete record. The cursor is a byte offset, not a character count. */
export function *readJournal(directory: string, offset = 0, limit = Infinity) {
  const fd = openSync(join(directory, 'events.jsonl'), 'r')
  let pending = Buffer.alloc(0)
  let position = offset
  let end = offset
  let records = 0
  try {
    const buffer = Buffer.alloc(65_536)
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, position)
      if (!length) {
        return
      }
      position += length
      pending = Buffer.concat([pending, buffer.subarray(0, length)])
      for (;;) {
        const newline = pending.indexOf(10)
        if (newline === -1) {
          break
        }
        const bytes = pending.subarray(0, newline)
        end += newline + 1
        pending = pending.subarray(newline + 1)
        const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`Invalid journal record at ${end}.`)
        }
        const record = value as JournalRecord
        if (record.version !== 2 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !Number.isFinite(record.time) || typeof record.sessionId !== 'string' || !['start', 'output', 'complete', 'resize', 'barrier', 'session.end', 'session.ready', 'capture.error'].includes(record.type)) {
          throw new Error(`Unsupported journal record at ${end}.`)
        }
        yield {
          record,
          bytes,
          end,
        }
        if (++records >= limit) {
          return
        }
      }
      if (pending.length > 32 * 1024 * 1024) {
        throw new Error('Journal record exceeds the 32 MB reader limit.')
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** Verify and reconstruct the terminal transport, including chunk boundaries that split UTF-8 or ANSI. */
export const inspectJournal = (directory: string, selectedId?: string) => {
  const commands = new Map<string, {
    bytes: number
    chunks: number
    command: string
    complete?: JournalRecord
    hash: ReturnType<typeof createHash>
    output: Array<Buffer>
  }>
  let lastSequence = 0
  let sessionId: string | undefined
  let sessionEnded = false
  let consumedBytes = 0
  for (const {record, end} of readJournal(directory)) {
    if (sessionEnded) throw new Error('Records follow the terminal session-end manifest.')
    if (record.type === 'capture.error') throw new Error(`Producer reported capture failure: ${String(record.captureError)}.`)
    if (record.sequence !== ++lastSequence) {
      throw new Error(`Journal sequence gap at ${record.sequence}.`)
    }
    sessionId ??= record.sessionId
    if (record.sessionId !== sessionId) {
      throw new Error('Mixed session IDs in one journal.')
    }
    consumedBytes = end
    if (record.type === 'start') {
      if (!record.id || commands.has(record.id) || typeof record.command !== 'string') {
        throw new Error('Invalid or repeated command start.')
      }
      commands.set(record.id, {
        bytes: 0,
        chunks: 0,
        command: record.command,
        hash: createHash('sha256'),
        output: [],
      })
    } else if (record.type === 'output') {
      const command = commands.get(record.id ?? '')
      if (!command || command.complete || typeof record.data !== 'string') {
        throw new Error('Output without an open command.')
      }
      const bytes = Buffer.from(record.data, 'base64')
      if (bytes.toString('base64') !== record.data || bytes.length !== record.bytes || record.offset !== command.bytes || record.index !== command.chunks) {
        throw new Error('Output chunk metadata does not match its bytes.')
      }
      command.bytes += bytes.length
      command.chunks++
      command.hash.update(bytes)
      if (selectedId === record.id) {
        command.output.push(bytes)
      }
    } else if (record.type === 'complete') {
      const command = commands.get(record.id ?? '')
      if (!command || command.complete) {
        throw new Error('Completion without one open command.')
      }
      if (record.terminalBytes !== command.bytes || record.terminalChunks !== command.chunks || record.terminalSha256 !== command.hash.digest('hex')) {
        throw new Error('Terminal output checksum or completion manifest mismatch.')
      }
      if (record.captureError || record.lostRecords) {
        throw new Error(`Producer reported capture loss: ${String(record.captureError)}.`)
      }
      command.complete = record
    } else if (record.type === 'session.end') {
      if (record.captureError || record.lostRecords) {
        throw new Error('Session ended with recording failures.')
      }
      sessionEnded = true
    }
  }
  if (selectedId && !commands.has(selectedId)) {
    throw new Error(`Unknown command ID: ${selectedId}.`)
  }
  return {
    sessionId,
    sessionEnded,
    consumedBytes,
    lastSequence,
    commands,
  }
}
