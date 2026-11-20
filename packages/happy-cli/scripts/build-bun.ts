/**
 * Bundle the Bun entrypoint so it does not need a source tree at runtime.
 *
 * `bun build --packages external` keeps every bare specifier external, and the `@/*`
 * tsconfig alias is one of them: the emitted bundle still contains imports like
 * `from '@/configuration'`, which Bun resolves at runtime against whatever `src/` sits
 * next to the bundle. That is fine when the bundle and the source come from the same
 * checkout, and silently wrong when a build is deployed into another one — the daemon
 * then runs the new bundle with that checkout's old source for every aliased module.
 *
 * Externalizing the declared package names instead leaves npm dependencies external
 * while the alias targets are bundled like the rest of src.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(`${packageRoot}/package.json`, 'utf-8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
};

const external = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
]);

const args = ['build', './src/index.ts', '--outfile', './dist/index.bun.mjs', '--target', 'bun'];
for (const name of [...external].sort()) {
    args.push('--external', name, '--external', `${name}/*`);
}

const result = spawnSync(process.execPath, args, { cwd: packageRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);
