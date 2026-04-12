/**
 * Stockfish engine wrapper.
 *
 * Runs stockfish-web inside a dedicated Web Worker so that
 * worker.terminate() can fully release WASM memory and pthreads.
 *
 * UCI protocol sequence:
 *   uci → uciok → setoption (all) → ucinewgame → isready → readyok → go
 *   Mid-session option changes: stop → bestmove → setoption → isready → readyok → go
 *
 * Eval cache keyed by FEN (stripping move counters) — max 500 entries.
 */

import { Chess } from 'chess.js';

let _worker = null;
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
    return _ready && _worker !== null;
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
    return localStorage.getItem('engine-variant');
}

// ─── Init / Destroy ──────────────────────────────────────────────

const NNUE_CACHE = 'tnmp-nnue-v1';

export async function initEngine(variant, options = {}) {
    if (_worker) destroyEngine();
    _loading = true;
    _variant = variant || 'lite';
    if (options.hash !== undefined) _options.hash = options.hash;
    if (options.threads !== undefined) _options.threads = options.threads;
    localStorage.setItem('engine-variant', _variant);
    notify();

    try {
        // Create worker container
        _worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });

        // Wait for worker to load the WASM module
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Engine worker init timed out'));
            }, 15000);

            _worker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                } else if (e.data.type === 'error') {
                    clearTimeout(timeout);
                    reject(new Error(e.data.msg));
                }
            };

            const engineOrigin = typeof __EMBED__ !== 'undefined' ? 'https://tnmpairings.com' : window.location.origin;
            _worker.postMessage({ cmd: 'init', variant: _variant, engineOrigin });
        });

        // Load NNUE weights (fetched on main thread, transferred to worker)
        await _loadNnue(_variant);

        // Wire the permanent message handler
        _worker.onmessage = (e) => {
            const { type, line } = e.data;
            if (type === 'line') {
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
            } else if (type === 'error') {
                console.error('Stockfish error:', e.data.msg);
            }
        };

        // Start UCI handshake — wait for readyok
        return new Promise((resolve, reject) => {
            _initResolve = resolve;
            _send('uci');
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

async function _loadNnue(variant) {
    if (!_worker) return;
    const indices = variant === 'lite' ? [0] : [0, 1];
    const cache = await caches.open(NNUE_CACHE);

    for (const index of indices) {
        // Ask worker for the recommended NNUE filename
        const name = await new Promise((resolve) => {
            const handler = _worker.onmessage;
            _worker.onmessage = (e) => {
                if (e.data.type === 'nnue-name' && e.data.index === index) {
                    _worker.onmessage = handler;
                    resolve(e.data.name);
                } else {
                    handler?.(e);
                }
            };
            _worker.postMessage({ cmd: 'nnue-name', index });
        });
        if (!name) continue;

        const url = `https://api.tnmpairings.com/nnue/${name}`;
        let resp = await cache.match(url);
        if (!resp) {
            resp = await fetch(url);
            if (!resp.ok) throw new Error(`Failed to fetch NNUE: ${name} (${resp.status})`);
            cache.put(url, resp.clone());
        }

        const buf = new Uint8Array(await resp.arrayBuffer());

        // Transfer buffer to worker (zero-copy)
        await new Promise((resolve) => {
            const handler = _worker.onmessage;
            _worker.onmessage = (e) => {
                if (e.data.type === 'nnue-loaded' && e.data.index === index) {
                    _worker.onmessage = handler;
                    resolve();
                } else {
                    handler?.(e);
                }
            };
            _worker.postMessage({ cmd: 'nnue', buffer: buf, index }, [buf.buffer]);
        });
    }
}

function _send(cmd) {
    _worker?.postMessage({ cmd: 'uci', line: cmd });
}

function _sendInitOptions() {
    const threads = _resolveThreads();
    if (threads > 1) _send(`setoption name Threads value ${threads}`);
    _send(`setoption name Hash value ${_options.hash}`);
    _send('setoption name UCI_ShowWDL value true');
}

function _resolveThreads() {
    if (_options.threads > 0) return _options.threads;
    return Math.min(navigator.hardwareConcurrency || 1, 4);
}

export function destroyEngine() {
    if (_worker) {
        _worker.terminate();
        _worker = null;
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

export function setOptions(options) {
    if (!_ready || !_worker) return Promise.resolve();
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
    if (!_pendingOptions || !_worker) return;
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
    if (!_ready || !_worker) return;

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
    if (_worker && _ready && _searching) {
        _send('stop');
    }
}

export function newGame() {
    if (_worker && _ready) {
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
