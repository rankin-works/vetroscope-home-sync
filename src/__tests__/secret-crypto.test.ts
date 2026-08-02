// SPDX-License-Identifier: Apache-2.0
//
// Sync-DEK wrapping format. The stakes here are asymmetric: a bug that
// prevents *writing* a wrap is an inconvenience, but a bug that prevents
// *reading* one loses the user's data-encryption key permanently. So the
// cases below lean on the read paths, especially the mixed-format state an
// install passes through when it adopts VS_SYNC_DEK_KEK with wraps already
// on disk.

import { describe, expect, it } from "vitest";

import { decryptSyncDek, encryptSyncDek } from "../lib/secret-crypto.js";

const JWT_SECRET = "jwt-secret-for-tests";
const KEK_HEX = "a".repeat(64);
const OTHER_KEK_HEX = "b".repeat(64);
const KEK_B64 = Buffer.alloc(32, 7).toString("base64");
const DEK = "0123456789abcdef".repeat(4); // 64 hex chars, the real DEK shape

describe("sync DEK wrapping", () => {
  it("round-trips with the legacy JWT-derived key when no KEK is set", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET);
    expect(wrap.startsWith("v2:")).toBe(false);
    expect(decryptSyncDek(wrap, JWT_SECRET)).toBe(DEK);
  });

  it("round-trips with a configured KEK and tags the blob v2", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    expect(wrap.startsWith("v2:")).toBe(true);
    expect(decryptSyncDek(wrap, JWT_SECRET, KEK_HEX)).toBe(DEK);
  });

  it("accepts a base64 KEK as well as hex", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET, KEK_B64);
    expect(decryptSyncDek(wrap, JWT_SECRET, KEK_B64)).toBe(DEK);
  });

  // The rollout case: wraps written before the KEK existed must stay
  // readable after it is configured, or adopting a KEK silently bricks
  // every existing account's sign-in recovery.
  it("still reads a legacy wrap after a KEK is adopted", () => {
    const legacy = encryptSyncDek(DEK, JWT_SECRET);
    expect(decryptSyncDek(legacy, JWT_SECRET, KEK_HEX)).toBe(DEK);
  });

  it("reads a v2 wrap even if the JWT secret has since rotated", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    expect(decryptSyncDek(wrap, "a-completely-different-secret", KEK_HEX)).toBe(
      DEK,
    );
  });

  // The mirror of the above, and the reason the v1 path is worth keeping:
  // legacy wraps are bound to the signing secret, so `vhs-cli
  // rotate-jwt-secret` destroys them. Pinned here so the coupling is a
  // documented property rather than a surprise.
  it("cannot read a legacy wrap once the JWT secret rotates", () => {
    const legacy = encryptSyncDek(DEK, JWT_SECRET);
    expect(() => decryptSyncDek(legacy, "rotated-secret")).toThrow();
  });

  it("refuses a v2 wrap when no KEK is configured", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    expect(() => decryptSyncDek(wrap, JWT_SECRET)).toThrow(/no KEK/i);
  });

  it("refuses a v2 wrap under the wrong KEK", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    expect(() => decryptSyncDek(wrap, JWT_SECRET, OTHER_KEK_HEX)).toThrow();
  });

  it("rejects a KEK that is not 32 bytes", () => {
    expect(() => encryptSyncDek(DEK, JWT_SECRET, "too-short")).toThrow(
      /32 bytes/,
    );
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const wrap = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    const [prefix, iv, ct] = wrap.split(":") as [string, string, string];
    const flipped = Buffer.from(ct, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = `${prefix}:${iv}:${flipped.toString("base64")}`;
    expect(() => decryptSyncDek(tampered, JWT_SECRET, KEK_HEX)).toThrow();
  });

  it("uses a fresh IV per call so identical plaintexts differ", () => {
    const a = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    const b = encryptSyncDek(DEK, JWT_SECRET, KEK_HEX);
    expect(a).not.toBe(b);
    expect(decryptSyncDek(a, JWT_SECRET, KEK_HEX)).toBe(DEK);
    expect(decryptSyncDek(b, JWT_SECRET, KEK_HEX)).toBe(DEK);
  });
});
