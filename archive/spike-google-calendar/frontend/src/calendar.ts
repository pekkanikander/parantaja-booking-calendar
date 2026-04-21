import { Calendar } from "@fullcalendar/core";
import timeGridPlugin from "@fullcalendar/timegrid";
import { listEvents } from "./api";
import { SLOT_MINUTES } from "./config";
import type { GCalEvent, Slot } from "./types";

function eventStart(e: GCalEvent): Date {
  return new Date((e.start.dateTime ?? e.start.date)!);
}

function eventEnd(e: GCalEvent): Date {
  return new Date((e.end.dateTime ?? e.end.date)!);
}

function computeSlots(events: GCalEvent[]): Slot[] {
  const openEvents = events.filter(e => e.summary === "OPEN");
  if (openEvents.length === 0) console.log("[calendar] no OPEN events in range");

  const blockedTimes = events
    .filter(e => e.summary !== "OPEN")
    .map(e => ({ start: eventStart(e), end: eventEnd(e) }));

  const slots: Slot[] = [];
  for (const open of openEvents) {
    if (!open.start.dateTime) {
      console.warn("[calendar] OPEN event is all-day (no dateTime) — skipped:", open.id);
      continue;
    }
    let cursor = eventStart(open);
    const openEnd = eventEnd(open);
    while (cursor.getTime() + SLOT_MINUTES * 60_000 <= openEnd.getTime()) {
      const slotEnd = new Date(cursor.getTime() + SLOT_MINUTES * 60_000);
      const blocked = blockedTimes.some(b => b.start < slotEnd && b.end > cursor);
      if (!blocked) {
        slots.push({
          id: cursor.toISOString(),
          start: cursor.toISOString(),
          end: slotEnd.toISOString(),
        });
      }
      cursor = slotEnd;
    }
  }
  return slots;
}

export function initCalendar(
  el: HTMLElement,
  onSlotClick: (slot: Slot) => void,
): { calendar: Calendar; refreshSlots: () => Promise<void> } {
  let currentStart = "";
  let currentEnd = "";

  const refreshSlots = async (): Promise<void> => {
    if (!currentStart) return;
    console.log("[calendar] fetching events", currentStart, "→", currentEnd);
    const events = await listEvents(currentStart, currentEnd);
    console.log("[calendar] events from API:", events.length, events.map(e => e.summary));
    const slots = computeSlots(events);
    console.log("[calendar] computed slots:", slots.length);
    calendar.removeAllEvents();
    for (const s of slots) {
      calendar.addEvent({ id: s.id, title: "Available", start: s.start, end: s.end });
    }
  };

  const calendar = new Calendar(el, {
    plugins: [timeGridPlugin],
    initialView: "timeGridWeek",
    slotDuration: "00:30:00",
    slotMinTime: "07:00:00",
    slotMaxTime: "21:00:00",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "timeGridWeek,timeGridDay",
    },
    eventColor: "#22c55e",
    datesSet: async info => {
      currentStart = info.startStr;
      currentEnd = info.endStr;
      try {
        await refreshSlots();
      } catch (err) {
        console.error("[calendar] failed to load slots:", err);
        const errEl = document.createElement("p");
        errEl.style.cssText = "color:red;padding:8px;margin:0";
        errEl.textContent = `Failed to load slots: ${String(err)}`;
        el.prepend(errEl);
      }
    },
    eventClick: info => {
      const slot: Slot = {
        id: info.event.id,
        start: info.event.startStr,
        end: info.event.endStr,
      };
      onSlotClick(slot);
    },
  });

  calendar.render();
  return { calendar, refreshSlots };
}
