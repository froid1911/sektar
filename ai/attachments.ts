// The assistant's way to the stored files: which ones a document holds, what a
// file shows, storing an image attached to the chat, and putting a file on an
// invoice or in Files. The model only ever sees handles (ai/handles.ts); the
// real references stay in code. Bytes go through the same attachment client the
// screens use, named by the document that holds the ref, which is what
// authorizes a download. Writes go through the host's built-in tools, so they
// run as the signed-in user. A file that could not be loaded and a write that
// was not applied always throw: the agent feeds the error to the model, so
// neither can pass for an empty file or a job done.
import {
  getAttachmentClient,
  getPHStore,
} from "@powerhousedao/reactor-browser";
import type {
  PhAiChatImage,
  PhAiToolContext,
} from "@powerhousedao/shared/document-model";
import { generateId } from "document-model";
import { actions as fileActions } from "document-models/file";
import {
  actions as invoiceActions,
  type AttachmentRole,
} from "document-models/invoice";
import { DOC_TYPES } from "../editors/sektar/kit/data.js";
import {
  FILE_TYPE,
  fileKind,
  type AttachmentRefString,
} from "../editors/sektar/kit/files.js";
import { uniqueAttachments } from "../editors/sektar/kit/mail.js";
import {
  fileForHandle,
  handleFor,
  isFileRef,
  withoutRefs,
  type HandledFile,
} from "./handles.js";
import { clip, compact, driveIdOf, fitted, RESULT_BUDGET } from "./read.js";

/** PDF pages shown to the model per file. */
export const PDF_PAGES_SHOWN = 5;

/** Larger files are not fetched: a tab holds them in memory to read them. */
const MAX_READ_BYTES = 50 * 1024 * 1024;

const UNKNOWN = "Treat its content as unknown.";

/** What a document stores as a reference, usable or not: see isFileRef. */
const STORED_REF = /^attachment:\/\/v\d+:/;

/** An error's text as the model may see it. */
function messageOf(error: unknown): string {
  return withoutRefs(error instanceof Error ? error.message : String(error));
}

function attachmentClient() {
  const client = getAttachmentClient();
  if (!client) {
    throw new Error(
      `Stored files are not available in this session. ${UNKNOWN}`,
    );
  }
  return client;
}

/* ------------------------------------------------- what a document holds */

export interface HeldAttachment {
  ref: AttachmentRefString;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  inline: boolean;
  /** Where in the document it sits, such as lines.0.attachments.1. */
  at: string;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * Every stored file in a document's state, wherever its model keeps them:
 * anything with an attachment ref, which covers a message's files, a File's
 * source and renditions, and an invoice's attachments and those of its lines.
 */
export function attachmentsIn(state: unknown): HeldAttachment[] {
  const found: HeldAttachment[] = [];
  const walk = (value: unknown, at: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        walk(item, at ? `${at}.${index}` : `${index}`),
      );
      return;
    }
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    if (typeof entry.ref === "string" && STORED_REF.test(entry.ref)) {
      found.push({
        ref: entry.ref as AttachmentRefString,
        fileName: text(entry.fileName) ?? text(entry.name) ?? "attachment",
        mimeType: text(entry.mimeType),
        sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : null,
        inline: entry.inline === true,
        at,
      });
    }
    for (const [key, child] of Object.entries(entry)) {
      walk(child, at ? `${at}.${key}` : key);
    }
  };
  walk(state, "");
  return uniqueAttachments(found);
}

async function readDocument(documentId: string, signal?: AbortSignal) {
  const client = getPHStore()?.reactorClient;
  if (!client) {
    throw new Error(
      `Documents are not available in this session, so ${documentId} could not be read. ${UNKNOWN}`,
    );
  }
  try {
    return await client.get(documentId, undefined, signal);
  } catch (error) {
    throw new Error(
      `Document ${documentId} could not be read: ${messageOf(error)}. ${UNKNOWN}`,
      { cause: error },
    );
  }
}

