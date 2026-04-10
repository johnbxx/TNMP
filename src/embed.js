/**
 * TNMP Embeddable Game Viewer
 *
 * Single <script> tag ships the full game panel — board, move list,
 * opening explorer, game browser, player profiles, engine analysis.
 * CSS is injected automatically.
 *
 * Usage:
 *   <script src="tnmp-viewer.js"></script>
 *   <script>
 *     TNMPViewer.open();              // opens the game browser
 *     TNMPViewer.open({ gameId });    // opens a specific game
 *   </script>
 */

// CSS — injected into <head> by vite-plugin-css-injected-by-js
import '../styles.css';

// Inline piece images (no /pieces/ directory needed on embedding site)
import { PIECE_URLS, injectPieces } from './embed-pieces.js';

// Compile-time feature flags (injected by vite.config.embed.js).
// In the main app build these are undefined — default to full features.
const FEAT = {
    playerProfiles: typeof __FEAT_PLAYER_PROFILES__ !== 'undefined' ? __FEAT_PLAYER_PROFILES__ : true,
    globalPlayerSearch: typeof __FEAT_GLOBAL_PLAYER_SEARCH__ !== 'undefined' ? __FEAT_GLOBAL_PLAYER_SEARCH__ : true,
    import: typeof __FEAT_IMPORT__ !== 'undefined' ? __FEAT_IMPORT__ : true,
    localEngine: typeof __FEAT_LOCAL_ENGINE__ !== 'undefined' ? __FEAT_LOCAL_ENGINE__ : true,
    explorer: typeof __FEAT_EXPLORER__ !== 'undefined' ? __FEAT_EXPLORER__ : true,
};

// Viewer + data layer (same modules as the main app)
import { trapFocus } from './modal.js';
import { openStyle, initStyle } from './style.js';
import { showToast } from './toast.js';
import { formatName, getHeader } from './utils.js';
import { initPlayerProfile, openPlayerProfile } from './player-profile.js';
import {
    openGamePanel,
    closeGamePanel,
    handlePanelKeydown,
    explorerBackToBrowser,
    resolveDirtyDialog,
    explorerGoToStart,
    explorerGoBack,
    explorerGoForward,
    goToStart,
    goToPrev,
    goToNext,
    goToEnd,
    flipBoard,
    toggleAutoPlay,
    toggleComments,
    toggleBranchMode,
    toggleEngine,
    confirmEngineChoice,
    toggleEnginePause,
    openEngineSettings,
    applyEngineSettings,
    getGamePgn,
    getGameMoves,
    getCurrentNodeId,
    getNodes,
    toggleNag,
    showImportDialog,
    hideImportDialog,
    doImport,
    submitGame,
    showHeaderEditor,
    saveHeaderEditor,
    launchExplorer,
    initGamePanel,
} from './game-panel.js';
import {
    prefetchGames,
    getCachedGame,
    fetchGames,
    getPlayer,
    getPlayerUscfId,
    getGroupedGames,
    getFilter,
} from './games.js';

// --- PGN download helper ---

