// 0x88 replay engine with Zobrist hashing for explorer tree building.
// Replays trusted SAN moves without legality checks — 65x faster than chess.js.
// Exports ReplayEngine (for tree building) and hashFen (for position lookups).

// ─── 0x88 Board ─────────────────────────────────────────────────────

const Ox88 = {
    a8:   0, b8:   1, c8:   2, d8:   3, e8:   4, f8:   5, g8:   6, h8:   7,
    a7:  16, b7:  17, c7:  18, d7:  19, e7:  20, f7:  21, g7:  22, h7:  23,
    a6:  32, b6:  33, c6:  34, d6:  35, e6:  36, f6:  37, g6:  38, h6:  39,
    a5:  48, b5:  49, c5:  50, d5:  51, e5:  52, f5:  53, g5:  54, h5:  55,
    a4:  64, b4:  65, c4:  66, d4:  67, e4:  68, f4:  69, g4:  70, h4:  71,
    a3:  80, b3:  81, c3:  82, d3:  83, e3:  84, f3:  85, g3:  86, h3:  87,
    a2:  96, b2:  97, c2:  98, d2:  99, e2: 100, f2: 101, g2: 102, h2: 103,
    a1: 112, b1: 113, c1: 114, d1: 115, e1: 116, f1: 117, g1: 118, h1: 119,
};

function rank(sq) { return sq >> 4; }
function file(sq) { return sq & 0xf; }
function parseSquare(s) { return Ox88[s]; }

// ─── Piece Encoding ─────────────────────────────────────────────────
// White: 1-6, Black: 9-14. p=1 n=2 b=3 r=4 q=5 k=6. Empty=0.

const W = 0, B = 8;
const P = 1, N = 2, _B = 3, R = 4, Q = 5, K = 6;
const CHAR_TO_PIECE = { p: P, n: N, b: _B, r: R, q: Q, k: K };
const pieceColor = (p) => p >> 3;
const pieceType = (p) => p & 7;

// ─── Reachability ───────────────────────────────────────────────────

const PIECE_OFFSETS = {
    [N]: [-18, -33, -31, -14, 18, 33, 31, 14],
    [_B]: [-17, -15, 17, 15],
    [R]: [-16, 1, 16, -1],
    [Q]: [-17, -16, -15, 1, 17, 16, 15, -1],
    [K]: [-17, -16, -15, 1, 17, 16, 15, -1],
};

const IS_SLIDING = { [_B]: true, [R]: true, [Q]: true };

function canReach(board, type, from, to) {
    const offsets = PIECE_OFFSETS[type];
    if (!offsets) return false;
    if (IS_SLIDING[type]) {
        for (const offset of offsets) {
            let sq = from + offset;
            while (!(sq & 0x88)) {
                if (sq === to) return true;
                if (board[sq]) break;
                sq += offset;
            }
        }
    } else {
        for (const offset of offsets) {
            if (from + offset === to) return true;
        }
    }
    return false;
}

// ─── Zobrist Keys ───────────────────────────────────────────────────

function splitmix64(seed) {
    let state = BigInt(seed);
    return function () {
        state += 0x9e3779b97f4a7c15n;
        state &= 0xffffffffffffffffn;
        let z = state;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
        return (z ^ (z >> 31n)) & 0xffffffffffffffffn;
    };
}

const rand = splitmix64(0x12345678);

const PIECE_KEYS = Array.from({ length: 2 }, () =>
    Array.from({ length: 7 }, () => Array.from({ length: 128 }, () => rand()))
);
const EP_KEYS = Array.from({ length: 8 }, () => rand());
const CASTLING_KEYS = Array.from({ length: 16 }, () => rand());
const SIDE_KEY = rand();

function hashPiece(encoded, sq) {
    return PIECE_KEYS[pieceColor(encoded)][pieceType(encoded)][sq];
}

// ─── hashFen ────────────────────────────────────────────────────────
// Compute Zobrist hash directly from a FEN string (for position lookups).

const FEN_CHAR_TO_ENCODED = {
    P: W | P, N: W | N, B: W | _B, R: W | R, Q: W | Q, K: W | K,
    p: B | P, n: B | N, b: B | _B, r: B | R, q: B | Q, k: B | K,
};

