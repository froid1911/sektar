// The attachment tools over the real attachment client and the real document
// reducers. Only the storage under the client is stubbed, so a file that fails
// to arrive fails here the same way. The PDF renderer is the one stand-in: it
// needs a browser's canvas.
import type { getPHStore } from "@powerhousedao/reactor-browser";
import type { PhAiToolDescriptor } from "@powerhousedao/shared/document-model";
import {
  addAttachment as addEmailAttachment,
  reducer as emailReducer,
  utils as emailUtils,
} from "document-models/email";
import {
  actions as fileActions,
  addRendition,
  reducer as fileReducer,
  setAttachmentSource,
  setDocumentSource,
  utils as fileUtils,
} from "document-models/file";
import {
  addAttachment as addInvoiceAttachment,
  actions as invoiceActions,
  addLine,
  reducer as invoiceReducer,
  utils as invoiceUtils,
  voidInvoice,
} from "document-models/invoice";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fileForHandle,
  forgetHandles,
  handleFor,
  type HandledFile,
} from "./handles.js";
import { installStore } from "./test-index.js";
import { aiTools } from "./tools.js";

const pdf = vi.hoisted(() => ({ renderPdfPages: vi.fn() }));
vi.mock("./pdf-pages.js", () => pdf);

type IAttachmentService = NonNullable<
  NonNullable<ReturnType<typeof getPHStore>>["attachmentService"]
>;

const hash = (char: string) => char.repeat(64);
const refOf = (char: string) => `attachment://v${1}:${hash(char)}` as const;
const RECEIPT = refOf("a");
const LOGO = refOf("b");
const AT = "2026-10-30T12:00:00.000Z";
const JPEG = "data:image/jpeg;base64,/9j/2wBD";

function tool(name: string): PhAiToolDescriptor {
  const found = aiTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found;
}

const call = (
  name: string,
  args: unknown,
  context?: Parameters<PhAiToolDescriptor["callback"]>[1],
) =>
  tool(name).callback(args as never, context) as Promise<
    Record<string, unknown>
  >;

interface StoredFile {
  mimeType: string;
  fileName: string;
  bytes: Uint8Array;
  /** Set to report a size other than the bytes, as a cut stream would. */
  sizeBytes?: number;
}

const stored = (
  mimeType: string,
  fileName: string,
  text = "the file's bytes",
): StoredFile => ({
  mimeType,
  fileName,
  bytes: new TextEncoder().encode(text),
});

const headerOf = (file: StoredFile, ref: string) => ({
  hash: ref.slice(-64),
  mimeType: file.mimeType,
  fileName: file.fileName,
  sizeBytes: file.sizeBytes ?? file.bytes.length,
  extension: null,
  status: "available",
  source: "local",
  createdAtUtc: AT,
  lastAccessedAtUtc: AT,
  expiresAtUtc: null,
});

const bodyOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** A storage holding `files` by ref; what the tools asked for is on `calls`. */
function storage(files: Record<string, StoredFile>) {
  const calls = {
    get: [] as { ref: string; documentId?: string }[],
    reserved: [] as Record<string, unknown>[],
    sent: [] as Blob[],
  };
  const service = {
    get: (ref: string, options: { documentId?: string }) => {
      calls.get.push({ ref, documentId: options.documentId });
      const file = files[ref] as StoredFile | undefined;
      return file
        ? Promise.resolve({
            header: headerOf(file, ref),
            body: bodyOf(file.bytes),
          })
        : Promise.reject(new Error("Attachment not found"));
    },
    reserve: (options: Record<string, unknown>) => {
      calls.reserved.push(options);
      const ref = `attachment://v1:${String(options.clientHash)}`;
      return Promise.resolve({
        ref,
        send: (data: Blob) => {
          calls.sent.push(data);
          return Promise.resolve({
            hash: options.clientHash,
            ref,
            header: {},
          });
        },
      });
    },
  } as unknown as IAttachmentService;
  return { service, calls };
}

/** The browser's reader, which a Node test run does not have. */
class StubFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}

const openDocuments = (...documents: { header: { id: string } }[]) => ({
  get: (id: string) => {
    const found = documents.find((document) => document.header.id === id);
    return found
      ? Promise.resolve(found)
      : Promise.reject(new Error(`Document not found: ${id}`));
  },
});

const invoiceWithLine = () =>
  invoiceReducer(
    invoiceUtils.createDocument(),
    addLine({
      id: "line-1",
      description: "Train to Ghent",
      quantity: 1,
      unitPrice: 20,
      vatCategory: "STANDARD",
      vatRate: 21,
    }),
  );

const attachmentInput = (over: Record<string, unknown> = {}) => ({
  id: "4ae1d2b8-5d0a-4d51-a6a9-3a6d8ad1e001",
  role: "SUPPORTING" as const,
  fileName: "receipt.pdf",
  mimeType: "application/pdf",
  ref: RECEIPT as `attachment://v${number}:${string}`,
  sizeBytes: 1200,
  addedAt: AT,
  ...over,
});

/** A stored file on a mail, as the tools would have handed it out. */
const handleOf = (ref: string, over: Partial<HandledFile> = {}) =>
  handleFor({
    documentId: "mail-1",
    ref: ref as HandledFile["ref"],
    fileName: "receipt.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1200,
    ...over,
  });

