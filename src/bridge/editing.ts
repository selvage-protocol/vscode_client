/**
 * The document policy: line endings, the smallest change between two texts, and the
 * comparison that stands in for an echo guard.
 *
 * All three are settled by measurement in `SPIKES.md`. Two editors with different line
 * endings rewrite each other for ever unless the replica holds LF and the adapter restores
 * the document's own endings on render (spike 3); a "this edit is mine" flag loses or
 * duplicates an edit depending on when the coalesced change event lands, while comparing
 * the buffer's text against the replica's is not a bet on timing (spike 2). This module is
 * the policy those two findings add up to, with no editor in scope.
 */

/** A document's line endings. A file with neither (or an empty one) is `'\n'`. */
export type LineEnding = '\n' | '\r\n';

/**
 * What goes into the replica: LF only, whoever wrote it. A lone `\r` is left alone — it is
 * not a line ending any editor here produces, and rewriting one would edit a document the
 * user cannot see changed.
 */
export function toCrdt(bufferText: string): string {
  return bufferText.replaceAll('\r\n', '\n');
}

/**
 * The replica's text as this document renders it. The result is what the buffer must hold,
 * and it must never be written back: the conversion is this adapter's, and a peer with the
 * other line ending would answer it with the same edit.
 */
export function render(crdtText: string, eol: LineEnding): string {
  return eol === '\n' ? crdtText : crdtText.replaceAll('\n', '\r\n');
}

/**
 * A single replacement of `[start, end)` with `text`, in UTF-16 code units of the text it
 * changes. Offsets are counted in the text the change is taken against — the buffer's for
 * a change handed to an editor, the replica's for one written into the CRDT.
 */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

/**
 * Whether `offset` falls between the two code units of one astral character — the state a
 * change boundary must never be in.
 */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return false;
  }
  const high = text.charCodeAt(offset - 1);
  const low = text.charCodeAt(offset);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * The smallest replacement that turns `from` into `to`: the common prefix and suffix are
 * left alone, and no end of the range is left between the two halves of a surrogate pair.
 *
 * A whole-document replacement is the same edit with `start = 0`, and it is what the
 * cheapest implementation does. It is worth the extra scan to avoid: it collapses undo
 * granularity, resets folding and can jump the local caret, and the replica's delta is
 * available for free (`SPIKES.md`, spike 2 finding 2). An empty change — `start === end`,
 * `text === ''` — means the texts already agree.
 */
export function diff(from: string, to: string): TextChange {
  if (from === to) {
    return { start: 0, end: 0, text: '' };
  }
  let start = 0;
  const shortest = Math.min(from.length, to.length);
  while (start < shortest && from[start] === to[start]) {
    start += 1;
  }
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from[endFrom - 1] === to[endTo - 1]) {
    endFrom -= 1;
    endTo -= 1;
  }
  // The scans compare one code unit at a time and cannot see a pair, so a boundary can land
  // between a high and a low half — any two astral characters that share a high surrogate
  // will do, which is every emoji replacement. A change whose range does that describes an
  // edit no editor can make, and its `text` begins or ends with half a character; a lone
  // surrogate is not a string a peer's decoder can be handed (`vim.json.decode` refuses the
  // escape, drops the line and never answers the apply). The range is widened to whole
  // characters instead — outward, so the change still reproduces `to` exactly — at a cost of
  // at most one code unit at each end: the change is no longer the strictly smallest one.
  // The two indices move together: the suffix scan left `from[endFrom]` equal to `to[endTo]`,
  // so giving up one on each side keeps that equality, and `text` is what `to` holds there.
  if (splitsPair(from, start) || splitsPair(to, start)) {
    start -= 1;
  }
  if (splitsPair(from, endFrom) || splitsPair(to, endTo)) {
    endFrom += 1;
    endTo += 1;
  }
  return { start, end: endFrom, text: to.slice(start, endTo) };
}

/** Applies a change. The inverse of `diff` up to the range it chose. */
export function applyChange(text: string, change: TextChange): string {
  return (
    text.slice(0, change.start) +
    change.text +
    text.slice(Math.max(change.end, change.start))
  );
}

/**
 * Whether a buffer's offsets and the replica's differ at all.
 *
 * The conversions below are a no-op unless the buffer holds a `\r`: the two texts count the
 * same code units otherwise, and a lone `\r` counts as one in the replica too, so only the
 * pairs matter. A caller that already has the buffer in hand works this out once per change
 * and passes the answer down, rather than each conversion scanning the document again — the
 * scan is what a caret and every peer cursor's endpoint would otherwise repeat per report.
 */
export function hasCarriageReturn(text: string): boolean {
  return text.indexOf('\r') !== -1;
}

/**
 * A buffer offset as a replica offset. The replica is LF-only and the buffer keeps the
 * document's own endings, so the two count the same code units in different texts: every
 * `\r\n` before the offset is one code unit the replica does not have. Offsets stop at the
 * seam, and this is the seam.
 *
 * `carriageReturn` is `hasCarriageReturn(bufferText)` when it is left out, so every call is
 * exactly the scan below; passing it is what makes a document with no `\r` in it free.
 */
export function toReplicaOffset(
  bufferText: string,
  bufferOffset: number,
  carriageReturn = hasCarriageReturn(bufferText),
): number {
  if (!carriageReturn) {
    // What the loop counts: one replica code unit per buffer code unit it walks, stopped by
    // either end. `Math.ceil` keeps the answer for a fractional or non-finite offset what
    // the loop's `<` test makes it — nothing a caller produces, and nothing a CRLF document
    // can be affected by, since this path is only taken for a buffer with no `\r` in it.
    const end = Math.min(Math.ceil(bufferOffset), bufferText.length);
    return end > 0 ? end : 0;
  }
  let replica = 0;
  for (let index = 0; index < bufferOffset && index < bufferText.length; index += 1) {
    if (bufferText[index] === '\r' && bufferText[index + 1] === '\n') {
      index += 1;
    }
    replica += 1;
  }
  return replica;
}

/** The inverse of `toReplicaOffset`: the buffer offset a replica offset lands on. */
export function toBufferOffset(
  bufferText: string,
  replicaOffset: number,
  carriageReturn = hasCarriageReturn(bufferText),
): number {
  if (!carriageReturn) {
    const end = Math.min(Math.ceil(replicaOffset), bufferText.length);
    return end > 0 ? end : 0;
  }
  let replica = 0;
  let buffer = 0;
  while (replica < replicaOffset && buffer < bufferText.length) {
    if (bufferText[buffer] === '\r' && bufferText[buffer + 1] === '\n') {
      buffer += 2;
    } else {
      buffer += 1;
    }
    replica += 1;
  }
  return buffer;
}

/**
 * Whether a buffer already holds what this replica holds — the echo guard.
 *
 * An editor gives no way to tell a keystroke from this adapter's own application of a peer's
 * edit: `WorkspaceEdit` carries no author and `TextDocumentChangeEvent` only a
 * `reason: Undo | Redo | undefined`. Content is the only thing left to compare. A change
 * event this answers `true` for is published as nothing — and because what *is* published
 * is a diff against the replica rather than the event's own ranges, an event that carries
 * no change cannot become one.
 */
export function matchesReplica(bufferText: string, crdtText: string): boolean {
  return toCrdt(bufferText) === crdtText;
}
