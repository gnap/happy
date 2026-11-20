/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession, type ArchiveSessionResult } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { RestartSessionResult } from './types';
import { extractA2aText, extractA2aTitle } from '@/a2a/parse';
import { sendA2aMessage } from './sendA2aMessage';

export function startDaemonControlServer({
  getChildren,
  getRecentlyExited,
  stopSession,
  stopSessionByPid,
  port,
  spawnSession,
  restartSession,
  archiveSession,
  requestShutdown,
  onHappySessionWebhook,
  onSessionEnding,
  onProxyConfig,
}: {
  getChildren: () => TrackedSession[];
  getRecentlyExited: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  stopSessionByPid: (pid: number) => boolean;
  port: number;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  restartSession: (sessionId: string, sandboxConfig?: unknown, requiresDesktop?: boolean, expectGeneration?: number, mode?: 'wait' | 'accept') => Promise<RestartSessionResult>;
  archiveSession: (sessionId: string) => ArchiveSessionResult;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  onSessionEnding: (sessionId: string, pid: number, reason: string, exitCode?: number, archive?: boolean) => void;
  /**
   * A session's proxy route. `null` forgets it.
   *
   * The daemon serves a loopback HTTP proxy for sessions whose profile chose a route — a SOCKS5
   * hop, the relay, or both; this is how the session — which is where the profile is resolved —
   * tells the daemon where to send its requests. A route without `socks5` means the relay is the
   * egress and dials the targets itself. The daemon never learns the route any other way.
   */
  onProxyConfig: (token: string, config: { socks5?: string; viaRelay: boolean; label?: string } | null) => void;
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

    typed.post('/a2a/:sessionId/message', {
      schema: {
        params: z.object({
          sessionId: z.string(),
        }),
        body: z.any(),
        response: {
          200: z.object({
            success: z.boolean(),
            messageId: z.string().optional(),
            seq: z.number().optional(),
          }),
          400: z.object({
            success: z.literal(false),
            error: z.string(),
          }),
          500: z.object({
            success: z.literal(false),
            error: z.string(),
          }),
        },
      }
    }, async (request, reply) => {
      const { sessionId } = request.params;
      const text = extractA2aText(request.body);
      const title = extractA2aTitle(request.body);

      if (!text) {
        reply.code(400);
        return { success: false as const, error: 'Missing message text' };
      }

      logger.debug(`[CONTROL SERVER] A2A forward request: ${sessionId}`);
      const result = await sendA2aMessage(sessionId, text, { title });
      if (!result.success) {
        reply.code(500);
        return { success: false as const, error: result.error ?? 'Failed to forward A2A message' };
      }

      return {
        success: true,
        messageId: result.messageId,
        seq: result.seq,
      };
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
          agent: z.enum(['claude', 'codex', 'cursor', 'cursor-acp', 'gemini']).optional(),
          environmentVariables: z.record(z.string()).optional(),
          resumeSessionTag: z.string().optional(),
          sandboxConfig: z.any().optional(),
          /** Whether this session's traffic goes through the relay. Absent means no. */
          proxyViaRelay: z.boolean().optional(),
          /** `accepted` answers when a process exists, not when it has registered. */
          expect: z.enum(['accepted']).optional(),
          /** The spec revision the caller observed; a restart may carry it. */
          generation: z.number().int().min(0).optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional(),
            // Additive: old callers read success/sessionId and ignore everything below.
            accepted: z.boolean().optional(),
            stage: z.string().optional(),
            ref: z.string().optional(),
            tag: z.string().optional(),
            generation: z.number().optional(),
            phase: z.string().optional(),
            reason: z.string().optional(),
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional(),
            accepted: z.boolean().optional(),
            stage: z.string().optional(),
            ref: z.string().optional(),
            generation: z.number().optional(),
            phase: z.string().optional(),
            reason: z.string().optional(),
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, environmentVariables, resumeSessionTag, sandboxConfig, expect, generation, proxyViaRelay } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent ?? 'default'}, sandbox=${sandboxConfig ? 'yes' : 'no'}, expect=${expect ?? 'blocking'}`);
      const result = await spawnSession({
        directory, sessionId, agent, environmentVariables, resumeSessionTag, sandboxConfig,
        ...(expect === 'accepted' ? { expectAccepted: true } : {}),
        ...(generation !== undefined ? { generation } : {}),
        ...(proxyViaRelay !== undefined ? { proxyViaRelay } : {}),
      });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              accepted: false,
              stage: 'failed',
              reason: 'no-session-id',
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true,
            // Additive: the blocking answer has always meant "registered", so the phase is
            // Running rather than Starting. Older callers see the same fields as before.
            accepted: true,
            stage: 'running',
            ref: result.sessionId,
            ...(result.tag ? { tag: result.tag } : {}),
            ...(result.generation !== undefined ? { generation: result.generation } : {}),
            phase: 'Running',
          };

        case 'accepted':
          // A process exists; the server has not named the session yet. `ref` is the tag because
          // that is the only name the session has at this point.
          return {
            success: true,
            accepted: true,
            stage: 'starting',
            ref: result.ref,
            tag: result.tag,
            generation: result.generation,
            phase: result.phase,
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
            accepted: false,
            stage: 'failed',
            reason: 'spawn-failed',
            error: result.errorMessage
          };
      }
    });

    // Restart a session: kill existing process and respawn reconnecting to same server session
    typed.post('/restart-session', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          requiresDesktop: z.boolean().optional(),
          /** `accepted` answers when the machine has taken the restart, not when it finishes. */
          expect: z.enum(['accepted']).optional(),
          /** The generation the caller observed; a repeat is answered, not repeated. */
          generation: z.number().int().min(0).optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            newSessionId: z.string().optional(),
            error: z.string().optional(),
            // Additive: the shape older callers already read is unchanged above.
            accepted: z.boolean().optional(),
            stage: z.string().optional(),
            ref: z.string().optional(),
            generation: z.number().optional(),
            phase: z.string().optional(),
            reason: z.string().optional(),
            message: z.string().optional(),
          })
        }
      }
    }, async (request) => {
      const { sessionId, requiresDesktop, expect, generation } = request.body;
      logger.debug(`[CONTROL SERVER] Restart session request: ${sessionId}, expect=${expect ?? 'wait'}, generation=${generation ?? '-'}`);
      return restartSession(
        sessionId,
        undefined,
        typeof requiresDesktop === 'boolean' ? requiresDesktop : undefined,
        generation,
        expect === 'accepted' ? 'accept' : 'wait',
      );
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
      const result = archiveSession(sessionId);
      return { success: result.applied };
    });

    // A session registers (or clears) the proxy route its profile selected. The rule that the
    // profile's traffic takes that route lives in the session; the daemon only holds the token ->
    // route table and never dials anything on its own initiative. A route with no SOCKS5 hop is
    // the relay-dials-the-target case; `socks5: null` with the relay off is how a session forgets
    // its route, so the two fields are read together.
    typed.post('/proxy-config', {
      schema: {
        body: z.object({
          token: z.string().min(1),
          socks5: z.string().nullable(),
          viaRelay: z.boolean(),
          /** A session name for logs. Never the address, which is a credential. */
          label: z.string().optional(),
        }),
        response: {
          200: z.object({ status: z.literal('ok') })
        }
      }
    }, async (request) => {
      const { token, socks5, viaRelay, label } = request.body;
      const clearing = socks5 === null && !viaRelay;
      onProxyConfig(token, clearing
        ? null
        : { ...(socks5 !== null ? { socks5 } : {}), viaRelay, ...(label ? { label } : {}) });
      // The address is a credential: log which way it goes, never what it is or the token.
      const route = clearing ? 'cleared' : socks5 === null ? 'set relay egress' : viaRelay ? 'set via relay' : 'set direct';
      logger.debug(`[CONTROL SERVER] Proxy route ${route}`);
      return { status: 'ok' as const };
    });

    // Session pre-announces its exit reason before dying
    typed.post('/session-ending', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          pid: z.number().int().positive(),
          reason: z.string(),
          exitCode: z.number().int().optional(),
          archive: z.boolean().optional(),
        }),
        response: {
          200: z.object({ status: z.literal('ok') })
        }
      }
    }, async (request) => {
      const { sessionId, pid, reason, exitCode, archive } = request.body;
      logger.debug(`[CONTROL SERVER] Session ending: ${sessionId} PID ${pid} reason="${reason}" archive=${archive ?? false}`);
      onSessionEnding(sessionId, pid, reason, exitCode, archive);
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

    app.listen({ port, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const boundPort = parseInt(address.split(':').pop()!, 10);
      logger.debug(`[CONTROL SERVER] Started on port ${boundPort}`);

      resolve({
        port: boundPort,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}