function downloadPgn(pgnText, filename) {
    const blob = new Blob([pgnText], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// --- Action dispatch (same as app.js, minus main-page actions) ---

const ACTIONS = {
    'open-style': openStyle,
    'open-games': () => openGamePanel(),
    'open-profile': (e) => {
        const btn = e.target.closest('[data-action="open-profile"]');
        if (!btn?.dataset.name) return;
        if (FEAT.playerProfiles) {
            openPlayerProfile(btn.dataset.name);
        } else {
            const uscfId = getPlayerUscfId(btn.dataset.name);
            if (uscfId) window.open(`https://ratings.uschess.org/player/${uscfId}`, '_blank', 'noopener');
        }
    },
    // Viewer
    'viewer-start': goToStart,
    'viewer-prev': goToPrev,
    'viewer-play': toggleAutoPlay,
    'viewer-next': goToNext,
    'viewer-end': goToEnd,
    'viewer-flip': flipBoard,
    'viewer-comments': (e) => {
        const btn = e.target.closest('[data-action]');
        btn.classList.toggle('active', !toggleComments());
    },
    'viewer-branch': (e) => {
        const btn = e.target.closest('[data-action]');
        btn.classList.toggle('active', toggleBranchMode());
    },
    'viewer-analysis': async () => {
        document.getElementById('share-popover')?.classList.add('hidden');
        document.getElementById('overflow-menu')?.classList.add('hidden');
        const pgn = getGamePgn();
        if (!pgn) return;
        const nodes = getNodes();
        const ply = nodes[getCurrentNodeId()]?.ply || 0;
        const hash = ply > 0 ? '#' + ply : '';
        const tab = window.open('about:blank', '_blank');
        try {
            const res = await fetch('https://lichess.org/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: 'pgn=' + encodeURIComponent(pgn),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.url) {
                    if (tab) tab.location.href = data.url + hash;
                    else window.open(data.url + hash, '_blank');
                    return;
                }
            }
        } catch {
            /* network error */
        }
        if (tab) tab.location.href = 'https://lichess.org/paste';
        else window.open('https://lichess.org/paste', '_blank');
    },
    'viewer-share': (e) => {
        e.stopPropagation();
        document.getElementById('share-popover').classList.toggle('hidden');
    },
    'viewer-overflow': (e) => {
        e.stopPropagation();
        const menu = document.getElementById('overflow-menu');
        const stillHidden = menu.classList.toggle('hidden');
        if (!stillHidden) {
            const commentsBtn = document.getElementById('viewer-comments');
            const branchBtn = document.getElementById('viewer-branch');
            menu.querySelector('[data-action="overflow-comments"]')?.classList.toggle(
                'active',
                commentsBtn?.classList.contains('active'),
            );
            menu.querySelector('[data-action="overflow-branch"]')?.classList.toggle(
                'active',
                branchBtn?.classList.contains('active'),
            );
        }
    },
    'overflow-comments': (e) => {
        const showing = !toggleComments();
        document.getElementById('viewer-comments')?.classList.toggle('active', showing);
        e.target.closest('.overflow-item')?.classList.toggle('active', showing);
    },
    'overflow-branch': (e) => {
        const showing = toggleBranchMode();
        document.getElementById('viewer-branch')?.classList.toggle('active', showing);
        e.target.closest('.overflow-item')?.classList.toggle('active', showing);
    },
    'viewer-engine': () => {
        if (FEAT.localEngine) toggleEngine();
        else ACTIONS['viewer-analysis']();
    },
    'overflow-engine': () => {
        document.getElementById('overflow-menu')?.classList.add('hidden');
        if (FEAT.localEngine) toggleEngine();
        else ACTIONS['viewer-analysis']();
    },
    'engine-confirm': () => {
        if (FEAT.localEngine) {
            const v = document.querySelector('input[name="engine-variant"]:checked')?.value || 'lite';
            confirmEngineChoice(v);
        }
    },
    'engine-cancel': () => document.getElementById('engine-choice-dialog')?.classList.add('hidden'),
    'engine-pause': () => {
        if (FEAT.localEngine) toggleEnginePause();
    },
    'engine-settings': () => {
        if (FEAT.localEngine) openEngineSettings();
    },
    'engine-settings-save': () => {
        if (FEAT.localEngine) applyEngineSettings();
    },
    'engine-settings-cancel': () => document.getElementById('engine-settings-dialog')?.classList.add('hidden'),
    'overflow-analysis': () => {
        document.getElementById('overflow-menu')?.classList.add('hidden');
        ACTIONS['viewer-analysis']();
    },
    'overflow-headers': () => {
        document.getElementById('overflow-menu')?.classList.add('hidden');
        ACTIONS['editor-headers']();
    },
    // Explorer
    'explorer-start': explorerGoToStart,
    'explorer-prev': explorerGoBack,
    'explorer-next': explorerGoForward,
    'explorer-flip': flipBoard,
    'explorer-back': explorerBackToBrowser,
    'explorer-view-games': explorerBackToBrowser,
    // Browser
    'browser-explore': () => {
        if (FEAT.explorer) launchExplorer();
    },
    // Editor
    'editor-import-ok': () => {
        if (FEAT.import) doImport();
    },
    'editor-import-cancel': () => {
        if (FEAT.import) hideImportDialog();
    },
    'browser-import': () => {
        if (FEAT.import) showImportDialog();
    },
    'submit-add-moves': () => {
        if (FEAT.import) showImportDialog(true);
    },
    'viewer-submit': () => {
        if (FEAT.import) submitGame();
    },
    'editor-headers': showHeaderEditor,
    'header-save': saveHeaderEditor,
    'header-cancel': () => document.getElementById('editor-header-popup')?.classList.add('hidden'),
    'dirty-copy-leave': () => resolveDirtyDialog('copy-leave'),
    'dirty-discard': () => resolveDirtyDialog('discard'),
    'dirty-cancel': () => resolveDirtyDialog('cancel'),
    // Share
    'share-copy-pgn': () => handleShareAction('copy-pgn'),
    'share-copy-link': () => handleShareAction('copy-link'),
    'share-download': () => handleShareAction('download'),
    'share-native': () => handleShareAction('share'),
    'close-panel': closeGamePanel,
};

function handleShareAction(action) {
    document.getElementById('share-popover').classList.add('hidden');
    document.getElementById('overflow-menu')?.classList.add('hidden');
    const pgn = getGamePgn();
    if (!pgn) return;
    if (action === 'copy-pgn') {
        navigator.clipboard.writeText(getGameMoves() || pgn).then(
            () => showToast('Moves copied!', 'success'),
            () => showToast('Could not copy to clipboard', 'error'),
        );
    } else if (action === 'copy-link') {
        const gameId = getHeader(pgn, 'GameId');
        const url = gameId ? `https://tnmpairings.com?game=${gameId}` : window.location.href.split('?')[0];
        navigator.clipboard.writeText(url).then(
            () => showToast('Link copied!', 'success'),
            () => showToast('Could not copy to clipboard', 'error'),
        );
    } else if (action === 'download') {
        const w = getHeader(pgn, 'White')?.split(',')[0] || 'White';
        const b = getHeader(pgn, 'Black')?.split(',')[0] || 'Black';
        const d = (getHeader(pgn, 'Date') || '').replace(/\./g, '');
        downloadPgn(pgn, d ? `${w}-${b}-${d}.pgn` : `${w}-${b}.pgn`);
    } else if (action === 'share') {
        const gameId = getHeader(pgn, 'GameId');
        const url = gameId ? `https://tnmpairings.com?game=${gameId}` : window.location.href.split('?')[0];
        navigator
            .share({
                title: `${formatName(getHeader(pgn, 'White'))} vs ${formatName(getHeader(pgn, 'Black'))} — ${getHeader(pgn, 'Result')}`,
                url,
            })
            .catch(() => {});
    }
}

function handleBrowserExport() {
    const gameIds = getGroupedGames()
        .flatMap((g) => g.games)
        .filter((g) => g.gameId)
        .map((g) => g.gameId);
    if (!gameIds.length) {
        showToast('No games to export', 'error');
        return;
    }
    const games = gameIds.map((id) => getCachedGame(id)).filter((g) => g?.pgn);
    if (!games.length) {
        showToast('No PGN data available', 'error');
        return;
    }
    const playerName = getPlayer();
    let filename;
    if (playerName) {
        const parts = [playerName.replace(/\s+/g, '-')];
        const t = getFilter('tournament');
        if (t) parts.push(t);
        filename = parts.join('-') + '.pgn';
    } else {
        filename = `games-R${games[0]?.round || 'all'}.pgn`;
    }
    downloadPgn(games.map((g) => g.pgn).join('\n\n'), filename);
    showToast(`${games.length} game${games.length > 1 ? 's' : ''} exported`, 'success');
}

// --- Event listeners ---

document.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
        if (actionBtn.hasAttribute('data-hold')) return;
        const handler = ACTIONS[actionBtn.dataset.action];
        if (handler) {
            handler(e);
            return;
        }
    }
    if (e.target.classList.contains('modal-backdrop') && e.target.closest('#viewer-modal')) {
        closeGamePanel();
        return;
    }
    if (!e.target.closest('.share-btn-wrapper') && !e.target.closest('.overflow-btn-wrapper')) {
        document.getElementById('share-popover')?.classList.add('hidden');
    }
    if (!e.target.closest('.overflow-btn-wrapper')) {
        document.getElementById('overflow-menu')?.classList.add('hidden');
    }
    if (e.target.closest('#browser-export')) {
        handleBrowserExport();
        return;
    }
    const nagBtn = e.target.closest('.nag-btn');
    if (nagBtn) {
        toggleNag(parseInt(nagBtn.dataset.nag, 10));
        return;
    }
});

