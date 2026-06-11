import { describe, expect, test } from "bun:test";
import {
  type DependencyCheck,
  pingPostgres,
  pingRedis,
  waitForDependencies,
  withDeadline,
} from "@/lib/readiness";

const pass = (name: string): DependencyCheck => ({
  name,
  ping: async () => true,
});

describe("readiness pings", () => {
  test("pingPostgres returns true against the test database", async () => {
    expect(await pingPostgres()).toBe(true);
  });

  test("pingRedis returns true against the test redis", async () => {
    expect(await pingRedis()).toBe(true);
  });
});

describe("withDeadline", () => {
  // Bun's RedisClient queues commands while reconnecting, so a ping against a
  // dead Redis never settles on its own — the deadline is what turns "hung"
  // into "down".
  test("rejects when the work outlives the deadline", async () => {
    const never = new Promise<boolean>(() => {});

    await expect(withDeadline(never, 10)).rejects.toThrow(/timed out/);
  });

  test("passes through a result that beats the deadline", async () => {
    await expect(withDeadline(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  test("passes through a rejection that beats the deadline", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 1000),
    ).rejects.toThrow("boom");
  });
});

describe("waitForDependencies", () => {
  test("resolves when every check passes", async () => {
    await expect(
      waitForDependencies([pass("postgres"), pass("redis")], {
        attempts: 1,
        delayMs: 1,
      }),
    ).resolves.toBeUndefined();
  });

  test("retries until a flaky dependency recovers", async () => {
    let calls = 0;
    const flaky: DependencyCheck = {
      name: "postgres",
      ping: async () => {
        calls++;
        return calls >= 3;
      },
    };

    await waitForDependencies([flaky], { attempts: 5, delayMs: 1 });

    expect(calls).toBe(3);
  });

  test("throws after exhausting attempts, naming the failed dependency", async () => {
    const down: DependencyCheck = { name: "redis", ping: async () => false };

    await expect(
      waitForDependencies([pass("postgres"), down], {
        attempts: 2,
        delayMs: 1,
      }),
    ).rejects.toThrow(/redis/);
  });
});