const globalState = (document: { state: unknown }) =>
  (document.state as { global?: unknown }).global;

/** A row for the model: the handle stands in for the reference. */
function fileRow(documentId: string, file: HeldAttachment) {
  const usable = isFileRef(file.ref);
  return compact({
    handle: usable
      ? handleFor({
          documentId,
          ref: file.ref,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        })
      : null,
    fileName: clip(file.fileName, 120),
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    inline: file.inline || null,
    damaged: usable ? null : true,
    at: file.at,
  });
}

/** What the invoice's lines are, for attaching a file to one. */
function invoiceLines(state: unknown) {
  const { lines = [] } = state as {
    lines?: { id: string; description?: string | null }[];
  };
  const rows = lines.map((line) =>
    compact({ id: line.id, description: clip(line.description, 80) }),
  );
  const kept = fitted(rows, RESULT_BUDGET / 4);
  return compact({
    lines: kept,
    linesCutOff: kept.length < rows.length || null,
  });
}

/** The document's stored files, for the model to read or attach elsewhere. */
export async function readDocumentAttachments(
  documentId: string,
  signal?: AbortSignal,
) {
  const document = await readDocument(documentId, signal);
  const { id, documentType, name } = document.header;
  const global = globalState(document);
  return {
    document: compact({ id, type: documentType, name: clip(name, 120) }),
    rows: attachmentsIn(global).map((file) => fileRow(id, file)),
    beside: documentType === DOC_TYPES.invoice ? invoiceLines(global) : {},
  };
}

/** A file with its name known, ready to read or to put on a document. */
type NamedFile = HandledFile & { fileName: string };

/**
 * The file behind a handle. Only a mail row's handle comes without a name, type
 * and size: those are read from the message, the way a list would give them.
 */
async function namedFile(
  handle: string,
  signal?: AbortSignal,
): Promise<NamedFile> {
  const file = fileForHandle(handle);
  if (file.fileName !== null) return { ...file, fileName: file.fileName };
  const documentId = file.documentId ?? "";
  const document = await readDocument(documentId, signal);
  const held = attachmentsIn(globalState(document)).find(
    (candidate) => candidate.ref === file.ref,
  );
  if (!held) {
    throw new Error(
      `${handle} is no longer on its document: list the document's files again.`,
    );
  }
  const named = {
    documentId,
    ref: file.ref,
    fileName: held.fileName,
    mimeType: held.mimeType,
    sizeBytes: held.sizeBytes,
  };
  handleFor(named);
  return named;
}

/* -------------------------------------------------------- showing a file */

/** An image for the model, as the chat holds one. */
interface ShownImage {
  dataUrl: string;
  mediaType: string;
}

/** A result with images, as an MCP tool returns one: the agent shows them. */
export function withImages(value: object, images: readonly ShownImage[]) {
  return {
    content: [
      { type: "text", text: JSON.stringify(value) },
      ...images.map((image) => ({
        type: "image",
        data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
        mimeType: image.mediaType,
      })),
    ],
    structuredContent: value,
  };
}

const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** The type the chat can carry this image under, if it can. */
function chatImageType(
  mimeType: string,
  fileName: string,
  chatTypes: readonly string[],
): string | undefined {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (chatTypes.includes(mime)) return mime;
  if (mime === "image/jpg") return "image/jpeg";
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  // Mail often stores a picture as an octet stream under a proper file name.
  return mime.startsWith("image/")
    ? undefined
    : IMAGE_TYPE_BY_EXTENSION[extension];
}

async function readBytes(
  body: ReadableStream<Uint8Array>,
  expected: number,
): Promise<Blob> {
  const blob = await new Response(body).blob();
  if (blob.size === 0) throw new Error("the file came back empty");
  if (expected > 0 && blob.size !== expected) {
    throw new Error(`only ${blob.size} of ${expected} bytes arrived`);
  }
  return blob;
}

