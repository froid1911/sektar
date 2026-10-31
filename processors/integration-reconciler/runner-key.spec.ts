import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadRunnerKey,
  RunnerKeyStorage,
  runnerKeyPath,
} from "./runner-key.js";

const MASTER = "ab".repeat(32);

describe("the runner key", () => {
  let dir: string;
  const env = (extra: Record<string, string> = {}) => ({
    PH_USER_DATA_DIR: dir,
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-key-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lives under the user's .ph folder, beside the host key", () => {
    expect(runnerKeyPath(env())).toBe(join(dir, ".ph", ".runner-keypair.json"));
  });

  it("survives a restart", async () => {
    const first = await loadRunnerKey(env());
    const second = await loadRunnerKey(env());
    expect(second.did).toBe(first.did);
    expect(first.did).toMatch(/^did:key:/);
  });

  it("is a different key in another environment", async () => {
    const here = await loadRunnerKey(env());
    const other = mkdtempSync(join(tmpdir(), "runner-key-"));
    const there = await loadRunnerKey({ PH_USER_DATA_DIR: other });
    rmSync(other, { recursive: true, force: true });
    expect(there.did).not.toBe(here.did);
  });

  it("signs after a restart", async () => {
    await loadRunnerKey(env());
    const key = await loadRunnerKey(env());
    const message = new TextEncoder().encode("hello");
    const signature = await key.sign(message);
    expect(await key.verify(message, signature)).toBe(true);
  });

  describe("with a master key", () => {
    const sealed = () =>
      env({ PH_WORKFLOWS_SECRETS_MASTER_KEY: MASTER });

    it("keeps no private key in the clear", async () => {
      await loadRunnerKey(sealed());
      const text = readFileSync(runnerKeyPath(env()), "utf8");
      expect(text).not.toContain("privateKey");
      expect(text).not.toContain('"d"');
      expect(JSON.parse(text)).toHaveProperty("v", 1);
    });

    it("survives a restart", async () => {
      const first = await loadRunnerKey(sealed());
      const second = await loadRunnerKey(sealed());
      expect(second.did).toBe(first.did);
    });

    it("cannot be opened without it: what a piece worker gets", async () => {
      await loadRunnerKey(sealed());
      await expect(loadRunnerKey(env())).rejects.toThrow(/is encrypted/);
    });

    it("cannot be opened with another key", async () => {
      await loadRunnerKey(sealed());
      await expect(
        loadRunnerKey(
          env({ PH_WORKFLOWS_SECRETS_MASTER_KEY: "cd".repeat(32) }),
        ),
      ).rejects.toThrow();
    });
  });

  it("has nothing to load before it was made", async () => {
    const storage = new RunnerKeyStorage(join(dir, "absent.json"));
    expect(await storage.loadKeyPair()).toBeUndefined();
  });
});
