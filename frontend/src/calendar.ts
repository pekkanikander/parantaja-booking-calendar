import { Calendar } from "@fullcalendar/core";
import timeGridPlugin from "@fullcalendar/timegrid";
import { fetchSlots } from "./api";
import type { Slot } from "./types";

export function initCalendar(
  el: HTMLElement,
  onSlotClick: (slot: Slot) => void,
): { calendar: Calendar; refreshSlots: () => Promise<void> } {
  let currentStart = "";
  let currentEnd   = "";

  const refreshSlots = async (): Promise<void> => {
    if (!currentStart) return;
    const grouped = await fetchSlots(currentStart, currentEnd);
    calendar.removeAllEvents();
    for (const slots of Object.values(grouped)) {
      for (const s of slots) {
        calendar.addEvent({ id: s.start, title: "Available", start: s.start, end: s.end });
      }
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
      currentEnd   = info.endStr;
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
      const start = info.event.start?.toISOString() ?? info.event.startStr;
      const end   = info.event.end?.toISOString()   ?? info.event.endStr;
      onSlotClick({ start, end });
    },
  });

  calendar.render();
  return { calendar, refreshSlots };
}
