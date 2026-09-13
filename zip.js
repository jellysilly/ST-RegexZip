/**
 * Minimal dependency-free ZIP reader/writer for the Regex ZIP extension.
 *
 * Reading uses DecompressionStream('deflate-raw') when available and falls back
 * to a built-in raw-inflate implementation, so it also works on older WebViews.
 * Writing uses CompressionStream('deflate-raw') and falls back to STORE.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// #region CRC32

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

/**
 * Computes the CRC-32 checksum of a byte array.
 * @param {Uint8Array} bytes Input bytes
 * @returns {number} Unsigned CRC-32
 */
export function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// #endregion

// #region Inflate fallback (RFC 1951, "puff"-style canonical Huffman decoding)

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class BitReader {
    constructor(data) {
        this.data = data;
        this.pos = 0;
        this.bitBuffer = 0;
        this.bitCount = 0;
    }

    bits(need) {
        let value = this.bitBuffer;
        while (this.bitCount < need) {
            if (this.pos >= this.data.length) {
                throw new Error('Unexpected end of deflate stream');
            }
            value |= this.data[this.pos++] << this.bitCount;
            this.bitCount += 8;
        }
        this.bitBuffer = value >>> need;
        this.bitCount -= need;
        return value & ((1 << need) - 1);
    }

    align() {
        this.bitBuffer = 0;
        this.bitCount = 0;
    }
}

function buildHuffman(lengths, count) {
    const counts = new Int32Array(16);
    for (let i = 0; i < count; i++) {
        counts[lengths[i]]++;
    }
    counts[0] = 0;
    const offsets = new Int32Array(16);
    for (let i = 1; i < 16; i++) {
        offsets[i] = offsets[i - 1] + counts[i - 1];
    }
    const symbols = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        if (lengths[i]) {
            symbols[offsets[lengths[i]]++] = i;
        }
    }
    return { counts, symbols };
}

function decodeSymbol(reader, tree) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
        code |= reader.bits(1);
        const count = tree.counts[len];
        if (code - first < count) {
            return tree.symbols[index + (code - first)];
        }
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    throw new Error('Invalid Huffman code in deflate stream');
}

let fixedLitTree = null;
let fixedDistTree = null;

function getFixedTrees() {
    if (!fixedLitTree) {
        const litLengths = new Uint8Array(288);
        litLengths.fill(8, 0, 144);
        litLengths.fill(9, 144, 256);
        litLengths.fill(7, 256, 280);
        litLengths.fill(8, 280, 288);
        fixedLitTree = buildHuffman(litLengths, 288);
        const distLengths = new Uint8Array(30).fill(5);
        fixedDistTree = buildHuffman(distLengths, 30);
    }
    return [fixedLitTree, fixedDistTree];
}

/**
 * Pure-JS raw DEFLATE decompressor, used when DecompressionStream is missing.
 * @param {Uint8Array} input Compressed bytes
 * @param {number} expectedSize Known uncompressed size (used to preallocate)
 * @returns {Uint8Array} Decompressed bytes
 */
