import { WORKER_URL } from "./config";
import type { Slot, BookRequest, BookResponse } from "./types";

export class ConflictError extends Error {}

export async function fetchSlots(start: string, end: string): Promise<Record<string, Slot[]>> {
  const url = new URL(`${WORKER_URL}/v1/slots`);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`fetchSlots: ${resp.status}`);
  const body = await resp.json() as { data: { slots: Record<string, Slot[]> } };
  return body.data.slots;
}

export async function postBooking(req: BookRequest): Promise<BookResponse> {
  const resp = await fetch(`${WORKER_URL}/v1/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (resp.status === 409) throw new ConflictError("slot taken");
  if (!resp.ok) throw new Error(`postBooking: ${resp.status}`);
  const body = await resp.json() as { data: BookResponse };
  return body.data;
}

export async function cancelBooking(uid: string): Promise<void> {
  const resp = await fetch(`${WORKER_URL}/v1/bookings/${encodeURIComponent(uid)}`, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) throw new Error(`cancelBooking: ${resp.status}`);
}
