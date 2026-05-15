/**
 * Library exports for slopus package
 * 
 * This file provides the main API classes and types for external consumption
 * without the CLI-specific functionality.
 */

// These exports allow me to use this package a library in dev-environment cli helper programs
export { ApiClient } from '@/api/api'
export { ApiSessionClient } from '@/api/apiSession'

export { logger } from '@/ui/logger'
export { configuration } from '@/configuration'

export { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'

// ── Session pipeline (used by happy-cursor) ─────────────────────────────────
export { type Credentials, readCredentials, readSettings, writeSessionPidFile, removeSessionPidFile } from '@/persistence'
export { createSessionMetadata } from '@/utils/createSessionMetadata'
export type { BackendFlavor, CreateSessionMetadataOptions, SessionMetadataResult } from '@/utils/createSessionMetadata'
export { initialMachineMetadata } from '@/daemon/run'
export { MessageQueue2 } from '@/utils/MessageQueue2'
export { hashObject } from '@/utils/deterministicJson'
export { startHappyServer } from '@/claude/utils/startHappyServer'
export { notifyDaemonSessionStarted, notifyDaemonSessionEnding } from '@/daemon/controlClient'
export { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
export { stopCaffeinate } from '@/utils/caffeinate'
export { connectionState } from '@/utils/serverConnectionErrors'
export { setupOfflineReconnection } from '@/utils/setupOfflineReconnection'
export type { SetupOfflineReconnectionOptions, SetupOfflineReconnectionResult } from '@/utils/setupOfflineReconnection'
export type { PermissionMode, UserMessage } from '@/api/types'