export interface ReadAttachmentInput {
  handle: string;
}

/**
 * Loads a file by handle and shows it to the model: an image as it is, a PDF as
 * images of its first pages. Anything else comes back as a statement that it
 * cannot be read; a failed load throws.
 */
export async function readAttachment(
  input: ReadAttachmentInput,
  signal?: AbortSignal,
): Promise<unknown> {
  const held = await namedFile(input.handle, signal);
  if (held.documentId === null) {
    throw new Error(
      `${input.handle} is on no document yet, so it cannot be loaded. Put it on one first; an image attached to this chat is already in front of you.`,
    );
  }
  const client = attachmentClient();
  const failed = (error: unknown) =>
    new Error(
      `The file could not be loaded: ${messageOf(error)}. ${UNKNOWN} If it was attached moments ago, try again shortly; otherwise list the document's files again.`,
      { cause: error },
    );

  let response;
  try {
    response = await client.download({
      documentId: held.documentId,
      ref: held.ref,
      signal,
    });
  } catch (error) {
    throw failed(error);
  }
  const { header, body } = response;
  const { fileName } = held;
  const mimeType = held.mimeType ?? header.mimeType;
  const file = { fileName, mimeType, sizeBytes: header.sizeBytes };
  const unread = (reason: string) => {
    void body.cancel().catch(() => undefined);
    return {
      ...file,
      read: false,
      note: `${reason} Say so; do not guess what it holds.`,
    };
  };

  const kind = fileKind(mimeType, fileName);
  const { CHAT_IMAGE_TYPES, readChatImage } =
    await import("@powerhousedao/reactor-browser/ai");
  const imageType =
    kind === "img"
      ? chatImageType(mimeType, fileName, CHAT_IMAGE_TYPES)
      : undefined;
  if (kind !== "pdf" && !imageType) {
    return unread(
      `This ${mimeType || "file"} cannot be read here: only images (PNG, JPEG, WebP, GIF) and PDFs can.`,
    );
  }
  if (header.sizeBytes > MAX_READ_BYTES) {
    return unread(
      `This file is ${Math.round(header.sizeBytes / (1024 * 1024))} MB, too large to read here.`,
    );
  }

  let blob: Blob;
  try {
    blob = await readBytes(body, header.sizeBytes);
  } catch (error) {
    throw failed(error);
  }
  if (imageType) {
    const image = await readChatImage(
      new File([blob], fileName, { type: imageType }),
    );
    return withImages({ ...file, read: true }, [image]);
  }

  const { renderPdfPages } = await import("./pdf-pages.js");
  let rendered;
  try {
    rendered = await renderPdfPages(blob, PDF_PAGES_SHOWN, signal);
  } catch (error) {
    throw new Error(
      `The PDF could not be read: ${messageOf(error)}. ${UNKNOWN}`,
      {
        cause: error,
      },
    );
  }
  const { total, pages } = rendered;
  return withImages(
    {
      ...file,
      read: true,
      pages: total,
      pagesShown: pages.length,
      ...(total > pages.length
        ? {
            cutOff: true,
            note: `Showing the first ${pages.length} of ${total} pages. The rest were not read, so say so if the answer could be on them.`,
          }
        : {}),
    },
    pages,
  );
}

/* --------------------------------------------- storing a chat attachment */

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function imageBytes(image: PhAiChatImage): Blob {
  const base64 = image.dataUrl.slice(image.dataUrl.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: image.mediaType });
}

const CHAT_IMAGE = /^image-\d+$/;

function chatImage(
  handle: string,
  images: readonly PhAiChatImage[] = [],
): PhAiChatImage {
  const image = images.find((candidate) => candidate.handle === handle);
  if (image) return image;
  throw new Error(
    images.length > 0
      ? `This chat has no image ${handle}. Its images are ${images.map((i) => i.handle).join(", ")}.`
      : `This chat has no image ${handle}: no image was attached to it.`,
  );
}

