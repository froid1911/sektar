// Business Travel's vocabulary and data: the Trips drive, its trips, the
// labels the overview speaks in, and the writes the forms make. Reads are
// hooks over the drive; writes go through dispatchActions so the drive app,
// the trip editor and the travel dashboard share one way of saying things.
import { findDrive } from "../../../processors/drives/index.js";
import {
  addDocument,
  dispatchActions,
  useDrives,
} from "@powerhousedao/reactor-browser";
import type { DocumentDriveDocument } from "@powerhousedao/shared/document-drive";
import { generateId } from "document-model";
import {
  actions,
  tripTotals,
  type TripAction,
  type TripDocument,
  type TripExtraKind,
  type TripMealKind,
  type TripPurposeKind,
  type TripState,
  type TripStatus,
  type TripTransportMode,
} from "document-models/trip";
import type { BadgeTone } from "./format.js";
import type { IconName } from "./ui.js";

/** The Trips drive, declared in the host files. */
export const TRIPS_DRIVE_SLUG = "trips";
export const TRIP_TYPE = "sektar/trip";

/* ------------------------------------------------------------- reading */

export function useTripsDrive(): DocumentDriveDocument | undefined {
  return findDrive(useDrives(), TRIPS_DRIVE_SLUG);
}

export const byStartDesc = (a: TripDocument, b: TripDocument) =>
  (b.state.global.startDate ?? "").localeCompare(a.state.global.startDate ?? "") ||
  (a.state.global.title ?? "").localeCompare(b.state.global.title ?? "");

/* ------------------------------------------------------------- the words */

export const PURPOSE: Record<TripPurposeKind, { label: string; icon: IconName }> = {
  CLIENT_VISIT: { label: "Client visit", icon: "customers" },
  CONFERENCE: { label: "Conference", icon: "calendar" },
  OFFSITE: { label: "Offsite", icon: "sun" },
  WORKSHOP: { label: "Workshop", icon: "settings" },
  SALES: { label: "Sales", icon: "growth" },
  TRAINING: { label: "Training", icon: "help" },
  OTHER: { label: "Other", icon: "folder" },
};
/** The label and icon of a purpose as the index spells it (a plain string), or null. */
export function purposeOf(kind: string | null | undefined): { label: string; icon: IconName } | null {
  return kind && kind in PURPOSE ? PURPOSE[kind as TripPurposeKind] : null;
}

export const PURPOSE_ORDER = Object.keys(PURPOSE) as TripPurposeKind[];

/** What a trip is now: its own status, or what its dates say. */
export type TripPhase = "upcoming" | "ongoing" | "completed" | "cancelled" | "undated";

export function phaseOf(s: Pick<TripState, "status" | "startDate" | "endDate">, now = Date.now()): TripPhase {
  if (s.status === "CANCELLED") return "cancelled";
  if (!s.startDate) return s.status === "COMPLETED" ? "completed" : "undated";
  const start = Date.parse(s.startDate.slice(0, 10) + "T00:00:00Z");
  const end = Date.parse((s.endDate ?? s.startDate).slice(0, 10) + "T23:59:59Z");
  if (now < start) return "upcoming";
  if (now <= end) return "ongoing";
  return "completed";
}

export const PHASE: Record<TripPhase, { label: string; tone: BadgeTone }> = {
  upcoming: { label: "Upcoming", tone: "info" },
  ongoing: { label: "Under way", tone: "success" },
  completed: { label: "Completed", tone: "mint" },
  cancelled: { label: "Cancelled", tone: "danger" },
  undated: { label: "No dates", tone: "neutral" },
};

