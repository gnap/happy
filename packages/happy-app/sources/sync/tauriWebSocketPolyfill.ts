/**
 * Browser-WebSocket-compatible wrapper around `@tauri-apps/plugin-websocket`.
 *
 * On Linux, WebKitGTK + libsoup's native WebSocket exhibits intermittent
 * stalls and flapping when multiple network interfaces are up (even when
 * routing/source-address selection looks correct). Routing it through
 * `tauri-plugin-websocket` instead uses Rust's tungstenite on the host
 * network stack, which doesn't have this issue.
 *
 * Usage:
 *   const restore = await installTauriWebSocketAsWebSocketCtor();
 *   try {
 *     await import('socket.io-client'); // captures our ctor at module load
 *   } finally {
 *     restore();
 *   }
 */

import { isRunningInTauri } from '@/utils/platform';

type PluginWebSocketModule = typeof import('@tauri-apps/plugin-websocket');
type PluginWebSocket = InstanceType<PluginWebSocketModule['default']>;
type PluginMessage =
    | { type: 'Text'; data: string }
    | { type: 'Binary'; data: number[] }
    | { type: 'Ping'; data: number[] }
    | { type: 'Pong'; data: number[] }
    | { type: 'Close'; data: { code: number; reason: string } | null };

const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;
const READY_STATE_CLOSING = 2;
const READY_STATE_CLOSED = 3;

let cachedModule: Promise<PluginWebSocketModule> | null = null;
function loadPlugin(): Promise<PluginWebSocketModule> {
    if (!cachedModule) {
        cachedModule = import('@tauri-apps/plugin-websocket');
    }
    return cachedModule;
}

class TauriBackedWebSocket {
    static readonly CONNECTING = READY_STATE_CONNECTING;
    static readonly OPEN = READY_STATE_OPEN;
    static readonly CLOSING = READY_STATE_CLOSING;
    static readonly CLOSED = READY_STATE_CLOSED;

    readonly CONNECTING = READY_STATE_CONNECTING;
    readonly OPEN = READY_STATE_OPEN;
    readonly CLOSING = READY_STATE_CLOSING;
    readonly CLOSED = READY_STATE_CLOSED;

    binaryType: 'arraybuffer' | 'blob' = 'blob';
    readyState: number = READY_STATE_CONNECTING;
    url: string;
    protocol: string = '';
    extensions: string = '';
    bufferedAmount: number = 0;

    onopen: ((ev: any) => void) | null = null;
    onclose: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;

    private inner: PluginWebSocket | null = null;
    private innerReady: Promise<void>;
    private listenerCleanup: (() => void) | null = null;
    private closeRequested = false;

    constructor(url: string, _protocols?: string | string[]) {
        this.url = url;
        this.innerReady = this.#open();
    }

