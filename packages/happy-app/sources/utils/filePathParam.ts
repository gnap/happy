/**
 * A file path carried in a route parameter.
 *
 * Base64url of the path's UTF-8 bytes. Plain `btoa` throws on any character above U+00FF, so a
 * path with a Chinese directory name could not be opened at all; base64url rather than base64
 * because `+` in a query string reads back as a space in too many parsers.
 */

export function encodeFilePathParam(path: string): string {
    const bytes = new TextEncoder().encode(path);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function decodeFilePathParam(encoded: string): string {
    try {
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    } catch {
        // Not one of ours: the route also accepts a raw path.
        return encoded;
    }
}
