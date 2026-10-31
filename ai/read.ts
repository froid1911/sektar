// How the assistant's tools read Sektar's indexes: the drive by its slug,
// the endpoint the screens use, the caller's own bearer (kit/index-gql.ts), and
// answers trimmed to what fits. A failed read always throws: the agent feeds
// the error to the model, and an empty list only ever means the index was read
// and held nothing.
import { getPHStore } from "@powerhousedao/reactor-browser";
import {
  currentIndexMode,
  indexGql,
} from "../editors/sektar/kit/index-gql.js";
import { findDrive } from "../processors/drives/index.js";

/** The drives the tools read, by slug, as the model is told about them. */
export const DRIVE_LABEL = {
  sektar: "finance",
  mail: "mail",
  calendar: "calendar",
  files: "files",
  trips: "trips",
  integrations: "integrations",
  backfills: "backfills",
  workflows: "workflows",
} as const;

export type IndexedDrive = keyof typeof DRIVE_LABEL;

/**
 * The most characters one tool answer may take. Under the agent's own limit
 * (MAX_TOOL_RESULT_CHARS, 12,000), which cuts the text off mid-JSON: stopping
 * here keeps the answer whole and lets it say how much was left out.
 */
export const RESULT_BUDGET = 10_000;

const UNKNOWN = "Treat the answer as unknown.";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The drive's id and the switchboard that answers for it, or an error saying why not. */
function indexSource(slug: IndexedDrive): { base: string; driveId: string } {
  const label = DRIVE_LABEL[slug];
  const drive = findDrive(getPHStore()?.drives, slug);
  if (!drive) {
    throw new Error(
      `The ${label} drive is not available in this session, so it could not be read. ${UNKNOWN}`,
    );
  }
  const driveId = drive.header.id;
  const mode = currentIndexMode(driveId);
  if (mode.kind === "remote") return { base: mode.base, driveId };
  throw new Error(
    mode.kind === "local"
      ? `The ${label} drive is kept in this browser, where these tools cannot read its index. ${UNKNOWN}`
      : `No switchboard answers for the ${label} drive, so it could not be read. ${UNKNOWN}`,
  );
}

/** The id of a drive, as the drive-level built-in tools need it. */
export function driveIdOf(slug: IndexedDrive): string {
  return indexSource(slug).driveId;
}

/**
 * One query to the index of a drive, as the screens send it. The drive's id
 * is passed as `$d`.
 */
export async function readIndex<T>(
  slug: IndexedDrive,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const { base, driveId } = indexSource(slug);
  try {
    return await indexGql<T>(base, query, { d: driveId, ...variables });
  } catch (error) {
    throw new Error(
      `The ${DRIVE_LABEL[slug]} index could not be read: ${messageOf(error)}. ${UNKNOWN}`,
      { cause: error },
    );
  }
}

/** Rows from the top, as many as fit `budget` characters of JSON. */
export function fitted<T>(items: readonly T[], budget = RESULT_BUDGET): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    used += JSON.stringify(item).length + 1;
    if (used > budget) break;
    kept.push(item);
  }
  return kept;
}

/**
 * A list as the model gets it: how many matched, the rows that fit, and in
 * so many words whether it was cut off or the index really holds none.
 * `beside` is what the answer carries next to the rows; it counts against
 * the budget. `query` is the search that was asked: every word has to appear,
 * so a search of several words that found nothing proves little.
 */
export function listing<T, B extends object = object>(
  what: string,
  items: readonly T[],
  found: number,
  options: { offset?: number; budget?: number; beside?: B; query?: string } = {},
) {
  const { offset = 0, budget = RESULT_BUDGET, beside, query } = options;
  const kept = fitted(items, budget - JSON.stringify(beside ?? {}).length);
  const reached = offset + kept.length;
  const rows = { ...(beside as B), found, shown: kept.length, items: kept };
  if (found === 0) {
    const words = query?.trim().split(/\s+/).length ?? 0;
    return {
      ...rows,
      note: `The index was read and holds no ${what} for this.${
        words > 1
          ? " Every word of the search must appear: try fewer words before saying it does not exist."
          : ""
      }`,
    };
  }
  if (reached >= found) return rows;
  return {
    ...rows,
    cutOff: true,
    note: `Cut off: showing ${offset + 1}-${reached} of ${found} ${what}. Narrow the search, or read on with offset ${reached}.`,
  };
}

/** Empty values left out: the model pays for every character. */
export function compact<T extends object>(row: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0),
    ),
  ) as Partial<T>;
}

/** Free text cut to `max` characters; an empty one becomes null. */
export function clip(
  text: string | null | undefined,
  max: number,
): string | null {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The day of an ISO timestamp. */
export function day(iso: string | null | undefined): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/**
 * Reads several parts of an answer, each of which can fail alone. The parts
 * that were read are returned with the failures named in `notRead`, so a part
 * that failed cannot pass for one with nothing in it. When every part fails
 * the call fails.
 */
export async function readParts<T extends Record<string, unknown>>(parts: {
  [K in keyof T]: () => Promise<T[K]>;
}): Promise<{ read: Partial<T>; notRead?: Record<string, string> }> {
  const names = Object.keys(parts) as (keyof T & string)[];
  const settled = await Promise.allSettled(names.map((name) => parts[name]()));
  const read: Partial<T> = {};
  const notRead: Record<string, string> = {};
  settled.forEach((result, index) => {
    const name = names[index];
    if (result.status === "fulfilled") read[name] = result.value;
    else notRead[name] = messageOf(result.reason);
  });
  const failures = Object.values(notRead);
  if (failures.length === names.length) throw new Error(failures.join(" "));
  return failures.length > 0 ? { read, notRead } : { read };
}
