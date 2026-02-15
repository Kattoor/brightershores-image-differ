import fs from "fs";
import crypto from "crypto";
import { decompress } from "@mongodb-js/zstd";
import { Image } from "image-js";
import Bcdec from "./wasm/bcdec.js";

// ---------------- CLI ----------------
const OLD_PATH = process.argv[2];
const NEW_PATH = process.argv[3];
if (!OLD_PATH || !NEW_PATH) {
    console.error('Usage: node app.mjs "C:\\path\\to\\old\\assetBundle3" "C:\\path\\to\\new\\assetBundle3"');
    process.exit(1);
}

// ---------------- output ----------------
const OUT_DIR = "./out";
const OUT_DECOMP = `${OUT_DIR}/decompressed-new`;
const OUT_COMP = `${OUT_DIR}/compressed-new`;
const OUT_IMG = `${OUT_DIR}/images`;
fs.mkdirSync(OUT_DECOMP, { recursive: true });
fs.mkdirSync(OUT_COMP, { recursive: true });
fs.mkdirSync(OUT_IMG, { recursive: true });

// ---------------- scan params ----------------
const ZSTD_MAGIC = 0x28b52ffd;
const LOG_EVERY = 500;
const MAX_SLICE_BYTES = 128 * 1024 * 1024;

