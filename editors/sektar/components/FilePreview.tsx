// Seeing what a File holds: its source of truth (a stored file, or another
// document) and each of its renditions. Shared by the File editor's preview
// pane and the Files drive app's preview pane.
import { findDrive } from "../../../processors/drives/index.js";
import {
  makeNodeSlug,
  openTarget,
  useAttachmentPreview,
  useAttachments,
  useDocumentModelModules,
  useDocumentSafe,
  useDriveNode,
  useDrives,
  useReactorClient,
} from "@powerhousedao/reactor-browser";
import type { FileDocument, FileRendition } from "document-models/file";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  bytes,
  fileKind,
  isTextual,
  KIND_LABEL,
  tileClass,
  type FileKind,
} from "../kit/files.js";
import { Badge, Button, cx, Icon, Skeleton } from "../kit/ui.js";

/* ------------------------------------------------------------ the items */

/** What a preview pane can show: the source, or one rendition. */
export type PreviewItem = { kind: "source" } | { kind: "rendition"; id: string };

export const SOURCE_ITEM: PreviewItem = { kind: "source" };

export function itemKey(item: PreviewItem): string {
  return item.kind === "source" ? "source" : `r:${item.id}`;
}

export function itemFromKey(key: string): PreviewItem {
  return key.startsWith("r:") ? { kind: "rendition", id: key.slice(2) } : SOURCE_ITEM;
}

/** The kind of tile a rendition wears. */
export function renditionKind(r: Pick<FileRendition, "mimeType" | "fileName">): FileKind {
  return fileKind(r.mimeType, r.fileName);
}

/** A rendition's name in a list: its label, else its role, else its file. */
export function renditionName(r: FileRendition): string {
  return r.label ?? (r.type ? capitalise(r.type) : null) ?? r.fileName ?? r.mimeType;
}

export function renditionMeta(r: FileRendition): string {
  const size = r.ref ? bytes(r.sizeBytes) : r.text != null ? `${r.text.length.toLocaleString()} characters` : "";
  return [r.type && r.label ? r.type : null, r.mimeType, size].filter(Boolean).join(" · ");
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The type tile: the design system's file tile, with a label for the kinds it lacks. */
export function FileTypeTile({ kind, small }: { kind: FileKind; small?: boolean }) {
  return (
    <span className={cx("sk-file-type", small && "sk-file-type--sm", tileClass(kind), `sk-ftile--${kind}`)}>
      {KIND_LABEL[kind]}
    </span>
  );
}

/** A document's type, as its model names it. */
export function useTypeName(documentType: string | null | undefined): string {
  const modules = useDocumentModelModules();
  if (!documentType) return "Document";
  const m = modules?.find((x) => x.documentModel.global.id === documentType);
  return m?.documentModel.global.name ?? documentType;
}

/* ------------------------------------------------------- the dispatcher */

export function FileItemPreview({ doc, item }: { doc: FileDocument; item: PreviewItem }) {
  const s = doc.state.global;
  if (item.kind === "rendition") {
    const r = s.renditions.find((x) => x.id === item.id);
    if (!r) return <PreviewEmpty>That rendition is gone.</PreviewEmpty>;
    return <RenditionPreview documentId={doc.header.id} rendition={r} />;
  }
  const source = s.source;
  if (!source) {
    return (
      <PreviewEmpty>
        No source yet. Upload a file or link a document, and it shows here.
      </PreviewEmpty>
    );
  }
  if (source.kind === "DOCUMENT" && source.documentId) {
    return (
      <LinkedDocumentPreview
        documentId={source.documentId}
        documentType={source.documentType ?? null}
        documentName={source.documentName ?? null}
      />
    );
  }
  if (source.ref) {
    return (
      <StoredFilePreview
        key={source.ref}
        documentId={doc.header.id}
        file={{ ref: source.ref, fileName: source.fileName ?? "file", mimeType: source.mimeType }}
      />
    );
  }
  return <PreviewEmpty>The source carries no content.</PreviewEmpty>;
}

export function RenditionPreview({
  documentId,
  rendition,
}: {
  documentId: string;
  rendition: FileRendition;
}) {
  if (rendition.ref) {
    return (
      <StoredFilePreview
        key={rendition.ref}
        documentId={documentId}
        file={{
          ref: rendition.ref,
          fileName: rendition.fileName ?? renditionName(rendition),
          mimeType: rendition.mimeType,
        }}
      />
    );
  }
  return <TextContentPreview mimeType={rendition.mimeType} text={rendition.text ?? ""} />;
}

function PreviewEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="sk-file-preview__empty">
      <Icon name="reports" size={32} />
      <p className="sk-small sk-text-muted">{children}</p>
    </div>
  );
}

