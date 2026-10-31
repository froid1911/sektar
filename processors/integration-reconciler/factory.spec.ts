import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationReconcilerFactoryBuilder } from "./factory.js";

describe("integrationReconcilerFactoryBuilder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps its processors on a host that cannot serve its route", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = new Error("cannot host HTTP routes");

    // A throw here rejects the whole package's factory, and every index with it.
    const factory = integrationReconcilerFactoryBuilder({
      http: {
        get() {
          throw refused;
        },
      },
    } as never);

    expect(factory).toBeTypeOf("function");
    expect(warn).toHaveBeenCalledWith(expect.any(String), refused);
  });

  it("serves the runner facts where the host can", () => {
    const get = vi.fn();

    integrationReconcilerFactoryBuilder({ http: { get } } as never);

    expect(get).toHaveBeenCalledWith("runner", expect.any(Function));
  });
});
