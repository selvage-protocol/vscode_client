/**
 * The WebSocket transport seam.
 *
 * The engine speaks text frames (the JSON envelope) and binary frames (y-protocols
 * payloads) and knows nothing else about the socket. `WebSocketLike` is the intersection
 * of what Node's global `WebSocket`, the `ws` package and the browser API all provide,
 * so the default can be swapped for the extension host's own WebSocket without touching
 * the engine — and a test can inject a socket it controls.
 */

/** The slice of a WebSocket both Node's and the browser's implementations satisfy. */
export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** `readyState` of an open WebSocket. */
export const SOCKET_OPEN = 1;

export interface TransportHandlers {
  onText(text: string): void;
  onBinary(bytes: Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(error: Error): void;
}

/** A socket the engine can write to, once the handshake with the peer is done. */
export interface OpenSocket {
  readonly isOpen: boolean;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

function reasonText(reason: unknown): string {
  if (typeof reason === 'string') {
    return reason;
  }
  const bytes = toBytes(reason);
  return bytes === undefined ? '' : new TextDecoder().decode(bytes);
}

/**
 * Opens a socket and reports frames to `handlers`. Rejects when the socket closes or
 * errors before it opened: the caller learns that the transport never came up, rather
 * than being handed a socket that will never speak. An `AbortSignal` gives the caller a
 * deadline for the upgrade: aborting rejects with the signal's reason and closes the
 * socket, which is what stops a connect that never fires open, error or close.
 */
export function openSocket(
  url: string,
  handlers: TransportHandlers,
  factory: WebSocketFactory,
  signal?: AbortSignal,
): Promise<OpenSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocketLike;
    try {
      socket = factory(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // Binary frames arrive as ArrayBuffer where the implementation honours this, which
    // is what makes the handler synchronous.
    socket.binaryType = 'arraybuffer';

    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      outcome();
    };

    const onAbort = (): void => {
      settle(() => {
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('the connection attempt was abandoned'),
        );
      });
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    };

    socket.onopen = () => {
      settle(() => {
        resolve({
          get isOpen(): boolean {
            return socket.readyState === SOCKET_OPEN;
          },
          sendText(text: string): void {
            socket.send(text);
          },
          sendBinary(bytes: Uint8Array): void {
            socket.send(bytes);
          },
          close(code?: number, reason?: string): void {
            socket.close(code, reason);
          },
        });
      });
    };
    socket.onmessage = (message) => {
      // The frame's kind is in the data's type, never in whether it happens to decode as
      // UTF-8: a text frame is a string, and everything else is a y-protocols payload.
      if (typeof message.data === 'string') {
        handlers.onText(message.data);
        return;
      }
      const bytes = toBytes(message.data);
      if (bytes !== undefined) {
        handlers.onBinary(bytes);
      }
    };
    socket.onclose = (event) => {
      const code = typeof event.code === 'number' ? event.code : 1006;
      const reason = reasonText(event.reason);
      if (!settled) {
        settle(() => {
          reject(new Error(`the socket closed before it opened: ${code} ${reason}`));
        });
      }
      handlers.onClose(code, reason);
    };
    socket.onerror = () => {
      const error = new Error('the WebSocket reported an error');
      if (!settled) {
        settle(() => {
          reject(error);
        });
      }
      handlers.onError(error);
    };

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
