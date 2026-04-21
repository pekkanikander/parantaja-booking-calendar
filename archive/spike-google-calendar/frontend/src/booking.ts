import type { Calendar } from "@fullcalendar/core";
import { insertEvent, deleteEvent, listEvents } from "./api";
import type { Slot } from "./types";

let formEl: HTMLDivElement | null = null;

function getFormEl(): HTMLDivElement {
  if (formEl) return formEl;
  formEl = document.createElement("div");
  Object.assign(formEl.style, {
    display: "none",
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: "white",
    border: "1px solid #d1d5db",
    borderRadius: "8px",
    padding: "24px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.2)",
    zIndex: "1000",
    minWidth: "320px",
  });
  document.body.appendChild(formEl);
  return formEl;
}

export function showBookingForm(
  slot: Slot,
  calendar: Calendar,
  refreshSlots: () => Promise<void>,
): void {
  const el = getFormEl();

  const slotStart = new Date(slot.start);
  const slotEnd = new Date(slot.end);
  const startLabel = slotStart.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const endLabel = slotEnd.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  el.innerHTML = `
    <h3 style="margin:0 0 16px;font-size:1.1rem">${startLabel} – ${endLabel}</h3>
    <label style="display:block;margin-bottom:12px;font-size:0.9rem">
      Name
      <input id="bf-name" type="text" placeholder="Your name"
        style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:4px;font-size:1rem">
    </label>
    <label style="display:block;margin-bottom:16px;font-size:0.9rem">
      Note <span style="color:#9ca3af">(optional)</span>
      <input id="bf-note" type="text" placeholder="Any notes"
        style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:4px;font-size:1rem">
    </label>
    <div id="bf-error" style="color:#dc2626;margin-bottom:12px;font-size:0.9rem;display:none"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="bf-cancel"
        style="padding:8px 16px;border:1px solid #d1d5db;border-radius:4px;background:white;cursor:pointer">
        Cancel
      </button>
      <button id="bf-submit"
        style="padding:8px 16px;border:none;border-radius:4px;background:#22c55e;color:white;cursor:pointer;font-size:1rem">
        Book
      </button>
    </div>
  `;
  el.style.display = "block";

  const nameInput = document.getElementById("bf-name") as HTMLInputElement;
  nameInput.focus();

  document.getElementById("bf-cancel")!.onclick = () => {
    el.style.display = "none";
  };

  document.getElementById("bf-submit")!.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.style.borderColor = "#dc2626";
      return;
    }
    const note = (document.getElementById("bf-note") as HTMLInputElement).value.trim();

    const submitBtn = document.getElementById("bf-submit") as HTMLButtonElement;
    const cancelBtn = document.getElementById("bf-cancel") as HTMLButtonElement;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = "Booking…";

    const created = await insertEvent(name, note, slot.start, slot.end);
    const events = await listEvents(slot.start, slot.end);
    const conflict = events.some(e => e.summary !== "OPEN" && e.id !== created.id);

    if (conflict) {
      await deleteEvent(created.id);
      const errorEl = document.getElementById("bf-error") as HTMLDivElement;
      errorEl.textContent = "Sorry, this slot was just taken.";
      errorEl.style.display = "block";
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = "Book";
      await refreshSlots();
      return;
    }

    el.style.display = "none";
    calendar.getEventById(slot.id)?.remove();
    showConfirmation(name, startLabel, endLabel);
  };
}

function showConfirmation(name: string, startLabel: string, endLabel: string): void {
  const el = getFormEl();
  el.innerHTML = `
    <h3 style="margin:0 0 12px;color:#16a34a;font-size:1.1rem">Booking confirmed!</h3>
    <p id="conf-msg" style="margin:0 0 16px"></p>
    <div style="display:flex;justify-content:flex-end">
      <button id="bf-close"
        style="padding:8px 16px;border:none;border-radius:4px;background:#22c55e;color:white;cursor:pointer;font-size:1rem">
        Close
      </button>
    </div>
  `;
  const p = document.getElementById("conf-msg")!;
  p.textContent = `Thanks, ${name}! Your appointment at ${startLabel} – ${endLabel} is booked.`;
  document.getElementById("bf-close")!.onclick = () => {
    el.style.display = "none";
  };
  el.style.display = "block";
}