/** A built-in tool's answer, as the host's MCP wrapper shapes it. */
interface ToolAnswer {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: object;
}

const answered = (value: object): ToolAnswer => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const toolError = (message: string): ToolAnswer => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${message}` }],
});

const CREATORS: Record<string, (input: never) => never> = {
  ADD_ATTACHMENT: invoiceActions.addAttachment as never,
  SET_ATTACHMENT_SOURCE: fileActions.setAttachmentSource as never,
};

/**
 * The host's built-in writes over the real reducers, answering as the real
 * tools do: addActions reports what each action did, and a rejected action is
 * stored as an operation with an error that changed nothing.
 */
function reactor(...documents: { header: { id: string } }[]) {
  type Doc = ReturnType<typeof invoiceUtils.createDocument>;
  const docs = new Map(
    (documents as Doc[]).map((document) => [document.header.id, document]),
  );
  const calls = {
    created: [] as Record<string, unknown>[],
    applied: [] as { documentId: string; actions: unknown[] }[],
    deleted: [] as string[],
  };
  const reducerFor = (document: Doc) =>
    (document.header.documentType === "sektar/file"
      ? fileReducer
      : invoiceReducer) as typeof invoiceReducer;
  const builtIns = {
    createDocument: (args: Record<string, unknown>): Promise<ToolAnswer> => {
      calls.created.push(args);
      const document = fileUtils.createDocument() as unknown as Doc;
      docs.set(document.header.id, document);
      return Promise.resolve(answered({ documentId: document.header.id }));
    },
    addActions: (args: {
      documentId: string;
      actions: { type: string; input: never }[];
    }): Promise<ToolAnswer> => {
      calls.applied.push(args);
      const document = docs.get(args.documentId);
      if (!document) return Promise.resolve(toolError("NOT_FOUND"));
      const results = args.actions.map(({ type, input }, index) => {
        const next = reducerFor(document)(document, CREATORS[type](input));
        docs.set(args.documentId, next);
        const error = next.operations.global.at(-1)?.error;
        return {
          index,
          type,
          scope: "global",
          ...(error ? { error: { kind: "reducer-error", message: error } } : {}),
        };
      });
      return Promise.resolve(
        answered({
          documentId: args.documentId,
          success: results.every((result) => !result.error),
          results,
        }),
      );
    },
    deleteDocument: (args: { documentId: string }): Promise<ToolAnswer> => {
      calls.deleted.push(args.documentId);
      docs.delete(args.documentId);
      return Promise.resolve(answered({ documentId: args.documentId }));
    },
  };
  return {
    docs,
    calls,
    builtIns,
    store: {
      reactorClient: {
        get: (id: string) => {
          const found = docs.get(id);
          return found
            ? Promise.resolve(found)
            : Promise.reject(new Error(`Document not found: ${id}`));
        },
      },
      aiTools: () =>
        Promise.resolve(
          Object.entries(builtIns).map(([name, callback]) => ({
            name,
            callback: (args: never) => callback(args),
          })),
        ),
    },
  };
}

beforeEach(() => {
  forgetHandles();
  pdf.renderPdfPages.mockReset();
  vi.stubGlobal("FileReader", StubFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sektarListAttachments", () => {
  const list = (document: { header: { id: string } }) => {
    installStore({ reactorClient: openDocuments(document) });
    return call("sektarListAttachments", { documentId: document.header.id });
  };

  it("finds an invoice's files, on the invoice and on its lines", async () => {
    const document = [
      addInvoiceAttachment(attachmentInput()),
      addInvoiceAttachment(
        attachmentInput({
          id: "4ae1d2b8-5d0a-4d51-a6a9-3a6d8ad1e002",
          lineId: "line-1",
          ref: LOGO,
          fileName: "ticket.png",
          mimeType: "image/png",
          sizeBytes: 90,
          role: "RECEIPT",
        }),
      ),
    ].reduce((doc, action) => invoiceReducer(doc, action), invoiceWithLine());

    const result = await list(document);
    expect(result).toMatchObject({
      document: { id: document.header.id, type: document.header.documentType },
      found: 2,
      items: expect.arrayContaining([
        {
          handle: expect.stringMatching(/^file-\d+$/) as string,
          fileName: "receipt.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1200,
          at: "attachments.0",
        },
        {
          handle: expect.stringMatching(/^file-\d+$/) as string,
          fileName: "ticket.png",
          mimeType: "image/png",
          sizeBytes: 90,
          at: "lines.0.attachments.0",
        },
      ]) as unknown,
    });
    expect(JSON.stringify(result)).not.toContain("attachment://");
  });

  it("gives the lines of an invoice, so a file can go on one", async () => {
    expect(await list(invoiceWithLine())).toMatchObject({
      found: 0,
      lines: [{ id: "line-1", description: "Train to Ghent" }],
    });
  });

  it("gives no lines for anything else", async () => {
    const answer = await list(fileUtils.createDocument());
    expect(answer).not.toHaveProperty("lines");
  });

  it("keeps a file's handle when it is listed again", async () => {
    const document = invoiceReducer(
      invoiceUtils.createDocument(),
      addInvoiceAttachment(attachmentInput()),
    );
    expect(await list(document)).toEqual(await list(document));
  });

  it("shows a damaged reference as damaged, without a handle", async () => {
    const document = invoiceReducer(
      invoiceUtils.createDocument(),
      addInvoiceAttachment(
        attachmentInput({ ref: `attachment://v1:${"a".repeat(78)}` }),
      ),
    );
    const result = await list(document);
    expect(result).toMatchObject({
      found: 1,
      items: [{ fileName: "receipt.pdf", damaged: true }],
    });
    expect((result.items as object[])[0]).not.toHaveProperty("handle");
    expect(JSON.stringify(result)).not.toContain("attachment://");
  });

  it("gives a message's files once each, under their real names", async () => {
    const add = (id: string, ref: string, fileName: string, inline = false) =>
      addEmailAttachment({
        id,
        ref: ref as `attachment://v${number}:${string}`,
        fileName,
        mimeType: inline ? "image/png" : "application/pdf",
        sizeBytes: 500,
        inline,
      });
    const document = [
      add("a1", RECEIPT, "attachment-1"),
      add("a2", RECEIPT, "invoice.pdf"),
      add("a3", LOGO, "logo.png", true),
    ].reduce(
      (doc, action) => emailReducer(doc, action),
      emailUtils.createDocument(),
    );

    const result = await list(document);
    expect(result).toMatchObject({
      found: 2,
      items: [
        { handle: "file-1", fileName: "invoice.pdf" },
        { handle: "file-2", fileName: "logo.png", inline: true },
      ],
    });
    expect((result.items as object[])[0]).not.toHaveProperty("inline");
    expect(fileForHandle("file-1").ref).toBe(RECEIPT);
    expect(fileForHandle("file-2").ref).toBe(LOGO);
  });

  it("gives a File's source and renditions", async () => {
    const document = [
      setAttachmentSource({
        ref: RECEIPT as `attachment://v${number}:${string}`,
        fileName: "contract.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1200,
        setAt: AT,
      }),
      addRendition({
        id: "r1",
        mimeType: "image/png",
        ref: LOGO as `attachment://v${number}:${string}`,
        fileName: "thumb.png",
        sizeBytes: 90,
        createdAt: AT,
      }),
    ].reduce(
      (doc, action) => fileReducer(doc, action),
      fileUtils.createDocument(),
    );

    expect(await list(document)).toMatchObject({
      found: 2,
      items: [
        { handle: "file-1", at: "source" },
        { handle: "file-2", at: "renditions.0" },
      ],
    });
  });

  it("says a document without stored files holds none", async () => {
    const document = fileReducer(
      fileUtils.createDocument(),
      setDocumentSource({
        documentId: "other-document",
        documentType: "sektar/invoice",
        setAt: AT,
      }),
    );
    expect(await list(document)).toMatchObject({
      found: 0,
      items: [],
      note: "The document was read and holds no stored files.",
    });
  });

  it("reports a document it cannot read as an error", async () => {
    installStore({ reactorClient: openDocuments() });
    await expect(
      call("sektarListAttachments", { documentId: "missing" }),
    ).rejects.toThrow(/could not be read.*Document not found/);
  });

  it("reports a session without documents as an error", async () => {
    installStore();
    await expect(
      call("sektarListAttachments", { documentId: "any" }),
    ).rejects.toThrow(/could not be read/);
  });
});

