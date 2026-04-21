import type { ParsedEvent } from "./caldav";

export interface Slot {
  start: string;     // ISO 8601
  end: string;       // ISO 8601
  available: boolean;
}

export function computeSlots(events: ParsedEvent[], slotMinutes: number): Slot[] {
  const openEvents   = events.filter(e => e.summary === "OPEN");
  const blockedTimes = events
    .filter(e => e.summary !== "OPEN")
    .map(e => ({ start: new Date(e.start), end: new Date(e.end) }));

  const slots: Slot[] = [];
  for (const open of openEvents) {
    let cursor = new Date(open.start);
    const openEnd = new Date(open.end);
    while (cursor.getTime() + slotMinutes * 60_000 <= openEnd.getTime()) {
      const slotEnd = new Date(cursor.getTime() + slotMinutes * 60_000);
      const blocked = blockedTimes.some(b => b.start < slotEnd && b.end > cursor);
      slots.push({ available: !blocked, start: cursor.toISOString(), end: slotEnd.toISOString() });
      cursor = slotEnd;
    }
  }
  return slots;
}
