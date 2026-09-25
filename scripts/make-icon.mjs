/**
 * Derives `images/icon.png` — the icon the manifest points at, which is what the Marketplace and
 * Open VSX show in the listing — from the owner's opaque 800×800 export, as the whole frame at
 * 256×256 and with no colour change.
 *
 * The export is not in this repository. It is the owner's
 * `~/pictures/profile_pictures/profile_picture_svp_800_800.png` (sha256 9bf1980d…, 58,531 bytes),
 * and the sibling `site` checkout vendors it byte-identical as `app/opengraph-image.png`, so
 * either path is a valid source. Pass one as the argument, or set `SELVAGE_ICON_EXPORT`; the
 * script refuses a file that does not look like that export (not an 8-bit RGB or RGBA PNG, or not
 * square) rather than deriving something from the wrong image.
 *
 * The icon it replaces is a centred 580×580 **crop** of the same export, resized to 256, which
 * cuts the owner's field away and leaves the wordmark almost touching the canvas edge. This
 * produces the whole frame instead: the owner's composition, the wordmark where the owner put it.
 *
 * Standard library only. The derivation is an exact area average — each destination pixel is the
 * mean of the source rectangle it covers, premultiplied by alpha — so it is a function of the
 * bytes and needs neither a floating-point path nor an installed ImageMagick. The source's own
 * colour-space chunks (`gAMA`, `cHRM`, `sRGB`, `iCCP`) travel with the pixels; the owner's export
 * carries none, so the icon declares nothing and a viewer reads it as sRGB.
 *
 *     node scripts/make-icon.mjs <export.png>            # rewrite images/icon.png
 *     node scripts/make-icon.mjs <export.png> --check    # derive in memory; fail when it differs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICON = resolve(root, 'images/icon.png');

/** The listing icon's side in pixels. The Marketplace wants at least 128×128; the export is square. */
const SIZE = 256;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The colour-space chunks, in the order the PNG specification puts them after `IHDR`.
 *
 * They travel with the pixels: an export that declares a gamma or a chromaticity is written back
 * with the same declaration, so "no colour change" is true of how a colour-managed viewer reads
 * the file and not only of the sample values. The owner's export carries none of them, and the
 * icon's predecessor carried ImageMagick's `cHRM`; either way this file's declaration is the
 * source's rather than one this script invents.
 */
const COLOUR_CHUNKS = ['cHRM', 'gAMA', 'iCCP', 'sRGB'];

/** A PNG this script cannot read: only the two colour types ImageMagick writes for this export. */
class PngError extends Error {}

/** An 8-bit RGB or RGBA, non-interlaced PNG as `{ width, height, rgba }`. */
function decodePng(bytes, path) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new PngError(`${path} does not start with the PNG signature`);
  }
  let width = 0;
  let height = 0;
  let bpp = 0;
  const colour = [];
  const parts = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const kind = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
        throw new PngError(
          `${path} is bit depth ${depth}, colour type ${colour}, interlace ${interlace}; ` +
            'only 8-bit RGB and RGBA without interlacing are read',
        );
      }
      bpp = colour === 6 ? 4 : 3;
    } else if (kind === 'IDAT') {
      parts.push(body);
    } else if (COLOUR_CHUNKS.includes(kind)) {
      colour.push({ kind, body: Buffer.from(body) });
    } else if (kind === 'IEND') {
      break;
    }
  }
  if (width === 0 || height === 0) {
    throw new PngError(`${path} carries no IHDR`);
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) {
    throw new PngError(
      `${path}: ${raw.length} inflated bytes where ${(stride + 1) * height} were expected`,
    );
  }
  const flat = Buffer.alloc(stride * height);
  let at = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[at];
    at += 1;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? flat[row * stride + i - bpp] : 0;
      const up = row > 0 ? flat[(row - 1) * stride + i] : 0;
      const corner = row > 0 && i >= bpp ? flat[(row - 1) * stride + i - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toCorner = Math.abs(estimate - corner);
        predictor = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
      } else if (filter !== 0) {
        throw new PngError(`${path}: filter ${filter} on row ${row}`);
      }
      flat[row * stride + i] = (raw[at + i] + predictor) & 0xff;
    }
    at += stride;
  }
  colour.sort((a, b) => COLOUR_CHUNKS.indexOf(a.kind) - COLOUR_CHUNKS.indexOf(b.kind));
  if (bpp === 4) return { width, height, rgba: flat, colour };
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = flat[pixel * bpp];
    rgba[pixel * 4 + 1] = flat[pixel * bpp + 1];
    rgba[pixel * 4 + 2] = flat[pixel * bpp + 2];
    rgba[pixel * 4 + 3] = 0xff;
  }
  return { width, height, rgba, colour };
}

/** The whole frame as a `SIZE`×`SIZE` RGBA raster: each pixel the mean of the box it covers. */
function areaAverage(rgba, width, height) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let dy = 0; dy < SIZE; dy += 1) {
    const top = (dy * height) / SIZE;
    const bottom = ((dy + 1) * height) / SIZE;
    for (let dx = 0; dx < SIZE; dx += 1) {
      const left = (dx * width) / SIZE;
      const right = ((dx + 1) * width) / SIZE;
      const sums = [0, 0, 0, 0];
      let area = 0;
      for (let sy = Math.floor(top); sy < Math.min(Math.ceil(bottom), height); sy += 1) {
        const coverY = Math.min(sy + 1, bottom) - Math.max(sy, top);
        if (coverY <= 0) continue;
        for (let sx = Math.floor(left); sx < Math.min(Math.ceil(right), width); sx += 1) {
          const coverX = Math.min(sx + 1, right) - Math.max(sx, left);
          if (coverX <= 0) continue;
          const cover = coverX * coverY;
          const from = (sy * width + sx) * 4;
          // Premultiplied, so a partly transparent destination pixel is the colour of the ink
          // that covers it rather than a blend of that ink with whatever lies beside it.
          const alpha = rgba[from + 3];
          for (let c = 0; c < 3; c += 1) sums[c] += (rgba[from + c] * alpha * cover) / 255;
          sums[3] += alpha * cover;
          area += cover;
        }
      }
      const meanAlpha = sums[3] / area;
      const to = (dy * SIZE + dx) * 4;
      if (meanAlpha > 0) {
        for (let c = 0; c < 3; c += 1) {
          out[to + c] = Math.max(0, Math.min(255, Math.round((sums[c] / area) * (255 / meanAlpha))));
        }
      }
      out[to + 3] = Math.max(0, Math.min(255, Math.round(meanAlpha)));
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(kind, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])));
  return Buffer.concat([head, Buffer.from(kind, 'latin1'), body, tail]);
}

