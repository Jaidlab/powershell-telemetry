// eslint-disable-next-line typescript/no-restricted-imports -- The installer only needs built-in file operations.
import {mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const powershellTelemetry = async (options: {
  archiveRoot?: string
  endpoint: string
  profile?: string
}) => {
  const endpoint = new URL(options.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('The endpoint must use HTTP or HTTPS.')
  }
  let profile = options.profile
  if (!profile) {
    const child = Bun.spawn(['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exitCode !== 0) {
      throw new Error(stderr || 'Could not locate the PowerShell profile.')
    }
    profile = stdout.trim()
  }
  if (!profile) {
    throw new Error('The PowerShell profile path is empty.')
  }
  const hook = fileURLToPath(new URL('bootstrap.ps1', import.meta.url))
  const file = Bun.file(profile)
  const original = await file.exists() ? Buffer.from(await file.arrayBuffer()).toString('utf8') : ''
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    '# Begin powershell-telemetry',
    'try {',
    `  & ${quote(hook)} -Endpoint ${quote(endpoint.href)} -BunPath ${quote(process.execPath)}${options.archiveRoot ? ` -ArchiveRoot ${quote(options.archiveRoot)}` : ''}`,
    '} catch {',
    '  Write-Warning ("PowerShell telemetry could not start: " + $_.Exception.Message)',
    '}',
    '# End powershell-telemetry',
  ].join(newline)
  const pattern = /^# Begin powershell-telemetry\r?\n[\s\S]*?^# End powershell-telemetry(?=\r?$)/gm
  const content = original.replace(/^\uFEFF/u, '')
  const matches = [...content.matchAll(pattern)]
  if (matches.length > 1 || matches.length === 0 && /^# (Begin|End) powershell-telemetry\r?$/m.test(content)) {
    throw new Error('The existing telemetry block is ambiguous. Repair its markers before reinstalling.')
  }
  const remaining = content.replaceAll(pattern, '').trimStart()
  if (remaining.includes('# SIG # Begin signature block')) {
    throw new Error('Use the standalone terminal launcher for Authenticode-signed profiles.')
  }
  if (/^\s*(using\s+|param\s*\()/imu.test(remaining)) {
    const parser = Bun.spawn(['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); [Console]::Write([bool]($ast.ParamBlock -or $ast.UsingStatements.Count))'], {
      stdin: new Blob([remaining]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [result, errors, exitCode] = await Promise.all([new Response(parser.stdout).text(), new Response(parser.stderr).text(), parser.exited])
    if (exitCode !== 0) {
      throw new Error(`Could not validate the profile syntax: ${errors}`)
    }
    if (result.trim() === 'True') {
      throw new Error('Use the standalone terminal launcher for profiles with top-level using/param headers.')
    }
  }
  const updated = (original.startsWith('\uFEFF') ? '\uFEFF' : '') + block + newline + newline + remaining
  await mkdir(dirname(profile), {recursive: true})
  if (updated !== original) {
    const backup = Bun.file(`${profile}.before-powershell-telemetry`)
    if (original && !await backup.exists()) {
      await Bun.write(backup, original)
    }
    await Bun.write(file, updated)
  }
  return profile
}

export default powershellTelemetry

if (import.meta.main) {
  const {values} = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      endpoint: {type: 'string'},
      profile: {type: 'string'},
      'archive-root': {type: 'string'},
    },
  })
  if (!values.endpoint) {
    throw new Error('Usage: bun run install-profile --endpoint <OTLP trace URL> [--profile <path>]')
  }
  console.log(`Installed PowerShell telemetry in ${await powershellTelemetry({
    endpoint: values.endpoint,
    profile: values.profile,
    archiveRoot: values['archive-root'],
  })}`)
}
