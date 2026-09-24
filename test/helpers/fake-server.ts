/**
 * A minimal server for the sealed wire, for tests that must not depend on a Rust build.
 *
 * It implements the parts of `PROTOCOL.md`
 * (https://github.com/selvage-protocol/specification) a client talks to: the handshake and
 * its refusals (§5, §9), the room's membership (§6), payload-opaque binary relay (§3, §7),
 * the holds a room's open-document set is read from (§13.7) and the room grace period (§9).
 *
 * It is not the reference server and does not pretend to be: `test/relay-selvaged.test.ts`,
 * `test/selvage2-selvaged.test.ts` and `test/selvage2-reconnect-selvaged.test.ts` run the real
 * one. What this exists for is the paths that need a fault the reference server will not produce
 * on demand — a dropped socket, a hostile `x.` event, a room that is reaped under a guest.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { SessionBase } from '../../src/engine/urls.ts';
import {
  DEFAULT_KEEPALIVE,
  WIRE_VERSION,
  close,
  code,
  event,
} from '../../src/engine/envelope.ts';
import type { MetaKeepalive, PeerInfo } from '../../src/engine/envelope.ts';
import { baseOf } from './base.ts';

export interface FakeServerOptions {
  /**
   * What `/meta` advertises as its wire versions. Omitted, it advertises what the server seats:
   * the one wire. A body that disagreed with the handshake would model a server no client should
   * trust.
   */
  metaWireVersions?: string[];
  /** The keepalive the server advertises in the handshake and in `/meta`. */
  keepalive?: Partial<MetaKeepalive>;
  /** How long the room survives after its host leaves; no reaping when omitted. */
  roomGraceMs?: number;
  /** Answer `/meta` with this status instead of a body, for the unreachable-`/meta` path. */
  metaStatus?: number;
  /** Accept the upgrade and then never answer a frame, for the handshake-timeout path. */
  silent?: boolean;
  /** Go silent once this many connections have been accepted, for a retry's timeout. */
  silentAfter?: number;
  /**
   * Models a server that seats a host without handing it the room's token: `room.created` names
   * the room and carries no token. That is the one way a live room reaches a client with no
   * invite to hand on, and it is a fault to survive rather than a shape to expect — `PROTOCOL.md`
   * §6.1 says the mint is the frame that carries the token.
   */
  omitHostToken?: boolean;
}

interface Client {
  id: string;
  socket: WebSocket;
  peer: PeerInfo;
  roomId?: string;
  holds: Set<string>;
  seated: boolean;
}

/** The two methods a client sends as text; the rest of its traffic is sealed frames. */
const method = {
  sessionHello: 'session.hello',
  rename: 'session.rename',
} as const;

interface Room {
  id: string;
  token: string;
  hostId: string | null;
  peers: Set<string>;
  reap?: ReturnType<typeof setTimeout>;
}

/** The capabilities the reference server advertises. */
const SERVER_CAPABILITIES = [
  'y-protocols/1',
  'awareness',
];

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export class FakeServer {
  readonly wsBase: SessionBase;
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
  /**
   * The wire version each connection claimed in its `session.hello`, in arrival order. What a
   * client speaks is otherwise invisible to a test without a real server: the version is not in
   * any reply.
   */
  readonly hellos: string[] = [];
  /**
   * When set, every later handshake is refused with this code and the matching close — the
   * shape a full room or a full server refuses a retry with. A refusal is an `x.` capacity
   * code the server invents, so the client has to treat the reserved namespace as final
   * (`PROTOCOL.md` §9.1, §11); the fake server produces the fault the real one will not
   * produce on demand. */
  helloRefusal: { code: string; message: string } | undefined = undefined;

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
    this.wsBase = baseOf(`ws://127.0.0.1:${port}`);
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
          keepalive: {
            ...DEFAULT_KEEPALIVE,
            ...options.keepalive,
            // The grace is the server's own configuration, so a fake server that models one
            // advertises it in `/meta` as the reference does (§2, §9).
            ...(options.roomGraceMs === undefined
              ? {}
              : { room_grace_ms: options.roomGraceMs }),
          },
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

  /**
   * Announces a peer to one client, as the room's own membership does when it is seated: the
   * frame every seat carries, and the only one that announces a return — no server frame marks a
   * host (`PROTOCOL.md` §13). Sending it by hand is how a case gets driven where the announcement
   * does not arrive — a guest whose socket was down when the host came back.
   */
  announcePeerToClient(displayName: string, peer: PeerInfo): void {
    this.sendToClient(displayName, JSON.stringify({ v: WIRE_VERSION, event: event.peerJoined, params: { peer } }));
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
    this.hellos.push(String(message.v));
    const params = (message.params ?? {}) as Record<string, unknown>;
    const displayName =
      typeof params.display_name === 'string' ? params.display_name : '';
    if (displayName.trim() === '') {
      this.refuse(client, code.badParams, 'a display_name is required');
      return;
    }
    if (this.helloRefusal !== undefined) {
      this.refuse(client, this.helloRefusal.code, this.helloRefusal.message);
      return;
    }
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
        this.sessionParams(minted, client, {
          ...(this.options.omitHostToken === true ? {} : { token: minted.token }),
        }),
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
    // This server seats nobody as the host: a room's roles are the host's own state to assign
    // (`§13.4`), and this one only records the minting connection so it can reap the room.
    existing.peers.add(client.id);
    client.roomId = existing.id;
    client.peer = {
      peer_id: client.id,
      display_name: displayName,
      role: 'guest',
      ...(awareness === undefined ? {} : { awareness_client_id: awareness }),
    };
    client.seated = true;
    this.send(
      client,
      event.roomJoined,
      this.sessionParams(existing, client, {}),
    );
    this.broadcast(existing, { peer: client.peer }, event.peerJoined, client.id);
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
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
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
    default:
      return close.protocolError;
  }
}
