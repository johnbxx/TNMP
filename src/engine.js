/**
 * Stockfish engine wrapper using @lichess-org/stockfish-web.
 *
 * Loads Stockfish 18 as an ES module on the main thread. The engine
 * internally spawns Web Workers for pthreads (multi-threaded when
 * cross-origin isolated, single-threaded otherwise).
 *
 * UCI protocol sequence:
 *   uci → uciok → setoption (all) → ucinewgame → isready → readyok → go
 *   Mid-session option changes: stop → bestmove → setoption → isready → readyok → go
 *
 * Eval cache keyed by FEN (stripping move counters) — max 500 entries.
 */

import { Chess } from 'chess.js';

let _sf = null; // stockfish-web instance
let _ready = false;
let _loading = false;
let _variant = null; // 'lite' | 'full'
let _onLine = null; // current line handler
let _onChange = null;

// Current engine options (applied between uciok and isready)
let _options = { hash: 256, threads: 0 }; // threads 0 = auto

const EVAL_CACHE = new Map();
const CACHE_MAX = 500;

// ─── Public state ────────────────────────────────────────────────

export function isReady() {
    return _ready;
}
export function isLoading() {
    return _loading;
}
export function isActive() {
    return _ready && _sf !== null;
}
export function getVariant() {
    return _variant;
}
export function getOptions() {
    return { ..._options };
}
export function onChange(fn) {
    _onChange = fn;
}

function notify() {
    _onChange?.({ ready: _ready, loading: _loading, variant: _variant });
}

export function getSavedVariant() {
    return localStorage.getItem('engine-variant'); // kept for settings UI compat
}

// ─── Init / Destroy ──────────────────────────────────────────────

/**
 * Initialize the engine. Dynamically imports @lichess-org/stockfish-web,
 * loads NNUE weights, then runs the UCI handshake.
 */
export async function initEngine(variant, options = {}) {
    if (_sf) destroyEngine();
    _loading = true;
    _variant = variant || 'lite';
    if (options.hash !== undefined) _options.hash = options.hash;
    if (options.threads !== undefined) _options.threads = options.threads;
    localStorage.setItem('engine-variant', _variant);
    notify();

    try {
        // Dynamic import at runtime — path must bypass Vite's static analysis
        // 'lite' uses sf_18_smallnet (single small NNUE), 'full' uses sf_18 (dual NNUE)
        const jsFile = _variant === 'lite' ? 'sf_18_smallnet.js' : 'sf_18.js';
        const engineOrigin = typeof __EMBED__ !== 'undefined' ? 'https://tnmpairings.com' : window.location.origin;
        const engineUrl = new URL(`/engine/${jsFile}`, engineOrigin).href;
        const mod = await import(/* @vite-ignore */ engineUrl);
        const Sf_18_Web = mod.default;
        _sf = await Sf_18_Web();

        // Wire the listener
        _sf.listen = (line) => {
            if (!_ready && line === 'uciok') {
                _sendInitOptions();
                _send('ucinewgame');
                _send('isready');
            } else if (!_ready && line === 'readyok') {
                _ready = true;
                _loading = false;
                notify();
                _initResolve?.();
                _initResolve = null;
            } else {
                _onLine?.(line);
            }
        };
        _sf.onError = (msg) => {
            console.error('Stockfish error:', msg);
        };

        // Load NNUE weights (not embedded in the lichess-org WASM build)
        await _loadNnue(_variant);

        // Start UCI handshake — wait for readyok
        return new Promise((resolve, reject) => {
            _initResolve = resolve;
            _send('uci');
            // Timeout safety
            setTimeout(() => {
                if (!_ready) {
                    _loading = false;
                    notify();
                    reject(new Error('Engine init timed out'));
                }
            }, 15000);
        });
    } catch (err) {
        _loading = false;
        notify();
        throw err;
    }
}

let _initResolve = null;

/**
 * Load NNUE network file required by the lichess-org stockfish-web build.
 * 'full' variant loads the big net (104MB, max strength).
 * 'lite' variant loads the small net (3.4MB, fast download).
 */
const NNUE_CACHE = 'tnmp-nnue-v1';

async function _loadNnue(variant) {
    if (!_sf) return;
    // 'full' (sf_18) needs both nets; 'lite' (sf_18_smallnet) needs only its single net
    const indices = variant === 'lite' ? [0] : [0, 1];
    const cache = await caches.open(NNUE_CACHE);

    for (const index of indices) {
        const name = _sf.getRecommendedNnue(index);
        if (!name) continue;
        const url = `https://api.tnmpairings.com/nnue/${name}`;

        let resp = await cache.match(url);
        if (!resp) {
            resp = await fetch(url);
            if (!resp.ok) throw new Error(`Failed to fetch NNUE: ${name} (${resp.status})`);
            cache.put(url, resp.clone());
        }

        const buf = new Uint8Array(await resp.arrayBuffer());
        _sf.setNnueBuffer(buf, index);
    }
}

/** Send a UCI command to the engine. */
function _send(cmd) {
    _sf?.uci(cmd);
}

/** Send all setoption commands. Called once between uciok and isready. */
function _sendInitOptions() {
    const threads = _resolveThreads();
    if (threads > 1) _send(`setoption name Threads value ${threads}`);
    _send(`setoption name Hash value ${_options.hash}`);
    _send('setoption name UCI_ShowWDL value true');
}

function _resolveThreads() {
    if (_options.threads > 0) return _options.threads;
    return Math.min(navigator.hardwareConcurrency || 1, 4); // auto
}

export function destroyEngine() {
    if (_sf) {
        try {
            _send('quit');
        } catch {
            /* already dead */
        }
        _sf = null;
    }
    _ready = false;
    _loading = false;
    _onLine = null;
    _searching = false;
    _pendingEval = null;
    _pendingOptions = null;
    _initResolve = null;
    EVAL_CACHE.clear();
    notify();
}

