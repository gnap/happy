#!/usr/bin/env bun

process.env.HAPPY_CLI_RUNTIME ??= 'bun';

try {
  await import('../dist/index.bun.mjs');
} catch (error) {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND') {
    throw new Error('Missing Bun bundle at dist/index.bun.mjs. Run "yarn workspace happy-coder build:bun" before starting Bun-based processes.');
  } else {
    throw error;
  }
}