/* --------------------------------------------------------- inline text */

export function TextContentPreview({ mimeType, text }: { mimeType: string; text: string }) {
  const kind = fileKind(mimeType);
  if (kind === "html") {
    return (
      <div className="sk-file-preview__sheet sk-file-preview__sheet--frame">
        {/* sandboxed: no scripts, no same-origin, links open nowhere */}
        <iframe title="HTML content" sandbox="" srcDoc={text} className="sk-file-preview__frame" />
      </div>
    );
  }
  const shown = kind === "data" && /json/.test(mimeType) ? prettyJson(text) : text;
  if (!shown.trim()) {
    return <PreviewEmpty>This rendition is empty.</PreviewEmpty>;
  }
  return (
    <div className="sk-file-preview__sheet">
      <pre className={cx("sk-file-preview__text", kind === "data" && "sk-font-mono")}>{shown}</pre>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/* -------------------------------------------------------- stored files */

export interface StoredFile {
  ref: string;
  fileName: string;
  mimeType?: string | null;
}

/** A stored file: images and PDFs inline, text read and shown, anything else to open or download. */
export function StoredFilePreview({
  documentId,
  file,
  label,
  subtitle,
}: {
  documentId: string;
  file: StoredFile;
  /** In the toolbar in place of the type tile and file name (when a picker above names the file) */
  label?: ReactNode;
  /** Under the file name in the toolbar */
  subtitle?: ReactNode;
}) {
  const client = useAttachments();
  const preview = useAttachmentPreview({ documentId, ref: file.ref as `attachment://v${number}:${string}` });
  // The URL is only trusted once this ref's own load has finished: a ref
  // change leaves the hook one render behind (see AttachmentPreview).
  const ready = preview.stage === "done" && !preview.loading;
  const url = ready ? preview.url : undefined;
  const mime = (ready ? preview.header?.mimeType : undefined) ?? file.mimeType ?? null;
  const kind = fileKind(mime, file.fileName);
  const text = useFetchedText(url, isTextual(mime) || kind === "html");

  return (
    <div className="sk-preview sk-file-preview">
      <div className="sk-preview__toolbar">
        {label ?? (
          <>
            <FileTypeTile kind={kind} small />
            {subtitle ? (
              <span className="sk-file-preview__titles">
                <span className="sk-file-preview__name">{file.fileName}</span>
                <span className="sk-file-preview__subtitle">{subtitle}</span>
              </span>
            ) : (
              <span className="sk-file-preview__name">{file.fileName}</span>
            )}
          </>
        )}
        <span className="sk-grow" />
        {url && (
          <a
            className="sk-btn sk-btn--ghost sk-btn--sm sk-btn--icon"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            title="Open in a new tab"
          >
            <Icon name="arrow-up-right" />
          </a>
        )}
        {client && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="download"
            aria-label="Download"
            title="Download"
            onClick={() =>
              void client.saveAttachment(
                { documentId, ref: file.ref as `attachment://v${number}:${string}` },
                { fileName: file.fileName },
              )
            }
          />
        )}
      </div>
      {!client && (
        <PreviewEmpty>
          This drive lives in the browser only, so there is no file store to read from.
        </PreviewEmpty>
      )}
      {client && preview.loading && (
        <div className="sk-file-preview__sheet sk-file-preview__sheet--loading">
          <Skeleton height={14} width="60%" />
          <Skeleton height={14} width="85%" />
          <Skeleton height={14} width="40%" />
          <span className="sk-caption">
            Fetching… attempt {preview.attempt} of {preview.maxAttempts}
          </span>
        </div>
      )}
      {client && preview.error && !preview.loading && (
        <p className="sk-small sk-text-danger">Could not load this file: {preview.error.message}</p>
      )}
      {url && kind === "img" && (
        <div className="sk-file-preview__stage">
          <img src={url} alt={file.fileName} className="sk-file-preview__image" />
        </div>
      )}
      {url && kind === "pdf" && (
        <div className="sk-file-preview__sheet sk-file-preview__sheet--frame">
          <iframe src={url} title={file.fileName} className="sk-file-preview__frame" />
        </div>
      )}
      {url && text !== null && kind === "html" && (
        <TextContentPreview mimeType="text/html" text={text} />
      )}
      {url && text !== null && kind !== "html" && kind !== "img" && kind !== "pdf" && (
        <TextContentPreview mimeType={mime ?? "text/plain"} text={text} />
      )}
      {url && text === null && kind !== "img" && kind !== "pdf" && !isTextual(mime) && kind !== "html" && (
        <PreviewEmpty>
          No inline preview for {mime ?? "this file type"}. Open it in a new tab or download it;
          an extracted rendition shows here once it is added.
        </PreviewEmpty>
      )}
    </div>
  );
}

/** A small text file's contents, read from its object URL. */
function useFetchedText(url: string | undefined, wanted: boolean): string | null {
  const [text, setText] = useState<{ url: string; text: string } | null>(null);
  useEffect(() => {
    if (!url || !wanted) return;
    let active = true;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (active) setText({ url, text: t.length > 400_000 ? `${t.slice(0, 400_000)}\n…` : t });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [url, wanted]);
  return text && text.url === url ? text.text : null;
}

/* ---------------------------------------------------- linked documents */

/** The read half's relationship edges. The browser client's interface leaves
 * them out, but both of its read halves (the switchboard's GraphQL client and
 * the tab's own reactor) answer them. */
type EdgeReader = {
  getIncomingRelationshipEdges?: (
    targetIdentifier: string,
  ) => Promise<{ results: { sourceId: string; relationshipType: string }[] }>;
};

/** Edges that file a document in a drive: a reactor-drive's and a legacy drive's. */
const DRIVE_EDGES = new Set(["drive/child", "child"]);

/**
 * The drive a document is filed in, from the relationship index: one small
 * read, rather than every drive's node list. `knownDriveId` skips it when the
 * caller already knows (a board over one drive).
 */
function useParentDriveId(
  documentId: string | null | undefined,
  knownDriveId: string | undefined,
): string | undefined {
  const client = useReactorClient();
  const [found, setFound] = useState<{ id: string; drive: string } | null>(null);
  useEffect(() => {
    if (!documentId || knownDriveId) return;
    const read = client?.read as EdgeReader | undefined;
    if (!read?.getIncomingRelationshipEdges) return;
    let active = true;
    read
      .getIncomingRelationshipEdges(documentId)
      .then((page) => {
        const edge = page.results.find((e) => DRIVE_EDGES.has(e.relationshipType));
        if (active && edge) setFound({ id: documentId, drive: edge.sourceId });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, documentId, knownDriveId]);
  if (knownDriveId) return knownDriveId;
  return found && found.id === documentId ? found.drive : undefined;
}

/**
 * Where a document lives: its drive and node, to open it there. Pass the
 * drive's slug or id when it is known; otherwise the drive is found through
 * the document's relationships. Works on legacy drives and reactor-drives.
 */
export function useDocumentLocation(
  documentId: string | null | undefined,
  driveSlugOrId?: string,
) {
  const drives = useDrives();
  const known = driveSlugOrId ? findDrive(drives, driveSlugOrId) : undefined;
  const driveId = useParentDriveId(documentId, known?.header.id);
  const node = useDriveNode(driveId, documentId);
  return useMemo(() => {
    if (!documentId || !driveId || !node) return null;
    const drive = known ?? drives?.find((d) => d.header.id === driveId);
    return drive ? { drive, node } : null;
  }, [documentId, driveId, node, known, drives]);
}

export function openDocument(location: ReturnType<typeof useDocumentLocation>) {
  if (!location) return;
  openTarget({
    driveSlug: location.drive.header.slug || location.drive.header.id,
    nodeSlug: makeNodeSlug(location.node),
  });
}

/** Another document as the source of truth: what it is, and its properties. */
export function LinkedDocumentPreview({
  documentId,
  documentType,
  documentName,
}: {
  documentId: string;
  documentType: string | null;
  documentName: string | null;
}) {
  const q = useDocumentSafe(documentId);
  const typeName = useTypeName(documentType);
  const location = useDocumentLocation(documentId);
  const doc = q.data;
  const name = doc?.header.name || documentName || "Untitled document";
  const global = (doc?.state as { global?: unknown } | undefined)?.global;

  return (
    <div className="sk-file-preview">
      <div className="sk-file-linked">
        <span className="sk-icon-tile sk-icon-tile--lg">
          <Icon name={iconForType(documentType)} />
        </span>
        <div className="sk-file-linked__body">
          <div className="sk-eyebrow">{typeName}</div>
          <div className="sk-file-linked__name">{name}</div>
          {location && (
            <div className="sk-caption">
              In {location.drive.header.name || location.drive.state.global.name}
            </div>
          )}
        </div>
        {location && (
          <Button size="sm" variant="secondary" icon="arrow-up-right" onClick={() => openDocument(location)}>
            Open
          </Button>
        )}
      </div>
      {q.isPending && (
        <div className="sk-stack sk-stack--2">
          <Skeleton height={14} width="70%" />
          <Skeleton height={14} width="50%" />
          <Skeleton height={14} width="60%" />
        </div>
      )}
      {Boolean(q.error) && !doc && (
        <p className="sk-small sk-text-danger">
          The document could not be read: {q.error instanceof Error ? q.error.message : String(q.error)}
        </p>
      )}
      {doc && <PropertySheet value={global} />}
    </div>
  );
}

export function iconForType(documentType: string | null | undefined) {
  switch (documentType) {
    case "sektar/invoice":
      return "invoice" as const;
    case "sektar/contact":
      return "customers" as const;
    case "sektar/expense-report":
      return "wallet" as const;
    case "sektar/bank-account":
      return "bank" as const;
    case "sektar/email":
      return "mail" as const;
    case "sektar/file":
      return "reports" as const;
    case "powerhouse/document-drive":
      return "folder" as const;
    default:
      return "reports" as const;
  }
}

/* ------------------------------------------------------ property sheet */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const humanKey = (k: string) =>
  capitalise(k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase());

const isPlain = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isScalar = (v: unknown): v is string | number | boolean | null =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one-line name of an item in a list: its name, title, label… */
function itemLabel(v: Json): string {
  if (isScalar(v)) return v === null ? "—" : String(v);
  if (isPlain(v)) {
    for (const k of ["name", "title", "label", "description", "subject", "address", "reference", "method"]) {
      const x = v[k];
      if (typeof x === "string" && x.trim()) return x;
    }
    // Anything readable before an id: an amount, a date, a word.
    for (const [k, x] of Object.entries(v)) {
      if (k === "id" || /Id$/.test(k)) continue;
      if (typeof x === "number") return x.toLocaleString();
      if (typeof x === "string" && x.trim() && !UUID.test(x)) {
        return /^\d{4}-\d{2}-\d{2}T/.test(x) ? new Date(x).toLocaleDateString() : x;
      }
    }
    return "…";
  }
  return `${v.length} items`;
}

function formatScalar(v: string | number | boolean | null): ReactNode {
  if (v === null || v === "") return <span className="sk-text-muted">—</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  if (/^attachment:\/\//.test(v)) return <span className="sk-font-mono sk-text-muted">stored file</span>;
  return v.length > 280 ? `${v.slice(0, 280)}…` : v;
}

/** A document's state as a readable sheet: scalars as rows, objects one level deep, lists summarised. */
export function PropertySheet({ value }: { value: unknown }) {
  if (!isPlain(value)) return null;
  const rows: { key: string; value: ReactNode }[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (isScalar(v)) {
      rows.push({ key: humanKey(k), value: formatScalar(v) });
    } else if (Array.isArray(v)) {
      rows.push({
        key: humanKey(k),
        value:
          v.length === 0 ? (
            <span className="sk-text-muted">None</span>
          ) : v.every(isScalar) ? (
            <span className="sk-file-props__chips">
              {v.slice(0, 12).map((x, i) => (
                <Badge key={i} tone="outline">
                  {String(x)}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="sk-file-props__list">
              <span className="sk-text-muted">{v.length} ×</span>{" "}
              {v
                .slice(0, 3)
                .map(itemLabel)
                .join(", ")}
              {v.length > 3 ? "…" : ""}
            </span>
          ),
      });
    } else if (isPlain(v)) {
      const inner = Object.entries(v).filter(([, x]) => isScalar(x) && x !== null && x !== "");
      if (inner.length === 0) continue;
      for (const [ik, iv] of inner.slice(0, 6)) {
        rows.push({ key: `${humanKey(k)} · ${humanKey(ik).toLowerCase()}`, value: formatScalar(iv as string) });
      }
    }
  }
  if (rows.length === 0) return null;
  return (
    <dl className="sk-file-props">
      {rows.map((r) => (
        <div key={r.key} className="sk-file-props__row">
          <dt>{r.key}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
