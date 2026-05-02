import { WORKER_URL } from "./config";
import type { Slot, BookRequest, BookResponse } from "./types";

interface Challenge {
  nonce: string;
  difficulty: number;
  expires_at: string;
}

async function fetchChallenge(): Promise<Challenge> {
  const resp = await fetch(`${WORKER_URL}/v1/challenge`);
  if (!resp.ok) throw new Error(`fetchChallenge: ${resp.status}`);
  return resp.json() as Promise<Challenge>;
}

function solvePuzzle(nonce: string, slotStart: string, difficulty: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./puzzle.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ solution: number }>) => {
      worker.terminate();
      resolve(e.data.solution);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(String(e.message)));
    };
    worker.postMessage({ nonce, slotStart, difficulty });
  });
}

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
  const challenge = await fetchChallenge();
  const solution = await solvePuzzle(challenge.nonce, req.slot_start, challenge.difficulty);

  const resp = await fetch(`${WORKER_URL}/v1/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, puzzle_nonce: challenge.nonce, puzzle_solution: solution }),
  });
  if (resp.status === 409) throw new ConflictError("slot taken");
  if (!resp.ok) throw new Error(`postBooking: ${resp.status}`);
  const body = await resp.json() as { data: BookResponse };
  const booking = body.data;
  localStorage.setItem(`booking_nonce_${booking.uid}`, booking.cancellation_nonce);
  return booking;
}

export async function cancelBooking(uid: string): Promise<void> {
  const nonce = localStorage.getItem(`booking_nonce_${uid}`);
  const resp = await fetch(`${WORKER_URL}/v1/bookings/${encodeURIComponent(uid)}`, {
    method: "DELETE",
    headers: nonce ? { "Content-Type": "application/json" } : {},
    body: nonce ? JSON.stringify({ nonce }) : undefined,
  });
  if (!resp.ok && resp.status !== 404) throw new Error(`cancelBooking: ${resp.status}`);
  localStorage.removeItem(`booking_nonce_${uid}`);
}