describe("sektarReadAttachment", () => {
  const read = (
    files: Record<string, StoredFile>,
    over: Partial<HandledFile> = {},
  ) => {
    const { service, calls } = storage(files);
    installStore({ attachmentService: service });
    return {
      calls,
      result: call("sektarReadAttachment", {
        handle: handleOf(RECEIPT, {
          fileName: (files[RECEIPT] as StoredFile | undefined)?.fileName ?? "file",
          mimeType: null,
          ...over,
        }),
      }),
    };
  };

  it("asks for the file through the document that holds it", async () => {
    const { result, calls } = read({
      [RECEIPT]: stored("image/png", "photo.png"),
    });
    await result;
    expect(calls.get).toEqual([{ ref: RECEIPT, documentId: "mail-1" }]);
  });

  it("shows an image as an image", async () => {
    const { result } = read({ [RECEIPT]: stored("image/png", "photo.png") });
    expect(await result).toMatchObject({
      structuredContent: {
        fileName: "photo.png",
        mimeType: "image/png",
        read: true,
      },
      content: [
        { type: "text" },
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("the file's bytes").toString("base64"),
        },
      ],
    });
  });

  it.each([
    ["image/jpg", "photo.jpg", "image/jpeg"],
    ["application/octet-stream", "scan.JPEG", "image/jpeg"],
    ["image/png; name=x.png", "x.png", "image/png"],
  ])("takes %s named %s for an image", async (mimeType, fileName, shownAs) => {
    const { result } = read({ [RECEIPT]: stored(mimeType, fileName) });
    expect(await result).toMatchObject({
      content: [{ type: "text" }, { type: "image", mimeType: shownAs }],
    });
  });

  it("goes by the document's own name and type over what was uploaded", async () => {
    const { result } = read(
      { [RECEIPT]: stored("application/octet-stream", "attachment") },
      { fileName: "photo.webp", mimeType: "image/webp" },
    );
    expect(await result).toMatchObject({
      structuredContent: { fileName: "photo.webp" },
      content: [{ type: "text" }, { type: "image", mimeType: "image/webp" }],
    });
  });

  it("shows a short PDF whole", async () => {
    pdf.renderPdfPages.mockResolvedValue({
      total: 3,
      pages: [1, 2, 3].map(() => ({
        dataUrl: JPEG,
        mediaType: "image/jpeg",
      })),
    });
    const { result } = read({
      [RECEIPT]: stored("application/pdf", "invoice.pdf"),
    });
    const answer = await result;
    expect(pdf.renderPdfPages.mock.calls[0][1]).toBe(5);
    expect(answer).toMatchObject({
      structuredContent: { read: true, pages: 3, pagesShown: 3 },
    });
    expect((answer.content as object[]).slice(1)).toEqual(
      [1, 2, 3].map(() => ({
        type: "image",
        data: "/9j/2wBD",
        mimeType: "image/jpeg",
      })),
    );
    expect(answer.structuredContent).not.toHaveProperty("note");
  });

  it("says when a PDF has more pages than were shown", async () => {
    pdf.renderPdfPages.mockResolvedValue({
      total: 12,
      pages: Array.from({ length: 5 }, () => ({
        dataUrl: JPEG,
        mediaType: "image/jpeg",
      })),
    });
    const { result } = read({
      [RECEIPT]: stored("application/octet-stream", "contract.PDF"),
    });
    expect(await result).toMatchObject({
      structuredContent: {
        pages: 12,
        pagesShown: 5,
        cutOff: true,
        note: expect.stringContaining("first 5 of 12 pages") as string,
      },
    });
  });

  it("says plainly that other files cannot be read, without fetching them", async () => {
    const cancel = vi.fn();
    const service = {
      get: () =>
        Promise.resolve({
          header: headerOf(stored("text/csv", "lines.csv"), RECEIPT),
          body: new ReadableStream({ cancel }),
        }),
    } as unknown as IAttachmentService;
    installStore({ attachmentService: service });
    const answer = await call("sektarReadAttachment", {
      handle: handleOf(RECEIPT, { fileName: "lines.csv", mimeType: null }),
    });
    expect(answer).toMatchObject({
      fileName: "lines.csv",
      read: false,
      note: expect.stringContaining("cannot be read") as string,
    });
    expect(answer).not.toHaveProperty("content");
    expect(cancel).toHaveBeenCalled();
  });

  it("treats an image type the chat cannot carry the same way", async () => {
    const { result } = read({ [RECEIPT]: stored("image/heic", "photo.heic") });
    expect(await result).toMatchObject({ read: false });
  });

  it("does not fetch a file too large to read", async () => {
    const huge = {
      ...stored("application/pdf", "scan.pdf"),
      sizeBytes: 60 * 1024 * 1024,
    };
    const { result } = read({ [RECEIPT]: huge });
    expect(await result).toMatchObject({
      read: false,
      note: expect.stringContaining("60 MB") as string,
    });
    expect(pdf.renderPdfPages).not.toHaveBeenCalled();
  });

  it("reports a missing file as an error, not as nothing", async () => {
    const { result } = read({});
    await expect(result).rejects.toThrow(
      /could not be loaded: Attachment not found.*unknown/,
    );
  });

  it("reports an empty file as an error", async () => {
    const { result } = read({
      [RECEIPT]: stored("application/pdf", "empty.pdf", ""),
    });
    await expect(result).rejects.toThrow(/could not be loaded.*empty/);
    expect(pdf.renderPdfPages).not.toHaveBeenCalled();
  });

  it("reports a cut-off download as an error", async () => {
    const { result } = read({
      [RECEIPT]: { ...stored("image/png", "photo.png"), sizeBytes: 9000 },
    });
    await expect(result).rejects.toThrow(/could not be loaded.*of 9000 bytes/);
  });

  it("reports a stream that fails midway as an error", async () => {
    const service = {
      get: () =>
        Promise.resolve({
          header: headerOf(stored("image/png", "photo.png"), RECEIPT),
          body: new ReadableStream({
            pull: (controller) => controller.error(new Error("socket closed")),
          }),
        }),
    } as unknown as IAttachmentService;
    installStore({ attachmentService: service });
    await expect(
      call("sektarReadAttachment", {
        handle: handleOf(RECEIPT, {
          fileName: "photo.png",
          mimeType: "image/png",
        }),
      }),
    ).rejects.toThrow(/could not be loaded: socket closed/);
  });

  it("reports a PDF it cannot open as an error", async () => {
    pdf.renderPdfPages.mockRejectedValue(new Error("Invalid PDF structure."));
    const { result } = read({
      [RECEIPT]: stored("application/pdf", "broken.pdf"),
    });
    await expect(result).rejects.toThrow(
      /PDF could not be read: Invalid PDF structure/,
    );
  });

  it("refuses a handle it never gave, and sends the model back to the list", async () => {
    const { service, calls } = storage({
      [RECEIPT]: stored("image/png", "photo.png"),
    });
    installStore({ attachmentService: service });
    await expect(
      call("sektarReadAttachment", { handle: "file-99" }),
    ).rejects.toThrow(/file-99 is not a file handle.*list the document's files/);
    expect(calls.get).toEqual([]);
  });

  it("refuses a reference typed in place of a handle, without repeating it", async () => {
    const garbled = `${RECEIPT}deadbeefdeadbeefdeadbeef`;
    const { service, calls } = storage({
      [RECEIPT]: stored("image/png", "photo.png"),
    });
    installStore({ attachmentService: service });
    const failure = await call("sektarReadAttachment", {
      handle: garbled,
    }).catch((error: unknown) => (error as Error).message);
    expect(failure).toMatch(/not a file handle/);
    expect(failure).not.toContain("attachment://");
    expect(calls.get).toEqual([]);
  });

  it("takes a mail row's handle, with the name and type the message gives", async () => {
    const message = emailReducer(
      emailUtils.createDocument(),
      addEmailAttachment({
        id: "a1",
        ref: RECEIPT,
        fileName: "photo.webp",
        mimeType: "image/webp",
        sizeBytes: 500,
      }),
    );
    const { service, calls } = storage({
      [RECEIPT]: stored("application/octet-stream", "attachment"),
    });
    installStore({
      attachmentService: service,
      reactorClient: openDocuments(message),
    });
    const handle = handleOf(RECEIPT, {
      documentId: message.header.id,
      fileName: null,
      mimeType: null,
      sizeBytes: null,
    });
    expect(await call("sektarReadAttachment", { handle })).toMatchObject({
      structuredContent: { fileName: "photo.webp" },
      content: [{ type: "text" }, { type: "image", mimeType: "image/webp" }],
    });
    expect(calls.get).toEqual([{ ref: RECEIPT, documentId: message.header.id }]);
  });

  it("says when a mail row's file has left its message", async () => {
    const message = emailUtils.createDocument();
    installStore({ reactorClient: openDocuments(message) });
    const handle = handleOf(RECEIPT, {
      documentId: message.header.id,
      fileName: null,
    });
    await expect(call("sektarReadAttachment", { handle })).rejects.toThrow(
      /no longer on its document.*list the document's files again/,
    );
  });

  it("says a saved image on no document cannot be loaded back", async () => {
    installStore({ attachmentService: storage({}).service });
    await expect(
      call("sektarReadAttachment", {
        handle: handleOf(RECEIPT, { documentId: null }),
      }),
    ).rejects.toThrow(/on no document yet/);
  });

  it("keeps a reference out of a failure's text", async () => {
    const service = {
      get: () => Promise.reject(new Error(`Forbidden: ${RECEIPT}`)),
    } as unknown as IAttachmentService;
    installStore({ attachmentService: service });
    const failure = await call("sektarReadAttachment", {
      handle: handleOf(RECEIPT),
    }).catch((error: unknown) => (error as Error).message);
    expect(failure).toMatch(/could not be loaded: Forbidden/);
    expect(failure).not.toContain("attachment://");
  });

  it("reports a session without stored files as an error", async () => {
    installStore();
    await expect(
      call("sektarReadAttachment", { handle: handleOf(RECEIPT) }),
    ).rejects.toThrow(/not available/);
  });

  it("passes the turn's signal on, so Stop stops the download", async () => {
    const seen: unknown[] = [];
    const { service } = storage({
      [RECEIPT]: stored("image/png", "photo.png"),
    });
    const get = service.get.bind(service);
    service.get = ((ref: never, options: { signal?: AbortSignal }) => {
      seen.push(options.signal);
      return get(ref, options);
    }) as never;
    installStore({ attachmentService: service });
    const { signal } = new AbortController();
    await call(
      "sektarReadAttachment",
      { handle: handleOf(RECEIPT, { fileName: "photo.png", mimeType: null }) },
      { signal },
    );
    expect(seen).toEqual([signal]);
  });
});