export function inflateRaw(input, expectedSize = 0) {
    const reader = new BitReader(input);
    let out = new Uint8Array(Math.max(expectedSize || 0, 1024));
    let outLength = 0;

    const ensure = (extra) => {
        if (outLength + extra <= out.length) {
            return;
        }
        let size = out.length || 1024;
        while (size < outLength + extra) {
            size *= 2;
        }
        const next = new Uint8Array(size);
        next.set(out.subarray(0, outLength));
        out = next;
    };

    let final = 0;
    do {
        final = reader.bits(1);
        const type = reader.bits(2);

        if (type === 0) {
            reader.align();
            if (reader.pos + 4 > input.length) {
                throw new Error('Unexpected end of stored block');
            }
            const len = input[reader.pos] | (input[reader.pos + 1] << 8);
            reader.pos += 4;
            ensure(len);
            out.set(input.subarray(reader.pos, reader.pos + len), outLength);
            outLength += len;
            reader.pos += len;
            continue;
        }

        let litTree;
        let distTree;

        if (type === 1) {
            [litTree, distTree] = getFixedTrees();
        } else if (type === 2) {
            const hlit = reader.bits(5) + 257;
            const hdist = reader.bits(5) + 1;
            const hclen = reader.bits(4) + 4;
            const clenLengths = new Uint8Array(19);
            for (let i = 0; i < hclen; i++) {
                clenLengths[CLEN_ORDER[i]] = reader.bits(3);
            }
            const clenTree = buildHuffman(clenLengths, 19);
            const lengths = new Uint8Array(hlit + hdist);
            let i = 0;
            while (i < lengths.length) {
                const symbol = decodeSymbol(reader, clenTree);
                if (symbol < 16) {
                    lengths[i++] = symbol;
                } else if (symbol === 16) {
                    const prev = lengths[i - 1];
                    let repeat = 3 + reader.bits(2);
                    while (repeat-- > 0) lengths[i++] = prev;
                } else if (symbol === 17) {
                    let repeat = 3 + reader.bits(3);
                    while (repeat-- > 0) lengths[i++] = 0;
                } else {
                    let repeat = 11 + reader.bits(7);
                    while (repeat-- > 0) lengths[i++] = 0;
                }
            }
            litTree = buildHuffman(lengths.subarray(0, hlit), hlit);
            distTree = buildHuffman(lengths.subarray(hlit), hdist);
        } else {
            throw new Error('Invalid deflate block type');
        }

        for (;;) {
            const symbol = decodeSymbol(reader, litTree);
            if (symbol < 256) {
                ensure(1);
                out[outLength++] = symbol;
                continue;
            }
            if (symbol === 256) {
                break;
            }
            const lengthIndex = symbol - 257;
            if (lengthIndex >= LENGTH_BASE.length) {
                throw new Error('Invalid length symbol in deflate stream');
            }
            const length = LENGTH_BASE[lengthIndex] + reader.bits(LENGTH_EXTRA[lengthIndex]);
            const distIndex = decodeSymbol(reader, distTree);
            const distance = DIST_BASE[distIndex] + reader.bits(DIST_EXTRA[distIndex]);
            if (distance > outLength) {
                throw new Error('Invalid distance in deflate stream');
            }
            ensure(length);
            let from = outLength - distance;
            for (let i = 0; i < length; i++) {
                out[outLength++] = out[from++];
            }
        }
    } while (!final);

    return out.subarray(0, outLength);
}

// #endregion

