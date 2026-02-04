/**
 * Cloudflare Pages Function — injects dynamic OG meta tags for social media crawlers.
 *
 * For regular users: passes through to static assets with zero overhead.
 * For crawlers: fetches current state from the worker and injects OG tags into the HTML.
 */

const WORKER_URL = 'https://tnmp-notifications.johnfranklinboyer.workers.dev';
const SITE_URL = 'https://tnmpairings.com';

const CRAWLER_REGEX = /facebookexternalhit|Twitterbot|Slackbot|LinkedInBot|Discordbot|TelegramBot|WhatsApp|Googlebot|bingbot|Applebot/i;

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://tnmp-notifications.johnfranklinboyer.workers.dev; frame-ancestors 'none';",
};

function addSecurityHeaders(response) {
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        newHeaders.set(key, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
}

export async function onRequest(context) {
    const { request, next } = context;
    const ua = request.headers.get('User-Agent') || '';

    // Non-crawlers: pass through with security headers
    if (!CRAWLER_REGEX.test(ua)) {
        const response = await next();
        return addSecurityHeaders(response);
    }

    // Crawlers: fetch state and inject OG tags
    try {
        const [response, stateResponse] = await Promise.all([
            next(),
            fetch(`${WORKER_URL}/og-state`, {
                signal: AbortSignal.timeout(2000),
            }).catch(() => null),
        ]);

        // If we can't get the HTML or it's not HTML, pass through
        const contentType = response.headers.get('Content-Type') || '';
        if (!contentType.includes('text/html')) {
            return response;
        }

        let html = await response.text();

        // Build OG tags from worker state or use fallbacks
        let ogTags;
        if (stateResponse?.ok) {
            const data = await stateResponse.json();
            ogTags = buildOgTags(data);
        } else {
            ogTags = buildFallbackOgTags();
        }

        // Inject OG tags: replace existing fallback OG tags and add dynamic ones
        // Remove any existing og: tags from the static HTML to avoid duplicates
        html = html.replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '');
        html = html.replace(/<meta\s+name="twitter:card"[^>]*>\s*/gi, '');

        // Insert before </head>
        html = html.replace('</head>', ogTags + '\n</head>');

        return addSecurityHeaders(new Response(html, {
            status: response.status,
            headers: response.headers,
        }));
    } catch {
        // On any error, just pass through with security headers
        const response = await next();
        return addSecurityHeaders(response);
    }
}

function buildOgTags(data) {
    const title = escapeHtml(data.title || 'Are the Pairings Up?');
    const description = escapeHtml(data.description || 'Tuesday Night Marathon pairings checker');
    const image = `${SITE_URL}/og/${data.image || 'og-yes.png'}`;
    const color = data.color || '#4CAF50';

    return `    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:url" content="${SITE_URL}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Are the Pairings Up?">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="theme-color" content="${color}">`;
}

function buildFallbackOgTags() {
    return `    <meta property="og:title" content="Are the Pairings Up?">
    <meta property="og:description" content="Tuesday Night Marathon pairings checker">
    <meta property="og:image" content="${SITE_URL}/og/og-yes.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:url" content="${SITE_URL}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Are the Pairings Up?">
    <meta name="twitter:card" content="summary_large_image">`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
