/**
 * Sektar's drives, by the slugs the host files declare them under. A slug is a
 * drive's name on its switchboard; lookups go by it and everything past them by
 * the drive's id.
 */
type HasHeader = { header: { id: string; slug: string } };

/** The drive `ref` names among loaded drives: its slug, or its id. */
export function findDrive<T extends HasHeader>(
  drives: readonly T[] | undefined,
  ref: string,
): T | undefined {
  return drives?.find((d) => d.header.slug === ref || d.header.id === ref);
}

type DriveReader = { get: (idOrSlug: string) => Promise<{ header: { id: string } }> };

/** The id of the drive under a slug in this store, or null if it has none. */
export async function resolveDriveId(
  read: DriveReader,
  slug: string,
): Promise<string | null> {
  try {
    return (await read.get(slug)).header.id;
  } catch {
    return null;
  }
}

/** The drives Sektar's processors serve. */
export type ServedDrive =
  | "mail"
  | "sektar"
  | "calendar"
  | "files"
  | "trips"
  | "integrations"
  | "backfills"
  | "workflows";

/**
 * Whether a processor that serves `slugs` runs on this drive. A processor runs
 * on the drives whose documents it indexes and nowhere else: every processor on
 * every drive replays every drive's history (Mail's hundred thousand messages)
 * for nothing.
 */
export function bindsToAny(
  header: { slug: string },
  slugs: readonly ServedDrive[],
): boolean {
  return (slugs as readonly string[]).includes(header.slug);
}
