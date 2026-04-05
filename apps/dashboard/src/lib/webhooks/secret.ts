import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SECRET_HEADER } from "@/lib/webhooks/constants";

const SECRET_BYTES = 24;
const SALT_BYTES = 16;
const KEY_LENGTH = 32;

export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function hashWebhookSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const hash = scryptSync(secret, salt, KEY_LENGTH).toString("base64url");
  return `${salt}:${hash}`;
}

export function verifyWebhookSecret(secret: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) {
    return false;
  }

  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) {
    return false;
  }

  const actualHash = scryptSync(secret, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHash, "base64url");

  if (actualHash.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actualHash, expected);
}
