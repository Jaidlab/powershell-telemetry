import type {Manifest} from './journal.ts'

import {existsSync, readdirSync, readFileSync, unlinkSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import {atomicJson, SessionExporter} from './exporter.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0); return true
  } catch {
    return false
  }
}
const readManifest = (directory: string): Manifest => {
  const value = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest
  if (value.version !== 2 || typeof value.sessionId !== 'string' || !Number.isSafeInteger(value.hostPid) || !Number.isSafeInteger(value.shellPid) || typeof value.host !== 'string' || typeof value.user !== 'string' || typeof value.serviceName !== 'string' || !['http:', 'https:'].includes(new URL(value.endpoint).protocol)) {
    throw new Error('Invalid terminal session manifest.')
  }
  return value
}

export const exportSession = async (directory: string, options: {follow?: boolean
  freshReplay?: boolean
  timeout?: number} = {}) => {
  directory = resolve(directory)
  const manifest = readManifest(directory)
  const exporter = new SessionExporter(directory, manifest, {freshReplay: options.freshReplay})
  const requestsFolder = join(directory, 'requests')
  let lastStatus = 0
  let error: unknown
  try {
    for (;;) {
      const ingested = exporter.ingest()
      if (existsSync(requestsFolder) && !options.freshReplay) {
        for (const name of readdirSync(requestsFolder).filter(name => /^[0-9a-f]{32}\.json$/u.test(name))) {
          const file = join(requestsFolder, name)
          const request = JSON.parse(readFileSync(file, 'utf8')) as {requestId: string
            through: number
            time: number
            timeout: number}
          if (`${request.requestId}.json` !== name || !Number.isSafeInteger(request.through) || !Number.isFinite(request.time) || !Number.isInteger(request.timeout) || request.timeout < 1 || request.timeout > 600_000) {
            throw new Error('Invalid synchronization request.')
          }
          const remaining = request.time + request.timeout - Date.now()
          if (exporter.cursor < request.through && remaining > 0) {
            continue
          }
          const complete = remaining > 0 && await exporter.sync(request.through, remaining)
          atomicJson(join(requestsFolder, `${request.requestId}.response.json`), {
            requestId: request.requestId,
            complete,
          })
          unlinkSync(file)
        }
      }
      if (Date.now() - lastStatus >= 250) {
        exporter.publishStatus()
        lastStatus = Date.now()
      }
      if (exporter.ended || !options.follow && !ingested || options.follow && !alive(manifest.hostPid)) {
        break
      }
      // Yield even under a heavy output load so delivery, status and sync barriers remain responsive.
      await Bun.sleep(ingested ? 0 : 100)
    }
  } catch (error_) {
    error = error_
    exporter.admissionError = Error.isError(error_) ? error_.message : String(error_)
  }
  const status = await exporter.close(options.timeout ?? (options.follow ? 1000 : 10_000))
  if (error) {
    throw error
  }
  return status
}

if (import.meta.main) {
  const {values} = parseArgs({
    options: {
      session: {type: 'string'},
      follow: {type: 'boolean'},
      fresh: {type: 'boolean'},
    },
  })
  if (!values.session || values.follow && values.fresh) {
    throw new Error('Usage: bun run replay --session <directory> [--fresh]. The host uses --follow for live delivery.')
  }
  try {
    const status = await exportSession(values.session, {
      follow: values.follow,
      freshReplay: values.fresh,
    })
    if (!values.follow) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    }
    if (!status.complete) {
      process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`${Error.isError(error) ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}
