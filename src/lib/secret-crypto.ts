// SPDX-License-Identifier: Apache-2.0
//
// AES-256-GCM helpers for server-managed secrets (Google Calendar vault,
// sync-key server wraps). Wire format: `iv_b64:ciphertext_b64`, optionally
// prefixed with a version tag — see below.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// Two wrapping-key sources, distinguished on the wire by a version prefix:
//
//   v1 (`iv:ct`)    — key derived from the server's JWT secret. The original
//                     scheme, and still the default when no dedicated KEK is
//                     configured. Ties secret-at-rest to the signing secret:
//                     rotating the JWT secret makes these blobs unreadable.
//   v2 (`v2:iv:ct`) — key supplied out-of-band via VS_SYNC_DEK_KEK. Independent
//                     of the JWT secret, so signing-key rotation is safe.
//
// Reads accept either form, so an install that adopts a KEK keeps working
// against wraps written before it. Writes use v2 whenever a KEK is present.
// Existing v1 blobs are left as-is rather than rewritten on read: a silent
// re-wrap during a read path would make the ciphertext depend on config
// that may be temporarily unset, and losing a DEK is unrecoverable.
const V2_PREFIX = "v2";

function deriveKey(jwtSecret: string, purpose: string): Buffer {
  return createHash("sha256").update(`${purpose}:${jwtSecret}`).digest();
}

/** Accepts a 32-byte KEK as 64 hex chars or base64. */
function importKek(kek: string): Buffer {
  const buf = /^[0-9a-f]{64}$/i.test(kek)
    ? Buffer.from(kek, "hex")
    : Buffer.from(kek, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "VS_SYNC_DEK_KEK must be 32 bytes (64 hex chars or base64)",
    );
  }
  return buf;
}

/** Returns `iv_b64:ciphertext_b64`. */
export function encryptSecret(plaintext: string, jwtSecret: string): string {
  return encryptWithPurpose(plaintext, jwtSecret, "gcal-vault", null);
}

export function decryptSecret(blob: string, jwtSecret: string): string {
  return decryptWithPurpose(blob, jwtSecret, "gcal-vault", null);
}

/** Wrap/unwrap sync DEKs for default (sign-in recovery) mode. */
export function encryptSyncDek(
  plaintext: string,
  jwtSecret: string,
  kek: string | null = null,
): string {
  return encryptWithPurpose(plaintext, jwtSecret, "sync-dek", kek);
}

export function decryptSyncDek(
  blob: string,
  jwtSecret: string,
  kek: string | null = null,
): string {
  return decryptWithPurpose(blob, jwtSecret, "sync-dek", kek);
}

function encryptWithPurpose(
  plaintext: string,
  jwtSecret: string,
  purpose: string,
  kek: string | null,
): string {
  const key = kek ? importKek(kek) : deriveKey(jwtSecret, purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = `${iv.toString("base64")}:${Buffer.concat([enc, tag]).toString("base64")}`;
  return kek ? `${V2_PREFIX}:${body}` : body;
}

function decryptWithPurpose(
  blob: string,
  jwtSecret: string,
  purpose: string,
  kek: string | null,
): string {
  const parts = blob.split(":");
  const versioned = parts.length === 3 && parts[0] === V2_PREFIX;
  const [ivB64, cipherB64] = versioned
    ? [parts[1], parts[2]]
    : [parts[0], parts[1]];
  if (!ivB64 || !cipherB64) throw new Error("Invalid ciphertext format");

  // A v2 blob can only be opened with the configured KEK; a v1 blob only
  // with the derived key. Picking by prefix rather than by current config
  // keeps both readable during and after a KEK rollout.
  if (versioned && !kek) {
    throw new Error(
      "Ciphertext was wrapped with VS_SYNC_DEK_KEK, but no KEK is configured",
    );
  }
  const key = versioned ? importKek(kek!) : deriveKey(jwtSecret, purpose);

  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(cipherB64, "base64");
  const tag = data.subarray(data.length - 16);
  const enc = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8",
  );
}
