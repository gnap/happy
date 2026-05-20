import { describe, expect, it } from 'vitest';
import {
  isInteractiveCompressComplete,
  isInteractiveCompressFailed,
  isInteractiveInputReady,
} from './interactiveCompletion';

describe('interactiveCompletion', () => {
  it('detects initial TUI input readiness including Rendering latest messages', () => {
    expect(isInteractiveInputReady('Rendering latest messages. Use /full-conversation\n')).toBe(true);
    expect(isInteractiveInputReady('still loading')).toBe(false);
  });

  it('does not treat Rendering latest messages alone as compress complete', () => {
    expect(isInteractiveCompressComplete('Rendering latest messages. Use /full-conversation\n')).toBe(false);
  });

  it('detects compress complete via post-command prompt', () => {
    expect(isInteractiveCompressComplete('done\nAdd a follow-up\n')).toBe(true);
  });

  it('detects compress complete via explicit success text', () => {
    expect(isInteractiveCompressComplete('Context compressed successfully.\n')).toBe(true);
  });

  it('detects compress failure', () => {
    expect(isInteractiveCompressFailed('Compression failed: out of memory\n')).toBe(true);
    expect(isInteractiveCompressComplete('Compression failed: out of memory\n')).toBe(false);
  });
});