export function hashFen(fen) {
    const parts = fen.split(' ');
    let hash = 0n;

    // Pieces
    const rows = parts[0].split('/');
    for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of rows[r]) {
            if (ch >= '1' && ch <= '8') {
                f += parseInt(ch);
            } else {
                const encoded = FEN_CHAR_TO_ENCODED[ch];
                if (encoded) hash ^= hashPiece(encoded, r * 16 + f);
                f++;
            }
        }
    }

    // Side to move
    if (parts[1] === 'b') hash ^= SIDE_KEY;

    // Castling
    let castlingIdx = 0;
    if (parts[2] && parts[2] !== '-') {
        if (parts[2].includes('K')) castlingIdx |= 1;
        if (parts[2].includes('Q')) castlingIdx |= 2;
        if (parts[2].includes('k')) castlingIdx |= 4;
        if (parts[2].includes('q')) castlingIdx |= 8;
    }
    hash ^= CASTLING_KEYS[castlingIdx];

    // En passant
    if (parts[3] && parts[3] !== '-') {
        const epFile = parts[3].charCodeAt(0) - 97;
        hash ^= EP_KEYS[epFile];
    }

    return hash;
}

// Precomputed start position hash
export const START_HASH = hashFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');

// ─── ReplayEngine ───────────────────────────────────────────────────

export class ReplayEngine {
    constructor() {
        this.board = new Uint8Array(128);
        this.pieces = { w: [], b: [] };
        this.kings = { w: -1, b: -1 };
        this.turn = 'w';
        this.castling = { w: 0, b: 0 };
        this.epSquare = -1;
        this.hash = 0n;
        this.reset();
    }

    reset() {
        this.board.fill(0);
        this.pieces = { w: [], b: [] };
        this.turn = 'w';
        this.castling = { w: 3, b: 3 };
        this.epSquare = -1;
        this.hash = 0n;

        const backRank = [R, N, _B, Q, K, _B, N, R];
        for (let f = 0; f < 8; f++) {
            this._put(W, backRank[f], Ox88.a1 + f);
            this._put(W, P, Ox88.a2 + f);
            this._put(B, backRank[f], Ox88.a8 + f);
            this._put(B, P, Ox88.a7 + f);
        }

        this.hash ^= CASTLING_KEYS[this.castling.w | (this.castling.b << 2)];
    }

    _put(color, type, sq) {
        const encoded = color | type;
        this.board[sq] = encoded;
        const colorKey = color ? 'b' : 'w';
        this.pieces[colorKey].push({ type, sq });
        if (type === K) this.kings[colorKey] = sq;
        this.hash ^= hashPiece(encoded, sq);
    }

