#!/usr/bin/env node
/**
 * Parse strace -tt log for TCP close timing around MCP port (default 38087).
 * Usage: node scripts/analyze-cursor-strace-tcp.mjs <strace.log> [--port 38087] [--result-offset-ms N]
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node analyze-cursor-strace-tcp.mjs <strace.log> [--port PORT] [--result-offset-ms MS]');
  process.exit(1);
}
let port = 38087;
let resultOffsetMs = null;
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) port = Number(process.argv[++i]);
  else if (process.argv[i] === '--result-offset-ms' && process.argv[i + 1]) {
    resultOffsetMs = Number(process.argv[++i]);
  }
}

const text = readFileSync(path, 'utf8');
const lines = text.split('\n');

function parseTs(line) {
  const m = line.match(/(\d{2}:\d{2}:\d{2}\.\d{6})/);
  return m ? m[1] : null;
}

function toMs(ts) {
  if (!ts) return null;
  const [h, m, rest] = ts.split(':');
  const [s, us] = rest.split('.');
  return (
    Number(h) * 3600000 +
    Number(m) * 60000 +
    Number(s) * 1000 +
    Math.floor(Number(us) / 1000)
  );
}

const events = [];
const portRe = new RegExp(`:${port}\\)`);

for (const line of lines) {
  if (!line.includes('38087') && !portRe.test(line)) continue;
  const ts = parseTs(line);
  const tms = toMs(ts);
  const pidM = line.match(/^(\d+)\s/);
  const pid = pidM ? pidM[1] : '?';

  if (/connect\(/.test(line) && portRe.test(line)) {
    events.push({ kind: 'connect', pid, ts, tms, line: line.trim().slice(0, 120) });
  }
  if (/shutdown\(/.test(line)) {
    const fdM = line.match(/shutdown\((\d+),/);
    events.push({
      kind: 'shutdown',
      pid,
      fd: fdM?.[1],
      ts,
      tms,
      line: line.trim().slice(0, 120),
    });
  }
  if (/close\(\d+\)/.test(line) && !/close_range/.test(line)) {
    const fdM = line.match(/close\((\d+)\)/);
    events.push({ kind: 'close', pid, fd: fdM?.[1], ts, tms, line: line.trim().slice(0, 120) });
  }
}

events.sort((a, b) => (a.tms ?? 0) - (b.tms ?? 0));

const t0 = events.find((e) => e.kind === 'connect')?.tms ?? events[0]?.tms ?? 0;

console.log(`# TCP/MCP port ${port} — ${path}`);
console.log(`events: ${events.length} (connect=${events.filter((e) => e.kind === 'connect').length} shutdown=${events.filter((e) => e.kind === 'shutdown').length} close=${events.filter((e) => e.kind === 'close').length})`);

if (resultOffsetMs != null) {
  console.log(`result_at_approx: +${resultOffsetMs}ms from run start (caller-supplied)`);
}

for (const e of events) {
  const rel = e.tms != null ? `+${((e.tms - t0) / 1000).toFixed(3)}s` : '?';
  const post =
    resultOffsetMs != null && e.tms != null
      ? ` post-result=${((e.tms - t0) * 0 + e.tms - (t0 + resultOffsetMs)).toFixed(0)}ms`
      : '';
  console.log(`${rel} pid=${e.pid} ${e.kind}${e.fd ? ` fd=${e.fd}` : ''}${post} ${e.line}`);
}

const shutdowns = events.filter((e) => e.kind === 'shutdown');
if (shutdowns.length >= 2) {
  const first = shutdowns[0];
  const last = shutdowns[shutdowns.length - 1];
  if (first.tms != null && last.tms != null) {
    console.log(`\nshutdown span: ${((last.tms - first.tms) / 1000).toFixed(2)}s (${shutdowns.length} calls)`);
  }
}

// Per-PID shutdown clusters after last connect
const lastConnect = [...events].reverse().find((e) => e.kind === 'connect');
const postConnect = lastConnect
  ? events.filter((e) => e.tms != null && lastConnect.tms != null && e.tms >= lastConnect.tms)
  : events;
const byPid = new Map();
for (const e of postConnect.filter((x) => x.kind === 'shutdown')) {
  if (!byPid.has(e.pid)) byPid.set(e.pid, []);
  byPid.get(e.pid).push(e);
}
console.log('\nshutdown by pid (post last connect):');
for (const [pid, list] of byPid) {
  const span =
    list.length >= 2 && list[0].tms != null && list[list.length - 1].tms != null
      ? `${((list[list.length - 1].tms - list[0].tms) / 1000).toFixed(2)}s`
      : 'n/a';
  console.log(`  pid ${pid}: ${list.length} shutdown(s), span ${span}`);
}
