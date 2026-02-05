/**
 * Web Push Protocol implementation using crypto.subtle.
 * VAPID (RFC 8292) + Payload Encryption (RFC 8291).
 * No dependencies — runs on Cloudflare Workers.
 */

// --- Base64url helpers ---

function base64urlEncode(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + '='.repeat(padding));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// --- HKDF (RFC 5869) ---

async function hkdfExtract(salt, ikm) {
    const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const prk = await crypto.subtle.sign('HMAC', key, ikm);
    return new Uint8Array(prk);
}

async function hkdfExpand(prk, info, length) {
    const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    let t = new Uint8Array(0);
    let okm = new Uint8Array(0);
    let counter = 1;

    while (okm.length < length) {
        const input = new Uint8Array(t.length + info.length + 1);
        input.set(t, 0);
        input.set(info, t.length);
        input[t.length + info.length] = counter;
        t = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
        const next = new Uint8Array(okm.length + t.length);
        next.set(okm, 0);
        next.set(t, okm.length);
        okm = next;
        counter++;
    }

    return okm.slice(0, length);
}

async function hkdf(salt, ikm, info, length) {
    const prk = await hkdfExtract(salt, ikm);
    return hkdfExpand(prk, info, length);
}

// --- Info construction for RFC 8291 (aes128gcm) ---

function buildInfo(type) {
    const encoder = new TextEncoder();
    // For aes128gcm (RFC 8291), info is simply "Content-Encoding: <type>\0"
    const str = `Content-Encoding: ${type}\0`;
    return encoder.encode(str);
}

// --- VAPID JWT (RFC 8292) ---

async function buildVapidJwt(endpoint, privateKeyBase64url) {
    const endpointUrl = new URL(endpoint);
    const aud = endpointUrl.origin;
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

    const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({
        aud,
        exp,
        sub: 'mailto:info@tnmpairings.com',
    })));

    const unsignedToken = `${header}.${payload}`;

    // Import the VAPID private key
    const privateKeyBytes = base64urlDecode(privateKeyBase64url);
    const privateKey = await crypto.subtle.importKey(
        'jwk',
        {
            kty: 'EC',
            crv: 'P-256',
            d: privateKeyBase64url,
            // We need x and y but they'll be derived; however, importKey requires them.
            // We'll import as PKCS8 instead.
        },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    ).catch(() => {
        // JWK import may fail without x,y — use raw PKCS8
        return importPrivateKeyRaw(privateKeyBytes);
    });

    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode(unsignedToken)
    );

    // Convert DER signature to raw r||s format (each 32 bytes)
    const rawSig = derToRaw(new Uint8Array(signature));

    return `${unsignedToken}.${base64urlEncode(rawSig)}`;
}

/**
 * Import a raw 32-byte P-256 private key scalar as a CryptoKey.
 */
async function importPrivateKeyRaw(privateKeyBytes) {
    // Build PKCS8 wrapper around the raw 32-byte key
    // PKCS8 header for EC P-256
    const pkcs8Header = new Uint8Array([
        0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06,
        0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
        0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
        0x01, 0x04, 0x20,
    ]);
    const pkcs8 = new Uint8Array(pkcs8Header.length + privateKeyBytes.length);
    pkcs8.set(pkcs8Header, 0);
    pkcs8.set(privateKeyBytes, pkcs8Header.length);

    return crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );
}

/**
 * Convert DER-encoded ECDSA signature to raw 64-byte r||s format.
 * crypto.subtle may return either format depending on the platform.
 */
function derToRaw(der) {
    // If it's already 64 bytes, it's raw format
    if (der.length === 64) return der;

    // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
    if (der[0] !== 0x30) return der;

    let offset = 2;
    const rLen = der[offset + 1];
    const r = der.slice(offset + 2, offset + 2 + rLen);
    offset += 2 + rLen;
    const sLen = der[offset + 1];
    const s = der.slice(offset + 2, offset + 2 + sLen);

    // Pad or trim to 32 bytes each
    const raw = new Uint8Array(64);
    raw.set(r.length > 32 ? r.slice(r.length - 32) : r, 32 - Math.min(r.length, 32));
    raw.set(s.length > 32 ? s.slice(s.length - 32) : s, 64 - Math.min(s.length, 32));
    return raw;
}