    async #open(): Promise<void> {
        try {
            const mod = await loadPlugin();
            if (this.closeRequested) {
                return;
            }
            const ws = await mod.default.connect(this.url);
            if (this.closeRequested) {
                try { await ws.disconnect(); } catch { /* ignore */ }
                return;
            }
            this.inner = ws;
            this.listenerCleanup = ws.addListener((msg) => this.#handleMessage(msg as PluginMessage));
            this.readyState = READY_STATE_OPEN;
            this.#safeInvoke(this.onopen, { type: 'open', target: this });
        } catch (err) {
            this.readyState = READY_STATE_CLOSED;
            this.#safeInvoke(this.onerror, { type: 'error', error: err, target: this });
            this.#safeInvoke(this.onclose, {
                type: 'close',
                target: this,
                code: 1006,
                reason: err instanceof Error ? err.message : String(err),
                wasClean: false,
            });
        }
    }

    #handleMessage(msg: PluginMessage | null) {
        if (!msg) return;
        switch (msg.type) {
            case 'Text': {
                this.#safeInvoke(this.onmessage, {
                    type: 'message', target: this, data: msg.data,
                });
                return;
            }
            case 'Binary': {
                const arr = new Uint8Array(msg.data);
                const data = this.binaryType === 'arraybuffer'
                    ? arr.buffer
                    : (typeof Blob !== 'undefined' ? new Blob([arr]) : arr.buffer);
                this.#safeInvoke(this.onmessage, {
                    type: 'message', target: this, data,
                });
                return;
            }
            case 'Close': {
                const code = msg.data?.code ?? 1006;
                const reason = msg.data?.reason ?? '';
                this.readyState = READY_STATE_CLOSED;
                this.#safeInvoke(this.onclose, {
                    type: 'close', target: this,
                    code, reason, wasClean: code === 1000,
                });
                this.#cleanup();
                return;
            }
            case 'Ping':
            case 'Pong':
                // Tauri plugin handles control frames internally.
                return;
        }
    }

    #cleanup() {
        try { this.listenerCleanup?.(); } catch { /* ignore */ }
        this.listenerCleanup = null;
        this.inner = null;
    }

    #safeInvoke(handler: ((ev: any) => void) | null, ev: any) {
        if (!handler) return;
        try {
            handler(ev);
        } catch {
            // Browser WebSocket swallows handler errors silently.
        }
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
        if (this.readyState !== READY_STATE_OPEN || !this.inner) {
            // Browser WebSocket throws InvalidStateError when not open.
            throw new Error('WebSocket is not open');
        }
        const inner = this.inner;
        if (typeof data === 'string') {
            void inner.send(data).catch((err) => this.#onSendError(err));
            return;
        }
        if (data instanceof ArrayBuffer) {
            void inner.send(Array.from(new Uint8Array(data))).catch((err) => this.#onSendError(err));
            return;
        }
        if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView;
            const bytes = Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
            void inner.send(bytes).catch((err) => this.#onSendError(err));
            return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            void data.arrayBuffer()
                .then((buf) => this.inner?.send(Array.from(new Uint8Array(buf))))
                .catch((err) => this.#onSendError(err));
            return;
        }
        throw new Error('Unsupported WebSocket.send() data type');
    }

    #onSendError(err: unknown) {
        this.#safeInvoke(this.onerror, { type: 'error', error: err, target: this });
    }

    close(_code?: number, _reason?: string): void {
        if (this.closeRequested) return;
        this.closeRequested = true;
        if (this.readyState === READY_STATE_CLOSED) return;
        this.readyState = READY_STATE_CLOSING;

        const finish = (clean: boolean) => {
            if (this.readyState === READY_STATE_CLOSED) return;
            this.readyState = READY_STATE_CLOSED;
            this.#safeInvoke(this.onclose, {
                type: 'close', target: this,
                code: clean ? 1000 : 1006,
                reason: '',
                wasClean: clean,
            });
            this.#cleanup();
        };

        void this.innerReady.then(() => {
            const inner = this.inner;
            if (!inner) {
                finish(true);
                return;
            }
            inner.disconnect()
                .then(() => finish(true))
                .catch(() => finish(false));
        });
    }

    addEventListener(type: string, listener: (ev: any) => void): void {
        switch (type) {
            case 'open': this.onopen = listener; break;
            case 'close': this.onclose = listener; break;
            case 'error': this.onerror = listener; break;
            case 'message': this.onmessage = listener; break;
        }
    }

    removeEventListener(type: string, _listener: (ev: any) => void): void {
        switch (type) {
            case 'open': this.onopen = null; break;
            case 'close': this.onclose = null; break;
            case 'error': this.onerror = null; break;
            case 'message': this.onmessage = null; break;
        }
    }

    dispatchEvent(_ev: any): boolean { return true; }
}

/**
 * Returns true if we should route socket.io's WebSocket through tauri-plugin-websocket.
 *
 * Currently enabled only on Linux + Tauri, where WebKitGTK/libsoup is known to
 * misbehave on multi-homed hosts. macOS uses WKWebView and Windows uses WebView2
 * (Chromium), neither of which exhibit the issue.
 */
export function shouldUseTauriWebSocketTransport(): boolean {
    if (!isRunningInTauri()) return false;
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent ?? '';
    const platform = (navigator as any).platform ?? '';
    return /Linux/i.test(ua) || /Linux/i.test(platform);
}

/**
 * Temporarily replaces `globalThis.WebSocket` with the Tauri-backed implementation,
 * triggers `loader` (which is expected to `import('socket.io-client')` / similar),
 * then restores the original ctor. engine.io-client binds the WebSocket ctor at
 * module load time, so the loader callback captures our implementation while the
 * rest of the app continues to see the native WebSocket.
 */
export async function withTauriWebSocketCtor<T>(loader: () => Promise<T>): Promise<T> {
    if (!shouldUseTauriWebSocketTransport()) {
        return loader();
    }
    const g = globalThis as any;
    const originalWebSocket = g.WebSocket;
    const originalMozWebSocket = g.MozWebSocket;
    try {
        g.WebSocket = TauriBackedWebSocket;
        // Belt and braces: engine.io-client also falls back to MozWebSocket.
        g.MozWebSocket = TauriBackedWebSocket;
        return await loader();
    } finally {
        if (originalWebSocket === undefined) delete g.WebSocket; else g.WebSocket = originalWebSocket;
        if (originalMozWebSocket === undefined) delete g.MozWebSocket; else g.MozWebSocket = originalMozWebSocket;
    }
}
