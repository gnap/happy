/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export function startDaemonControlServer({
  getChildren,
  getRecentlyExited,
  stopSession,
  stopSessionByPid,
  spawnSession,
  restartSession,
  archiveSession,
  requestShutdown,
  onHappySessionWebhook,
  onSessionEnding,
}: {
  getChildren: () => TrackedSession[];
  getRecentlyExited: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  stopSessionByPid: (pid: number) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  restartSession: (sessionId: string) => Promise<{ success: boolean; newSessionId?: string; error?: string }>;
  archiveSession: (sessionId: string) => boolean;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  onSessionEnding: (sessionId: string, pid: number, reason: string, exitCode?: number) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any() // Metadata type from API
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      onHappySessionWebhook(sessionId, metadata);

      return { status: 'ok' as const };
    });

    // List all tracked sessions (active + stopped-but-not-archived)
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number(),
              directory: z.string().optional(),
              sessionTag: z.string().optional(),
              agent: z.string().optional(),
              lastHeartbeat: z.number().optional(),
              isAlive: z.boolean(),
              exitReason: z.string().optional(),
              exitTime: z.number().optional(),
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return {
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => {
            const isAlive = child.exitTime
              ? false
              : (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })();
            return {
              startedBy: child.startedBy,
              happySessionId: child.happySessionId!,
              pid: child.pid,
              directory: child.directory,
              sessionTag: child.sessionTag,
              agent: child.agent,
              lastHeartbeat: child.lastHeartbeat,
              isAlive,
              exitReason: child.exitReason,
              exitTime: child.exitTime,
            };
          })
      };
    });

    // Stop specific session (by sessionId from mapping, or by pid without mapping)
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string().optional(),
          pid: z.number().int().positive().optional()
        }).refine((b) => (b.sessionId != null) !== (b.pid != null), { message: 'Provide exactly one of sessionId or pid' }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId, pid } = request.body;

      const success = pid != null
        ? stopSessionByPid(pid)
        : stopSession(sessionId!);
      logger.debug(`[CONTROL SERVER] Stop session request: ${pid != null ? `pid=${pid}` : `sessionId=${sessionId}`} -> ${success}`);
      return { success };
    });

    // Spawn new session (optional agent + environmentVariables for restart-from-server with tag)
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          agent: z.enum(['claude', 'codex', 'cursor', 'gemini']).optional(),
          environmentVariables: z.record(z.string()).optional()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, environmentVariables } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent ?? 'default'}`);
      const result = await spawnSession({ directory, sessionId, agent, environmentVariables });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Restart a session: kill existing process and respawn reconnecting to same server session
    typed.post('/restart-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            newSessionId: z.string().optional(),
            error: z.string().optional()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;
      logger.debug(`[CONTROL SERVER] Restart session request: ${sessionId}`);
      const result = await restartSession(sessionId);
      return result;
    });

    // Archive (permanently remove from list) a stopped session
    typed.post('/archive-session', {
      schema: {
        body: z.object({ sessionId: z.string() }),
        response: {
          200: z.object({ success: z.boolean() })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;
      logger.debug(`[CONTROL SERVER] Archive session request: ${sessionId}`);
      const success = archiveSession(sessionId);
      return { success };
    });

    // Session pre-announces its exit reason before dying
    typed.post('/session-ending', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          pid: z.number().int().positive(),
          reason: z.string(),
          exitCode: z.number().int().optional(),
        }),
        response: {
          200: z.object({ status: z.literal('ok') })
        }
      }
    }, async (request) => {
      const { sessionId, pid, reason, exitCode } = request.body;
      logger.debug(`[CONTROL SERVER] Session ending: ${sessionId} PID ${pid} reason="${reason}"`);
      onSessionEnding(sessionId, pid, reason, exitCode);
      return { status: 'ok' as const };
    });

    // List recently exited sessions for post-mortem analysis
    typed.post('/list-history', {
      schema: {
        response: {
          200: z.object({
            recentlyExited: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string().optional(),
              pid: z.number(),
              directory: z.string().optional(),
              agent: z.string().optional(),
              exitCode: z.number().nullable().optional(),
              exitSignal: z.string().nullable().optional(),
              exitTime: z.number().optional(),
              exitReason: z.string().optional(),
              lastHeartbeat: z.number().optional(),
            }))
          })
        }
      }
    }, async () => {
      const exited = getRecentlyExited();
      return {
        recentlyExited: exited.map(s => ({
          startedBy: s.startedBy,
          happySessionId: s.happySessionId,
          pid: s.pid,
          directory: s.directory,
          agent: s.agent,
          exitCode: s.exitCode,
          exitSignal: s.exitSignal,
          exitTime: s.exitTime,
          exitReason: s.exitReason,
          lastHeartbeat: s.lastHeartbeat,
        }))
      };
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}