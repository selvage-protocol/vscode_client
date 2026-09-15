/**
 * A WebSocket that tallies the frames crossing it, so a measurement or a test can say what an
 * engine published rather than infer it from what a peer happened to observe. A repeated
 * identical state is invisible to a peer (y-protocols guards `change`), so a peer's view
 * cannot count the frames the wire carried.
 */

import WebSocket from 'ws';

import type { WebSocketLike } from '../../src/engine/transport.ts';

/** Every frame one direction carried, by kind. A binary frame's kind is its first varUint. */
export interface Tally {
  text: number;
  sync: number;
  syncBytes: number;
  awareness: number;
  awarenessBytes: number;
  other: number;
  bytes: number;
}

export interface FrameTally {
  sent: Tally;
  received: Tally;
}

function zero(): Tally {
  return { text: 0, sync: 0, syncBytes: 0, awareness: 0, awarenessBytes: 0, other: 0, bytes: 0 };
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

function count(tally: Tally, bytes: number, kind: 'text' | 'sync' | 'awareness' | 'other'): void {
  tally.bytes += bytes;
  if (kind === 'text') {
    tally.text += 1;
    return;
  }
  if (kind === 'sync') {
    tally.sync += 1;
    tally.syncBytes += bytes;
    return;
  }
  if (kind === 'awareness') {
    tally.awareness += 1;
    tally.awarenessBytes += bytes;
    return;
  }
  tally.other += 1;
}

function tallyFrame(tally: Tally, data: unknown): void {
  if (typeof data === 'string') {
    count(tally, Buffer.byteLength(data, 'utf8'), 'text');
    return;
  }
  const bytes = toBytes(data);
  const first = bytes?.[0];
  count(tally, bytes?.length ?? 0, first === 0 ? 'sync' : first === 1 ? 'awareness' : 'other');
}

/** A real `ws` socket with a tally in front of it. */
export class CountingSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly inner: WebSocket;
  private readonly tally: FrameTally;

  constructor(url: string, tally: FrameTally) {
    this.tally = tally;
    this.inner = new WebSocket(url);
    this.inner.on('open', () => {
      this.readyState = 1;
      this.onopen?.();
    });
    this.inner.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        tallyFrame(this.tally.received, data.toString());
        this.onmessage?.({ data: data.toString() });
        return;
      }
      const bytes = toBytes(data);
      tallyFrame(this.tally.received, bytes);
      this.onmessage?.({ data: bytes });
    });
    this.inner.on('close', (code: number, reason: Buffer) => {
      this.readyState = 3;
      this.onclose?.({ code, reason: reason.toString() });
    });
    this.inner.on('error', () => {
      this.onerror?.(new Error('the socket reported an error'));
    });
  }

  /** Forwarded, because the engine sets it and the inner socket is the one that decodes. */
  get binaryType(): string | undefined {
    return this.inner.binaryType;
  }

  set binaryType(value: string | undefined) {
    if (value !== undefined) {
      this.inner.binaryType = value as WebSocket['binaryType'];
    }
  }

  send(data: string | Uint8Array): void {
    tallyFrame(this.tally.sent, data);
    this.inner.send(data);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
}

/** A `WebSocketFactory` and the tally it feeds, shared by every connection it opens. */
export interface Counting {
  factory: (url: string) => WebSocketLike;
  tally: FrameTally;
  /** Clears the tally, so a scenario is counted from its own start. */
  reset(): void;
}

export function counting(): Counting {
  const tally: FrameTally = { sent: zero(), received: zero() };
  return {
    tally,
    factory: (url: string): WebSocketLike => new CountingSocket(url, tally),
    reset(): void {
      Object.assign(tally.sent, zero());
      Object.assign(tally.received, zero());
    },
  };
}
