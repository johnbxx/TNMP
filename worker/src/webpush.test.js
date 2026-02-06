import { describe, it, expect } from 'vitest';
import { base64urlEncode, base64urlDecode, derToRaw, buildInfo } from './webpush.js';

// --- base64url round-trip ---

describe('base64urlEncode / base64urlDecode', () => {
    it('round-trips empty buffer', () => {
        const buf = new Uint8Array(0);
        const encoded = base64urlEncode(buf);
        const decoded = base64urlDecode(encoded);
        expect(decoded).toEqual(buf);
    });

    it('round-trips a simple byte array', () => {
        const buf = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        const encoded = base64urlEncode(buf);
        expect(encoded).toBe('SGVsbG8'); // no padding
        const decoded = base64urlDecode(encoded);
        expect(decoded).toEqual(buf);
    });

    it('round-trips bytes that produce + and / in standard base64', () => {
        // 0xFB, 0xFF, 0xFE → standard base64 "u//+" → base64url "u__-"
        const buf = new Uint8Array([0xFB, 0xFF, 0xFE]);
        const encoded = base64urlEncode(buf);
        expect(encoded).not.toMatch(/[+/=]/);
        const decoded = base64urlDecode(encoded);
        expect(decoded).toEqual(buf);
    });

    it('round-trips a 32-byte key', () => {
        const buf = new Uint8Array(32);
        for (let i = 0; i < 32; i++) buf[i] = i;
        const encoded = base64urlEncode(buf);
        const decoded = base64urlDecode(encoded);
        expect(decoded).toEqual(buf);
    });

    it('round-trips a 65-byte public key', () => {
        const buf = new Uint8Array(65);
        buf[0] = 0x04; // uncompressed point prefix
        for (let i = 1; i < 65; i++) buf[i] = i;
        const encoded = base64urlEncode(buf);
        const decoded = base64urlDecode(encoded);
        expect(decoded).toEqual(buf);
    });

    it('handles ArrayBuffer input to encode', () => {
        const buf = new Uint8Array([1, 2, 3]).buffer;
        const encoded = base64urlEncode(buf);
        const decoded = base64urlDecode(encoded);
        expect(decoded).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('decodes a known VAPID public key', () => {
        // The actual VAPID public key from config.js
        const key = 'BKdSGlB3e8V2mPw7Mmr3wchYnk6ySS5tWsEiqJwkRMvb3Z_ArLWvaV8ZOCqAzcaFdqLyo2LJU-qP17RQMPGRzS4';
        const decoded = base64urlDecode(key);
        expect(decoded.length).toBe(65); // P-256 uncompressed public key
        expect(decoded[0]).toBe(0x04); // uncompressed point prefix
    });
});

// --- derToRaw ---

describe('derToRaw', () => {
    it('returns 64-byte input unchanged (already raw format)', () => {
        const raw = new Uint8Array(64);
        for (let i = 0; i < 64; i++) raw[i] = i;
        expect(derToRaw(raw)).toEqual(raw);
    });

    it('converts a standard DER signature to 64-byte raw', () => {
        // DER: 0x30 <totallen> 0x02 <rlen> <r...> 0x02 <slen> <s...>
        // r = 32 bytes of 0x01, s = 32 bytes of 0x02
        const r = new Uint8Array(32).fill(0x01);
        const s = new Uint8Array(32).fill(0x02);
        const der = new Uint8Array([
            0x30, 68, // SEQUENCE, total length
            0x02, 32, ...r,  // INTEGER r
            0x02, 32, ...s,  // INTEGER s
        ]);
        const raw = derToRaw(der);
        expect(raw.length).toBe(64);
        expect(raw.slice(0, 32)).toEqual(r);
        expect(raw.slice(32)).toEqual(s);
    });

    it('handles DER with leading zero padding on r', () => {
        // When the high bit of r is set, DER prepends 0x00
        const rBody = new Uint8Array(32).fill(0x80);
        const r = new Uint8Array([0x00, ...rBody]); // 33 bytes with leading zero
        const s = new Uint8Array(32).fill(0x02);
        const der = new Uint8Array([
            0x30, 69,
            0x02, 33, ...r,
            0x02, 32, ...s,
        ]);
        const raw = derToRaw(der);
        expect(raw.length).toBe(64);
        // Leading zero should be stripped, keeping last 32 bytes
        expect(raw.slice(0, 32)).toEqual(rBody);
        expect(raw.slice(32)).toEqual(s);
    });

    it('handles DER with short r (left-pads with zeros)', () => {
        const r = new Uint8Array([0x01, 0x02, 0x03]); // 3 bytes
        const s = new Uint8Array(32).fill(0x05);
        const der = new Uint8Array([
            0x30, 39,
            0x02, 3, ...r,
            0x02, 32, ...s,
        ]);
        const raw = derToRaw(der);
        expect(raw.length).toBe(64);
        // r should be left-padded to 32 bytes
        expect(raw[28]).toBe(0x00);
        expect(raw[29]).toBe(0x01);
        expect(raw[30]).toBe(0x02);
        expect(raw[31]).toBe(0x03);
    });

    it('returns non-DER input unchanged', () => {
        const notDer = new Uint8Array([0x01, 0x02, 0x03]);
        expect(derToRaw(notDer)).toEqual(notDer);
    });
});

// --- buildInfo ---

describe('buildInfo', () => {
    it('builds aes128gcm info string', () => {
        const info = buildInfo('aes128gcm');
        const expected = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
        expect(info).toEqual(expected);
    });

    it('builds nonce info string', () => {
        const info = buildInfo('nonce');
        const expected = new TextEncoder().encode('Content-Encoding: nonce\0');
        expect(info).toEqual(expected);
    });

    it('includes null terminator', () => {
        const info = buildInfo('test');
        // Last byte should be 0x00
        expect(info[info.length - 1]).toBe(0);
    });
});
