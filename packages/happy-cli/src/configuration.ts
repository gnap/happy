/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'
import { isNode } from '@/utils/runtime'

/** HTTPS agent that forces IPv4 for server requests (avoids ETIMEDOUT on IPv6-unreachable hosts). */
export const serverHttpsAgent = new https.Agent({ family: 4 })
export const DEFAULT_DAEMON_HTTP_PORT = 55672

function parseDaemonHttpPort(rawPort: unknown): number | null {
  if (typeof rawPort !== 'string' && typeof rawPort !== 'number') return null

  const parsed = Number.parseInt(String(rawPort), 10)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed
  }

  return null
}

function readDaemonHttpPortFromSettings(settingsFile: string): { port: number | null; hadValue: boolean } {
  if (!existsSync(settingsFile)) return { port: null, hadValue: false }

  try {
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8'))
    return {
      port: parseDaemonHttpPort(raw?.daemonHttpPort),
      hadValue: raw?.daemonHttpPort !== undefined,
    }
  } catch {
    return { port: null, hadValue: false }
  }
}

function resolveDaemonHttpPort(settingsFile: string, legacyEnvPort: string | undefined): number {
  const configuredPort = readDaemonHttpPortFromSettings(settingsFile)
  if (configuredPort.port !== null) return configuredPort.port

  const fallbackPort = parseDaemonHttpPort(legacyEnvPort)
  if (fallbackPort !== null) {
    return fallbackPort
  }

  if (configuredPort.hadValue || legacyEnvPort) {
    console.warn(
      `Invalid daemon port configuration. Falling back to ${DEFAULT_DAEMON_HTTP_PORT}.`,
    )
  }
  return DEFAULT_DAEMON_HTTP_PORT
}

// Force all HTTPS in this process to use IPv4 (catches axios, socket.io, etc. that do not pass agent).
if (isNode()) {
  (https as any).globalAgent = serverHttpsAgent
}

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly daemonHttpPort: number
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Server configuration - priority: parameter > environment > default
    this.serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com'
    this.webappUrl = process.env.HAPPY_WEBAPP_URL || 'https://app.happy.engineering'

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: HAPPY_HOME_DIR env > default home dir
    if (process.env.HAPPY_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), '.happy')
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
    this.daemonHttpPort = resolveDaemonHttpPort(this.settingsFile, process.env.HAPPY_DAEMON_HTTP_PORT)

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = process.env.BUILD_VERSION || packageJson.version

    // Validate variant configuration
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (variant === 'dev' && !this.happyHomeDir.includes('dev')) {
      console.warn('⚠️  WARNING: HAPPY_VARIANT=dev but HAPPY_HOME_DIR does not contain "dev"')
      console.warn(`   Current: ${this.happyHomeDir}`)
      console.warn(`   Expected: Should contain "dev" (e.g., ~/.happy-dev)`)
    }

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    if (!existsSync(this.happyHomeDir)) {
      mkdirSync(this.happyHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
