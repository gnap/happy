#!/usr/bin/env bun

process.env.HAPPY_CLI_RUNTIME ??= 'bun';

try {
  await import('../dist/index.bun.mjs');
} catch (error) {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND') {
    await import('../dist/index.mjs');
  } else {
    throw error;
  }
}