export const STATUS: Record<TripStatus, string> = {
  PLANNED: "Planned",
  BOOKED: "Booked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export type TripGlyph = "plane" | "train" | "car" | "taxi" | "bus" | "ferry" | "metro" | "parking" | "bed" | "meal" | "coffee" | "ticket" | "desk" | "signal" | "passport" | "shield" | "bag" | "pin";

export const MODE: Record<TripTransportMode, { label: string; glyph: TripGlyph }> = {
  FLIGHT: { label: "Flight", glyph: "plane" },
  TRAIN: { label: "Train", glyph: "train" },
  CAR: { label: "Car", glyph: "car" },
  TAXI: { label: "Taxi", glyph: "taxi" },
  RIDE_HAIL: { label: "Ride-hail", glyph: "taxi" },
  BUS: { label: "Bus", glyph: "bus" },
  FERRY: { label: "Ferry", glyph: "ferry" },
  PUBLIC_TRANSPORT: { label: "Public transport", glyph: "metro" },
  PARKING: { label: "Parking", glyph: "parking" },
  OTHER: { label: "Other", glyph: "pin" },
};
/** The label and glyph of a transport mode as the index spells it, or null. */
export function modeOf(mode: string | null | undefined): { label: string; glyph: TripGlyph } | null {
  return mode && mode in MODE ? MODE[mode as TripTransportMode] : null;
}

export const MODE_ORDER = Object.keys(MODE) as TripTransportMode[];

export const MEAL: Record<TripMealKind, { label: string; glyph: TripGlyph }> = {
  BREAKFAST: { label: "Breakfast", glyph: "coffee" },
  LUNCH: { label: "Lunch", glyph: "meal" },
  DINNER: { label: "Dinner", glyph: "meal" },
  COFFEE: { label: "Coffee", glyph: "coffee" },
  DRINKS: { label: "Drinks", glyph: "coffee" },
  SNACK: { label: "Snack", glyph: "meal" },
  OTHER: { label: "Other", glyph: "meal" },
};
export const MEAL_ORDER = Object.keys(MEAL) as TripMealKind[];

export const EXTRA: Record<TripExtraKind, { label: string; glyph: TripGlyph }> = {
  EVENT_TICKET: { label: "Event ticket", glyph: "ticket" },
  COWORKING: { label: "Co-working", glyph: "desk" },
  CONNECTIVITY: { label: "Connectivity", glyph: "signal" },
  VISA: { label: "Visa", glyph: "passport" },
  INSURANCE: { label: "Insurance", glyph: "shield" },
  SUPPLIES: { label: "Supplies", glyph: "bag" },
  OTHER: { label: "Other", glyph: "pin" },
};
export const EXTRA_ORDER = Object.keys(EXTRA) as TripExtraKind[];

/* ------------------------------------------------------------- dates */

const D = (iso: string) => new Date(iso.slice(0, 10) + "T12:00:00Z");

/** "11–12 Jul 2024", "30 Nov – 3 Dec 2025", "11 Jul 2024" */
export function dateRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return "No dates yet";
  const a = D(start);
  const b = end ? D(end) : a;
  const day = (d: Date) => d.getUTCDate();
  const mon = (d: Date) => d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const yr = (d: Date) => d.getUTCFullYear();
  if (a.getTime() === b.getTime()) return `${day(a)} ${mon(a)} ${yr(a)}`;
  if (yr(a) !== yr(b)) return `${day(a)} ${mon(a)} ${yr(a)} – ${day(b)} ${mon(b)} ${yr(b)}`;
  if (mon(a) !== mon(b)) return `${day(a)} ${mon(a)} – ${day(b)} ${mon(b)} ${yr(b)}`;
  return `${day(a)}–${day(b)} ${mon(a)} ${yr(a)}`;
}

