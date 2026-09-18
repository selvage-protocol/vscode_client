/**
 * y-protocols framing (spec §7, §8). One binary frame is a *stream* of top-level
 * messages with no count and no terminator, so a receiver reads until the frame ends.
 *
 * Message types 2 (auth) and 3 (awareness query) belong to y-protocols and are unused by
 * `selvage/1`: both are read and dropped. The query is dropped rather than answered because
 * an answer costs a whole frame, and a frame is a byte stream with no count — so a frame of
 * query bytes drew one answer per byte, which an inbound bound on the frame does nothing to
 * bound. `MAX_REPLIES_PER_FRAME` caps what any one frame can draw, whatever it holds.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

/**
 * How many messages one frame may be answered with. A conforming peer asks once per frame at
 * most — this client and the reference one write one y-protocols message per frame, and only
 * SyncStep1 is answered at all — so a legitimate frame cannot lose an answer it needs. What
 * the cap bounds is the work a hostile frame can cost: without it `SyncStep1` costs a whole
 * replica-sized reply per two bytes, the same amplification the awareness query had per byte.
 */
const MAX_REPLIES_PER_FRAME = 1;

/** The replies a frame asked for, in the order the messages appeared. */
export interface FrameEffect {
  replies: Uint8Array[];
}

/** SyncStep1 with this replica's state vector: the catch-up handshake of §7. */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** A single update, carrying only the delta a local edit produced. */
export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Awareness states for the given client ids (a `null` state means "gone"). */
export function encodeAwareness(
  awareness: Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  );
  return encoding.toUint8Array(encoder);
}

/**
 * Applies one binary frame: every message in it, in order.
 *
 * Throws when the frame cannot be read as y-protocols at all. The caller drops such a
 * frame and keeps the session: a payload it cannot decode is a peer bug, not a reason to
 * end a working connection (the reference client does the same).
 */
export function applyFrame(
  frame: Uint8Array,
  doc: Y.Doc,
  awareness: Awareness,
  origin: unknown,
): FrameEffect {
  const decoder = decoding.createDecoder(frame);
  const replies: Uint8Array[] = [];

  while (decoding.hasContent(decoder)) {
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
        if (encoding.length(encoder) > 0 && replies.length < MAX_REPLIES_PER_FRAME) {
          replies.push(wrap(MESSAGE_SYNC, encoding.toUint8Array(encoder)));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          origin,
        );
        break;
      }
      // Unused by `selvage/1` and read and dropped here: see the header. Nothing is
      // consumed for it — a query carries no payload — and nothing is written back.
      case MESSAGE_QUERY_AWARENESS: {
        break;
      }
      case MESSAGE_AUTH: {
        decoding.readVarUint8Array(decoder);
        break;
      }
      default: {
        throw new Error(`unknown y-protocols message type ${messageType}`);
      }
    }
  }
  return { replies };
}

/** Prepends a top-level message type to an already-encoded message body. */
function wrap(messageType: number, body: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  encoding.writeUint8Array(encoder, body);
  return encoding.toUint8Array(encoder);
}
