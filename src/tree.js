// 0x88 replay engine with split-32 Zobrist hashing for explorer tree building.
// Replays trusted SAN moves without legality checks.
// ReplayEngine: board-centric, zero allocation per move.
// Hash stored as two Int32 (hi/lo) — avoids BigInt overhead in hot paths.
// Exports ReplayEngine (for tree building) and hashFen (for position lookups).

// ─── Piece Encoding ─────────────────────────────────────────────────
// White: 1-6, Black: 9-14. p=1 n=2 b=3 r=4 q=5 k=6. Empty=0.

const W = 0,
    B = 8;
const P = 1,
    N = 2,
    _B = 3,
    R = 4,
    Q = 5,
    K = 6;
const pieceColor = (p) => p >> 3;
const pieceType = (p) => p & 7;

// ─── Piece Offsets ──────────────────────────────────────────────────

const PIECE_OFFSETS = {
    [N]: [-18, -33, -31, -14, 18, 33, 31, 14],
    [_B]: [-17, -15, 17, 15],
    [R]: [-16, 1, 16, -1],
    [Q]: [-17, -16, -15, 1, 17, 16, 15, -1],
    [K]: [-17, -16, -15, 1, 17, 16, 15, -1],
};

// ─── Zobrist Keys (split-32) ───────────────────────────────────────
// PRNG generates 64-bit keys via BigInt at module init, then splits to
// paired Int32 typed arrays. No BigInt touches the hot path.

function splitmix64(seed) {
    let state = BigInt(seed);
    return function () {
        state += 0x9e3779b97f4a7c15n;
        state &= 0xffffffffffffffffn;
        let z = state;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
        z = (z ^ (z >> 31n)) & 0xffffffffffffffffn;
        return [Number(z >> 32n) | 0, Number(z & 0xffffffffn) | 0];
    };
}

const rand = splitmix64(0x12345678);

// Interleaved [hi, lo, hi, lo, ...] pairs in single typed arrays.
function randPairs(n) {
    const a = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const [h, l] = rand();
        a[i * 2] = h;
        a[i * 2 + 1] = l;
    }
    return a;
}

const PIECE_KEYS = Array.from({ length: 2 }, () => Array.from({ length: 7 }, () => randPairs(128)));
const EP_KEYS = randPairs(8);
const CASTLING_KEYS = randPairs(16);
const SIDE_KEY = randPairs(1);

// ─── hashFen ────────────────────────────────────────────────────────
// Compute Zobrist hash directly from a FEN string (for position lookups).
// Returns [hi, lo] Int32 pair.

const FEN_CHAR_TO_ENCODED = {
    P: W | P,
    N: W | N,
    B: W | _B,
    R: W | R,
    Q: W | Q,
    K: W | K,
    p: B | P,
    n: B | N,
    b: B | _B,
    r: B | R,
    q: B | Q,
    k: B | K,
};

export function hashFen(fen) {
    const parts = fen.split(' ');
    let hi = 0,
        lo = 0;

    const rows = parts[0].split('/');
    for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of rows[r]) {
            if (ch >= '1' && ch <= '8') {
                f += parseInt(ch);
            } else {
                const encoded = FEN_CHAR_TO_ENCODED[ch];
                if (encoded) {
                    const k = PIECE_KEYS[pieceColor(encoded)][pieceType(encoded)];
                    const j = (r * 16 + f) * 2;
                    hi ^= k[j];
                    lo ^= k[j + 1];
                }
                f++;
            }
        }
    }

    if (parts[1] === 'b') {
        hi ^= SIDE_KEY[0];
        lo ^= SIDE_KEY[1];
    }

    let ci = 0;
    if (parts[2] && parts[2] !== '-') {
        if (parts[2].includes('K')) ci |= 1;
        if (parts[2].includes('Q')) ci |= 2;
        if (parts[2].includes('k')) ci |= 4;
        if (parts[2].includes('q')) ci |= 8;
    }
    hi ^= CASTLING_KEYS[ci * 2];
    lo ^= CASTLING_KEYS[ci * 2 + 1];

    if (parts[3] && parts[3] !== '-') {
        const j = (parts[3].charCodeAt(0) - 97) * 2;
        hi ^= EP_KEYS[j];
        lo ^= EP_KEYS[j + 1];
    }

    return [hi, lo];
}