// ---------------- helpers ----------------
function sha256(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function* findMagicOffsets(buffer) {
    for (let i = 0; i <= buffer.length - 4; i++) {
        if (buffer.readUInt32BE(i) === ZSTD_MAGIC) yield i;
    }
}

function findNextMagic(buffer, start) {
    for (let i = start; i <= buffer.length - 4; i++) {
        if (buffer.readUInt32BE(i) === ZSTD_MAGIC) return i;
    }
    return null;
}

// Your proven boundary heuristic
function sliceOldMethod(buffer, offset) {
    const next = findNextMagic(buffer, offset + 4);
    const rawLen = next ? next - offset : buffer.length - offset;
    const len = Math.min(rawLen, MAX_SLICE_BYTES);
    if (len < 16) return null;
    return buffer.subarray(offset, offset + len);
}

async function tryDecompress(frameBytes) {
    try {
        return await decompress(frameBytes); // Buffer
    } catch {
        return null;
    }
}

// ---------------- bcdec init ----------------
const bcdec = await Bcdec();
const bcdec_bc1 = bcdec.cwrap("bcdec_bc1", null, ["number", "number", "number", "number", "number"]);
const bcdec_bc3 = bcdec.cwrap("bcdec_bc3", null, ["number", "number", "number", "number", "number"]);
const bcdec_bc4 = bcdec.cwrap("bcdec_bc4", null, ["number", "number", "number", "number", "number"]);
const bcdec_bc5 = bcdec.cwrap("bcdec_bc5", null, ["number", "number", "number", "number", "number"]);
const bcdec_r8 = bcdec.cwrap("bcdec_r8", null, ["number", "number", "number", "number", "number"]);

class Format {
    constructor(func, blockSize, pixelsPerBlock) {
        this.func = func;
        this.blockSize = blockSize;
        this.pixelsPerBlock = pixelsPerBlock;
        this.blockDimensions = Math.floor(Math.sqrt(pixelsPerBlock));
    }
}
const formats = {
    BC1: new Format(bcdec_bc1, 8, 16),
    BC3: new Format(bcdec_bc3, 16, 16),
    BC4: new Format(bcdec_bc4, 8, 16),
    BC5: new Format(bcdec_bc5, 16, 16),
    R8: new Format(bcdec_r8, 1, 1),
};

// --- same heuristic you already use ---
function getAverageBlockColor(data) {
    const combine = (high, low) => Math.floor(low + (high - low) / 3);
    const r1 = data[1] & 0b11111000;
    const g1 = ((data[1] & 0b00000111) << 5) + ((data[0] & 0b11100000) >> 3);
    const b1 = (data[0] & 0b00011111) << 3;
    const r2 = data[3] & 0b11111000;
    const g2 = ((data[3] & 0b00000111) << 5) + ((data[2] & 0b11100000) >> 3);
    const b2 = (data[2] & 0b00011111) << 3;
    return [combine(r1, r2), combine(g1, g2), combine(b1, b2)];
}
function guessColorUpper(data) {
    const blocks = Math.floor(data.length / 4);
    if (!blocks) return 0;
    let good = 0;
    let prev = [0, 0, 0];
    let greenCount = 0;
    for (let p = 0; p < data.length; p += 4) {
        const c = getAverageBlockColor(data.slice(p, p + 4));
        let dist = (c[0] - prev[0]) ** 2 + (c[1] - prev[1]) ** 2 + (c[2] - prev[2]) ** 2;
        if (c[0] === 0 && c[1] === 160 && c[2] === 0) {
            greenCount++;
            dist = 1_000_000;
        }
        if (dist < 1000) good++;
        prev = c;
    }
    if (greenCount > 10) return -1;
    return good / blocks;
}
const guessColorLower = (d) => 1 - guessColorUpper(d);

function guessSmoothUpper(data) {
    const blocks = Math.floor(data.length / 2);
    if (!blocks) return 0;
    let green = 0;
    for (let p = 0; p < data.length; p += 2) if (data[p] === 0 && data[p + 1] === 5) green++;
    return green / blocks;
}
function guessSmoothLower(data) {
    if (!data.length) return 0;
    let solid = 0;
    for (let p = 0; p < data.length; p++) if (data[p] === 0 || data[p] === 0xff) solid++;
    return solid / data.length;
}

function guessFiletype(u8) {
    const size = u8.length;
    const possible = { BC1: true, BC3: true, BC4: true, BC5: true, R8: true };
    const score = { BC1: 0, BC3: 0, BC4: 0, BC5: 0, R8: 0 };

    if (size % 16 !== 0) {
        possible.BC3 = false;
        possible.BC5 = false;
    }
    if (size % 8 !== 0) {
        possible.BC1 = false;
        possible.BC4 = false;
    }

    score.R8 = guessSmoothLower(u8.slice(0, Math.min(size, 4096)));

    if (possible.BC1) {
        score.BC1 += guessColorUpper(u8.slice(0, Math.floor(size / 2)));
        score.BC1 += guessColorLower(u8.slice(Math.floor(size / 2)));
    }
    if (possible.BC3) {
        const sub = Math.floor(size / 8);
        score.BC3 += guessSmoothUpper(u8.slice(0, sub));
        score.BC3 += guessColorUpper(u8.slice(sub, sub * 2));
        score.BC3 += guessSmoothLower(u8.slice(sub * 3, sub * 6));
        score.BC3 += guessColorLower(u8.slice(sub * 6, sub * 8));
        score.BC3 /= 2;
    }
    if (possible.BC4) {
        score.BC4 += guessSmoothUpper(u8.slice(0, Math.floor(size / 2)));
        score.BC4 += guessSmoothLower(u8.slice(Math.floor(size / 2)));
    }

    for (const k of Object.keys(possible)) if (!possible[k]) delete score[k];
    return Object.keys(score).reduce((a, b) => (score[a] > score[b] ? a : b));
}

// Better dims: choose factor pair closest to square
function bestBlockDims(blockCount) {
    let best = null;
    let bestAspect = Infinity;
    for (let h = 1; h * h <= blockCount; h++) {
        if (blockCount % h !== 0) continue;
        const w = blockCount / h;
        const width = w * 4;
        const height = h * 4;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) continue;
        const aspect = Math.max(width, height) / Math.min(width, height);
        if (aspect < bestAspect) {
            bestAspect = aspect;
            best = [w, h];
        }
    }
    return best ?? [blockCount, 1];
}

class DxtProperties {
    static RGBA_SIZE = 4;
    constructor(data, format) {
        this.format = format;
        this.dataSize = data.length;
        this.blockCount = Math.floor(data.length / format.blockSize);
        this.pixelCount = this.blockCount * format.pixelsPerBlock;
        this.bufferSize = this.pixelCount * DxtProperties.RGBA_SIZE;

        // IMPORTANT: pick near-square factorization (not first factor)
        const [bw, bh] = bestBlockDims(this.blockCount);
        this.blocksWidth = bw;
        this.blocksHeight = bh;
        this.width = bw * format.blockDimensions;
        this.height = bh * format.blockDimensions;
    }
}

