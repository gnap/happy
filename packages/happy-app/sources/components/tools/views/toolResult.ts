const WRAPPER_KEYS = ['success', 'result', 'output', 'data'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasPayloadHints(value: Record<string, unknown>): boolean {
    return (
        'diffString' in value ||
        'beforeFullFileContent' in value ||
        'afterFullFileContent' in value ||
        '_lazyResult' in value ||
        'lazyResult' in value
    );
}

function hasLazyMarkerDeep(value: unknown, seen = new Set<object>()): boolean {
    if (!isObject(value) || seen.has(value)) return false;
    seen.add(value);

    if (value._lazyResult === true || value.lazyResult === true) return true;

    return WRAPPER_KEYS.some((key) => hasLazyMarkerDeep(value[key], seen));
}

export function unwrapToolResult(value: unknown): any {
    if (!isObject(value)) return value;

    let current: Record<string, unknown> = value;
    const seen = new Set<object>();

    while (isObject(current) && !seen.has(current)) {
        seen.add(current);
        const next =
            current.success ??
            current.result ??
            current.output ??
            current.data;

        if (!isObject(next)) break;

        // Follow one or more known wrapper layers until we reach the actual payload.
        if (hasPayloadHints(next) || WRAPPER_KEYS.some((key) => key in next)) {
            current = next;
            continue;
        }

        break;
    }

    return current;
}

export function hasLazyResultMarker(value: unknown): boolean {
    return hasLazyMarkerDeep(value);
}