describe("sektarSaveChatImage", () => {
  const PNG = Buffer.from("png bytes");
  const image = (handle: string, name?: string) => ({
    handle,
    dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    mediaType: "image/png",
    name,
  });

  it("asks for approval, as a write", () => {
    expect(tool("sektarSaveChatImage").annotations?.readOnlyHint).toBe(false);
  });

  it("uploads the chat's image and returns a handle, not its reference", async () => {
    const { service, calls } = storage({});
    installStore({ attachmentService: service });
    const answer = await call(
      "sektarSaveChatImage",
      { handle: "image-2", documentId: "invoice-1" },
      { chatImages: [image("image-1", "a.png"), image("image-2", "b.png")] },
    );

    expect(answer).toMatchObject({
      handle: "file-1",
      fileName: "b.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
    });
    expect(JSON.stringify(answer)).not.toContain("attachment://");
    expect(fileForHandle("file-1")).toMatchObject({
      documentId: "invoice-1",
      fileName: "b.png",
    });
    expect(fileForHandle("file-1").ref).toMatch(
      /^attachment:\/\/v1:[0-9a-f]{64}$/,
    );
    expect(calls.reserved).toMatchObject([
      { fileName: "b.png", mimeType: "image/png", sizeBytes: PNG.length },
    ]);
    expect(Buffer.from(await calls.sent[0].arrayBuffer())).toEqual(PNG);
  });

  it("names the document, so a routing store keeps it where that document lives", async () => {
    const reserved: Record<string, unknown>[] = [];
    const { service } = storage({});
    const reserve = service.reserve.bind(service);
    service.reserve = ((options: Record<string, unknown>) => {
      reserved.push(options);
      return reserve(options as never);
    }) as never;
    installStore({ attachmentService: service });
    await call(
      "sektarSaveChatImage",
      { handle: "image-1", documentId: "invoice-1" },
      { chatImages: [image("image-1")] },
    );
    expect(reserved[0].documentId).toBe("invoice-1");
  });

  it("names a nameless paste after its handle, and takes a given name first", async () => {
    const { service } = storage({});
    installStore({ attachmentService: service });
    const nameless = await call(
      "sektarSaveChatImage",
      { handle: "image-1" },
      { chatImages: [image("image-1")] },
    );
    expect(nameless.fileName).toBe("image-1.png");
    const named = await call(
      "sektarSaveChatImage",
      { handle: "image-1", fileName: "Train ticket.png" },
      { chatImages: [image("image-1", "paste.png")] },
    );
    expect(named.fileName).toBe("Train ticket.png");
  });

  it("says the image is on no document yet", async () => {
    const { service } = storage({});
    installStore({ attachmentService: service });
    const answer = await call(
      "sektarSaveChatImage",
      { handle: "image-1" },
      { chatImages: [image("image-1")] },
    );
    expect(answer.note).toMatch(/on no document yet/);
  });

  it("names the images there are when the handle is wrong", async () => {
    const { service } = storage({});
    installStore({ attachmentService: service });
    await expect(
      call(
        "sektarSaveChatImage",
        { handle: "image-9" },
        { chatImages: [image("image-1")] },
      ),
    ).rejects.toThrow(/no image image-9.*image-1/);
    await expect(
      call("sektarSaveChatImage", { handle: "image-1" }),
    ).rejects.toThrow(/no image was attached/);
  });

  it("reports a failed upload as an error", async () => {
    const { service } = storage({});
    service.reserve = (() =>
      Promise.reject(new Error("Unauthorized"))) as never;
    installStore({ attachmentService: service });
    await expect(
      call(
        "sektarSaveChatImage",
        { handle: "image-1" },
        { chatImages: [image("image-1")] },
      ),
    ).rejects.toThrow(/not saved: Unauthorized/);
  });

  it("reports a session without stored files as an error", async () => {
    installStore();
    await expect(
      call(
        "sektarSaveChatImage",
        { handle: "image-1" },
        { chatImages: [image("image-1")] },
      ),
    ).rejects.toThrow(/not available/);
  });
});