// ─── Mid-session option changes ──────────────────────────────────

let _pendingOptions = null;

/**
 * Change engine options mid-session. Follows the safe protocol:
 * stop (if searching) → wait for bestmove → setoption → isready → readyok → callback
 */
export function setOptions(options) {
    if (!_ready || !_sf) return Promise.resolve();
    if (options.hash !== undefined) _options.hash = options.hash;
    if (options.threads !== undefined) _options.threads = options.threads;

    return new Promise((resolve) => {
        _pendingOptions = { resolve };

        if (_searching) {
            _pendingEval = null;
            _send('stop');
        } else {
            _applyPendingOptions();
        }
    });
}

function _applyPendingOptions() {
    if (!_pendingOptions || !_sf) return;
    const { resolve } = _pendingOptions;

    const threads = _resolveThreads();
    _send(`setoption name Threads value ${threads}`);
    _send(`setoption name Hash value ${_options.hash}`);
    _send('isready');

    const prevOnLine = _onLine;
    _onLine = (line) => {
        if (line === 'readyok') {
            _onLine = prevOnLine;
            _pendingOptions = null;
            resolve();
        }
    };
}

// ─── Evaluation ──────────────────────────────────────────────────

let _searching = false;
let _pendingEval = null;

function fenKey(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

export function getCachedEval(fen) {
    return EVAL_CACHE.get(fenKey(fen)) || null;
}

export function evaluatePosition(fen, { depth = 20, multiPv = 1, onInfo } = {}) {
    if (!_ready || !_sf) return;

    if (_searching) {
        _pendingEval = { fen, depth, multiPv, onInfo };
        _send('stop');
        return;
    }

    startSearch(fen, depth, multiPv, onInfo);
}

function startSearch(fen, depth, multiPv, onInfo) {
    _searching = true;
    _pendingEval = null;
    let best = null;

    _onLine = (line) => {
        if (line.startsWith('info ') && line.includes(' pv ')) {
            const parsed = parseInfoLine(line);
            if (parsed) {
                onInfo?.(parsed);
                if (parsed.multiPvIndex === 1 && (!best || parsed.depth >= best.depth)) {
                    best = parsed;
                }
            }
        } else if (line.startsWith('bestmove ')) {
            _searching = false;
            _onLine = null;
            if (best) {
                best.bestmove = line.split(' ')[1];
                const key = fenKey(fen);
                if (EVAL_CACHE.size >= CACHE_MAX) {
                    const oldest = EVAL_CACHE.keys().next().value;
                    EVAL_CACHE.delete(oldest);
                }
                EVAL_CACHE.set(key, best);
            }
            if (_pendingOptions) {
                _applyPendingOptions();
            } else if (_pendingEval) {
                const p = _pendingEval;
                _pendingEval = null;
                startSearch(p.fen, p.depth, p.multiPv, p.onInfo);
            }
        }
    };

    _send(`setoption name MultiPV value ${multiPv}`);
    _send(`position fen ${fen}`);
    _send(depth >= 99 ? 'go infinite' : `go depth ${depth}`);
}

export function stopAnalysis() {
    _pendingEval = null;
    if (_sf && _ready && _searching) {
        _send('stop');
    }
}

export function newGame() {
    if (_sf && _ready) {
        _send('ucinewgame');
        _send('isready');
    }
    EVAL_CACHE.clear();
}

// ─── UCI parsing ─────────────────────────────────────────────────

export function parseInfoLine(line) {
    const tokens = line.split(' ');
    const result = {
        depth: 0,
        seldepth: 0,
        score: 0,
        mate: null,
        wdl: null,
        pv: [],
        nodes: 0,
        nps: 0,
        time: 0,
        multiPvIndex: 1,
    };

    for (let i = 0; i < tokens.length; i++) {
        switch (tokens[i]) {
            case 'depth':
                result.depth = parseInt(tokens[++i]);
                break;
            case 'seldepth':
                result.seldepth = parseInt(tokens[++i]);
                break;
            case 'multipv':
                result.multiPvIndex = parseInt(tokens[++i]);
                break;
            case 'nodes':
                result.nodes = parseInt(tokens[++i]);
                break;
            case 'nps':
                result.nps = parseInt(tokens[++i]);
                break;
            case 'time':
                result.time = parseInt(tokens[++i]);
                break;
            case 'wdl':
                result.wdl = [parseInt(tokens[i + 1]), parseInt(tokens[i + 2]), parseInt(tokens[i + 3])];
                i += 3;
                break;
            case 'score':
                if (tokens[i + 1] === 'cp') {
                    result.score = parseInt(tokens[i + 2]);
                    i += 2;
                } else if (tokens[i + 1] === 'mate') {
                    result.mate = parseInt(tokens[i + 2]);
                    result.score = 0;
                    i += 2;
                }
                break;
            case 'pv':
                result.pv = tokens.slice(i + 1);
                i = tokens.length;
                break;
        }
    }

    return result;
}

export function formatScore(cp, mate) {
    if (mate !== null && mate !== undefined) {
        return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
    }
    const sign = cp >= 0 ? '+' : '';
    return `${sign}${(cp / 100).toFixed(2)}`;
}

export function scoreToPercent(cp, mate) {
    if (mate !== null && mate !== undefined) {
        return mate > 0 ? 100 : 0;
    }
    return 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
}

export function pvToSan(fen, uciMoves) {
    const chess = new Chess(fen);
    const san = [];
    for (const uci of uciMoves) {
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci[4] : undefined;
        try {
            const move = chess.move({ from, to, promotion });
            if (!move) break;
            san.push(move.san);
        } catch {
            break;
        }
    }
    return san;
}
