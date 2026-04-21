import { initCalendar } from "./calendar";
import { showBookingForm } from "./booking";

const el = document.getElementById("calendar");
if (!el) throw new Error("No #calendar element found");

const { calendar, refreshSlots } = initCalendar(el, slot => {
  showBookingForm(slot, calendar, refreshSlots);
});
