/**
 * Embed feature flags — controls what ships in the MI embed build.
 *
 * These are injected as compile-time constants via Vite `define`,
 * so disabled features are tree-shaken from the bundle.
 *
 * Defaults match the full TNMP app. Flip to false for the MI build.
 */
export default {
    /** Search autocomplete queries all players across tournaments (true)
     *  or only players in the scoped tournament's game data (false) */
    globalPlayerSearch: true,

    /** Clicking a player name opens the in-app profile modal (true)
     *  or links to their USCF ratings page (false) */
    playerProfiles: true,

    /** Show the PGN import / game submission UI */
    import: true,

    /** In-browser Stockfish engine (true) or redirect to Lichess analysis (false).
     *  Disabled: requires COEP/COOP headers on the host page for SharedArrayBuffer. */
    localEngine: false,

    /** Opening explorer button in the game browser */
    explorer: true,

    /** Theme to bake into the embed build.
     *  CSS color expressions (light-dark, rgb-from, color-mix) are resolved
     *  at build time so the embed works on any host page without cascade issues. */
    theme: {
        colorScheme: 'light',
        accent: '#5e8048',
        bg: '#fcfcfc',
        pieceTheme: 'cburnett',
        boardLight: '#f0f0e0',
        boardDark: '#668d4e',
    },
};