function blockDimCandidates(blockCount, maxCandidates = 40) {
    const pairs = [];
    for (let h = 1; h * h <= blockCount; h++) {
        if (blockCount % h !== 0) continue;
        const w = blockCount / h;

        const width = w * 4;
        const height = h * 4;

        if (width <= 0 || height <= 0) continue;
        if (width > 16384 || height > 16384) continue;

        const aspect = Math.max(width, height) / Math.min(width, height);
        if (aspect > 16) continue; // kill super-skinny shapes early

        pairs.push({ wBlocks: w, hBlocks: h, width, height, aspect });
        if (w !== h) {
            pairs.push({ wBlocks: h, hBlocks: w, width: h * 4, height: w * 4, aspect });
        }
    }

    // sort: prefer near-square, then larger images
    pairs.sort((a, b) => (a.aspect - b.aspect) || ((b.width * b.height) - (a.width * a.height)));

    return pairs.slice(0, maxCandidates);
}


function scoreRgba(rgba, width, height) {
    // Sample a grid (fast) instead of all pixels
    const stepX = Math.max(1, Math.floor(width / 128));
    const stepY = Math.max(1, Math.floor(height / 128));

    let count = 0;
    let smoothness = 0;
    let extremes = 0;

    for (let y = 0; y < height - stepY; y += stepY) {
        for (let x = 0; x < width - stepX; x += stepX) {
            const i = (y * width + x) * 4;
            const j = ((y + stepY) * width + (x + stepX)) * 4;

            const dr = rgba[i] - rgba[j];
            const dg = rgba[i + 1] - rgba[j + 1];
            const db = rgba[i + 2] - rgba[j + 2];

            const d = dr * dr + dg * dg + db * db;
            // “smoothness”: lower distance is better
            smoothness += d;

            // penalize too many 0/255 values (often garbage patterns)
            if (rgba[i] === 0 || rgba[i] === 255) extremes++;
            if (rgba[i + 1] === 0 || rgba[i + 1] === 255) extremes++;
            if (rgba[i + 2] === 0 || rgba[i + 2] === 255) extremes++;

            count++;
        }
    }

    if (!count) return -Infinity;

    const avgD = smoothness / count;
    const extremeRate = extremes / (count * 3);

    // Convert to a “higher is better” score
    // avgD grows with noise; extremeRate grows with garbage.
    let score = 0;
    score += 1_000_000 / (1 + avgD);       // reward lower noise
    score -= extremeRate * 2000;           // penalize extremes
    return score;
}




async function decodeToPng(raw, outPngPath) {
    const u8 = new Uint8Array(raw);

    // Try formats in this order (most common first)
    const formatOrder = ["BC3", "BC1", "BC5", "BC4", "R8"];

    let best = null;

    for (const fmt of formatOrder) {
        const format = formats[fmt];
        if (!format) continue;

        // quick reject: size must align to block size (except R8)
        if (fmt !== "R8" && (u8.length % format.blockSize !== 0)) continue;

        // Build dimension candidates
        let candidates = [];
        if (fmt === "R8") {
            // R8 is 1 byte per pixel. Try “square-ish” factor pairs directly.
            // (skip ultra-wide)
            const n = u8.length;
            for (let h = 1; h * h <= n; h++) {
                if (n % h !== 0) continue;
                const w = n / h;
                const aspect = Math.max(w, h) / Math.min(w, h);
                if (aspect > 16) continue;
                candidates.push({ width: w, height: h, wBlocks: w, hBlocks: h });
                candidates.push({ width: h, height: w, wBlocks: h, hBlocks: w });
            }
            candidates.sort((a, b) => (Math.max(a.width, a.height) / Math.min(a.width, a.height)) -
                (Math.max(b.width, b.height) / Math.min(b.width, b.height)));
            candidates = candidates.slice(0, 40);
        } else {
            const blockCount = u8.length / format.blockSize;
            candidates = blockDimCandidates(blockCount, 40).map(c => ({
                ...c,
                wBlocks: c.wBlocks,
                hBlocks: c.hBlocks
            }));
        }

        // Try candidates, score, keep best
        for (const c of candidates) {
            const width = c.width ?? (c.wBlocks * format.blockDimensions);
            const height = c.height ?? (c.hBlocks * format.blockDimensions);

            const blockCount = (fmt === "R8")
                ? (width * height) // pixels
                : (c.wBlocks * c.hBlocks);

            const pixelCount = (fmt === "R8")
                ? (width * height)
                : (blockCount * format.pixelsPerBlock);

            const bufferSize = pixelCount * 4;
            if (bufferSize <= 0 || bufferSize > 512 * 1024 * 1024) continue;

            const inPtr = bcdec._malloc(u8.length);
            const outPtr = bcdec._malloc(bufferSize);

            try {
                bcdec.HEAPU8.set(u8, inPtr);
                format.func(inPtr, outPtr, c.wBlocks, c.hBlocks, u8.length);

                const rgba = new Uint8Array(bcdec.HEAPU8.subarray(outPtr, outPtr + bufferSize));
                const s = scoreRgba(rgba, width, height);

                if (!best || s > best.score) {
                    best = { fmt, width, height, rgba: Buffer.from(rgba), score: s };
                }
            } catch {
                // ignore candidate
            } finally {
                bcdec._free(inPtr);
                bcdec._free(outPtr);
            }
        }
    }

    if (!best) throw new Error("No valid decode candidates");

    // optional: reject “obviously bad” decodes
    if (best.score < 5) {
        throw new Error(`Decode looks bad (score=${best.score.toFixed(2)}) fmt=${best.fmt} ${best.width}x${best.height}`);
    }

    const img = new Image({
        width: best.width,
        height: best.height,
        data: best.rgba,
        kind: "RGBA",
    });

    await img.save(outPngPath);
}


