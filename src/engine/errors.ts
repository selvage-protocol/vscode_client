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

/**
 * A call that will not be answered: the session ended, the connection it went out on died,
 * or the server did not answer it in time. Nothing was refused — a refusal is a
 * `ProtocolError` — so there is no code, only the fact that this call is over.
 */
export class EngineClosedError extends Error {
  constructor(message = 'the session is closed') {
    super(message);
    this.name = 'EngineClosedError';
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
