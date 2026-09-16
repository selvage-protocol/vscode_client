/**
 * A WebSocket the test drives itself, for the frames a fake server will not produce on
 * demand: a close with no `session.error` before it, an upgrade that never completes.
 */

import type { WebSocketLike } from '../../src/engine/transport.ts';

export class ControlledSocket implements WebSocketLike {
  readyState = 0;
  binaryType?: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Text frames this socket was asked to send. */
  readonly sent: string[] = [];
  /** How many times it was closed, by either end. */
  closes = 0;

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      this.sent.push(data);
    }
  }

  close(code?: number, reason?: string): void {
    this.closes += 1;
    this.fromPeer(code ?? 1000, reason ?? '');
  }

  /** The peer completes the upgrade. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The peer sends a text frame. */
  deliver(text: string): void {
    this.onmessage?.({ data: text });
  }

  /** The peer sends a binary frame. */
  deliverBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes });
  }

  /** The peer closes the connection. */
  fromPeer(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The transport fails before the upgrade completes. */
  fail(error: unknown = new Error('the transport failed')): void {
    this.readyState = 3;
    this.onerror?.(error);
  }
}