// ---------------- diff core ----------------
async function buildOldDecompSet(oldBuf) {
    const set = new Set();
    let scanned = 0, ok = 0, skipped = 0;

    console.log("Building OLD decompressed hash set (old boundaries)...");
    for (const offset of findMagicOffsets(oldBuf)) {
        scanned++;
        const frame = sliceOldMethod(oldBuf, offset);
        if (!frame) { skipped++; continue; }

        const out = await tryDecompress(frame);
        if (!out) { skipped++; continue; }

        set.add(sha256(out));
        ok++;

        if (scanned % LOG_EVERY === 0) {
            console.log(`[OLD] scanned=${scanned} ok=${ok} skipped=${skipped} unique=${set.size}`);
        }
    }
    console.log(`[OLD DONE] scanned=${scanned} ok=${ok} skipped=${skipped} unique=${set.size}`);
    return set;
}

async function diffNewOnly(oldBuf, newBuf) {
    const oldSet = await buildOldDecompSet(oldBuf);

    let scanned = 0, ok = 0, skipped = 0, newOnly = 0, converted = 0, convFail = 0;

    console.log("Scanning NEW bundle (old boundaries)...");
    for (const offset of findMagicOffsets(newBuf)) {
        scanned++;

        const frame = sliceOldMethod(newBuf, offset);
        if (!frame) { skipped++; continue; }

        const out = await tryDecompress(frame);
        if (!out) { skipped++; continue; }

        ok++;
        const h = sha256(out);
        if (oldSet.has(h)) {
            if (scanned % LOG_EVERY === 0) {
                console.log(`[NEW] scanned=${scanned} ok=${ok} skipped=${skipped} newOnly=${newOnly} converted=${converted} convFail=${convFail}`);
            }
            continue;
        }

        const idx = newOnly++;
        fs.writeFileSync(`${OUT_DECOMP}/${idx}.bin`, out);
        fs.writeFileSync(`${OUT_COMP}/${idx}.bin`, frame);

        try {
            await decodeToPng(out, `${OUT_IMG}/${idx}.png`);
            converted++;
        } catch (e) {
            convFail++;
            fs.writeFileSync(`${OUT_DECOMP}/${idx}.decode_fail.txt`, String(e?.message ?? e));
        }

        if (scanned % LOG_EVERY === 0) {
            console.log(`[NEW] scanned=${scanned} ok=${ok} skipped=${skipped} newOnly=${newOnly} converted=${converted} convFail=${convFail}`);
        }
    }

    console.log(`[DONE] scanned=${scanned} ok=${ok} skipped=${skipped} newOnly=${newOnly} converted=${converted} convFail=${convFail}`);
}

// ---------------- run ----------------
async function main() {
    const oldBuf = fs.readFileSync(OLD_PATH);
    const newBuf = fs.readFileSync(NEW_PATH);

    console.log(`OLD sha256: ${sha256(oldBuf)}`);
    console.log(`NEW sha256: ${sha256(newBuf)}`);

    await diffNewOnly(oldBuf, newBuf);
}

main().catch((e) => {
    console.error("Fatal:", e);
    process.exitCode = 1;
});
