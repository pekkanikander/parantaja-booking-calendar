import { WORKER_URL, CALENDAR_ID } from "./config";
import type { GCalEvent } from "./types";

const BASE = `${WORKER_URL}/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

export async function listEvents(timeMin: string, timeMax: string): Promise<GCalEvent[]> {
  const url = new URL(BASE);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`listEvents: ${resp.status}`);
  const data = await resp.json() as { items?: GCalEvent[] };
  return data.items ?? [];
}

export async function insertEvent(
  summary: string,
  description: string,
  start: string,
  end: string,
): Promise<GCalEvent> {
  const resp = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: start },
      end: { dateTime: end },
      colorId: "11",
    }),
  });
  if (!resp.ok) throw new Error(`insertEvent: ${resp.status}`);
  return resp.json() as Promise<GCalEvent>;
}

export async function deleteEvent(eventId: string): Promise<void> {
  const resp = await fetch(`${BASE}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) throw new Error(`deleteEvent: ${resp.status}`);
}
