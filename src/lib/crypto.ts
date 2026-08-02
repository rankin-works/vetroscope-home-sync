// SPDX-License-Identifier: Apache-2.0
//
// Password hashing (PBKDF2), HS256 JWT, and token helpers.
//
// The hash encoding is a stored format: `password_hash` rows on disk were
// produced by these exact parameters, and there is no rehash-on-login path
// yet. Changing PBKDF2_ITERATIONS, SALT_LENGTH, or the digest without one
// makes every existing password unverifiable — locking every user out with
// no recovery short of an admin reset. Add the migration path first.

// Iteration count for password hashes written from now on. OWASP's current
// floor for PBKDF2-HMAC-SHA256 is 600k; the original 100k predates it.
export const PBKDF2_ITERATIONS = 600_000;

// What `users.password_hash` rows created before migration 025 were hashed
// with. A NULL/absent `password_iterations` means "hashed at this count".
// Never verify at the current default — that breaks every existing password.
export const LEGACY_PBKDF2_ITERATIONS = 100_000;

// Setup codes and invite codes are hashed with the same primitive but are a
// different problem, and are pinned here on purpose:
//
//   1. They are server-generated 60-bit random codes, not user-chosen
//      passwords. Brute force is bounded by their entropy, not by the KDF,
//      so a heavier work factor buys almost nothing.
//   2. Their hashes are already on disk. Raising the count would make every
//      outstanding invite fail to verify — and a server whose first-boot
//      setup code was issued but not yet redeemed could never be set up at
//      all, with no way to reissue.
//   3. consumeInvite() hashes once per outstanding invite to find a match,
//      so the cost here is multiplied by the number of open invites on
//      every registration attempt.
export const TOKEN_HASH_ITERATIONS = 100_000;

const SALT_LENGTH = 32;
const HASH_LENGTH = 64;

function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const view =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function generateSalt(): string {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return bufferToHex(salt);
}

export async function hashPassword(
  password: string,
  salt: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    HASH_LENGTH * 8,
  );

  return bufferToHex(derivedBits);
}

/**
 * Verify against the iteration count the stored hash was actually produced
 * with. Pass `users.password_iterations`; NULL or omitted is read as the
 * legacy count, which is what pre-025 rows were hashed at.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
  iterations?: number | null,
): Promise<boolean> {
  const computed = await hashPassword(
    password,
    salt,
    iterations ?? LEGACY_PBKDF2_ITERATIONS,
  );
  if (computed.length !== hash.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return result === 0;
}

// A syntactically valid salt + hash that nothing verifies against, used to
// spend the same work on an unknown email as on a real one. Without it, a
// miss returns in ~0ms while a hit costs a full derivation, and that gap
// enumerates which addresses have accounts.
const DUMMY_SALT = "00".repeat(SALT_LENGTH);
const DUMMY_HASH = "00".repeat(HASH_LENGTH);

/**
 * Spend a verification's worth of work and return false. Call on the
 * user-not-found branch so its timing matches found-but-wrong-password.
 *
 * Costed at the CURRENT count, not the legacy one. Mid-migration there are
 * two populations, and this choice decides which way the residual gap
 * points: at the current count, unknown emails match upgraded accounts and
 * only the shrinking legacy set answers faster. At the legacy count, every
 * upgraded account would answer slower instead — a set that grows, so the
 * oracle would worsen over time rather than closing.
 */
export async function verifyPasswordDummy(password: string): Promise<boolean> {
  return verifyPassword(password, DUMMY_HASH, DUMMY_SALT, PBKDF2_ITERATIONS);
}

export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return bufferToHex(hash);
}

export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bufferToHex(buf);
}

// Setup + invite codes surface in logs / UI, so they're generated in a
// human-friendly base32 Crockford alphabet (no I, L, O, U) and grouped
// into 4-char blocks for readability: V7K2-9ABM-X4FT.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generateHumanCode(blocks = 3, blockSize = 4): string {
  const bytes = new Uint8Array(blocks * blockSize);
  crypto.getRandomValues(bytes);
  const parts: string[] = [];
  for (let b = 0; b < blocks; b++) {
    let block = "";
    for (let i = 0; i < blockSize; i++) {
      block += CROCKFORD[bytes[b * blockSize + i]! % CROCKFORD.length];
    }
    parts.push(block);
  }
  return parts.join("-");
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────

function base64UrlEncodeBytes(data: ArrayBuffer | Uint8Array): string {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

async function getHmacKey(secret: string) {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJWT(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

export async function verifyJWT<T = Record<string, unknown>>(
  token: string,
  secret: string,
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ];

  // Everything from here on parses attacker-controlled bytes, so it all sits
  // inside the try: `atob` throws on a malformed signature segment, and an
  // uncaught throw here surfaces as a 500 with a logged stack instead of the
  // 401 a garbage token deserves.
  try {
    const key = await getHmacKey(secret);

    const sigPadded =
      signatureB64 + "=".repeat((4 - (signatureB64.length % 4)) % 4);
    const sigBase64 = sigPadded.replace(/-/g, "+").replace(/_/g, "/");
    const sigBinary = atob(sigBase64);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i);
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as T & {
      exp?: number;
    };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
