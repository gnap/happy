import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalRoutes } from './routes';

function fileWith(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'happy-routes-'));
    const path = join(dir, 'proxy-routes.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
}

describe('loadLocalRoutes', () => {
    it('reads a bare port as "everything through this route"', () => {
        expect(loadLocalRoutes(fileWith({ personal: 57315 })))
            .toEqual([{ name: 'personal', port: 57315 }]);
    });

    it('reads a scope, which is what keeps research traffic off the hop', () => {
        expect(loadLocalRoutes(fileWith({
            'Luo Yang Anthropic': { port: 57316, only: ['api.anthropic.com', 'api.deepseek.com'] },
        }))).toEqual([{
            name: 'Luo Yang Anthropic',
            port: 57316,
            only: ['api.anthropic.com', 'api.deepseek.com'],
        }]);
    });

    it('skips entries it cannot use without failing the others', () => {
        const routes = loadLocalRoutes(fileWith({
            good: 57315,
            badPort: 'not-a-port',
            badOnly: { port: 57317, only: 'api.test' },
            duplicate: 57315,
        }));
        expect(routes).toEqual([{ name: 'good', port: 57315 }]);
    });

    it('treats a missing file as no routes', () => {
        expect(loadLocalRoutes(join(tmpdir(), 'does-not-exist-happy-routes.json'))).toEqual([]);
    });
});