// Precomputed start position hash
export const START_HASH = hashFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');

// Char code → piece type (supports N/B/R/Q/K in both cases)
const CC = new Uint8Array(128);
CC[78] = N;
CC[66] = _B;
CC[82] = R;
CC[81] = Q;
CC[75] = K;
CC[110] = N;
CC[98] = _B;
CC[114] = R;
CC[113] = Q;
CC[107] = K;

// Compute 0x88 square from two chars at position i in string s
function sqAt(s, i) {
    return (56 - s.charCodeAt(i + 1)) * 16 + s.charCodeAt(i) - 97;
}

// ─── ReplayEngine ───────────────────────────────────────────────────
// Board-centric engine: no piece lists, no object allocation per move.
// Hash stored as hashHi/hashLo Int32 pair.

export class ReplayEngine {
    constructor() {
        this.board = new Uint8Array(128);
        this.wKing = 0;
        this.bKing = 0;
        this.us = W;
        this.castleW = 0;
        this.castleB = 0;
        this.epSquare = -1;
        this.hashHi = 0;
        this.hashLo = 0;
        this.reset();
    }

    reset() {
        this.board.fill(0);
        this.us = W;
        this.castleW = 3;
        this.castleB = 3;
        this.epSquare = -1;
        this.hashHi = 0;
        this.hashLo = 0;
        const back = [R, N, _B, Q, K, _B, N, R];
        for (let f = 0; f < 8; f++) {
            const wBack = W | back[f],
                bBack = B | back[f];
            this.board[112 + f] = wBack;
            this._xorPiece(wBack, 112 + f);
            this.board[96 + f] = W | P;
            this._xorPiece(W | P, 96 + f);
            this.board[f] = bBack;
            this._xorPiece(bBack, f);
            this.board[16 + f] = B | P;
            this._xorPiece(B | P, 16 + f);
        }
        this.wKing = 116;
        this.bKing = 4;
        this._xorCastling(3 | (3 << 2));
    }

    get turn() {
        return this.us === W ? 'w' : 'b';
    }
    set turn(v) {
        this.us = v === 'w' ? W : B;
    }

    _isPinned(sq, toSq) {
        const kingSq = this.us === W ? this.wKing : this.bKing;
        const enemy = this.us ^ 8;
        const dr = Math.sign((sq >> 4) - (kingSq >> 4));
        const df = Math.sign((sq & 0xf) - (kingSq & 0xf));
        if (dr === 0 && df === 0) return false;
        const offset = dr * 16 + df;
        let s = kingSq + offset;
        while (!(s & 0x88) && s !== sq) {
            if (this.board[s]) return false;
            s += offset;
        }
        if (s !== sq) return false;
        s = kingSq + offset;
        while (!(s & 0x88)) {
            if (s === toSq) return false;
            s += offset;
        }
        s = kingSq - offset;
        while (!(s & 0x88)) {
            if (s === toSq) return false;
            s -= offset;
        }
        s = sq + offset;
        while (!(s & 0x88)) {
            const p = this.board[s];
            if (p) {
                if (p >> 3 !== enemy >> 3) return false;
                const ptype = p & 7;
                if (dr === 0 || df === 0) return ptype === R || ptype === Q;
                return ptype === _B || ptype === Q;
            }
            s += offset;
        }
        return false;
    }

    // ── Hash XOR helpers ─────────────────────────────────────────────

    _xorPiece(encoded, sq) {
        const k = PIECE_KEYS[pieceColor(encoded)][pieceType(encoded)],
            j = sq * 2;
        this.hashHi ^= k[j];
        this.hashLo ^= k[j + 1];
    }
    _xorSide() {
        this.hashHi ^= SIDE_KEY[0];
        this.hashLo ^= SIDE_KEY[1];
    }
    _xorCastling(idx) {
        const j = idx * 2;
        this.hashHi ^= CASTLING_KEYS[j];
        this.hashLo ^= CASTLING_KEYS[j + 1];
    }
    _xorEp(file) {
        const j = file * 2;
        this.hashHi ^= EP_KEYS[j];
        this.hashLo ^= EP_KEYS[j + 1];
    }

