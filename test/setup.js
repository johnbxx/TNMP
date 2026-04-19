/**
 * Vitest setup — runs once per test worker before any test file.
 *
 * Installs fake-indexeddb as a global shim so IDB code can run in
 * node env without a DOM. BroadcastChannel, crypto.randomUUID, and
 * structuredClone are all native Node 18+ globals — no shim needed.
 */

import 'fake-indexeddb/auto';
