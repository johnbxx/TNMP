/**
 * Export all subscriber records from Cloudflare KV to a local JSON file.
 * Encrypted phone numbers remain encrypted — this is a data backup, not a dump of plaintext.
 *
 * Usage: CLOUDFLARE_API_TOKEN=<token> node scripts/backup-kv.mjs
 * Output: backups/kv-backup-<timestamp>.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KV_NAMESPACE_ID = '69d27221bb904515958233a6c9481e75';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!API_TOKEN) {
    console.error('Error: CLOUDFLARE_API_TOKEN environment variable is required.');
    process.exit(1);
}

const headers = { 'Authorization': `Bearer ${API_TOKEN}` };

async function getAccountId() {
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers });
    const data = await res.json();
    if (!data.success) throw new Error(`Failed to get accounts: ${JSON.stringify(data.errors)}`);
    return data.result[0].id;
}

async function listKeys(accountId) {
    let cursor = undefined;
    const allKeys = [];

    while (true) {
        const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys`);
        if (cursor) url.searchParams.set('cursor', cursor);

        const res = await fetch(url.toString(), { headers });
        const data = await res.json();
        if (!data.success) throw new Error(`Failed to list keys: ${JSON.stringify(data.errors)}`);

        allKeys.push(...data.result);

        if (data.result_info?.cursor) {
            cursor = data.result_info.cursor;
        } else {
            break;
        }
    }

    return allKeys;
}

async function getValue(accountId, key) {
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
        { headers }
    );
    if (!res.ok) return null;
    return await res.text();
}

async function main() {
    const accountId = await getAccountId();
    console.log(`Account: ${accountId}`);

    const keys = await listKeys(accountId);
    console.log(`Found ${keys.length} keys`);

    // Only backup subscriber records and state keys (skip rate limits)
    const backupKeys = keys.filter(k => k.name.startsWith('sub:') || k.name.startsWith('state:') || k.name.startsWith('cache:'));
    console.log(`Backing up ${backupKeys.length} keys (skipping rate limits)`);

    const backup = {};
    for (const key of backupKeys) {
        process.stdout.write(`  ${key.name}...`);
        const value = await getValue(accountId, key.name);
        backup[key.name] = value;
        console.log(' done');
    }

    const backupDir = resolve(__dirname, '../backups');
    mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = resolve(backupDir, `kv-backup-${timestamp}.json`);
    writeFileSync(outFile, JSON.stringify(backup, null, 2));
    console.log(`\nBackup saved to ${outFile}`);
}

main().catch(err => { console.error(err); process.exit(1); });
