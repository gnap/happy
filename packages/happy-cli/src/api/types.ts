import { z } from 'zod'
import type { Update, UpdateMachineBody } from '@slopus/happy-wire';
import { UsageSchema } from '@/claude/types'
import type { SandboxConfig } from '@/persistence'

export {
  SessionMessageContentSchema,
  SessionMessageSchema,
  UpdateBodySchema,
  UpdateMachineBodySchema,
  UpdateSchema,
  UpdateSessionBodySchema,
} from '@slopus/happy-wire';
export type {
  SessionMessage,
  SessionMessageContent,
  Update,
  UpdateBody,
  UpdateMachineBody,
  UpdateSessionBody,
} from '@slopus/happy-wire';

/**
 * Permission mode type - includes Claude, Codex, and Cursor modes
 * Must match MessageMetaSchema.permissionMode enum values
 *
 * Claude: default, acceptEdits, bypassPermissions, plan
 * Codex: read-only, safe-yolo, yolo
 * Cursor: default, plan (--mode plan), ask (--mode ask), force (-f/--force)
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo' | 'ask' | 'force'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any, localId?: string }) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }, callback?: (ack: { success?: boolean; error?: string }) => void) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
  requestedMetadata?: Metadata,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string()
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  origin: z.enum(['app', 'a2a']).optional(), // Where the message came from
  a2aTrigger: z.boolean().optional(), // Transport marker: new row was written to a2aInbox (does not enqueue turn text)
  a2aInboxMessageId: z.string().optional(), // Inbox row id for the message that just arrived
  a2aInboxTurn: z.boolean().optional(), // Internal scheduler: run one cursor turn to drain unread inbox via MCP
  cursorCompactTurn: z.boolean().optional(), // Internal scheduler: run one interactive cursor-agent /compress turn
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo', 'ask', 'force']).optional(), // Permission mode for this message
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  maxMode: z.boolean().optional(), // Cursor max mode for this message (cli-config.json snapshot at spawn)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
  profileId: z.string().nullable().optional(), // Env profile id (null = clear). Daemon tracks this to detect changes.
  environmentVariables: z.record(z.string(), z.string()).optional(), // Resolved env vars, applied only when profileId changes
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type Metadata = {
  /**
   * ACP session config option value (normalized for UI metadata consumers).
   */
  // `code` = protocol value ID, `value` = human label
  models?: Array<{ code: string; value: string; description?: string | null }>,
  currentModelCode?: string,
  /** Cursor max mode (cli-config.json); synced from App message meta or CLI flags. */
  currentMaxMode?: boolean,
  operatingModes?: Array<{ code: string; value: string; description?: string | null }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>,
  currentThoughtLevelCode?: string,
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  tools?: string[],
  slashCommands?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  /** Happy server session tag (UUID) reported by the session on startup, used by daemon for restart */
  sessionTag?: string,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string
  sandbox?: SandboxConfig | null
  dangerouslySkipPermissions?: boolean | null
};

export type A2AInboxMessage = {
  id: string,
  text: string,
  createdAt: number,
  readAt?: number | null,
  title?: string,
};

export type A2AInboxState = {
  messages: A2AInboxMessage[],
};

/** Synced to server via update-state; full message bodies stay on the CLI machine only. */
export type A2AInboxServerState = {
  unreadCount: number,
};

export type AppCompatibleSessionMetadata = Omit<
  Metadata,
  'happyLibDir' | 'happyToolsDir' | 'startedFromDaemon' | 'startedBy' | 'lifecycleState' | 'lifecycleStateSince' | 'archivedBy' | 'archiveReason' | 'sessionTag'
>;

const SESSION_STATIC_METADATA_KEYS = [
  'path',
  'host',
  'version',
  'os',
  'machineId',
  'homeDir',
  'happyHomeDir',
  'hostPid',
  'flavor',
  'sandbox',
  'dangerouslySkipPermissions',
] as const;

/**
 * App-compatible session metadata subset.
 *
 * The mobile app currently uses a strict schema for session metadata and
 * rejects unknown fields. Keep server-bound session metadata limited to the
 * fields the app understands so historical and live sessions remain readable.
 */
export function sanitizeSessionMetadataForApp(metadata: Metadata): AppCompatibleSessionMetadata {
  const {
    models,
    currentModelCode,
    currentMaxMode,
    operatingModes,
    currentOperatingModeCode,
    thoughtLevels,
    currentThoughtLevelCode,
    path,
    host,
    version,
    name,
    os,
    summary,
    machineId,
    claudeSessionId,
    tools,
    slashCommands,
    homeDir,
    happyHomeDir,
    hostPid,
    flavor,
    sandbox,
    dangerouslySkipPermissions,
  } = metadata;

  return {
    ...(models !== undefined ? { models } : {}),
    ...(currentModelCode !== undefined ? { currentModelCode } : {}),
    ...(currentMaxMode !== undefined ? { currentMaxMode } : {}),
    ...(operatingModes !== undefined ? { operatingModes } : {}),
    ...(currentOperatingModeCode !== undefined ? { currentOperatingModeCode } : {}),
    ...(thoughtLevels !== undefined ? { thoughtLevels } : {}),
    ...(currentThoughtLevelCode !== undefined ? { currentThoughtLevelCode } : {}),
    path,
    host,
    ...(version !== undefined ? { version } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(os !== undefined ? { os } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(machineId !== undefined ? { machineId } : {}),
    ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(slashCommands !== undefined ? { slashCommands } : {}),
    ...(homeDir !== undefined ? { homeDir } : {}),
    ...(happyHomeDir !== undefined ? { happyHomeDir } : {}),
    ...(hostPid !== undefined ? { hostPid } : {}),
    ...(flavor !== undefined ? { flavor } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(dangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions } : {}),
  } as AppCompatibleSessionMetadata;
}

export function shouldSyncSessionMetadata(current: Metadata | null, next: Metadata): boolean {
  if (!current) {
    return true;
  }

  return SESSION_STATIC_METADATA_KEYS.some((key) => current[key] !== next[key]);
}

export function buildSyncedSessionMetadata(current: Metadata | null, next: Metadata): Metadata {
  return {
    ...(current ?? {}),
    path: next.path,
    host: next.host,
    version: next.version,
    os: next.os,
    machineId: next.machineId,
    homeDir: next.homeDir,
    happyHomeDir: next.happyHomeDir,
    happyLibDir: next.happyLibDir ?? current?.happyLibDir ?? '',
    happyToolsDir: next.happyToolsDir ?? current?.happyToolsDir ?? '',
    hostPid: next.hostPid,
    flavor: next.flavor,
    sandbox: next.sandbox,
    dangerouslySkipPermissions: next.dangerouslySkipPermissions,
  };
}

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  /** Cursor chat ID for resuming cursor-agent conversation across restarts */
  cursorChatId?: string | null
  a2aInbox?: A2AInboxServerState
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowTools?: string[]
    }
  }
}
