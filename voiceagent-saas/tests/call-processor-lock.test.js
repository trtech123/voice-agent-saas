import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireOrRecoverCallLock,
  buildCallLockKey,
  releaseCallLock,
} from "../call-processor.js";

function createMockRedis() {
  return {
    set: async () => "OK",
    get: async () => null,
    eval: async () => 0,
  };
}

describe("call processor active-call lock", () => {
  const previousEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it("builds lock key with environment namespace", () => {
    const key = buildCallLockKey("tenant-1", "campaign-2", "contact-3");
    expect(key).toBe("call-lock:test:tenant-1:campaign-2:contact-3");
  });

  it("acquires lock when key is free", async () => {
    const redis = createMockRedis();
    const result = await acquireOrRecoverCallLock(redis, "k", "job-1", 900);
    expect(result).toEqual({ acquired: true, ownerToken: "job-1", recovered: false });
  });

  it("recovers stalled job when lock owner token matches current job id", async () => {
    const redis = createMockRedis();
    redis.set = async () => null;
    redis.get = async () => "job-1";
    redis.eval = async (_script, _numKeys, _key, _token, ttl) => {
      expect(ttl).toBe("900");
      return 1;
    };

    const result = await acquireOrRecoverCallLock(redis, "k", "job-1", 900);
    expect(result).toEqual({ acquired: true, ownerToken: "job-1", recovered: true });
  });

  it("skips as duplicate when lock is owned by another job", async () => {
    const redis = createMockRedis();
    redis.set = async () => null;
    redis.get = async () => "job-2";

    const result = await acquireOrRecoverCallLock(redis, "k", "job-1", 900);
    expect(result).toEqual({ acquired: false, ownerToken: "job-2", recovered: false });
  });

  it("throws when Redis is unreachable (fail-closed path)", async () => {
    const redis = createMockRedis();
    redis.set = async () => {
      throw new Error("redis unavailable");
    };

    await expect(acquireOrRecoverCallLock(redis, "k", "job-1", 900)).rejects.toThrow(
      "redis unavailable",
    );
  });

  it("does not release lock if token does not match owner", async () => {
    const redis = createMockRedis();
    redis.eval = async () => 0;

    const released = await releaseCallLock(redis, "k", "job-1");
    expect(released).toBe(false);
  });
});
