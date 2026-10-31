/**
 * The control channel between Happy Daemon and Happy Sidecar.
 *
 * The daemon owns the machine: identity, LAN/relay, session records. The sidecar is the same
 * install running inside the user's Aqua session (a LaunchAgent, started at login), which is the
 * only place a process can touch the login keychain or anything else that needs a desktop session.
 *
 * They are deliberately separate processes and may start in any order: the daemon boots without a
 * user logged in, the sidecar appears when one does. So the daemon listens on a unix socket and the
 * sidecar dials; "no connection" is a normal state, not an error, and it means exactly one thing:
 * GUI-dependent work cannot run right now.
 *
 * What crosses this socket is control only — spawn, signal, liveness, capabilities. The session
 * process spawned by the sidecar registers with the daemon and speaks the existing session protocol
 * itself, and writes its own logs; its stdin/stdout never travels over this channel.
 */

export type SidecarCapabilities = {
    /** True when this process is in the user's GUI session. The daemon never asks for less. */
    gui: boolean;
    /** `unlocked` only when the build keychain was opened successfully at sidecar start. */
    keychain: 'unlocked' | 'locked' | 'unknown';
};

export type SidecarState =
    | { kind: 'absent' }
    | { kind: 'ready'; capabilities: SidecarCapabilities; since: number; lastPongAt: number }
    | { kind: 'lost'; since: number; reason: string };

export type SidecarFrame =
    | { t: 'hello'; protocol: number; uid: number; capabilities: SidecarCapabilities }
    | { t: 'state'; capabilities: SidecarCapabilities }
    | { t: 'ping' }
    | { t: 'pong'; at: number }
    | { t: 'spawn'; requestId: string; sessionId: string; cwd: string; argv: string[] }
    | { t: 'spawned'; requestId: string; sessionId: string; pid: number }
    | { t: 'error'; requestId: string; code: string; message: string }
    | { t: 'signal'; sessionId: string; signal: 'SIGTERM' | 'SIGKILL' }
    | { t: 'exit'; sessionId: string; pid: number; code: number | null; signal: string | null };

export const SIDECAR_PROTOCOL_VERSION = 1;
/** How long without a pong before a connected sidecar is treated as gone. */
export const SIDECAR_TIMEOUT_MS = 15_000;

/** One frame per line; anything larger than this is not a control frame. */
const MAX_FRAME_BYTES = 64 * 1024;

export function encodeSidecarFrame(frame: SidecarFrame): string {
    return JSON.stringify(frame) + '\n';
}

/**
 * Parses one line into a frame, or returns null.
 *
 * Null rather than a throw: this endpoint only ever answers frames it understands, and a daemon
 * must not be taken down by a malformed line from a process it is trying to supervise. Callers
 * treat null as "ignore and count".
 */
export function decodeSidecarFrame(line: string): SidecarFrame | null {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_FRAME_BYTES) {
        return null;
    }
    try {
        const value = JSON.parse(trimmed) as unknown;
        if (!value || typeof value !== 'object') {
            return null;
        }
        const frame = value as { t?: unknown };
        if (typeof frame.t !== 'string') {
            return null;
        }
        // Field validation is per-type at the point of use; the frame type is what decides
        // whether the daemon can act on it at all.
        return value as SidecarFrame;
    } catch {
        return null;
    }
}

/**
 * The daemon's view of the sidecar, as a small state machine.
 *
 * `lost` is not an error state for the daemon: every GUI operation is refused while it lasts, and
 * a reconnect (after a crash, a logout/login cycle, or the daemon's own restart) brings it back to
 * `ready` with no user action. What must never happen is treating an absent sidecar as "try and
 * see": a spawn attempt would fail somewhere far from the reason.
 */
export class SidecarPresence {
    private state: SidecarState = { kind: 'absent' };

    get current(): SidecarState {
        return this.state;
    }

    /** Whether GUI-dependent work may be attempted right now. */
    get usable(): boolean {
        return this.state.kind === 'ready' && this.state.capabilities.gui;
    }

    /** Whether a connected sidecar has a keychain it can use for signing work. */
    get keychainUsable(): boolean {
        return this.state.kind === 'ready' && this.state.capabilities.keychain === 'unlocked';
    }

    hello(capabilities: SidecarCapabilities, now: number): void {
        this.state = {
            kind: 'ready',
            capabilities,
            since: this.state.kind === 'ready' ? this.state.since : now,
            lastPongAt: now,
        };
    }

    capabilitiesChanged(capabilities: SidecarCapabilities, now: number): void {
        const since = this.state.kind === 'ready' ? this.state.since : now;
        this.state = { kind: 'ready', capabilities, since, lastPongAt: now };
    }

    pong(now: number): void {
        if (this.state.kind === 'ready') {
            this.state = { ...this.state, lastPongAt: now };
        }
    }

    /** The socket closed, or the connection stopped answering. */
    lose(reason: string, now: number): void {
        if (this.state.kind === 'ready') {
            this.state = { kind: 'lost', since: now, reason };
        }
    }

    /** Whether the last pong is older than the timeout; callers run this on their own tick. */
    timedOut(now: number): boolean {
        return this.state.kind === 'ready' && now - this.state.lastPongAt > SIDECAR_TIMEOUT_MS;
    }

    /** The refusal every GUI-dependent operation returns while there is no usable sidecar. */
    refusal(): { code: 'sidecar-unavailable'; message: string } {
        if (this.state.kind !== 'ready') {
            return {
                code: 'sidecar-unavailable',
                message: 'This machine has no desktop session right now (no user is logged in, or the sidecar is not running). Start or restart the session after logging in on that machine.',
            };
        }
        return {
            code: 'sidecar-unavailable',
            message: this.state.capabilities.keychain === 'unlocked'
                ? 'The desktop session is available but refused this operation.'
                : 'The desktop session is available, but its keychain is locked; unlock it and retry.',
        };
    }
}
