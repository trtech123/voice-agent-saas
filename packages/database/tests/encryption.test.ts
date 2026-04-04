// packages/database/tests/encryption.test.ts
import { describe, it, expect } from "vitest";
import { encryptCredential, decryptCredential } from "../src/encryption.js";

// 32-byte key, base64 encoded
const TEST_KEK = Buffer.from("a]b!c@d#e$f%g^h&i*j(k)l-m=n+o/p~", "utf8").toString("base64");

describe("envelope encryption", () => {
  it("encrypts and decrypts a credential payload", () => {
    const payload = JSON.stringify({ api_key: "sk-test-123", caller_id: "+972501234567" });
    const encrypted = encryptCredential(payload, TEST_KEK);

    // Encrypted output should not contain the original payload
    expect(encrypted).not.toContain("sk-test-123");
    expect(typeof encrypted).toBe("string");

    const decrypted = decryptCredential(encrypted, TEST_KEK);
    expect(decrypted).toBe(payload);
  });

  it("produces different ciphertext for same input (random DEK + IV)", () => {
    const payload = "same-input";
    const a = encryptCredential(payload, TEST_KEK);
    const b = encryptCredential(payload, TEST_KEK);
    expect(a).not.toBe(b);
  });

  it("throws on wrong KEK", () => {
    const payload = "secret";
    const encrypted = encryptCredential(payload, TEST_KEK);
    const wrongKek = Buffer.from("x".repeat(32), "utf8").toString("base64");
    expect(() => decryptCredential(encrypted, wrongKek)).toThrow();
  });

  it("throws on tampered ciphertext", () => {
    const payload = "secret";
    const encrypted = encryptCredential(payload, TEST_KEK);
    const parsed = JSON.parse(encrypted);
    parsed.ciphertext = parsed.ciphertext.slice(0, -4) + "AAAA";
    expect(() => decryptCredential(JSON.stringify(parsed), TEST_KEK)).toThrow();
  });
});
