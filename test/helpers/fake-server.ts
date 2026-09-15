/**
 * A minimal server speaking `selvage/1`, for tests that must not depend on a Rust build.
 *
 * It implements the parts of `PROTOCOL.md`
 * (https://github.com/selvage-protocol/specification) the engine talks to: the handshake and
 * its refusals (§5, §9), the open-document set and its hold semantics (§5), event
 * delivery (§6), payload-opaque binary relay (§3, §7) and the room grace period (§9).
 *
 * It is not the reference server and does not pretend to be: `test/selvaged.test.ts`
 * runs the real one. What this exists for is the paths that need a fault the reference
 * server will not produce on demand — a dropped socket, a hostile `x.` event, `/meta`
 * naming a version this client cannot speak.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import {
  DEFAULT_KEEPALIVE,
  WIRE_VERSION,
  close,
  code,
  event,
  isCompatible,
  method,
} from '../../src/engine/envelope.ts';
import type { Keepalive, PeerInfo, Role } from '../../src/engine/envelope.ts';

export interface FakeServerOptions {
  /** What `/meta` advertises as its wire versions. */
  metaWireVersions?: string[];
  /** The keepalive the server advertises in the handshake. */
  keepalive?: Partial<Keepalive>;
  /** How long the room survives after its host leaves; no reaping when omitted. */
  roomGraceMs?: number;
  /** Answer `/meta` with this status instead of a body, for the unreachable-`/meta` path. */
  metaStatus?: number;
  /** Accept the upgrade and then never answer a frame, for the handshake-timeout path. */
  silent?: boolean;
  /** Go silent once this many connections have been accepted, for a retry's timeout. */
  silentAfter?: number;
  /**
   * `false` models a server that predates the grant: `doc.grant` is answered
   * `unknown_method` and the connection stays open.
   */
  grant?: boolean;
  /**
   * Models a server that understands the grant and will not store this listing — one over its
   * own bound (`PROTOCOL.md` §5) — so `doc.grant` is answered `bad_params`.
   */
  refuseGrant?: boolean;
}

interface Client {
  id: string;
  socket: WebSocket;
  peer: PeerInfo;
  roomId?: string;
  holds: Set<string>;
  seated: boolean;
}

interface Room {
  id: string;
  token: string;
  hostId: string | null;
  peers: Set<string>;
  documents: string[];
  /** The host's listing, in the order it was published: the server never normalises it. */
  grant: string[];
  reap?: ReturnType<typeof setTimeout>;
}

