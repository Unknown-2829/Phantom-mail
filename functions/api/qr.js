/**
 * QR Code Generation API
 * Generates the QR code LOCALLY inside the Worker (no third-party fetch) and
 * returns it as an SVG data-URI. Nothing about the address ever leaves this
 * origin — the previous implementation proxied every address to
 * api.qrserver.com, which contradicts the product's privacy positioning.
 *
 * The encoder below is a compact, self-contained QR Model 2 (byte mode)
 * generator derived from the public-domain "qrcode-generator" algorithm by
 * Kazuhiko Arase (MIT). It supports versions 1–10 with error-correction
 * level M, which is far more than enough for an email address.
 */

const QR_DAILY_LIMIT = 30;

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const email = url.searchParams.get('email');

    if (!email) {
        return jsonResponse({ error: 'Missing email parameter' }, 400);
    }
    if (email.length > 512) {
        return jsonResponse({ error: 'email too long for QR encoding' }, 400);
    }

    // IP-based rate limiting: 30 requests per IP per day
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rateLimitKey = `ratelimit:qr:${ip}:${date}`;

    const tempKV = env.TEMP_EMAILS || env.INBOX_META || env.EMAILS;
    if (tempKV) {
        const countStr = await tempKV.get(rateLimitKey);
        const count = countStr ? parseInt(countStr, 10) : 0;

        if (count >= QR_DAILY_LIMIT) {
            return jsonResponse({ error: 'Rate limit exceeded. Max 30 QR requests per day.' }, 429);
        }

        await tempKV.put(rateLimitKey, String(count + 1), { expirationTtl: 86400 });
    }

    try {
        const svg = generateQrSvg(email, 200);
        // base64 SVG data-URI (utf-8 → base64) so it drops into an <img src> just
        // like the previous api.qrserver.com PNG response did.
        const base64 = btoa(unescape(encodeURIComponent(svg)));
        return jsonResponse(
            { qr: `data:image/svg+xml;base64,${base64}`, email },
            200,
            { 'Cache-Control': 'public, max-age=3600' }
        );
    } catch (error) {
        return jsonResponse({ error: 'QR generation failed: ' + error.message }, 500);
    }
}

function jsonResponse(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extra
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Local QR encoder (byte mode, EC level M, versions 1–10). Self-contained,
// no dependencies, no network. Public-domain QR Model 2 algorithm.
// ─────────────────────────────────────────────────────────────────────────────

// Galois-field (GF(256)) log/exp tables for Reed–Solomon error correction.
const GF_EXP = new Uint8Array(256);
const GF_LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d; // primitive polynomial
    }
    GF_EXP[255] = GF_EXP[0];
})();

function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

// Reed–Solomon generator polynomial for `degree` EC codewords.
// Returns `degree + 1` coefficients, highest-order term first, leading coeff 1.
function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        // Multiply current poly by (x - α^i) === (x ^ α^i) in GF(256).
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
            next[j]     ^= poly[j];                       // x term
            next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);     // α^i term
        }
        poly = next;
    }
    return poly;
}

// Polynomial long division: returns the `ecLen` remainder codewords.
function rsEncode(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen); // length ecLen + 1, gen[0] === 1
    // Work buffer = data followed by ecLen zero placeholders.
    const buf = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
        const coef = buf[i];
        if (coef !== 0) {
            // Subtract coef * gen (shifted to position i). gen[0] is 1, so buf[i]
            // is zeroed; the remaining ecLen terms fold into the tail.
            for (let j = 1; j <= ecLen; j++) {
                buf[i + j] ^= gfMul(gen[j], coef);
            }
        }
    }
    return buf.slice(data.length); // the last ecLen bytes are the remainder
}

// Per-version capacity/structure for EC level M (the level we always use).
// [ totalDataCodewords, ecPerBlock, numBlocksGroup1, dataPerBlockGroup1,
//   numBlocksGroup2, dataPerBlockGroup2 ]
const EC_M = {
    1:  [16,  10, 1, 16, 0, 0],
    2:  [28,  16, 1, 28, 0, 0],
    3:  [44,  26, 1, 44, 0, 0],
    4:  [64,  18, 2, 32, 0, 0],
    5:  [86,  24, 2, 43, 0, 0],
    6:  [108, 16, 4, 27, 0, 0],
    7:  [124, 18, 4, 31, 0, 0],
    8:  [154, 22, 2, 38, 2, 39],
    9:  [182, 22, 3, 36, 2, 37],
    10: [216, 26, 4, 43, 1, 44]
};

// Alignment-pattern centre coordinates per version.
const ALIGN_POS = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

function chooseVersion(dataLen) {
    for (let v = 1; v <= 10; v++) {
        // byte mode: 4 bits mode + 8 or 16 bits length + 8 bits per char
        const lenBits = v < 10 ? 8 : 16;
        const capacityBits = EC_M[v][0] * 8;
        const neededBits = 4 + lenBits + dataLen * 8;
        if (neededBits <= capacityBits) return v;
    }
    throw new Error('data too large for QR versions 1–10');
}

