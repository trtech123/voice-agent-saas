// packages/database/src/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const DEK_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a credential string using envelope encryption.
 * - Generates a random DEK (data encryption key)
 * - Encrypts the payload with DEK using AES-256-GCM
 * - Encrypts the DEK with the KEK
 * - Returns a JSON string containing all components
 */
export function encryptCredential(payload: string, kekBase64: string): string {
  const kek = Buffer.from(kekBase64, "base64");
  if (kek.length !== 32) throw new Error("KEK must be 32 bytes");

  // Generate random DEK and IV for payload encryption
  const dek = randomBytes(DEK_LENGTH);
  const payloadIv = randomBytes(IV_LENGTH);

  // Encrypt payload with DEK
  const payloadCipher = createCipheriv(ALGORITHM, dek, payloadIv);
  const payloadEncrypted = Buffer.concat([
    payloadCipher.update(payload, "utf8"),
    payloadCipher.final(),
  ]);
  const payloadTag = payloadCipher.getAuthTag();

  // Encrypt DEK with KEK
  const dekIv = randomBytes(IV_LENGTH);
  const dekCipher = createCipheriv(ALGORITHM, kek, dekIv);
  const dekEncrypted = Buffer.concat([
    dekCipher.update(dek),
    dekCipher.final(),
  ]);
  const dekTag = dekCipher.getAuthTag();

  return JSON.stringify({
    ciphertext: payloadEncrypted.toString("base64"),
    iv: payloadIv.toString("base64"),
    tag: payloadTag.toString("base64"),
    dek: dekEncrypted.toString("base64"),
    dekIv: dekIv.toString("base64"),
    dekTag: dekTag.toString("base64"),
  });
}

/**
 * Decrypt a credential string encrypted with encryptCredential.
 */
export function decryptCredential(encrypted: string, kekBase64: string): string {
  const kek = Buffer.from(kekBase64, "base64");
  if (kek.length !== 32) throw new Error("KEK must be 32 bytes");

  const { ciphertext, iv, tag, dek: dekEncrypted, dekIv, dekTag } = JSON.parse(encrypted);

  // Decrypt DEK with KEK
  const dekDecipher = createDecipheriv(ALGORITHM, kek, Buffer.from(dekIv, "base64"));
  dekDecipher.setAuthTag(Buffer.from(dekTag, "base64"));
  const dek = Buffer.concat([
    dekDecipher.update(Buffer.from(dekEncrypted, "base64")),
    dekDecipher.final(),
  ]);

  // Decrypt payload with DEK
  const payloadDecipher = createDecipheriv(ALGORITHM, dek, Buffer.from(iv, "base64"));
  payloadDecipher.setAuthTag(Buffer.from(tag, "base64"));
  const decrypted = Buffer.concat([
    payloadDecipher.update(Buffer.from(ciphertext, "base64")),
    payloadDecipher.final(),
  ]);

  return decrypted.toString("utf8");
}
