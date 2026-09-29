import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'

const {values} = parseArgs({
  options: {
    endpoint: {type: 'string'},
    'archive-root': {type: 'string'},
    'no-profile': {type: 'boolean'},
  },
})
const endpoint = values.endpoint ?? process.env.POWERSHELL_TELEMETRY_ENDPOINT
if (!endpoint) {
  throw new Error('Pass --endpoint <OTLP trace URL> or set POWERSHELL_TELEMETRY_ENDPOINT.')
}
const child = Bun.spawn([
  'pwsh',
  '-NoLogo',
  '-NoProfile',
  '-File',
  fileURLToPath(new URL('host.ps1', import.meta.url)),
  '-Endpoint',
  endpoint,
  '-BunPath',
  process.execPath,
  ...values['archive-root'] ? ['-ArchiveRoot', values['archive-root']] : [],
  ...values['no-profile'] ? ['-NoProfile'] : [],
], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exitCode = await child.exited