describe("sektarAttachToInvoice", () => {
  const PNG = Buffer.from("png bytes");
  const image = {
    handle: "image-1",
    dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    mediaType: "image/png",
    name: "ticket.png",
  };

  const attach = (world: ReturnType<typeof reactor>, args: object) => {
    installStore({ ...world.store, attachmentService: storage({}).service });
    return call("sektarAttachToInvoice", args);
  };

  const invoiceIn = (world: ReturnType<typeof reactor>, id: string) =>
    world.docs.get(id)?.state.global;

  it("asks for approval, as a write", () => {
    expect(tool("sektarAttachToInvoice").annotations?.readOnlyHint).toBe(false);
  });

  it("puts the real file on the invoice through the built-in addActions", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    const answer = await attach(world, {
      handle: handleOf(RECEIPT),
      invoiceId: invoice.header.id,
      role: "SUPPORTING",
    });

    expect(answer).toMatchObject({
      attached: true,
      invoiceId: invoice.header.id,
      role: "SUPPORTING",
      fileName: "receipt.pdf",
    });
    expect(JSON.stringify(answer)).not.toContain("attachment://");
    expect(world.calls.applied).toMatchObject([
      {
        documentId: invoice.header.id,
        actions: [{ type: "ADD_ATTACHMENT" }],
      },
    ]);
    expect(invoiceIn(world, invoice.header.id)?.attachments).toMatchObject([
      {
        ref: RECEIPT,
        role: "SUPPORTING",
        fileName: "receipt.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1200,
      },
    ]);
  });

  it("puts it on a line, not on the invoice", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    await attach(world, {
      handle: handleOf(RECEIPT),
      invoiceId: invoice.header.id,
      role: "RECEIPT",
      lineId: "line-1",
    });
    const state = invoiceIn(world, invoice.header.id);
    expect(state?.attachments).toEqual([]);
    expect(state?.lines[0].attachments).toMatchObject([
      { ref: RECEIPT, role: "RECEIPT" },
    ]);
  });

  it("takes a mail row's handle, with the name and type the message gives", async () => {
    const message = emailReducer(
      emailUtils.createDocument(),
      addEmailAttachment({
        id: "a1",
        ref: RECEIPT,
        fileName: "bill.pdf",
        mimeType: "application/pdf",
        sizeBytes: 500,
      }),
    );
    const invoice = invoiceWithLine();
    const world = reactor(invoice, message);
    await attach(world, {
      handle: handleOf(RECEIPT, {
        documentId: message.header.id,
        fileName: null,
        mimeType: null,
        sizeBytes: null,
      }),
      invoiceId: invoice.header.id,
      role: "SUPPORTING",
    });
    expect(invoiceIn(world, invoice.header.id)?.attachments).toMatchObject([
      {
        ref: RECEIPT,
        fileName: "bill.pdf",
        mimeType: "application/pdf",
        sizeBytes: 500,
      },
    ]);
  });

  it("stores a file of unknown type as an octet stream", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    await attach(world, {
      handle: handleOf(RECEIPT, { mimeType: null, sizeBytes: null }),
      invoiceId: invoice.header.id,
      role: "OTHER",
    });
    expect(invoiceIn(world, invoice.header.id)?.attachments).toMatchObject([
      { mimeType: "application/octet-stream", sizeBytes: null },
    ]);
  });

  it("stores a chat image and attaches it in the one call", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    const { service, calls } = storage({});
    installStore({ ...world.store, attachmentService: service });
    const answer = await call(
      "sektarAttachToInvoice",
      { handle: "image-1", invoiceId: invoice.header.id, role: "RECEIPT" },
      { chatImages: [image] },
    );
    expect(answer).toMatchObject({ attached: true, fileName: "ticket.png" });
    expect(calls.reserved).toMatchObject([{ documentId: invoice.header.id }]);
    expect(world.calls.applied).toHaveLength(1);
    expect(invoiceIn(world, invoice.header.id)?.attachments).toMatchObject([
      {
        ref: expect.stringMatching(/^attachment:\/\/v1:[0-9a-f]{64}$/) as string,
        fileName: "ticket.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("says a void invoice took nothing, and why", async () => {
    const voided = invoiceReducer(
      invoiceWithLine(),
      voidInvoice({ reason: "Billed twice" }),
    );
    const world = reactor(voided);
    await expect(
      attach(world, {
        handle: handleOf(RECEIPT),
        invoiceId: voided.header.id,
        role: "SUPPORTING",
      }),
    ).rejects.toThrow(
      /receipt\.pdf was not attached: A void invoice takes no attachments\. It is not on the invoice/,
    );
    expect(invoiceIn(world, voided.header.id)?.attachments).toEqual([]);
  });

  it("says a line the invoice does not have took nothing", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    await expect(
      attach(world, {
        handle: handleOf(RECEIPT),
        invoiceId: invoice.header.id,
        role: "RECEIPT",
        lineId: "no-such-line",
      }),
    ).rejects.toThrow(/was not attached: No such line/);
  });

  it("reports an action a policy refused as failed", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    world.builtIns.addActions = () =>
      Promise.resolve(
        answered({
          success: false,
          results: [{ error: { kind: "denied", message: "Not your invoice" } }],
        }),
      );
    await expect(
      attach(world, {
        handle: handleOf(RECEIPT),
        invoiceId: invoice.header.id,
        role: "SUPPORTING",
      }),
    ).rejects.toThrow(/was not attached: Not your invoice/);
  });

  it("does not take a missing success for one", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    world.builtIns.addActions = () => Promise.resolve(answered({}));
    await expect(
      attach(world, {
        handle: handleOf(RECEIPT),
        invoiceId: invoice.header.id,
        role: "SUPPORTING",
      }),
    ).rejects.toThrow(/was not attached: the document did not apply it/);
  });

  it("reports a built-in's error without repeating a reference", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    world.builtIns.addActions = () =>
      Promise.resolve(toolError(`INVALID_ACTION: bad ref ${RECEIPT}`));
    const failure = await attach(world, {
      handle: handleOf(RECEIPT),
      invoiceId: invoice.header.id,
      role: "SUPPORTING",
    }).catch((error: unknown) => (error as Error).message);
    expect(failure).toMatch(/was not attached: Error: INVALID_ACTION/);
    expect(failure).not.toContain("attachment://");
  });

  it("refuses a document that is not an invoice", async () => {
    const message = emailUtils.createDocument();
    const world = reactor(message);
    await expect(
      attach(world, {
        handle: handleOf(RECEIPT),
        invoiceId: message.header.id,
        role: "SUPPORTING",
      }),
    ).rejects.toThrow(/not an invoice\. Nothing was attached/);
    expect(world.calls.applied).toEqual([]);
  });

  it("refuses an unknown handle before it touches the invoice", async () => {
    const invoice = invoiceWithLine();
    const world = reactor(invoice);
    await expect(
      attach(world, {
        handle: "file-99",
        invoiceId: invoice.header.id,
        role: "SUPPORTING",
      }),
    ).rejects.toThrow(/file-99 is not a file handle/);
    expect(world.calls.applied).toEqual([]);
  });

  it("says so when the host offers no built-in tools", async () => {
    const invoice = invoiceWithLine();
    installStore({ reactorClient: openDocuments(invoice) });
    await expect(
      call("sektarAttachToInvoice", {
        handle: handleOf(RECEIPT),
        invoiceId: invoice.header.id,
        role: "SUPPORTING",
      }),
    ).rejects.toThrow(/addActions is not available/);
  });
});