async function streamThrough(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

async function decompressRaw(bytes, expectedSize) {
    if (typeof DecompressionStream !== 'undefined') {
        try {
            return await streamThrough(bytes, new DecompressionStream('deflate-raw'));
        } catch (error) {
            console.warn('[Regex ZIP] DecompressionStream failed, falling back to JS inflate', error);
        }
    }
    return inflateRaw(bytes, expectedSize);
}

async function compressRaw(bytes) {
    if (typeof CompressionStream === 'undefined') {
        return null;
    }
    try {
        return await streamThrough(bytes, new CompressionStream('deflate-raw'));
    } catch (error) {
        console.warn('[Regex ZIP] CompressionStream failed, storing uncompressed', error);
        return null;
    }
}

function decodeName(bytes, isUtf8) {
    try {
        return new TextDecoder(isUtf8 ? 'utf-8' : 'utf-8', { fatal: false }).decode(bytes);
    } catch {
        return String.fromCharCode(...bytes);
    }
}

function findEocd(view, length) {
    const maxScan = Math.min(length, 0xFFFF + 22);
    for (let i = length - 22; i >= length - maxScan && i >= 0; i--) {
        if (view.getUint32(i, true) === SIG_EOCD) {
            return i;
        }
    }
    return -1;
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name Full path of the entry inside the archive
 * @property {Uint8Array} data Uncompressed content
 */

/**
 * Reads all file entries of a ZIP archive.
 * @param {ArrayBuffer|Uint8Array} source Archive bytes
 * @returns {Promise<ZipEntry[]>} Extracted entries (directories are skipped)
 */
export async function readZip(source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const eocd = findEocd(view, bytes.byteLength);
    if (eocd < 0) {
        throw new Error('Not a ZIP archive (end of central directory not found)');
    }

    let entryCount = view.getUint16(eocd + 10, true);
    let centralOffset = view.getUint32(eocd + 16, true);

    // ZIP64 handling
    if (entryCount === 0xFFFF || centralOffset === 0xFFFFFFFF) {
        const locator = eocd - 20;
        if (locator >= 0 && view.getUint32(locator, true) === SIG_EOCD64_LOC) {
            const eocd64 = Number(view.getBigUint64(locator + 8, true));
            if (view.getUint32(eocd64, true) === SIG_EOCD64) {
                entryCount = Number(view.getBigUint64(eocd64 + 32, true));
                centralOffset = Number(view.getBigUint64(eocd64 + 48, true));
            }
        }
    }

    const entries = [];
    let pointer = centralOffset;

    for (let i = 0; i < entryCount; i++) {
        if (pointer + 46 > bytes.byteLength || view.getUint32(pointer, true) !== SIG_CENTRAL) {
            break;
        }

        const flags = view.getUint16(pointer + 8, true);
        const method = view.getUint16(pointer + 10, true);
        let compressedSize = view.getUint32(pointer + 20, true);
        let uncompressedSize = view.getUint32(pointer + 24, true);
        const nameLength = view.getUint16(pointer + 28, true);
        const extraLength = view.getUint16(pointer + 30, true);
        const commentLength = view.getUint16(pointer + 32, true);
        let localOffset = view.getUint32(pointer + 42, true);
        const name = decodeName(bytes.subarray(pointer + 46, pointer + 46 + nameLength), !!(flags & 0x0800));

        // ZIP64 extended information extra field
        if (uncompressedSize === 0xFFFFFFFF || compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
            let extraPointer = pointer + 46 + nameLength;
            const extraEnd = extraPointer + extraLength;
            while (extraPointer + 4 <= extraEnd) {
                const headerId = view.getUint16(extraPointer, true);
                const dataSize = view.getUint16(extraPointer + 2, true);
                if (headerId === 0x0001) {
                    let field = extraPointer + 4;
                    if (uncompressedSize === 0xFFFFFFFF) { uncompressedSize = Number(view.getBigUint64(field, true)); field += 8; }
                    if (compressedSize === 0xFFFFFFFF) { compressedSize = Number(view.getBigUint64(field, true)); field += 8; }
                    if (localOffset === 0xFFFFFFFF) { localOffset = Number(view.getBigUint64(field, true)); }
                    break;
                }
                extraPointer += 4 + dataSize;
            }
        }

        pointer += 46 + nameLength + extraLength + commentLength;

        const isDirectory = name.endsWith('/') || name.endsWith('\\');
        if (isDirectory || uncompressedSize === 0 && compressedSize === 0) {
            continue;
        }

        if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
            console.warn(`[Regex ZIP] Bad local header for "${name}", skipping`);
            continue;
        }

        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = bytes.subarray(dataStart, dataStart + compressedSize);

        let data;
        if (method === 0) {
            data = raw.slice();
        } else if (method === 8) {
            data = await decompressRaw(raw, uncompressedSize);
        } else {
            console.warn(`[Regex ZIP] Unsupported compression method ${method} for "${name}", skipping`);
            continue;
        }

        entries.push({ name, data });
    }

    return entries;
}

function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() / 2) & 0x1F);
    const day = (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
    return { time, day };
}

/**
 * Builds a ZIP archive from a list of files.
 * @param {{name: string, data: Uint8Array|string}[]} files Files to pack
 * @param {object} [options] Options
 * @param {boolean} [options.compress] Whether to deflate the contents
 * @returns {Promise<Blob>} The archive
 */
export async function createZip(files, { compress = true } = {}) {
    const encoder = new TextEncoder();
    const { time, day } = toDosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
        const checksum = crc32(data);

        let method = 0;
        let body = data;
        if (compress && data.length > 0) {
            const deflated = await compressRaw(data);
            if (deflated && deflated.length < data.length) {
                method = 8;
                body = deflated;
            }
        }

        const local = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, SIG_LOCAL, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint16(8, method, true);
        localView.setUint16(10, time, true);
        localView.setUint16(12, day, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, body.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, nameBytes.length, true);
        localView.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        parts.push(local, body);

        const entry = new Uint8Array(46 + nameBytes.length);
        const entryView = new DataView(entry.buffer);
        entryView.setUint32(0, SIG_CENTRAL, true);
        entryView.setUint16(4, 20, true);
        entryView.setUint16(6, 20, true);
        entryView.setUint16(8, 0x0800, true);
        entryView.setUint16(10, method, true);
        entryView.setUint16(12, time, true);
        entryView.setUint16(14, day, true);
        entryView.setUint32(16, checksum, true);
        entryView.setUint32(20, body.length, true);
        entryView.setUint32(24, data.length, true);
        entryView.setUint16(28, nameBytes.length, true);
        entryView.setUint32(38, 0o100644 << 16, true);
        entryView.setUint32(42, offset, true);
        entry.set(nameBytes, 46);
        central.push(entry);

        offset += local.length + body.length;
    }

    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, SIG_EOCD, true);
    eocdView.setUint16(8, files.length, true);
    eocdView.setUint16(10, files.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);

    return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}
