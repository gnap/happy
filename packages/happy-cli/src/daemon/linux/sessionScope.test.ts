/**
 * The pieces of the per-session systemd scope that are worth testing without a systemd.
 *
 * The scope itself is verified on a Linux host; what can be pinned down here is the naming, the
 * argv handed to `systemd-run`, when the mode is chosen at all, and where a signal is routed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    SESSION_SCOPE_ENV,
    SESSION_SCOPE_SLICE,
    buildSessionScopeUnitName,
    buildSystemdRunArgs,
    isSessionScopeRequested,
    parseScopeUnitFromCgroup,
    planSessionSignal,
    resolveSessionScopeMode,
    sanitizeUnitToken,
} from './sessionScope';

describe('scope unit names', () => {
    it('turns anything a session id may contain into a systemd-safe token', () => {
        expect(sanitizeUnitToken('cmt8igff69y1cyu0u8mozxp27')).toBe('cmt8igff69y1cyu0u8mozxp27');
        expect(sanitizeUnitToken('/Users/gnap/Projects/happy')).toBe('Users-gnap-Projects-happy');
        expect(sanitizeUnitToken('a b@c')).toBe('a-b-c');
        expect(sanitizeUnitToken('..--weird--..')).toBe('weird');
        expect(sanitizeUnitToken('')).toBe('session');
        expect(sanitizeUnitToken('x'.repeat(200)).length).toBeLessThanOrEqual(48);
    });

    it('adds a time and a random tail so two spawns can never collide', () => {
        expect(buildSessionScopeUnitName('abc', { now: 0, random: 'deadbeef' }))
            .toBe('happy-session-abc-0-deadbeef.scope');
        expect(buildSessionScopeUnitName('abc')).not.toBe(buildSessionScopeUnitName('abc'));
    });
});

describe('the command systemd-run is given', () => {
    it('puts the scope options first and the session after a bare --', () => {
        expect(buildSystemdRunArgs({
            executable: '/usr/bin/bun',
            argv: ['/opt/happy/dist/index.bun.mjs', '--started-by', 'daemon'],
            unitName: 'happy-session-abc.scope',
        })).toEqual([
            '--user',
            '--scope',
            '--collect',
            '--quiet',
            '--unit=happy-session-abc.scope',
            `--slice=${SESSION_SCOPE_SLICE}`,
            '--',
            '/usr/bin/bun',
            '/opt/happy/dist/index.bun.mjs',
            '--started-by',
            'daemon',
        ]);
    });

    it('keeps a session argument that looks like an option on the session side', () => {
        const args = buildSystemdRunArgs({
            executable: 'bun',
            argv: ['entry.mjs', '--resume-after-seq', '-1'],
            unitName: 'happy-session-abc.scope',
            slice: 'custom.slice',
        });
        expect(args.slice(args.indexOf('--'))).toEqual(['--', 'bun', 'entry.mjs', '--resume-after-seq', '-1']);
        expect(args).toContain('--slice=custom.slice');
    });
});

describe('when scopes are used', () => {
    it('never asks for them on a platform that has no systemd', () => {
        expect(isSessionScopeRequested({ [SESSION_SCOPE_ENV]: '1' }, 'darwin')).toBe(false);
        expect(isSessionScopeRequested({ [SESSION_SCOPE_ENV]: '1' }, 'linux')).toBe(true);
    });

    it('treats the switch as off unless it says otherwise', () => {
        for (const value of ['', '0', 'false', 'no', 'off', '  ']) {
            expect(isSessionScopeRequested({ [SESSION_SCOPE_ENV]: value }, 'linux')).toBe(false);
        }
        expect(isSessionScopeRequested({}, 'linux')).toBe(false);
    });

    it('does not touch systemd at all on macOS', () => {
        const deps = { systemdAvailable: vi.fn(() => true), systemdRunAvailable: vi.fn(() => true) };
        expect(resolveSessionScopeMode({ [SESSION_SCOPE_ENV]: '1' }, 'darwin', deps).enabled).toBe(false);
        expect(deps.systemdAvailable).not.toHaveBeenCalled();
        expect(deps.systemdRunAvailable).not.toHaveBeenCalled();
    });

    it('falls back to a direct spawn, with a reason, when systemd cannot do it', () => {
        const noSystemd = { systemdAvailable: () => false, systemdRunAvailable: () => true };
        const noSystemdRun = { systemdAvailable: () => true, systemdRunAvailable: () => false };
        const ok = { systemdAvailable: () => true, systemdRunAvailable: () => true };

        expect(resolveSessionScopeMode({ [SESSION_SCOPE_ENV]: '1' }, 'linux', noSystemd))
            .toMatchObject({ enabled: false, reason: 'systemd --user not available' });
        expect(resolveSessionScopeMode({ [SESSION_SCOPE_ENV]: '1' }, 'linux', noSystemdRun))
            .toMatchObject({ enabled: false, reason: 'systemd-run not available' });
        expect(resolveSessionScopeMode({ [SESSION_SCOPE_ENV]: '1' }, 'linux', ok))
            .toMatchObject({ enabled: true, slice: SESSION_SCOPE_SLICE });
    });
});

describe('where a signal goes', () => {
    it('goes through the scope so the whole cgroup is signalled', () => {
        expect(planSessionSignal({ pid: 42, scopeUnit: 'happy-session-a.scope' }, 'SIGTERM'))
            .toEqual({ kind: 'scope', unit: 'happy-session-a.scope', signal: 'SIGTERM' });
    });

    it('stays a plain PID signal for a directly spawned session', () => {
        expect(planSessionSignal({ pid: 42 }, 'SIGKILL')).toEqual({ kind: 'pid', pid: 42, signal: 'SIGKILL' });
    });
});

describe('reading a scope back from /proc', () => {
    it('finds the unit in a cgroup line', () => {
        expect(parseScopeUnitFromCgroup(
            '0::/user.slice/user-1001.slice/user@1001.service/happy.slice/happy-sessions.slice/happy-session-abc-1-deadbeef.scope\n',
        )).toBe('happy-session-abc-1-deadbeef.scope');
    });

    it('returns nothing for a process that is not in a session scope', () => {
        expect(parseScopeUnitFromCgroup('0::/user.slice/user-1001.slice/user@1001.service/app.slice/happy-daemon.service\n'))
            .toBeNull();
    });
});
