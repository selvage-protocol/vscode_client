/**
 * What the server said at the end of the handshake, in the shape an adapter is written against.
 *
 * It is the room description `src/bridge/bridge.ts` asks an engine for, projected from whatever
 * the connection was seated from: `RelaySessionInfo` (`relay.ts`) is the relay's own record of the
 * same reply, and `PeerEngine.session()` (`bridge/peer-engine.ts`) is the projection.
 */

import type { Keepalive, PeerInfo, Role } from './envelope.ts';
import type { SessionBase } from './urls.ts';

export interface SessionInfo {
  roomId: string;
  /** Present only for the connection that minted the room. */
  token?: string;
  role: Role;
  /** This connection's own peer record. */
  peer: PeerInfo;
  /** Peers that were already in the room. */
  peers: PeerInfo[];
  /** The room's open-document set at the moment of joining. */
  documents: string[];
  capabilities: string[];
  keepalive: Keepalive;
  /**
   * The server base this connection was opened against, without the endpoint path, as
   * `sessionBase` reads a base.
   */
  baseUrl: SessionBase;
}