/** "Thu 11 Jul" */
export function dayLabel(iso: string): string {
  return D(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "06:40", in the reader's zone; a date alone has no time. */
export function timeOf(iso: string | null | undefined): string | null {
  if (!iso || iso.length <= 10 || /T00:00:00(\.000)?Z$/.test(iso)) return null;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** A date input's value as the model's Date (midnight UTC); none when empty. */
export function dateValue(input: string): string | null {
  return input ? `${input}T00:00:00.000Z` : null;
}

/** A datetime-local input's value as an ISO instant; none when empty. */
export function instantValue(input: string): string | null {
  if (!input) return null;
  // midnight is "that day, no time known": kept as the day, not shifted by the zone
  if (/T00:00$/.test(input)) return `${input.slice(0, 10)}T00:00:00.000Z`;
  return new Date(input).toISOString();
}

/** An ISO instant as a datetime-local input's value, in the reader's zone. */
export function toInstantInput(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/T00:00:00(\.000)?Z$/.test(iso)) return `${iso.slice(0, 10)}T00:00`;
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------- figures */

/** A trip's year: the year it starts in. */
export const yearOf = (s: Pick<TripState, "startDate">) => (s.startDate ? Number(s.startDate.slice(0, 4)) : null);

export type TravelYear = {
  year: number;
  trips: number;
  days: number;
  nights: number;
  spend: number;
  billed: number;
};

/** The figures per year, newest first. */
export function yearsOf(trips: TripDocument[]): TravelYear[] {
  const map = new Map<number, TravelYear>();
  for (const t of trips) {
    const s = t.state.global;
    const y = yearOf(s);
    if (y === null || s.status === "CANCELLED") continue;
    const row = map.get(y) ?? { year: y, trips: 0, days: 0, nights: 0, spend: 0, billed: 0 };
    const totals = tripTotals(s);
    row.trips++;
    row.days += s.startDate && s.endDate ? Math.round((Date.parse(s.endDate) - Date.parse(s.startDate)) / 86_400_000) + 1 : 1;
    row.nights += s.stays.reduce((n, st) => n + (st.checkIn && st.checkOut ? Math.max(0, Math.round((Date.parse(st.checkOut) - Date.parse(st.checkIn)) / 86_400_000)) : 0), 0);
    row.spend += totals.total;
    row.billed += totals.billed;
    map.set(y, row);
  }
  return [...map.values()].sort((a, b) => b.year - a.year);
}

/** The places most travelled to: city, visits, last visit. */
/** The most visited places over index rows (cancelled trips left out). */
export function topRowDestinations(
  trips: readonly { status: string; startDate: string | null; destinations: { city: string; country: string | null }[] }[],
  limit = 6,
) {
  const map = new Map<string, { city: string; country: string | null; visits: number; last: string | null }>();
  for (const t of trips) {
    if (t.status === "CANCELLED") continue;
    for (const d of t.destinations) {
      const key = d.city.toLowerCase();
      const row = map.get(key) ?? { city: d.city, country: d.country ?? null, visits: 0, last: null };
      row.visits++;
      if (t.startDate && (!row.last || t.startDate > row.last)) row.last = t.startDate;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => b.visits - a.visits || (b.last ?? "").localeCompare(a.last ?? "")).slice(0, limit);
}

export function topDestinations(trips: TripDocument[], limit = 6) {
  const map = new Map<string, { city: string; country: string | null; visits: number; last: string | null }>();
  for (const t of trips) {
    const s = t.state.global;
    if (s.status === "CANCELLED") continue;
    for (const d of s.destinations) {
      const key = d.city.toLowerCase();
      const row = map.get(key) ?? { city: d.city, country: d.country ?? null, visits: 0, last: null };
      row.visits++;
      if (s.startDate && (!row.last || s.startDate > row.last)) row.last = s.startDate;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => b.visits - a.visits || (b.last ?? "").localeCompare(a.last ?? "")).slice(0, limit);
}

/** The flag for an ISO country code, as regional-indicator letters. */
export function flag(country: string | null | undefined): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return "";
  return String.fromCodePoint(...country.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/* ------------------------------------------------------------- writing */

export type NewTrip = {
  title: string;
  purpose?: string | null;
  purposeKind?: TripPurposeKind | null;
  startDate?: string | null;
  endDate?: string | null;
  city?: string | null;
  country?: string | null;
};

/** A new trip in the Trips drive; its id. */
export async function createTrip(drive: DocumentDriveDocument, input: NewTrip): Promise<string> {
  const node = await addDocument(drive.header.id, input.title, TRIP_TYPE);
  const ops: TripAction[] = [
    actions.setDetails({
      title: input.title,
      purpose: input.purpose ?? null,
      purposeKind: input.purposeKind ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
    }),
  ];
  if (input.city)
    ops.push(
      actions.addDestination({
        id: generateId(),
        city: input.city,
        country: input.country ?? null,
        arriveOn: input.startDate ?? null,
        leaveOn: input.endDate ?? null,
      }),
    );
  await dispatchActions(ops, node.id);
  return node.id;
}
