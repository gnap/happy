import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    lib: 'src/lib.ts',
    'codex/happyMcpStdioBridge': 'src/codex/happyMcpStdioBridge.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: false,
  outDir: 'dist',
  // Bundle all node_modules into the output to eliminate per-module disk I/O at startup.
  // Exceptions kept external:
  //   yoga-layout      — ships a pre-built WASM binary loaded via require() at runtime
  //   qrcode-terminal  — uses legacy octal escapes incompatible with esbuild strict mode
  //   react-devtools-core — optional ink dev dependency, not installed in production
  noExternal: [/^(?!yoga-layout$|qrcode-terminal$|react-devtools-core$).*/],
  external: ['yoga-layout', 'qrcode-terminal', 'react-devtools-core'],
  esbuildOptions(options, { format }) {
    if (format === 'esm') {
      // CJS packages bundled into ESM call require() for Node built-ins (e.g. tweetnacl → crypto).
      // Inject createRequire so those calls resolve correctly at runtime.
      options.banner = {
        js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
      }
    }
  },
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.cjs',
      dts: format === 'esm' ? '.d.mts' : '.d.cts',
    }
  },
})
