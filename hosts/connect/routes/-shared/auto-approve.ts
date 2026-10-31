import { useUser } from "@powerhousedao/reactor-browser";
import { useCallback, useSyncExternalStore } from "react";

const keyOf = (address: string) => `sk:assistant-auto-approve:${address}`;

/** Holds the choice when storage can't, and tells every box about a change. */
const chosen = new Map<string, boolean>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readAutoApprove(address: string | undefined): boolean {
  if (!address) return false;
  const known = chosen.get(address);
  if (known !== undefined) return known;
  try {
    return localStorage.getItem(keyOf(address)) === "1";
  } catch {
    return false;
  }
}

export function writeAutoApprove(address: string, on: boolean): void {
  chosen.set(address, on);
  try {
    if (on) localStorage.setItem(keyOf(address), "1");
    else localStorage.removeItem(keyOf(address));
  } catch {
    // Without storage it lasts until the page reloads, then asks again.
  }
  for (const listener of listeners) listener();
}

/**
 * Whether the assistant may change data without asking. Each identity's own:
 * the Desktop App's one window serves them all, and one person's choice must
 * not carry over to the next. Off until someone turns it on.
 */
export function useAutoApprove(): [boolean, (on: boolean) => void] {
  const address = useUser()?.address;
  const on = useSyncExternalStore(
    subscribe,
    () => readAutoApprove(address),
    () => false,
  );
  const set = useCallback(
    (next: boolean) => {
      if (address) writeAutoApprove(address, next);
    },
    [address],
  );
  return [on, set];
}
