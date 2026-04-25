import { describe, expect, it } from 'vitest';

import { buildCursorPtySpawn } from './cursorProcess';

describe('buildCursorPtySpawn', () => {
  it('passes the prompt as argv on macOS PTY runs', () => {
    const prompt = "-start\ncontains `backticks` and $(subshell)";
    const spec = buildCursorPtySpawn('/opt/homebrew/bin/cursor-agent', ['--print', '--', prompt], false);

    expect(spec.command).toBe('script');
    expect(spec.args).toEqual([
      '-q',
      '/dev/null',
      '/bin/bash',
      '-l',
      '-c',
      'exec "$0" "$@"',
      '/opt/homebrew/bin/cursor-agent',
      '--print',
      '--',
      prompt,
    ]);
  });

  it('shell-escapes each argv part on Linux PTY runs', () => {
    const prompt = "-start\ncontains `backticks` and 'quotes'";
    const spec = buildCursorPtySpawn('/usr/local/bin/cursor-agent', ['--print', '--', prompt], true);

    expect(spec.command).toBe('stdbuf');
    expect(spec.args[0]).toBe('-o0');
    expect(spec.args[1]).toBe('script');
    expect(spec.args[5]).toContain(`'/usr/local/bin/cursor-agent' '--print' '--' '-start
contains \`backticks\` and '\\''quotes'\\'''`);
    expect(spec.args[5]).toContain(`'/bin/bash' '-l' '-c' 'exec "$0" "$@"'`);
  });
});
