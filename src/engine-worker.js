/**
 * Engine Worker — thin container for stockfish-web.
 *
 * Runs the WASM module and its pthreads inside this worker.
 * Parent can call worker.terminate() to kill everything and free memory.
 *
 * Protocol (postMessage):
 *   Parent → Worker:
 *     { cmd: 'init', variant, engineOrigin }
 *     { cmd: 'nnue', buffer: Uint8Array, index: number }
 *     { cmd: 'uci', line: string }
 *   Worker → Parent:
 *     { type: 'line', line: string }
 *     { type: 'ready' }
 *     { type: 'nnue-name', index: number, name: string }
 *     { type: 'error', msg: string }
 */

let _sf = null;

self.onmessage = async (e) => {
    const { cmd } = e.data;

    if (cmd === 'init') {
        try {
            const jsFile = e.data.variant === 'lite' ? 'sf_18_smallnet.js' : 'sf_18.js';
            const engineUrl = new URL(`/engine/${jsFile}`, e.data.engineOrigin).href;
            const mod = await import(/* @vite-ignore */ engineUrl);
            _sf = await mod.default();

            _sf.listen = (line) => self.postMessage({ type: 'line', line });
            _sf.onError = (msg) => self.postMessage({ type: 'error', msg });

            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', msg: err.message });
        }
    } else if (cmd === 'nnue-name') {
        if (_sf) {
            const name = _sf.getRecommendedNnue(e.data.index);
            self.postMessage({ type: 'nnue-name', index: e.data.index, name });
        }
    } else if (cmd === 'nnue') {
        if (_sf) {
            _sf.setNnueBuffer(e.data.buffer, e.data.index);
            self.postMessage({ type: 'nnue-loaded', index: e.data.index });
        }
    } else if (cmd === 'uci') {
        if (_sf) _sf.uci(e.data.line);
    }
};