describe("sektarAddToFiles", () => {
  const PNG = Buffer.from("png bytes");
  const image = {
    handle: "image-1",
    dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    mediaType: "image/png",
    name: "ticket.png",
  };

  const add = (
    world: ReturnType<typeof reactor>,
    args: object,
    service: IAttachmentService = storage({}).service,
  ) => {
    installStore({ ...world.store, attachmentService: service });
    return call("sektarAddToFiles", args, { chatImages: [image] });
  };

  const fileIn = (world: ReturnType<typeof reactor>, id: unknown) =>
    world.docs.get(id as string)?.state.global as unknown;

  it("asks for approval, as a write", () => {
    expect(tool("sektarAddToFiles").annotations?.readOnlyHint).toBe(false);
  });

  it("creates the File with the real file as its source, in the one call", async () => {
    const world = reactor();
    const answer = await add(world, { handle: handleOf(RECEIPT) });

    expect(world.calls.created).toEqual([
      {
        documentType: "sektar/file",
        driveId: "id-of-files",
        name: "receipt.pdf",
      },
    ]);
    expect(answer).toMatchObject({ added: true, name: "receipt.pdf" });
    expect(JSON.stringify(answer)).not.toContain("attachment://");
    expect(fileIn(world, answer.documentId)).toMatchObject({
      title: "receipt.pdf",
      source: {
        kind: "ATTACHMENT",
        ref: RECEIPT,
        fileName: "receipt.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1200,
      },
    });
  });

  it("goes in the folder, under the name it is given", async () => {
    const world = reactor();
    const answer = await add(world, {
      handle: handleOf(RECEIPT),
      folderId: "folder-1",
      name: "Train ticket.pdf",
    });
    expect(world.calls.created).toMatchObject([
      { parentFolder: "folder-1", name: "Train ticket.pdf" },
    ]);
    expect(fileIn(world, answer.documentId)).toMatchObject({
      source: { fileName: "Train ticket.pdf", ref: RECEIPT },
    });
  });

  it("takes a chat image in the one call, stored under the new document", async () => {
    const world = reactor();
    const { service, calls } = storage({});
    const answer = await add(world, { handle: "image-1" }, service);

    expect(world.calls.created).toMatchObject([{ name: "ticket.png" }]);
    expect(calls.reserved).toMatchObject([
      { documentId: answer.documentId, fileName: "ticket.png" },
    ]);
    expect(world.calls.applied).toHaveLength(1);
    expect(fileIn(world, answer.documentId)).toMatchObject({
      source: {
        ref: expect.stringMatching(/^attachment:\/\/v1:[0-9a-f]{64}$/) as string,
        mimeType: "image/png",
        sizeBytes: PNG.length,
      },
    });
  });

  it("gives a handle for the file in its new place", async () => {
    const world = reactor();
    const answer = await add(world, { handle: handleOf(RECEIPT) });
    expect(fileForHandle(answer.handle as string)).toMatchObject({
      documentId: answer.documentId,
      ref: RECEIPT,
    });
  });

  it("refuses an unknown handle before it creates anything", async () => {
    const world = reactor();
    await expect(add(world, { handle: "file-99" })).rejects.toThrow(
      /file-99 is not a file handle/,
    );
    await expect(add(world, { handle: "image-9" })).rejects.toThrow(
      /no image image-9/,
    );
    expect(world.calls.created).toEqual([]);
  });

  it("says so when the document could not be created", async () => {
    const world = reactor();
    world.builtIns.createDocument = () =>
      Promise.resolve(toolError("FORBIDDEN: not allowed"));
    await expect(add(world, { handle: handleOf(RECEIPT) })).rejects.toThrow(
      /receipt\.pdf was not added to Files: Error: FORBIDDEN: not allowed\. Nothing was created/,
    );
    expect(world.calls.applied).toEqual([]);
  });

  it("takes the document back when the source was not set, and says so", async () => {
    const world = reactor();
    const { addActions } = world.builtIns;
    world.builtIns.addActions = (args) =>
      addActions(args).then(() =>
        answered({
          success: false,
          results: [{ error: { kind: "denied", message: "Not allowed" } }],
        }),
      );
    await expect(add(world, { handle: handleOf(RECEIPT) })).rejects.toThrow(
      /was not added to Files: Not allowed\. The new document was removed again/,
    );
    expect(world.calls.deleted).toHaveLength(1);
    expect(world.docs.size).toBe(0);
  });

  it("takes the document back when a chat image could not be stored", async () => {
    const world = reactor();
    const { service } = storage({});
    service.reserve = (() =>
      Promise.reject(new Error("Unauthorized"))) as never;
    await expect(add(world, { handle: "image-1" }, service)).rejects.toThrow(
      /was not added to Files: The image was not saved: Unauthorized\..*The new document was removed again/,
    );
    expect(world.calls.applied).toEqual([]);
    expect(world.calls.deleted).toHaveLength(1);
  });

  it("says what is left behind when it cannot take the document back", async () => {
    const world = reactor();
    world.builtIns.addActions = () => Promise.resolve(toolError("Offline"));
    world.builtIns.deleteDocument = () => Promise.resolve(toolError("Offline"));
    await expect(add(world, { handle: handleOf(RECEIPT) })).rejects.toThrow(
      /could not be removed.*an empty file is left in Files: tell the user/,
    );
  });
});