// Hold-to-repeat for nav buttons
{
    let timer = null;
    const stop = () => {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
    };
    document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('[data-hold][data-action]');
        if (!btn) return;
        const action = ACTIONS[btn.dataset.action];
        if (!action) return;
        e.preventDefault();
        action();
        timer = setTimeout(() => {
            timer = setInterval(action, 80);
        }, 400);
    });
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
}

document.addEventListener('keydown', (e) => {
    const viewerModal = document.getElementById('viewer-modal');
    if (viewerModal && !viewerModal.classList.contains('hidden')) {
        trapFocus(e, 'viewer-modal');
        handlePanelKeydown(e);
        if (e.key === 'Escape') closeGamePanel();
    }
});

// --- Piece image patching ---

function patchPieceImages(root) {
    const imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    for (const img of imgs) {
        const match = img.getAttribute('src')?.match(/\/pieces\/(\w+)\.webp$/);
        if (match && PIECE_URLS[match[1]]) img.src = PIECE_URLS[match[1]];
    }
    // Also patch if root itself is an img
    if (root.tagName === 'IMG') {
        const match = root.getAttribute('src')?.match(/\/pieces\/(\w+)\.webp$/);
        if (match && PIECE_URLS[match[1]]) root.src = PIECE_URLS[match[1]];
    }
}