const chatImageName = (image: PhAiChatImage, given?: string) =>
  given?.trim() ||
  image.name ||
  `${image.handle}.${EXTENSION_BY_TYPE[image.mediaType] ?? "img"}`;

/** Uploads the image; `documentId` names the document it is going on. */
async function storeChatImage(
  image: PhAiChatImage,
  fileName: string,
  documentId: string | undefined,
  signal?: AbortSignal,
): Promise<NamedFile> {
  const client = attachmentClient();
  const file = imageBytes(image);
  let result;
  try {
    result = await client.upload({
      file,
      fileName,
      mimeType: image.mediaType,
      documentId,
      signal,
    });
  } catch (error) {
    throw new Error(
      `The image was not saved: ${messageOf(error)}. Nothing was stored, so say so.`,
      { cause: error },
    );
  }
  return {
    documentId: documentId ?? null,
    ref: result.ref,
    fileName,
    mimeType: image.mediaType,
    sizeBytes: file.size,
  };
}

export interface SaveChatImageInput {
  handle: string;
  documentId?: string;
  fileName?: string;
}

/** Stores an image attached to this chat and gives the stored file's handle. */
export async function saveChatImage(
  input: SaveChatImageInput,
  images?: readonly PhAiChatImage[],
  signal?: AbortSignal,
) {
  const image = chatImage(input.handle, images);
  const stored = await storeChatImage(
    image,
    chatImageName(image, input.fileName),
    input.documentId,
    signal,
  );
  return {
    handle: handleFor(stored),
    fileName: stored.fileName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    note: "Stored, but on no document yet. Put it on one with sektarAttachToInvoice or sektarAddToFiles, or the user will not see it anywhere.",
  };
}

/* ----------------------------------------- putting a file on a document */

/** How long undoing a half-done write may take, whatever became of the turn. */
const ROLLBACK_TIMEOUT_MS = 10_000;

interface ToolAnswer {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: unknown;
}

/**
 * A built-in tool of the host, called the way the agent calls it: same client,
 * same signature, the signed-in user's name. It asks for no approval of its
 * own, because the tool calling it already had that. A tool's own failure
 * comes back as an answer, so it is thrown here.
 */
