// @vitest-environment happy-dom
import type {
  AiGatewayStatus,
  UseAiGatewayResult,
} from "@powerhousedao/reactor-browser/ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyCard } from "./assistant.js";

// The key card of a cloud Sektar: Vetra's key reaches the switchboard as its
// demo key (hosts/cli/docker-entrypoint.sh), and the card offers it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const status = (over: Partial<AiGatewayStatus>): AiGatewayStatus =>
  ({ configured: false, demoKeyAvailable: false, ...over }) as AiGatewayStatus;

const gateway = (over: Partial<UseAiGatewayResult> = {}): UseAiGatewayResult => ({
  gateway: undefined,
  connection: undefined,
  setKey: () => Promise.resolve(),
  resetKey: () => Promise.resolve(),
  setDemoKey: () => Promise.resolve(),
  ...over,
});

const included = () =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Use the key included with your Sektar"),
  );

describe("the key a cloud Sektar comes with", () => {
  it("is offered when the host has one and no key is set, and one click stores it", async () => {
    const setDemoKey = vi.fn(() => Promise.resolve());
    act(() =>
      root.render(
        <KeyCard status={status({ demoKeyAvailable: true })} gateway={gateway({ setDemoKey })} />,
      ),
    );
    const button = included();
    expect(button).toBeDefined();
    // The typed key stays possible beside it.
    expect(host.querySelector('input[name="openrouter-key"]')).not.toBeNull();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    expect(setDemoKey).toHaveBeenCalledTimes(1);
  });

  it("is not offered by a host without one, nor once a key is set", () => {
    act(() => root.render(<KeyCard status={status({})} gateway={gateway()} />));
    expect(included()).toBeUndefined();
    act(() =>
      root.render(
        <KeyCard
          status={status({ configured: true, demoKeyAvailable: true, keyHint: "sk-or-…7c1b" })}
          gateway={gateway()}
        />,
      ),
    );
    expect(included()).toBeUndefined();
  });

  it("shows why the included key was refused", async () => {
    const setDemoKey = vi.fn(() => Promise.reject(new Error("OpenRouter refused the key")));
    act(() =>
      root.render(
        <KeyCard status={status({ demoKeyAvailable: true })} gateway={gateway({ setDemoKey })} />,
      ),
    );
    await act(async () => {
      included()!.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("OpenRouter refused the key");
  });
});
