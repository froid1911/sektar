import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAutoApprove, writeAutoApprove } from "./auto-approve.js";

function fakeStorage(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  } as unknown as Storage;
}

describe("auto-approve", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });

  it("is off until someone turns it on", () => {
    expect(readAutoApprove("0xnew")).toBe(false);
  });

  it("is off with nobody signed in", () => {
    expect(readAutoApprove(undefined)).toBe(false);
  });

  it("belongs to one identity, not the next one in the window", () => {
    writeAutoApprove("0xa", true);

    expect(readAutoApprove("0xa")).toBe(true);
    expect(readAutoApprove("0xb")).toBe(false);
  });

  it("can be turned off again", () => {
    writeAutoApprove("0xc", true);
    writeAutoApprove("0xc", false);

    expect(readAutoApprove("0xc")).toBe(false);
    expect(localStorage.getItem("sk:assistant-auto-approve:0xc")).toBeNull();
  });

  it("still works for this session where storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });

    expect(readAutoApprove("0xd")).toBe(false);
    writeAutoApprove("0xd", true);
    expect(readAutoApprove("0xd")).toBe(true);
  });
});