/** The capabilities the reference server advertises. */
const SERVER_CAPABILITIES = [
  'y-protocols/1',
  'awareness',
  'open-document-set',
  'host-reclaim',
];

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export class FakeServer {
  readonly wsBase: string;
  readonly httpBase: string;

  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, Room>();
  private accepted = 0;
  /** Every `doc.open` / `doc.close` handled, in arrival order: for tests about ordering. */
  readonly requests: Array<{ client: string; method: string; path: string }> = [];
  /** Every `session.rename` handled, in arrival order: the peer and the name asked for. */
  readonly renames: Array<{ peerId: string; displayName: string }> = [];
  /** Every `doc.grant` handled, in arrival order: the peer and the listing it published. */
  readonly grants: Array<{ peerId: string; paths: string[] }> = [];
  /**
   * How many `doc.grant` frames arrived, whether or not the server applied them: what a host
   * attempted rather than only what a server kept.
   */
  grantAttempts = 0;
  /** Paths whose `doc.open` is refused, so a test can refuse a reconnect's re-open. */
  readonly refusedOpens = new Set<string>();
  /** Paths whose `doc.open` is accepted and never answered, for the request deadline. */
  readonly unansweredOpens = new Set<string>();
  private readonly options: Required<
    Pick<FakeServerOptions, 'metaWireVersions'>
  > &
    FakeServerOptions;

  private constructor(
    http: Server,
    wss: WebSocketServer,
    port: number,
    options: FakeServerOptions,
  ) {
    this.http = http;
    this.wss = wss;
    this.options = {
      metaWireVersions: [WIRE_VERSION],
      ...options,
    };
    this.wsBase = `ws://127.0.0.1:${port}`;
    this.httpBase = `http://127.0.0.1:${port}`;
  }

  static async start(options: FakeServerOptions = {}): Promise<FakeServer> {
    const http = createServer((request, response) => {
      // The reference server answers `/meta` whatever the method and 404s the rest.
      if (
        request.url?.split('?')[0] !== '/meta' ||
        (options.metaStatus !== undefined && options.metaStatus >= 400)
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          server: 'fake-selvaged/0.0.0',
          wire_versions: options.metaWireVersions ?? [WIRE_VERSION],
          capabilities: [...SERVER_CAPABILITIES],
          keepalive: { ...DEFAULT_KEEPALIVE, ...options.keepalive },
          roles: ['host', 'guest'],
        }),
      );
    });
    const wss = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => {
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the fake server did not bind a port');
    }
    const server = new FakeServer(http, wss, address.port, options);
    wss.on('connection', (socket, request) => {
      server.onConnection(socket, request.url ?? '');
    });
    return server;
  }

  /** How many connections are open. */
  get connectionCount(): number {
    return this.clients.size;
  }

  /** How many connections have been accepted in total, open or already gone. */
  get acceptedConnections(): number {
    return this.accepted;
  }

  roomOf(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Terminates the sockets of every client with this display name. */
  drop(displayName: string): void {
    for (const client of this.clients.values()) {
      if (client.peer.display_name === displayName) {
        client.socket.terminate();
      }
    }
  }

  /** Sends a binary frame to one client, as a misbehaving peer would. */
  sendBinaryToClient(displayName: string, bytes: Uint8Array): void {
    for (const client of this.clients.values()) {
      if (client.peer.display_name === displayName) {
        client.socket.send(bytes, { binary: true });
      }
    }
  }

  /** Sends a text frame to one client, as the server would. */
  sendToClient(displayName: string, text: string): void {
    for (const client of this.clients.values()) {
      if (client.peer.display_name === displayName) {
        client.socket.send(text);
      }
    }
  }

  peerIds(): string[] {
    return [...this.clients.keys()].sort();
  }

  /** The display names the seated clients were accepted with, sorted. */
  displayNames(): string[] {
    return [...this.clients.values()]
      .map((client) => client.peer.display_name)
      .sort();
  }

  async stop(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.reap !== undefined) {
        clearTimeout(room.reap);
      }
    }
    for (const client of this.clients.values()) {
      client.socket.terminate();
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.http.close(() => {
          resolve();
        });
      });
    });
  }

  // -- session --------------------------------------------------------------

  private onConnection(socket: WebSocket, url: string): void {
    this.accepted += 1;
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const room = query.get('room') ?? undefined;
    const token = query.get('token') ?? undefined;
    const id = `p-${hex(4)}`;
    const client: Client = {
      id,
      socket,
      peer: { peer_id: id, display_name: '', role: 'guest' },
      holds: new Set(),
      seated: false,
    };
    this.clients.set(id, client);

    // A silent server takes the upgrade and never answers a frame: the handshake times out.
    const silent =
      this.options.silent === true ||
      (this.options.silentAfter !== undefined &&
        this.accepted > this.options.silentAfter);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (silent) {
        return;
      }
      if (isBinary) {
        if (!client.seated) {
          this.refuse(client, code.badMessage, 'a binary frame before session.hello');
          return;
        }
        this.relay(client, data);
        return;
      }
      const text = data.toString();
      if (!client.seated) {
        this.hello(client, text, room, token);
        return;
      }
      this.handleText(client, text);
    });
    socket.on('close', () => {
      this.depart(client);
    });
    socket.on('error', () => {
      this.depart(client);
    });
  }

  private hello(
    client: Client,
    text: string,
    room: string | undefined,
    token: string | undefined,
  ): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.refuse(client, code.badMessage, 'not a session envelope');
      return;
    }
    if (message.method !== method.sessionHello) {
      this.refuse(
        client,
        code.helloRequired,
        `first method must be ${method.sessionHello}`,
      );
      return;
    }
    if (!isCompatible(String(message.v))) {
      this.refuse(client, code.unsupportedVersion, `unsupported ${message.v}`);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    const displayName =
      typeof params.display_name === 'string' ? params.display_name : '';
    if (displayName.trim() === '') {
      this.refuse(client, code.badParams, 'a display_name is required');
      return;
    }
    const claimed: Role | undefined =
      params.role === 'host' ? 'host' : params.role === 'guest' ? 'guest' : undefined;
    const awareness =
      typeof params.awareness_client_id === 'number'
        ? Math.trunc(params.awareness_client_id)
        : undefined;

    if (room === undefined) {
      // A connection without a room mints one: minting *is* hosting.
      const minted: Room = {
        id: `r-${hex(6)}`,
        token: hex(16),
        hostId: client.id,
        peers: new Set([client.id]),
        documents: [],
        grant: [],
      };
      this.rooms.set(minted.id, minted);
      client.roomId = minted.id;
      client.peer = {
        peer_id: client.id,
        display_name: displayName,
        role: 'host',
        ...(awareness === undefined ? {} : { awareness_client_id: awareness }),
      };
      client.seated = true;
      this.send(
        client,
        event.roomCreated,
        this.sessionParams(minted, client, { token: minted.token }),
      );
      return;
    }

    const existing = this.rooms.get(room);
    if (existing === undefined) {
      this.refuse(client, code.roomUnknown, `no such room: ${room}`);
      return;
    }
    if (token === undefined || token !== existing.token) {
      this.refuse(client, code.tokenInvalid, 'invalid room token');
      return;
    }
    const role: Role = claimed ?? 'guest';
    if (role === 'host' && existing.hostId !== null) {
      this.refuse(client, code.hostPresent, 'the room already has a host');
      return;
    }
    const wasHostless = existing.hostId === null;
    if (role === 'host') {
      existing.hostId = client.id;
      if (existing.reap !== undefined) {
        clearTimeout(existing.reap);
        existing.reap = undefined;
      }
    }
    existing.peers.add(client.id);
    client.roomId = existing.id;
    client.peer = {
      peer_id: client.id,
      display_name: displayName,
      role,
      ...(awareness === undefined ? {} : { awareness_client_id: awareness }),
    };
    client.seated = true;
    this.send(
      client,
      event.roomJoined,
      this.sessionParams(existing, client, {}),
    );
    // A joining connection learns the room's grant straight after its `room.joined`, and only
    // when the room grants something (§6.3).
    if (existing.grant.length > 0) {
      this.send(client, event.docGranted, { paths: existing.grant });
    }
    if (wasHostless && role === 'host') {
      this.broadcast(existing, { peer: client.peer }, event.hostAttached, client.id);
    } else {
      this.broadcast(existing, { peer: client.peer }, event.peerJoined, client.id);
    }
  }

  private sessionParams(
    room: Room,
    client: Client,
    extra: { token?: string },
  ): Record<string, unknown> {
    return {
      room_id: room.id,
      ...(extra.token === undefined ? {} : { token: extra.token }),
      self: client.peer,
      peers: [...room.peers]
        .filter((id) => id !== client.id)
        .map((id) => this.peers.get(id))
        .filter((peer): peer is PeerInfo => peer !== undefined),
      documents: room.documents,
      capabilities: [...SERVER_CAPABILITIES],
      keepalive: { ...DEFAULT_KEEPALIVE, ...this.options.keepalive },
    };
  }

  private handleText(client: Client, text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.alert(client, code.badMessage, 'not a session envelope');
      return;
    }
    const id = typeof message.id === 'number' ? Math.trunc(message.id) : undefined;
    if (id === undefined) {
      this.alert(client, code.badMessage, 'a request needs an id');
      return;
    }
    if (!isCompatible(String(message.v))) {
      this.respond(client, id, undefined, {
        code: code.unsupportedVersion,
        message: `unsupported ${String(message.v)}`,
      });
      client.socket.close(close.unsupportedVersion, 'version');
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case method.docGrant: {
        const room = this.rooms.get(client.roomId ?? '');
        if (room === undefined) {
          this.respond(client, id, undefined, {
            code: code.roomGone,
            message: 'the room is gone',
          });
          return;
        }
        this.grantAttempts += 1;
        if (this.options.grant === false) {
          this.respond(client, id, undefined, {
            code: code.unknownMethod,
            message: 'no such method: doc.grant',
          });
          return;
        }
        if (this.options.refuseGrant === true) {
          this.respond(client, id, undefined, {
            code: code.badParams,
            message: 'the listing is over the bound this server will store',
          });
          return;
        }
        const paths = Array.isArray(params.paths) ? params.paths : undefined;
        if (
          paths === undefined ||
          paths.some((path) => typeof path !== 'string' || path.trim() === '')
        ) {
          this.respond(client, id, undefined, {
            code: code.badParams,
            message: 'paths is required and every path must be non-blank',
          });
          return;
        }
        if (room.hostId !== client.id) {
          this.respond(client, id, undefined, {
            code: code.badParams,
            message: "the room's grant is its host's to publish",
          });
          return;
        }
        const listing = paths as string[];
        this.grants.push({ peerId: client.id, paths: [...listing] });
        // Stored and relayed verbatim: the fake server does not sort or deduplicate either.
        room.grant = [...listing];
        this.respond(client, id, {});
        this.broadcast(room, { paths: room.grant }, event.docGranted);
        return;
      }
      case method.docOpen:
      case method.docClose: {
        const path = typeof params.path === 'string' ? params.path : '';
        this.requests.push({
          client: client.peer.display_name,
          method: String(message.method),
          path,
        });
        if (message.method === method.docOpen && this.refusedOpens.has(path)) {
          this.respond(client, id, undefined, {
            code: code.badParams,
            message: 'this path is refused',
          });
          return;
        }
        if (message.method === method.docOpen && this.unansweredOpens.has(path)) {
          // A wedged server: the request was received and no answer is coming.
          return;
        }
        if (path.trim() === '') {
          this.respond(client, id, undefined, {
            code: code.badParams,
            message: 'path is required',
          });
          return;
        }
        const room = this.rooms.get(client.roomId ?? '');
        if (room === undefined) {
          this.respond(client, id, undefined, {
            code: code.roomGone,
            message: 'the room is gone',
          });
          return;
        }
        if (message.method === method.docOpen) {
          client.holds.add(path);
          if (!room.documents.includes(path)) {
            room.documents.push(path);
          }
        } else {
          client.holds.delete(path);
          this.release(room, path);
        }
        this.respond(client, id, { documents: room.documents });
        this.broadcast(
          room,
          {
            peer_id: client.id,
            path,
            documents: room.documents,
          },
          message.method === method.docOpen ? event.docOpened : event.docClosed,
        );
        return;
      }
      case method.sessionHello: {
        this.respond(client, id, undefined, {
          code: code.alreadySeated,
          message: 'this connection already completed the handshake',
        });
        return;
      }
      case method.rename: {
        const displayName =
          typeof params.display_name === 'string' ? params.display_name : '';
        this.renames.push({ peerId: client.id, displayName });
        // The bound is the handshake's, counted in UTF-16 code units, and a bad one is a
        // seated `bad_params` error response: the connection stays open (§5).
        if (displayName.trim() === '' || displayName.length > 32) {
          this.respond(client, id, undefined, {
            code: code.badParams,
            message: 'the display_name is blank or over the bound',
          });
          return;
        }
        const room = this.rooms.get(client.roomId ?? '');
        if (room === undefined) {
          this.respond(client, id, undefined, {
            code: code.roomGone,
            message: 'the room is gone',
          });
          return;
        }
        client.peer = { ...client.peer, display_name: displayName };
        this.respond(client, id, {});
        // Addressed like `doc.opened`: to every peer, the one that renamed included (§6).
        this.broadcast(room, { peer_id: client.id, display_name: displayName }, event.peerRenamed);
        return;
      }
      default: {
        this.respond(client, id, undefined, {
          code: code.unknownMethod,
          message: `no such method: ${String(message.method)}`,
        });
      }
    }
  }

  /** A path leaves the room's set only when no peer holds it any more (§5). */
  private release(room: Room, path: string): void {
    const held = [...room.peers].some((peerId) =>
      this.clients.get(peerId)?.holds.has(path),
    );
    if (!held) {
      room.documents = room.documents.filter((document) => document !== path);
    }
  }

  private depart(client: Client): void {
    if (!this.clients.delete(client.id)) {
      return;
    }
    const room = this.rooms.get(client.roomId ?? '');
    if (room === undefined) {
      return;
    }
    room.peers.delete(client.id);
    const wasHost = room.hostId === client.id;
    if (wasHost) {
      room.hostId = null;
    }
    if (client.seated) {
      this.broadcast(room, { peer_id: client.id }, event.peerLeft);
    }
    if (!wasHost) {
      return;
    }
    this.broadcast(
      room,
      { grace_ms: this.options.roomGraceMs ?? 30_000 },
      event.hostDetached,
    );
    if (this.options.roomGraceMs === undefined) {
      return;
    }
    room.reap = setTimeout(() => {
      this.rooms.delete(room.id);
      this.broadcast(
        room,
        { room_id: room.id, reason: 'host did not return' },
        event.roomGone,
      );
      for (const peerId of room.peers) {
        this.clients.get(peerId)?.socket.close(close.roomGone, 'room gone');
      }
    }, this.options.roomGraceMs);
  }

  // -- frames ---------------------------------------------------------------

  private relay(from: Client, frame: Buffer): void {
    const room = this.rooms.get(from.roomId ?? '');
    if (room === undefined) {
      return;
    }
    for (const peerId of room.peers) {
      if (peerId === from.id) {
        continue;
      }
      this.clients.get(peerId)?.socket.send(frame, { binary: true });
    }
  }

  private send(client: Client, name: string, params: unknown): void {
    client.socket.send(
      JSON.stringify({ v: WIRE_VERSION, event: name, params }),
    );
  }

  private broadcast(room: Room, params: unknown, name: string, except?: string): void {
    for (const peerId of room.peers) {
      if (peerId === except) {
        continue;
      }
      const peer = this.clients.get(peerId);
      if (peer !== undefined) {
        this.send(peer, name, params);
      }
    }
  }

  private respond(
    client: Client,
    id: number,
    result: unknown,
    error?: { code: string; message: string },
  ): void {
    client.socket.send(
      JSON.stringify(
        error === undefined
          ? { v: WIRE_VERSION, id, result: result ?? {} }
          : { v: WIRE_VERSION, id, error },
      ),
    );
  }

  private alert(client: Client, codeName: string, message: string): void {
    this.send(client, event.sessionError, { code: codeName, message });
  }

  /** Sends `session.error` and then closes with the matching code (§11). */
  private refuse(client: Client, codeName: string, message: string): void {
    this.alert(client, codeName, message);
    client.socket.close(closeCode(codeName), message);
  }

  private get peers(): Map<string, PeerInfo> {
    const out = new Map<string, PeerInfo>();
    for (const client of this.clients.values()) {
      if (client.seated) {
        out.set(client.id, client.peer);
      }
    }
    return out;
  }
}

function closeCode(codeName: string): number {
  switch (codeName) {
    case code.roomUnknown:
      return close.roomUnknown;
    case code.tokenInvalid:
      return close.tokenInvalid;
    case code.roomGone:
      return close.roomGone;
    case code.hostPresent:
      return close.hostPresent;
    case code.unsupportedVersion:
      return close.unsupportedVersion;
    default:
      return close.protocolError;
  }
}
