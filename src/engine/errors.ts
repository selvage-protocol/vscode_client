/** Faults an engine caller can see. */

/**
 * The session layer refused something: an `error` response to a request, a
 * `session.error` event, or a refusal during the handshake. `code` is the
 * machine-readable code from `PROTOCOL.md` §11
 * (https://github.com/selvage-protocol/specification).
 */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** True when `error` is a refusal with this session error code. */
export function isProtocolError(
  error: unknown,
  code?: string,
): error is ProtocolError {
  return (
    error instanceof ProtocolError &&
    (code === undefined || error.code === code)
  );
}