// --- Init & public API ---

function init() {
    // Create mount points (tnmp class scopes the CSS reset)
    const gameMount = document.createElement('div');
    gameMount.id = 'game-panel-mount';
    gameMount.className = 'tnmp';
    document.body.appendChild(gameMount);

    const styleMount = document.createElement('div');
    styleMount.id = 'style-mount';
    styleMount.className = 'tnmp';
    document.body.appendChild(styleMount);

    const profileMount = document.createElement('div');
    profileMount.id = 'profile-mount';
    profileMount.className = 'tnmp';
    document.body.appendChild(profileMount);

    // Set embed style defaults (only if user hasn't customized)
    if (!localStorage.getItem('appScheme')) localStorage.setItem('appScheme', 'mi-light');
    if (!localStorage.getItem('pieceTheme')) localStorage.setItem('pieceTheme', 'cburnett');
    if (!localStorage.getItem('boardLight')) localStorage.setItem('boardLight', '#f0f0e0');
    if (!localStorage.getItem('boardDark')) localStorage.setItem('boardDark', '#668d4e');

    // Init modules
    initGamePanel(gameMount, { features: FEAT });
    initStyle(styleMount);
    if (FEAT.playerProfiles) initPlayerProfile(profileMount);

    // Embed branding
    const brand = document.createElement('a');
    brand.href = 'https://tnmpairings.com';
    brand.target = '_blank';
    brand.rel = 'noopener';
    brand.className = 'embed-brand';
    brand.textContent = 'Powered by TNM Pairings';
    document.querySelector('.modal-content-viewer')?.appendChild(brand);

    // Inject inline piece images (chessground CSS + icon src patches)
    injectPieces();
    patchPieceImages(document);

    // Watch for dynamically added piece images
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1) patchPieceImages(node);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    // Comments button starts active
    document.querySelector('[data-action="viewer-comments"]')?.classList.add('active');

    // Hide share on platforms without it
    if (!navigator.share) {
        document.querySelector('[data-action="share-native"]')?.classList.add('hidden');
    }

    // Hide UI for disabled features
    if (!FEAT.import) {
        document.getElementById('browser-import')?.classList.add('hidden');
        document.querySelector('[data-action="viewer-submit"]')?.classList.add('hidden');
        document.querySelector('[data-action="submit-add-moves"]')?.classList.add('hidden');
    }
    if (!FEAT.explorer) {
        document.getElementById('browser-explore')?.classList.add('hidden');
        document.querySelector('[data-action="browser-explore"]')?.classList.add('hidden');
    }

    // Prefetch game data from API
    prefetchGames({
        ...(_scriptScope && { tournamentScope: _scriptScope }),
        ...(!FEAT.globalPlayerSearch && { localPlayerSearch: true }),
    });
}

// Capture script attributes at parse time (currentScript is null inside DOMContentLoaded)
const _scriptScope = document.currentScript?.getAttribute('tournament-scope') || null;

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Public API
window.TNMPViewer = {
    open: (opts) => openGamePanel(opts),
    openGame: (gameId) => {
        fetchGames({ gameId, include: 'pgn' }).then(() => {
            const game = getCachedGame(gameId);
            if (game) openGamePanel({ game });
        });
    },
    close: closeGamePanel,
};
