// SPDX-License-Identifier: Apache-2.0
//
// WebCrypto port of the Vetroscope client-side encryption scheme,
// with a pure-JS fallback so the page works on plain http://<lan-ip>
// in addition to https://. Mirrors electron/encryption.ts so the
// desktop and the browser agree byte-for-byte. The server never sees
// plaintext or the sync key in either path.
//
//  • AES-256-GCM, 12-byte IV, 16-byte auth tag.
//  • PBKDF2-SHA256, 100k iterations, 32-byte salt → 32-byte wrapping key.
//  • Recovery code is normalized: dashes stripped, uppercased.
//  • Field ciphertext (hex): IV || authTag || ciphertext.
//  • Wrapped key  (hex): salt || IV || authTag || ciphertext.
//
// Why a fallback exists: browsers gate `crypto.subtle` to "secure
// contexts" (HTTPS or localhost). A self-hosted Home Sync running on
// http://192.168.x.y or http://<tailscale-ip>:4437 doesn't qualify, so
// `crypto.subtle` is `undefined` and every AES call would fail. We
// detect the gap up front and route through @noble/ciphers + @noble/
// hashes (vendored under ./vendor/) when WebCrypto isn't available.
// Both libraries are MIT-licensed; their LICENSE files ride along.
//
// Performance: pure-JS AES-GCM is ~5–20× slower than the native path,
// but with the per-ciphertext cache in decryptMany the practical hit
// on a typical Home Sync dataset is a couple of seconds, not minutes.

import { gcm } from "./vendor/ciphers/aes.js";
import { pbkdf2Async } from "./vendor/hashes/pbkdf2.js";
import { sha256 } from "./vendor/hashes/sha2.js";

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

const HAS_WEBCRYPTO =
  typeof crypto !== "undefined" &&
  typeof crypto.subtle !== "undefined" &&
  typeof crypto.subtle.importKey === "function";

export const cryptoBackend = HAS_WEBCRYPTO ? "webcrypto" : "noble";

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

// — Wrapping key derivation (PBKDF2-SHA256) —
async function deriveWrappingKeyBytes(recoveryCode, salt) {
  const password = enc.encode(normalizeRecovery(recoveryCode));
  if (HAS_WEBCRYPTO) {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      password,
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
    return new Uint8Array(bits);
  }
  return pbkdf2Async(sha256, password, salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_LENGTH_BYTES,
  });
}

// — AES-GCM decrypt —
//
// Both backends expect the AEAD ciphertext + auth tag concatenated as
// a single buffer. The on-wire layout writes the auth tag *before* the
// ciphertext (matching Node's `cipher.getAuthTag()` returned separately
// then concat'd ahead of `encrypted`), so the caller shuffles them
// before handing off.
async function aesGcmDecrypt(keyBytes, iv, ciphertextWithTag) {
  if (HAS_WEBCRYPTO) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertextWithTag,
    );
    return new Uint8Array(plain);
  }
  // noble's gcm() returns a cipher object with decrypt(ct||tag).
  // Throws on auth-tag mismatch, same as WebCrypto's OperationError.
  return gcm(keyBytes, iv).decrypt(ciphertextWithTag);
}

// Unwrap (decrypt) the encryption key using the recovery code.
// Returns a hex-encoded sync key, or null on failure.
export async function unwrapKey(wrappedHex, recoveryCode) {
  try {
    const data = hexToBytes(wrappedHex);
    const salt = data.slice(0, SALT_LENGTH);
    const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = data.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.slice(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const recombined = new Uint8Array(ciphertext.length + authTag.length);
    recombined.set(ciphertext, 0);
    recombined.set(authTag, ciphertext.length);

    const wrappingKey = await deriveWrappingKeyBytes(recoveryCode, salt);
    const plain = await aesGcmDecrypt(wrappingKey, iv, recombined);
    return bytesToHex(plain);
  } catch {
    return null;
  }
}

let cachedSyncKeyBytes = null;
let cachedSyncKeyHex = null;

async function getSyncKeyBytes(syncKeyHex) {
  if (cachedSyncKeyHex === syncKeyHex && cachedSyncKeyBytes !== null) {
    return cachedSyncKeyBytes;
  }
  const raw = hexToBytes(syncKeyHex);
  cachedSyncKeyBytes = raw;
  cachedSyncKeyHex = syncKeyHex;
  return raw;
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

    const keyBytes = await getSyncKeyBytes(syncKeyHex);
    const plain = await aesGcmDecrypt(keyBytes, iv, recombined);
    return dec.decode(plain);
  } catch {
    return encryptedHex;
  }
}

// Bulk decrypt: takes a list of strings, returns parallel decrypted list.
// Caches identical ciphertexts (highly redundant — the same app_name
// gets stamped onto every entry) and runs decryption in parallel batches
// so the browser doesn't block on tens of thousands of sequential
// crypto round-trips. Progress callback fires after every batch so the
// lock screen can show "decrypting 12,300 / 50,000".
export async function decryptMany(values, syncKeyHex, opts = {}) {
  // Smaller default batch on the noble path — the work is CPU-bound on
  // the main thread, so larger batches just delay the next paint without
  // improving throughput. On WebCrypto the work is in a worker thread so
  // bigger batches are fine.
  const defaultBatch = HAS_WEBCRYPTO ? 512 : 128;
  const { onProgress = null, batchSize = defaultBatch } = opts;
  const cache = new Map();
  const results = new Array(values.length);

  const uniqueIndices = new Map();
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
  cachedSyncKeyBytes = null;
  cachedSyncKeyHex = null;
}
