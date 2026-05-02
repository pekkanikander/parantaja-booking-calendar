import { initCalendar } from "./calendar";
import { showBookingForm } from "./booking";

async function waitForServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  // Registration is also done in index.html; registering twice is safe — browser de-dupes.
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
  });
}

await waitForServiceWorker();

const el = document.getElementById("calendar");
if (!el) throw new Error("No #calendar element found");

const { calendar, refreshSlots } = initCalendar(el, slot => {
  showBookingForm(slot, calendar, refreshSlots);
});
