import {expect, test} from 'bun:test'

const {default: powershellTelemetry} = await import('#src/main.ts')

test('should run', () => {
  const result = powershellTelemetry()
  expect(result).toBe('powershell-telemetry') // TODO Test actual functionality
})
