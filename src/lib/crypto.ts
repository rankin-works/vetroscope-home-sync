// SPDX-License-Identifier: Apache-2.0
//
// Password hashing (PBKDF2), HS256 JWT, and token helpers.
//
// Hash format and JWT shape are deliberately identical to the Vetroscope
// Cloud Worker's crypto module so credentials produced on either side
// verify against the other. If you change iterations, salt length, or
// JWT alg here, change them in both places — otherwise future migrations
// between Cloud and Home Sync will break.

const PBKDF2_ITERATIONS = 100_000;
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
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    HASH_LENGTH * 8,
  );

  return bufferToHex(derivedBits);
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  const computed = await hashPassword(password, salt);
  if (computed.length !== hash.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return result === 0;
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

  try {
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