function paeth(left, up, corner) {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
}

function filterRow(kind, line, above, bpp) {
  const out = Buffer.alloc(line.length);
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= bpp ? line[i - bpp] : 0;
    const up = above[i];
    const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, i >= bpp ? above[i - bpp] : 0)][
      kind
    ];
    out[i] = (line[i] - predictor) & 0xff;
  }
  return out;
}

/**
 * A `SIZE`×`SIZE` 8-bit RGBA PNG of `rgba`, standard library only.
 *
 * The row filter is chosen per line by the sum of the filtered bytes read as signed — the
 * heuristic the format's own documentation suggests — so the mostly flat field compresses well.
 */
function encodePng(rgba, colour) {
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  let at = 0;
  let above = Buffer.alloc(stride);
  for (let y = 0; y < SIZE; y += 1) {
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    let best = null;
    for (const kind of [0, 1, 2, 3, 4]) {
      const filtered = filterRow(kind, line, above, 4);
      let score = 0;
      for (const value of filtered) score += Math.min(value, 256 - value);
      if (best === null || score < best.score) best = { score, kind, filtered };
    }
    raw[at] = best.kind;
    at += 1;
    best.filtered.copy(raw, at);
    at += stride;
    above = line;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', header),
    ...colour.map(({ kind, body }) => chunk(kind, body)),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sourcePath(argv) {
  const named = argv.find((one) => one !== '--check') ?? process.env.SELVAGE_ICON_EXPORT;
  if (!named) {
    throw new PngError(
      'no export given. Pass the path to the owner\'s opaque 800×800 PNG, which this repository ' +
        'does not vendor:\n' +
        '  ~/pictures/profile_pictures/profile_picture_svp_800_800.png (sha256 9bf1980d…), or the ' +
        'byte-identical copy the sibling `site` checkout vendors as app/opengraph-image.png',
    );
  }
  return resolve(named);
}

function main(argv) {
  const unknown = argv.filter((one) => one !== '--check' && one.startsWith('-'));
  if (unknown.length > 0) {
    console.error(`usage: ${process.argv[1]} <export.png> [--check]`);
    return 2;
  }
  const path = sourcePath(argv);
  const source = readFileSync(path);
  const { width, height, rgba, colour } = decodePng(source, path);
  if (width !== height) {
    console.error(`make-icon: ${path} is ${width}×${height}; the export is square, and averaging a field that is not would distort it`);
    return 2;
  }
  const raster = areaAverage(rgba, width, height);
  const derived = encodePng(raster, colour);
  const digest = createHash('sha256').update(source).digest('hex');
  if (argv.includes('--check')) {
    const committed = decodePng(readFileSync(ICON), ICON);
    if (committed.width !== SIZE || committed.height !== SIZE) {
      console.error(`make-icon: ${ICON} is ${committed.width}×${committed.height}, not ${SIZE}×${SIZE}`);
      return 1;
    }
    const differing = [];
    for (let i = 0; i < raster.length; i += 1) {
      if (raster[i] !== committed.rgba[i]) differing.push(i);
    }
    if (differing.length > 0) {
      const worst = differing.reduce((a, b) =>
        Math.abs(raster[a] - committed.rgba[a]) >= Math.abs(raster[b] - committed.rgba[b]) ? a : b,
      );
      console.error(
        `make-icon: ${ICON} is not the whole ${width}×${height} export averaged to ${SIZE}×${SIZE}: ` +
          `${differing.length} of ${raster.length} channels differ`,
      );
      console.error(
        `make-icon: worst at pixel ${Math.floor(worst / 4) % SIZE},${Math.floor(worst / 4 / SIZE)} ` +
          `channel ${worst % 4}: committed ${committed.rgba[worst]}, derived ${raster[worst]}`,
      );
      return 1;
    }
    // The pixels are the claim, but a colour-managed viewer reads the declaration beside them, so
    // it has to be the derivation's too.
    const declared = (list) =>
      list.map(({ kind, body }) => `${kind}:${body.toString('base64')}`).join(' ');
    if (declared(committed.colour) !== declared(colour)) {
      console.error(
        `make-icon: ${ICON} declares [${declared(committed.colour)}] where the export's ` +
          `derivation declares [${declared(colour)}]`,
      );
      return 1;
    }
    console.log(
      `make-icon: ${ICON} is the whole ${width}×${height} export (sha256 ${digest}) averaged to ` +
        `${SIZE}×${SIZE}: ${raster.length} channels match`,
    );
    return 0;
  }
  writeFileSync(ICON, derived);
  console.log(
    `make-icon: wrote ${ICON} from the ${width}×${height} export (sha256 ${digest}): ` +
      `${SIZE}×${SIZE}, no colour change, ${derived.length} bytes`,
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`make-icon: ${error.message}`);
  process.exitCode = 2;
}
