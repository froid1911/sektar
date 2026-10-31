import { describe, expect, it } from "vitest";
import { bindsToAny, findDrive, resolveDriveId } from "./index.js";

const drive = (id: string, slug: string) => ({ header: { id, slug } });

describe("drive lookups", () => {
  it("finds a drive by its slug or its id", () => {
    const mail = drive("generated", "mail");
    expect(findDrive([mail], "mail")).toBe(mail);
    expect(findDrive([mail], "generated")).toBe(mail);
    expect(findDrive([mail], "files")).toBeUndefined();
    expect(findDrive(undefined, "mail")).toBeUndefined();
  });

  it("resolves a slug through the reactor", async () => {
    const read = {
      get: (key: string) =>
        key === "mail"
          ? Promise.resolve({ header: { id: "generated" } })
          : Promise.reject(new Error("not found")),
    };
    expect(await resolveDriveId(read, "mail")).toBe("generated");
    expect(await resolveDriveId(read, "files")).toBeNull();
  });

  it("binds a processor to the drives it serves", () => {
    expect(bindsToAny({ slug: "mail" }, ["mail", "calendar"])).toBe(true);
    expect(bindsToAny({ slug: "vetra-1234" }, ["mail"])).toBe(false);
  });
});