    _remove(sq) {
        const encoded = this.board[sq];
        if (!encoded) return;
        this.board[sq] = 0;
        this.hash ^= hashPiece(encoded, sq);
        const colorKey = pieceColor(encoded) ? 'b' : 'w';
        const list = this.pieces[colorKey];
        for (let i = 0; i < list.length; i++) {
            if (list[i].sq === sq) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
    }

    _movePiece(from, to) {
        const encoded = this.board[from];
        this.hash ^= hashPiece(encoded, from);
        this.hash ^= hashPiece(encoded, to);
        this.board[to] = encoded;
        this.board[from] = 0;
        const colorKey = pieceColor(encoded) ? 'b' : 'w';
        for (const entry of this.pieces[colorKey]) {
            if (entry.sq === from) { entry.sq = to; break; }
        }
        if (pieceType(encoded) === K) this.kings[colorKey] = to;
    }

    move(san) {
        const us = this.turn;
        const them = us === 'w' ? 'b' : 'w';

        const last = san[san.length - 1];
        if (last === '+' || last === '#') san = san.slice(0, -1);

        if (san === 'O-O' || san === 'O-O-O') {
            const isKingside = san === 'O-O';
            const kFrom = this.kings[us];
            const kTo = isKingside ? kFrom + 2 : kFrom - 2;
            const rFrom = isKingside ? kFrom + 3 : kFrom - 4;
            const rTo = isKingside ? kFrom + 1 : kFrom - 1;

            this.hash ^= CASTLING_KEYS[this.castling.w | (this.castling.b << 2)];
            this._movePiece(kFrom, kTo);
            this._movePiece(rFrom, rTo);
            this.castling[us] = 0;
            this.hash ^= CASTLING_KEYS[this.castling.w | (this.castling.b << 2)];

            if (this.epSquare !== -1) {
                this.hash ^= EP_KEYS[file(this.epSquare)];
                this.epSquare = -1;
            }
            this.hash ^= SIDE_KEY;
            this.turn = them;
            return;
        }

        let pt, fromFile = -1, fromRank = -1, toSq, promotion = null;

        const eqIdx = san.indexOf('=');
        if (eqIdx !== -1) {
            promotion = CHAR_TO_PIECE[san[eqIdx + 1].toLowerCase()];
            san = san.substring(0, eqIdx);
        }

        if (san[0] >= 'a' && san[0] <= 'h') {
            pt = P;
            fromFile = san.charCodeAt(0) - 97;
            if (san[1] === 'x') {
                toSq = parseSquare(san.substring(2, 4));
            } else if (san.length >= 2 && san[1] >= '1' && san[1] <= '8') {
                toSq = parseSquare(san.substring(0, 2));
            } else {
                return;
            }
        } else {
            pt = CHAR_TO_PIECE[san[0].toLowerCase()];
            const xIdx = san.indexOf('x');
            const rest = xIdx !== -1 ? san.substring(0, xIdx) + san.substring(xIdx + 1) : san;
            toSq = parseSquare(rest.substring(rest.length - 2));
            const disambig = rest.substring(1, rest.length - 2);
            for (const c of disambig) {
                if (c >= 'a' && c <= 'h') fromFile = c.charCodeAt(0) - 97;
                else if (c >= '1' && c <= '8') fromRank = '87654321'.indexOf(c);
            }
        }

        if (toSq === undefined) return;

        let fromSq = -1;
        for (const entry of this.pieces[us]) {
            if (entry.type !== pt) continue;
            if (fromFile !== -1 && file(entry.sq) !== fromFile) continue;
            if (fromRank !== -1 && rank(entry.sq) !== fromRank) continue;
            if (pt === P) {
                const dir = us === 'w' ? -16 : 16;
                const isSinglePush = entry.sq + dir === toSq;
                const startRank = us === 'w' ? 6 : 1;
                const isDoublePush = rank(entry.sq) === startRank && entry.sq + dir * 2 === toSq && !this.board[entry.sq + dir];
                const isCapture = (entry.sq + dir - 1 === toSq || entry.sq + dir + 1 === toSq);
                if (!isSinglePush && !isDoublePush && !isCapture) continue;
            } else if (!canReach(this.board, pt, entry.sq, toSq)) continue;
            fromSq = entry.sq;
            break;
        }

        if (fromSq === -1) return;

        const oldCastlingIdx = this.castling.w | (this.castling.b << 2);

        if (this.epSquare !== -1) {
            this.hash ^= EP_KEYS[file(this.epSquare)];
        }

        if (pt === P && toSq === this.epSquare) {
            const capSq = us === 'w' ? toSq + 16 : toSq - 16;
            this._remove(capSq);
        } else if (this.board[toSq]) {
            this._remove(toSq);
        }

        this._movePiece(fromSq, toSq);

        if (promotion) {
            const colorBit = us === 'w' ? W : B;
            this.hash ^= hashPiece(colorBit | P, toSq);
            this.board[toSq] = colorBit | promotion;
            this.hash ^= hashPiece(colorBit | promotion, toSq);
            for (const entry of this.pieces[us]) {
                if (entry.sq === toSq) { entry.type = promotion; break; }
            }
        }

        if (pt === P && Math.abs(rank(fromSq) - rank(toSq)) === 2) {
            const epSq = (fromSq + toSq) / 2;
            // Only set EP if an enemy pawn can actually capture (matches chess.js / FIDE)
            const enemyPawn = (them === 'w' ? W : B) | P;
            const left = toSq - 1;
            const right = toSq + 1;
            if ((!(left & 0x88) && this.board[left] === enemyPawn) ||
                (!(right & 0x88) && this.board[right] === enemyPawn)) {
                this.epSquare = epSq;
                this.hash ^= EP_KEYS[file(epSq)];
            } else {
                this.epSquare = -1;
            }
        } else {
            this.epSquare = -1;
        }

        if (pt === K) {
            this.castling[us] = 0;
        } else if (pt === R) {
            const homeRank = us === 'w' ? Ox88.a1 : Ox88.a8;
            if (fromSq === homeRank) this.castling[us] &= ~2;
            else if (fromSq === homeRank + 7) this.castling[us] &= ~1;
        }
        const theirRank = them === 'w' ? Ox88.a1 : Ox88.a8;
        if (toSq === theirRank) this.castling[them] &= ~2;
        else if (toSq === theirRank + 7) this.castling[them] &= ~1;

        const newCastlingIdx = this.castling.w | (this.castling.b << 2);
        if (oldCastlingIdx !== newCastlingIdx) {
            this.hash ^= CASTLING_KEYS[oldCastlingIdx];
            this.hash ^= CASTLING_KEYS[newCastlingIdx];
        }

        this.hash ^= SIDE_KEY;
        this.turn = them;
    }
}