function generateQrSvg(text, pxSize) {
    const bytes = new TextEncoder().encode(text);
    const version = chooseVersion(bytes.length);
    const size = 17 + version * 4;
    const [totalData, ecLen, g1Blocks, g1Data, g2Blocks, g2Data] = EC_M[version];

    // ── 1. Build the data bit stream (byte mode) ─────────────────────────────
    const bits = [];
    const pushBits = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    pushBits(0b0100, 4);                       // byte mode indicator
    pushBits(bytes.length, version < 10 ? 8 : 16); // char count
    for (const b of bytes) pushBits(b, 8);
    // Terminator (up to 4 zero bits, not exceeding capacity)
    const capacityBits = totalData * 8;
    for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
    // Pad to a byte boundary
    while (bits.length % 8 !== 0) bits.push(0);
    // Fill remaining data codewords with the alternating pad bytes
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        dataCodewords.push(byte);
    }
    const PADS = [0xec, 0x11];
    let p = 0;
    while (dataCodewords.length < totalData) {
        dataCodewords.push(PADS[p % 2]);
        p++;
    }

    // ── 2. Split into blocks, compute EC, interleave ─────────────────────────
    const blocks = [];
    let idx = 0;
    for (let b = 0; b < g1Blocks; b++) {
        const d = dataCodewords.slice(idx, idx + g1Data);
        idx += g1Data;
        blocks.push({ data: d, ec: rsEncode(d, ecLen) });
    }
    for (let b = 0; b < g2Blocks; b++) {
        const d = dataCodewords.slice(idx, idx + g2Data);
        idx += g2Data;
        blocks.push({ data: d, ec: rsEncode(d, ecLen) });
    }

    const finalBytes = [];
    const maxData = Math.max(g1Data, g2Data);
    for (let i = 0; i < maxData; i++) {
        for (const blk of blocks) if (i < blk.data.length) finalBytes.push(blk.data[i]);
    }
    for (let i = 0; i < ecLen; i++) {
        for (const blk of blocks) finalBytes.push(blk.ec[i]);
    }

    const finalBits = [];
    for (const byte of finalBytes) {
        for (let i = 7; i >= 0; i--) finalBits.push((byte >> i) & 1);
    }

    // ── 3. Place modules on the matrix ───────────────────────────────────────
    const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    const placeFinder = (row, col) => {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const rr = row + r, cc = col + c;
                if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
                const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
                const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                               (c >= 0 && c <= 6 && (r === 0 || r === 6));
                const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                matrix[rr][cc] = isBorder ? 0 : (inRing || inCore ? 1 : 0);
                reserved[rr][cc] = true;
            }
        }
    };
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
        const v = i % 2 === 0 ? 1 : 0;
        if (matrix[6][i] === null) { matrix[6][i] = v; reserved[6][i] = true; }
        if (matrix[i][6] === null) { matrix[i][6] = v; reserved[i][6] = true; }
    }

    // Alignment patterns
    const centres = ALIGN_POS[version];
    for (const r of centres) {
        for (const c of centres) {
            if (reserved[r][c]) continue; // overlaps a finder
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    const rr = r + dr, cc = c + dc;
                    const ring = Math.max(Math.abs(dr), Math.abs(dc));
                    matrix[rr][cc] = (ring === 1) ? 0 : 1;
                    reserved[rr][cc] = true;
                }
            }
        }
    }

    // Dark module
    matrix[size - 8][8] = 1;
    reserved[size - 8][8] = true;

    // Reserve format-information areas (filled after masking)
    const reserveFormat = () => {
        for (let i = 0; i < 9; i++) {
            if (!reserved[8][i]) { reserved[8][i] = true; if (matrix[8][i] === null) matrix[8][i] = 0; }
            if (!reserved[i][8]) { reserved[i][8] = true; if (matrix[i][8] === null) matrix[i][8] = 0; }
        }
        for (let i = 0; i < 8; i++) {
            const cc = size - 1 - i;
            if (!reserved[8][cc]) { reserved[8][cc] = true; if (matrix[8][cc] === null) matrix[8][cc] = 0; }
            const rr = size - 1 - i;
            if (!reserved[rr][8]) { reserved[rr][8] = true; if (matrix[rr][8] === null) matrix[rr][8] = 0; }
        }
    };
    reserveFormat();

    // ── 4. Lay the data bits in zig-zag order ────────────────────────────────
    let bitIdx = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--; // skip the vertical timing column
        for (let i = 0; i < size; i++) {
            const row = upward ? size - 1 - i : i;
            for (let c = 0; c < 2; c++) {
                const cc = col - c;
                if (reserved[row][cc]) continue;
                const bit = bitIdx < finalBits.length ? finalBits[bitIdx] : 0;
                matrix[row][cc] = bit;
                bitIdx++;
            }
        }
        upward = !upward;
    }

    // ── 5. Apply mask 0 and write format information for (EC=M, mask=0) ───────
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (reserved[r][c]) continue;
            if ((r + c) % 2 === 0) matrix[r][c] ^= 1; // mask pattern 0
        }
    }

    // Format bits for EC level M (0b00) + mask 0 (0b000), BCH-encoded & masked.
    const FORMAT_M_MASK0 = 0b101010000010010; // 15 bits, precomputed
    const fmt = FORMAT_M_MASK0;
    // Around top-left finder
    for (let i = 0; i <= 5; i++) matrix[8][i] = (fmt >> i) & 1;
    matrix[8][7] = (fmt >> 6) & 1;
    matrix[8][8] = (fmt >> 7) & 1;
    matrix[7][8] = (fmt >> 8) & 1;
    for (let i = 9; i <= 14; i++) matrix[14 - i][8] = (fmt >> i) & 1;
    // Around the other two finders
    for (let i = 0; i <= 7; i++) matrix[size - 1 - i][8] = (fmt >> i) & 1;
    for (let i = 8; i <= 14; i++) matrix[8][size - 15 + i] = (fmt >> i) & 1;
    matrix[size - 8][8] = 1; // dark module stays set

    // ── 6. Emit SVG ──────────────────────────────────────────────────────────
    const quiet = 4;
    const dim = size + quiet * 2;
    let path = '';
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (matrix[r][c] === 1) {
                path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
            }
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${pxSize}" height="${pxSize}" ` +
        `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
        `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
        `<path d="${path}" fill="#000000"/></svg>`;
}
