import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }
let testHomeDir: string | undefined

async function loadConfiguration() {
  vi.resetModules()
  return await import('./configuration')
}

describe('configuration daemonHttpPort', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    if (testHomeDir) {
      rmSync(testHomeDir, { recursive: true, force: true })
      testHomeDir = undefined
    }
    vi.restoreAllMocks()
  })

  it('uses the stable default daemon port', async () => {
    delete process.env.HAPPY_DAEMON_HTTP_PORT

    const { configuration, DEFAULT_DAEMON_HTTP_PORT } = await loadConfiguration()

    expect(configuration.daemonHttpPort).toBe(DEFAULT_DAEMON_HTTP_PORT)
    expect(DEFAULT_DAEMON_HTTP_PORT).toBe(55672)
  })

  it('reads the daemon port from settings.json', async () => {
    testHomeDir = mkdtempSync(join(tmpdir(), 'happy-config-test-'))
    process.env.HAPPY_HOME_DIR = testHomeDir
    writeFileSync(
      join(testHomeDir, 'settings.json'),
      JSON.stringify({ schemaVersion: 2, onboardingCompleted: true, profiles: [], localEnvironmentVariables: {}, daemonHttpPort: 43123 }),
    )

    const { configuration } = await loadConfiguration()

    expect(configuration.daemonHttpPort).toBe(43123)
  })

  it('prefers settings.json over the legacy env override', async () => {
    testHomeDir = mkdtempSync(join(tmpdir(), 'happy-config-test-'))
    process.env.HAPPY_HOME_DIR = testHomeDir
    process.env.HAPPY_DAEMON_HTTP_PORT = '43123'
    writeFileSync(
      join(testHomeDir, 'settings.json'),
      JSON.stringify({ schemaVersion: 2, onboardingCompleted: true, profiles: [], localEnvironmentVariables: {}, daemonHttpPort: 51234 }),
    )

    const { configuration } = await loadConfiguration()

    expect(configuration.daemonHttpPort).toBe(51234)
  })
})
