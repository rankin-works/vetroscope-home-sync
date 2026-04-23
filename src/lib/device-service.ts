// SPDX-License-Identifier: Apache-2.0
//
// Device registration helpers. Isolated so /auth/register, /auth/login,
// and /setup all share the same device-limit check and row-shape.

import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import type { DeviceRow } from "../types.js";

export class DeviceLimitReachedError extends Error {
  readonly code = "DEVICE_LIMIT";
  readonly maxDevices: number;
  constructor(maxDevices: number) {
    super(`Device limit of ${maxDevices} reached for this user.`);
    this.maxDevices = maxDevices;
  }
}

export interface RegisterDeviceInput {
  id: string | null;
  deviceName: string;
  platform: string;
}

export function registerDevice(
  db: DB,
  userId: string,
  input: RegisterDeviceInput,
): string {
  const id = input.id ?? randomUUID();
  db.prepare<[string, string, string, string]>(
    "INSERT INTO devices (id, user_id, device_name, platform) VALUES (?, ?, ?, ?)",
  ).run(id, userId, input.deviceName, input.platform);
  return id;
}

export function findDevice(
  db: DB,
  userId: string,
  deviceId: string,
): DeviceRow | undefined {
  return db
    .prepare<[string, string], DeviceRow>(
      "SELECT * FROM devices WHERE id = ? AND user_id = ?",
    )
    .get(deviceId, userId);
}

export function countDevices(db: DB, userId: string): number {
  return db
    .prepare<[string], { n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE user_id = ?",
    )
    .get(userId)?.n ?? 0;
}

export function assertDeviceCapacity(
  db: DB,
  userId: string,
  maxDevices: number,
): void {
  if (countDevices(db, userId) >= maxDevices) {
    throw new DeviceLimitReachedError(maxDevices);
  }
}

export function listDevices(db: DB, userId: string): DeviceRow[] {
  return db
    .prepare<[string], DeviceRow>(
      "SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId);
}
