// SPDX-License-Identifier: Apache-2.0
//
// AES-256-GCM helpers for server-managed secrets (Google Calendar vault).
// Format matches the cloud Worker: `iv_b64:ciphertext_b64`.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function deriveKey(jwtSecret: string, purpose = "gcal-vault"): Buffer {
  return createHash("sha256").update(`${purpose}:${jwtSecret}`).digest();
}

/** Returns `iv_b64:ciphertext_b64`. */
export function encryptSecret(plaintext: string, jwtSecret: string): string {
  return encryptWithPurpose(plaintext, jwtSecret, "gcal-vault");
}

export function decryptSecret(blob: string, jwtSecret: string): string {
  return decryptWithPurpose(blob, jwtSecret, "gcal-vault");
}

/** Wrap/unwrap sync DEKs for default (sign-in recovery) mode. */
export function encryptSyncDek(plaintext: string, jwtSecret: string): string {
  return encryptWithPurpose(plaintext, jwtSecret, "sync-dek");
}

export function decryptSyncDek(blob: string, jwtSecret: string): string {
  return decryptWithPurpose(blob, jwtSecret, "sync-dek");
}

function encryptWithPurpose(plaintext: string, jwtSecret: string, purpose: string): string {
  const key = deriveKey(jwtSecret, purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${Buffer.concat([enc, tag]).toString("base64")}`;
}

function decryptWithPurpose(blob: string, jwtSecret: string, purpose: string): string {
  const [ivB64, cipherB64] = blob.split(":");
  if (!ivB64 || !cipherB64) throw new Error("Invalid ciphertext format");
  const key = deriveKey(jwtSecret, purpose);
  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(cipherB64, "base64");
  const tag = data.subarray(data.length - 16);
  const enc = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
