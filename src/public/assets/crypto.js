// SPDX-License-Identifier: Apache-2.0
//
// WebCrypto port of the Vetroscope client-side encryption scheme.
// Mirrors electron/encryption.ts so the desktop app and this browser
// agree byte-for-byte. The server never sees plaintext or the sync key.
//
//  • AES-256-GCM, 12-byte IV, 16-byte auth tag (GCM default).
//  • PBKDF2-SHA256, 100k iterations, 32-byte salt → 32-byte wrapping key.
//  • Recovery code is normalized: dashes stripped, uppercased.
//  • Field ciphertext (hex): IV || authTag || ciphertext.
//  • Wrapped key  (hex): salt || IV || authTag || ciphertext.

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hexToBytes(hex) {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return out.join("");
}

function normalizeRecovery(code) {
  return code.replace(/-/g, "").toUpperCase();
}

async function deriveWrappingKey(recoveryCode, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(normalizeRecovery(recoveryCode)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    KEY_LENGTH_BYTES * 8,
  );
  return crypto.subtle.importKey(
    "raw",
    bits,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
}

// Unwrap (decrypt) the encryption key using the recovery code.
// Returns a hex-encoded sync key, or null on failure.
export async function unwrapKey(wrappedHex, recoveryCode) {
  try {
    const data = hexToBytes(wrappedHex);
    const salt = data.slice(0, SALT_LENGTH);
    const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    // WebCrypto's AES-GCM expects the auth tag appended to the ciphertext —
    // so we hand it everything from the end of the IV onward, which matches
    // the Node `crypto.createDecipheriv`-style layout (authTag then ciphertext)
    // because the on-disk format is salt | iv | authTag | ciphertext.
    const tagAndCipher = data.slice(SALT_LENGTH + IV_LENGTH);
    // Node's GCM produces (ciphertext, authTag) separately but the Vetroscope
    // wire format writes authTag *first*, then ciphertext. WebCrypto needs
    // the reverse: ciphertext + tag concatenated. Shuffle them.
    const authTag = tagAndCipher.slice(0, AUTH_TAG_LENGTH);
    const ciphertext = tagAndCipher.slice(AUTH_TAG_LENGTH);
    const recombined = new Uint8Array(ciphertext.length + authTag.length);
    recombined.set(ciphertext, 0);
    recombined.set(authTag, ciphertext.length);

    const wrappingKey = await deriveWrappingKey(recoveryCode, salt);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      wrappingKey,
      recombined,
    );
    return bytesToHex(new Uint8Array(plain));
  } catch {
    return null;
  }
}

let cachedSyncKey = null;
let cachedSyncKeyHex = null;

async function importSyncKey(syncKeyHex) {
  if (cachedSyncKeyHex === syncKeyHex && cachedSyncKey !== null) {
    return cachedSyncKey;
  }
  const raw = hexToBytes(syncKeyHex);
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  cachedSyncKey = key;
  cachedSyncKeyHex = syncKeyHex;
  return key;
}

// Decrypt one field ciphertext. Returns the original value on failure
// (legacy unencrypted rows ride through unchanged) so the dashboard can
// still render mixed data.
export async function decryptField(encryptedHex, syncKeyHex) {
  if (encryptedHex == null) return encryptedHex;
  if (typeof encryptedHex !== "string" || encryptedHex.length < (IV_LENGTH + AUTH_TAG_LENGTH) * 2) {
    return encryptedHex;
  }
  if (!/^[0-9a-fA-F]+$/.test(encryptedHex)) return encryptedHex;
  try {
    const data = hexToBytes(encryptedHex);
    const iv = data.slice(0, IV_LENGTH);
    const authTag = data.slice(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.slice(IV_LENGTH + AUTH_TAG_LENGTH);

    const recombined = new Uint8Array(ciphertext.length + authTag.length);
    recombined.set(ciphertext, 0);
    recombined.set(authTag, ciphertext.length);

    const key = await importSyncKey(syncKeyHex);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      recombined,
    );
    return dec.decode(plain);
  } catch {
    return encryptedHex;
  }
}

// Bulk decrypt: takes a list of strings, returns parallel decrypted list.
// Caches identical ciphertexts (highly redundant — the same app_name
// gets stamped onto every entry) and runs decryption in parallel batches
// so the browser doesn't block on tens of thousands of sequential
// WebCrypto round-trips. Progress callback fires after every batch so
// the lock screen can show "decrypting 12,300 / 50,000".
export async function decryptMany(values, syncKeyHex, opts = {}) {
  const { onProgress = null, batchSize = 512 } = opts;
  const cache = new Map();
  const results = new Array(values.length);

  // Find unique non-null ciphertexts to decrypt once each, then fan
  // results back out across positions.
  const uniqueIndices = new Map(); // ciphertext → first index encountered
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { results[i] = v; continue; }
    if (!uniqueIndices.has(v)) uniqueIndices.set(v, i);
  }

  const uniqueList = [...uniqueIndices.keys()];
  let completed = 0;
  for (let start = 0; start < uniqueList.length; start += batchSize) {
    const slice = uniqueList.slice(start, start + batchSize);
    const decoded = await Promise.all(
      slice.map((cipher) => decryptField(cipher, syncKeyHex)),
    );
    for (let j = 0; j < slice.length; j++) cache.set(slice[j], decoded[j]);
    completed += slice.length;
    if (onProgress) onProgress(completed, uniqueList.length);
    // yield to the event loop so the UI can paint a progress update
    if (start + batchSize < uniqueList.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  for (let i = 0; i < values.length; i++) {
    if (results[i] !== undefined) continue;
    results[i] = cache.get(values[i]);
  }
  return results;
}

export function clearKeyCache() {
  cachedSyncKey = null;
  cachedSyncKeyHex = null;
}