// --- Payload Encryption (RFC 8291 / aes128gcm) ---

async function encryptPayload(subscription, payload) {
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));

    // Decode subscriber keys
    const clientPublicKey = base64urlDecode(subscription.keys.p256dh);
    const authSecret = base64urlDecode(subscription.keys.auth);

    // Generate ephemeral ECDH key pair
    const serverKeys = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
    );

    // Export server public key (uncompressed, 65 bytes)
    const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));

    // Import client public key for ECDH
    const clientKey = await crypto.subtle.importKey(
        'raw',
        clientPublicKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );

    // ECDH shared secret
    const sharedSecret = new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: 'ECDH', public: clientKey },
            serverKeys.privateKey,
            256
        )
    );

    // RFC 8291: IKM = HKDF(auth, sharedSecret, "WebPush: info\0" || clientPub || serverPub, 32)
    const webPushInfo = new Uint8Array([
        ...encoder.encode('WebPush: info\0'),
        ...clientPublicKey,
        ...serverPublicKeyRaw,
    ]);
    const ikm = await hkdf(authSecret, sharedSecret, webPushInfo, 32);

    // Generate 16-byte salt
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // Derive CEK and nonce using aes128gcm info strings (RFC 8291)
    const cekInfo = buildInfo('aes128gcm');
    const nonceInfo = buildInfo('nonce');

    const cek = await hkdf(salt, ikm, cekInfo, 16);
    const nonce = await hkdf(salt, ikm, nonceInfo, 12);

    // aes128gcm padding: plaintext + delimiter byte 0x02 (single record, no padding)
    const padded = new Uint8Array(payloadBytes.length + 1);
    padded.set(payloadBytes, 0);
    padded[payloadBytes.length] = 2; // delimiter: final record

    // AES-128-GCM encrypt
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
    );

    // Build aes128gcm content coding header:
    // salt (16) || rs (4, big-endian uint32) || idlen (1) || keyid (65) || encrypted
    const recordSize = padded.length + 16; // padded plaintext + AES-GCM tag (16 bytes)
    const header = new Uint8Array(16 + 4 + 1 + serverPublicKeyRaw.length);
    header.set(salt, 0);
    const rs = new DataView(header.buffer, 16, 4);
    rs.setUint32(0, recordSize);
    header[20] = serverPublicKeyRaw.length;
    header.set(serverPublicKeyRaw, 21);

    // Combine header + encrypted data
    const body = new Uint8Array(header.length + encrypted.length);
    body.set(header, 0);
    body.set(encrypted, header.length);

    return body;
}

// --- Send Push Notification ---

/**
 * Send a push notification to a subscription.
 * @param {object} subscription - { endpoint, keys: { p256dh, auth } }
 * @param {object|string} payload - The notification payload (will be JSON.stringified if object)
 * @param {object} env - Worker env with VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
 * @returns {{ success: boolean, status?: number, gone?: boolean, error?: string }}
 */
export async function sendPushNotification(subscription, payload, env) {
    try {
        const jwt = await buildVapidJwt(subscription.endpoint, env.VAPID_PRIVATE_KEY);
        const vapidPublicKey = env.VAPID_PUBLIC_KEY;

        const body = await encryptPayload(subscription, payload);

        const response = await fetch(subscription.endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `vapid t=${jwt},k=${vapidPublicKey}`,
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                'TTL': '86400',
                'Urgency': 'high',
            },
            body,
        });

        if (response.status === 201 || response.status === 200) {
            return { success: true, status: response.status };
        }

        if (response.status === 410 || response.status === 404) {
            return { success: false, status: response.status, gone: true };
        }

        const text = await response.text().catch(() => '');
        return { success: false, status: response.status, error: text || `HTTP ${response.status}` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
