import {createWriteStream, statSync} from 'node:fs'
import {join} from 'node:path'
import {parseArgs} from 'node:util'

import {inspectJournal, readJournal} from './journal.ts'

const {values} = parseArgs({
  options: {
    session: {type: 'string'},
    command: {type: 'string'},
    output: {type: 'string'},
    raw: {type: 'boolean'},
  },
})
if (!values.session || (values.output || values.raw) && !values.command || values.output && values.raw) {
  throw new Error('Usage: bun run inspect --session <directory> [--command <id> [--output <file.vt> | --raw]]')
}
const inspected = inspectJournal(values.session)
if (values.command && !inspected.commands.has(values.command)) {
  throw new Error('Command ID is not in this session.')
}
if (values.raw || values.output) {
  // Explicit raw rendering may execute terminal controls contained in application output.
  // Validate the complete journal before reproducing any of those bytes.
  const output = values.output ? createWriteStream(values.output, {
    flags: 'wx',
    mode: 0o600,
  }) : process.stdout
  for (const {record} of readJournal(values.session)) {
    if (record.type === 'output' && record.id === values.command) {
      if (!output.write(Buffer.from(String(record.data), 'base64'))) {
        await new Promise<void>(resolve => output.once('drain', resolve))
      }
    }
  }
  if (values.output) {
    await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())))
  }
} else {
  process.stdout.write(`${JSON.stringify({
    sessionId: inspected.sessionId,
    sessionEnded: inspected.sessionEnded,
    records: inspected.lastSequence,
    trailingIncompleteBytes: statSync(join(values.session, 'events.jsonl')).size - inspected.consumedBytes,
    commands: [...inspected.commands].filter(([id]) => !values.command || id === values.command).map(([id, command]) => ({
      id,
      command: command.command,
      bytes: command.bytes,
      chunks: command.chunks,
      complete: Boolean(command.complete),
      outcome: command.complete?.outcome,
      resultCode: command.complete?.resultCode,
    })),
  }, null, 2)}\n`)
}