    move(san) {
        let len = san.length;
        const lastC = san.charCodeAt(len - 1);
        if (lastC === 43 || lastC === 35) len--; // strip + or #

        const c0 = san.charCodeAt(0);

        // ── Castling ──────────────────────────────────────────────
        if (c0 === 79) {
            // 'O'
            const ks = len === 3; // O-O vs O-O-O
            const kFrom = this.us === W ? this.wKing : this.bKing;
            const kTo = ks ? kFrom + 2 : kFrom - 2;
            const rFrom = ks ? kFrom + 3 : kFrom - 4;
            const rTo = ks ? kFrom + 1 : kFrom - 1;
            const kEnc = this.board[kFrom];
            const rEnc = this.board[rFrom];

            const oldCI = this.castleW | (this.castleB << 2);
            this._xorCastling(oldCI);
            // Move king
            this._xorPiece(kEnc, kFrom);
            this._xorPiece(kEnc, kTo);
            this.board[kTo] = kEnc;
            this.board[kFrom] = 0;
            // Move rook
            this._xorPiece(rEnc, rFrom);
            this._xorPiece(rEnc, rTo);
            this.board[rTo] = rEnc;
            this.board[rFrom] = 0;

            if (this.us === W) {
                this.wKing = kTo;
                this.castleW = 0;
            } else {
                this.bKing = kTo;
                this.castleB = 0;
            }
            this._xorCastling(this.castleW | (this.castleB << 2));

            if (this.epSquare !== -1) {
                this._xorEp(this.epSquare & 0xf);
                this.epSquare = -1;
            }
            this._xorSide();
            this.us ^= 8;
            return;
        }

        // ── Parse SAN ─────────────────────────────────────────────
        let pt,
            fromFile = -1,
            fromRank = -1,
            toSq,
            promotion = 0;

        if (c0 >= 97 && c0 <= 104) {
            // Pawn move (starts with a-h)
            pt = P;
            fromFile = c0 - 97;
            const c1 = san.charCodeAt(1);
            if (c1 === 120) {
                // 'x' capture
                toSq = sqAt(san, 2);
                if (len > 4 && san.charCodeAt(4) === 61) promotion = CC[san.charCodeAt(5)];
            } else {
                toSq = sqAt(san, 0);
                if (len > 2 && san.charCodeAt(2) === 61) promotion = CC[san.charCodeAt(3)];
            }
        } else {
            // Piece move (N/B/R/Q/K)
            pt = CC[c0];
            if (!pt) return; // unknown token (e.g. -- null move)
            toSq = sqAt(san, len - 2);
            for (let i = 1; i < len - 2; i++) {
                const ch = san.charCodeAt(i);
                if (ch >= 97 && ch <= 104)
                    fromFile = ch - 97; // a-h
                else if (ch >= 49 && ch <= 56) fromRank = 56 - ch; // 1-8 → 0x88 rank
            }
        }

        // ── Find source square (reverse lookup from target) ───────
        const ourPiece = this.us | pt;
        let fromSq = -1;

        if (pt === P) {
            const dir = this.us === W ? -16 : 16;
            if (fromFile !== (toSq & 0xf)) {
                // Capture: pawn on fromFile, one rank behind target
                const sq = ((toSq - dir) & 0xf0) | fromFile;
                if (!(sq & 0x88) && this.board[sq] === ourPiece) fromSq = sq;
            } else {
                // Push: single, then double
                const sq1 = toSq - dir;
                if (this.board[sq1] === ourPiece) {
                    fromSq = sq1;
                } else if (!this.board[sq1]) {
                    const sq2 = toSq - dir * 2;
                    if (this.board[sq2] === ourPiece) fromSq = sq2;
                }
            }
        } else if (pt === K) {
            fromSq = this.us === W ? this.wKing : this.bKing;
        } else if (pt === N) {
            const offsets = PIECE_OFFSETS[N];
            for (let i = 0; i < 8; i++) {
                const sq = toSq - offsets[i];
                if (sq & 0x88) continue;
                if (this.board[sq] !== ourPiece) continue;
                if (fromFile !== -1 && (sq & 0xf) !== fromFile) continue;
                if (fromRank !== -1 && sq >> 4 !== fromRank) continue;
                if (this._isPinned(sq, toSq)) continue;
                fromSq = sq;
                break;
            }
        } else {
            // Sliding piece (B/R/Q): walk rays backward from target
            const offsets = PIECE_OFFSETS[pt];
            for (let d = 0; d < offsets.length; d++) {
                const offset = offsets[d];
                let sq = toSq - offset;
                while (!(sq & 0x88)) {
                    const p = this.board[sq];
                    if (p) {
                        if (
                            p === ourPiece &&
                            (fromFile === -1 || (sq & 0xf) === fromFile) &&
                            (fromRank === -1 || sq >> 4 === fromRank) &&
                            !this._isPinned(sq, toSq)
                        ) {
                            fromSq = sq;
                        }
                        break;
                    }
                    sq -= offset;
                }
                if (fromSq !== -1) break;
            }
        }

        if (fromSq === -1) return;

        // ── Apply move ────────────────────────────────────────────
        const oldCI = this.castleW | (this.castleB << 2);

        // Clear old EP hash
        if (this.epSquare !== -1) this._xorEp(this.epSquare & 0xf);

        // Handle capture
        if (pt === P && toSq === this.epSquare) {
            const capSq = this.us === W ? toSq + 16 : toSq - 16;
            this._xorPiece(this.board[capSq], capSq);
            this.board[capSq] = 0;
        } else if (this.board[toSq]) {
            this._xorPiece(this.board[toSq], toSq);
            this.board[toSq] = 0;
        }

        // Move piece
        this._xorPiece(ourPiece, fromSq);
        this._xorPiece(ourPiece, toSq);
        this.board[toSq] = ourPiece;
        this.board[fromSq] = 0;

        // Track king
        if (pt === K) {
            if (this.us === W) this.wKing = toSq;
            else this.bKing = toSq;
        }

        // Promotion
        if (promotion) {
            const promoted = this.us | promotion;
            this._xorPiece(ourPiece, toSq);
            this._xorPiece(promoted, toSq);
            this.board[toSq] = promoted;
        }

        // Set new EP square
        if (pt === P && Math.abs(fromSq - toSq) === 32) {
            const epSq = (fromSq + toSq) >> 1;
            const enemyPawn = (this.us ^ 8) | P;
            const left = toSq - 1,
                right = toSq + 1;
            if (
                (!(left & 0x88) && this.board[left] === enemyPawn) ||
                (!(right & 0x88) && this.board[right] === enemyPawn)
            ) {
                this.epSquare = epSq;
                this._xorEp(epSq & 0xf);
            } else {
                this.epSquare = -1;
            }
        } else {
            this.epSquare = -1;
        }

        // Castling rights — our piece
        if (pt === K) {
            if (this.us === W) this.castleW = 0;
            else this.castleB = 0;
        } else if (pt === R) {
            const homeRank = this.us === W ? 112 : 0;
            if (fromSq === homeRank) {
                if (this.us === W) this.castleW &= ~2;
                else this.castleB &= ~2;
            } else if (fromSq === homeRank + 7) {
                if (this.us === W) this.castleW &= ~1;
                else this.castleB &= ~1;
            }
        }
        // Castling rights — opponent rook captured
        const theirRank = this.us === W ? 0 : 112;
        if (toSq === theirRank) {
            if (this.us === W) this.castleB &= ~2;
            else this.castleW &= ~2;
        } else if (toSq === theirRank + 7) {
            if (this.us === W) this.castleB &= ~1;
            else this.castleW &= ~1;
        }

        const newCI = this.castleW | (this.castleB << 2);
        if (oldCI !== newCI) {
            this._xorCastling(oldCI);
            this._xorCastling(newCI);
        }

        this._xorSide();
        this.us ^= 8;
    }
}