async function callBuiltIn<T>(
  name: string,
  args: object,
  signal?: AbortSignal,
): Promise<T> {
  const tools = await getPHStore()?.aiTools?.();
  const tool = tools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} is not available in this session`);
  const answer = (await tool.callback(args as never, { signal })) as ToolAnswer;
  if (answer.isError) {
    throw new Error(answer.content?.[0]?.text ?? `${name} failed`);
  }
  return answer.structuredContent as T;
}

interface AppliedActions {
  success?: boolean;
  results?: { error?: { message: string } }[];
}

/** One action through the built-in addActions; throws unless it was applied. */
async function applyAction(
  documentId: string,
  action: { type: string; input: unknown },
  signal?: AbortSignal,
): Promise<void> {
  const applied = await callBuiltIn<AppliedActions | undefined>(
    "addActions",
    { documentId, actions: [{ type: action.type, input: action.input }] },
    signal,
  );
  if (applied?.success === true) return;
  const reasons = applied?.results?.flatMap(({ error }) =>
    error ? [error.message] : [],
  );
  throw new Error(reasons?.join("; ") || "the document did not apply it");
}

const sentence = (line: string) => (line.endsWith(".") ? line : `${line}.`);

export interface AttachToInvoiceInput {
  handle: string;
  invoiceId: string;
  role: AttachmentRole;
  lineId?: string;
}

/** Puts a file on an invoice, or on one of its lines. */
export async function attachToInvoice(
  input: AttachToInvoiceInput,
  context?: PhAiToolContext,
) {
  const { signal, chatImages } = context ?? {};
  const invoice = await readDocument(input.invoiceId, signal);
  const { id, documentType } = invoice.header;
  if (documentType !== DOC_TYPES.invoice) {
    throw new Error(
      `${input.invoiceId} is a ${documentType}, not an invoice. Nothing was attached.`,
    );
  }
  let file: NamedFile;
  if (CHAT_IMAGE.test(input.handle)) {
    const image = chatImage(input.handle, chatImages);
    file = await storeChatImage(image, chatImageName(image), id, signal);
  } else {
    file = await namedFile(input.handle, signal);
  }
  try {
    await applyAction(
      id,
      invoiceActions.addAttachment({
        id: generateId(),
        role: input.role,
        fileName: file.fileName,
        mimeType: file.mimeType || "application/octet-stream",
        ref: file.ref,
        sizeBytes: file.sizeBytes,
        lineId: input.lineId,
        addedAt: new Date().toISOString(),
      }),
      signal,
    );
  } catch (error) {
    throw new Error(
      `${file.fileName} was not attached: ${sentence(messageOf(error))} It is not on the invoice, so say so.`,
      { cause: error },
    );
  }
  return compact({
    attached: true,
    invoiceId: id,
    lineId: input.lineId,
    role: input.role,
    fileName: file.fileName,
    handle: handleFor({ ...file, documentId: id }),
  });
}

/** Takes back a document whose write failed, and says how that went. */
async function removeNewDocument(documentId: string): Promise<string> {
  try {
    await callBuiltIn(
      "deleteDocument",
      { documentId },
      AbortSignal.timeout(ROLLBACK_TIMEOUT_MS),
    );
    return "The new document was removed again, so nothing was added.";
  } catch (error) {
    return `The new document ${documentId} could not be removed (${messageOf(error)}), so an empty file is left in Files: tell the user.`;
  }
}

export interface AddToFilesInput {
  handle: string;
  folderId?: string;
  name?: string;
}

/**
 * Adds a file to Files in one approved call: the File document, in the Files
 * drive, with the file as its source. An image from the chat is stored on the
 * way, under the new document, as a routing store wants it.
 */
export async function addToFiles(
  input: AddToFilesInput,
  context?: PhAiToolContext,
) {
  const { signal, chatImages } = context ?? {};
  const driveId = driveIdOf("files");
  // A bad handle stops here, before anything is created.
  let fileName: string;
  let store: (documentId: string) => Promise<NamedFile>;
  if (CHAT_IMAGE.test(input.handle)) {
    const image = chatImage(input.handle, chatImages);
    fileName = chatImageName(image, input.name);
    store = (documentId) =>
      storeChatImage(image, fileName, documentId, signal);
  } else {
    const held = await namedFile(input.handle, signal);
    fileName = input.name?.trim() || held.fileName;
    store = () => Promise.resolve(held);
  }

  let created: { documentId: string };
  try {
    created = await callBuiltIn(
      "createDocument",
      compact({
        documentType: FILE_TYPE,
        driveId,
        name: fileName,
        parentFolder: input.folderId,
      }),
      signal,
    );
  } catch (error) {
    throw new Error(
      `${fileName} was not added to Files: ${sentence(messageOf(error))} Nothing was created, so say so.`,
      { cause: error },
    );
  }

  const { documentId } = created;
  try {
    const file = await store(documentId);
    await applyAction(
      documentId,
      fileActions.setAttachmentSource({
        ref: file.ref,
        fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        setAt: new Date().toISOString(),
      }),
      signal,
    );
    return compact({
      added: true,
      documentId,
      name: fileName,
      folderId: input.folderId,
      handle: handleFor({ ...file, documentId, fileName }),
    });
  } catch (error) {
    throw new Error(
      `${fileName} was not added to Files: ${sentence(messageOf(error))} ${await removeNewDocument(documentId)}`,
      { cause: error },
    );
  }
}
