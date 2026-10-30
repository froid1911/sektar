/**
 * The resources this runner recorded and cannot read back yet. A dispatch
 * resolves once the write is accepted, not committed (IProcessorDispatch), so
 * the next pass may still read an integration without the connection or
 * workflow the last one made, and make a second. The overlay lays what was
 * recorded over what is read until the read state shows it.
 */
import type { IntegrationState } from "document-models/integration";

type Resources = IntegrationState["resources"];
type Key = "connectionId" | "liveWorkflowId" | "backfillWorkflowId" | "pluggedItemId";
const KEYS: readonly Key[] = [
  "connectionId",
  "liveWorkflowId",
  "backfillWorkflowId",
  "pluggedItemId",
];

/** A write that never commits is not overlaid for ever. */
export const RECORDED_TTL_MS = 120_000;

export type RecordedResources = Partial<Record<Key, { value: string; at: number }>>;

/** Notes the RECORD_RESOURCES among dispatched actions, as the reducer applies them (set fields only). */
export function noteRecorded(
  recorded: RecordedResources,
  dispatched: readonly { type: string; input?: unknown }[],
  now: number,
): RecordedResources {
  let next = recorded;
  for (const action of dispatched) {
    if (action.type !== "RECORD_RESOURCES") continue;
    const input = (action.input ?? {}) as Partial<Record<Key, string | null>>;
    for (const key of KEYS) {
      const value = input[key];
      if (value) next = { ...next, [key]: { value, at: now } };
    }
  }
  return next;
}

/** The resources a pass works with, and what is still to be read back. */
export function withRecorded(
  resources: Resources,
  recorded: RecordedResources,
  now: number,
): { resources: Resources; recorded: RecordedResources } {
  let merged = resources;
  const remaining: RecordedResources = {};
  for (const key of KEYS) {
    const entry = recorded[key];
    if (!entry || now - entry.at > RECORDED_TTL_MS) continue;
    // Read back: the read state has caught up.
    if (resources[key] === entry.value) continue;
    merged = { ...merged, [key]: entry.value };
    remaining[key] = entry;
  }
  return { resources: merged, recorded: remaining };
}
