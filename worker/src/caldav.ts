import ICAL from "ical.js";

export interface ParsedEvent {
  uid: string;
  summary: string;
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

// "2026-04-20T09:00:00.000Z" → "20260420T090000Z"
function toCalDAVDate(iso: string): string {
  return iso.replace(/-/g, "").replace(/:/g, "").replace(/\.\d+/, "");
}

function parseIcs(icsString: string): ParsedEvent[] {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  return comp.getAllSubcomponents("vevent").map(vevent => {
    const ev = new ICAL.Event(vevent);
    return {
      uid:     ev.uid,
      summary: ev.summary,
      start:   ev.startDate.toJSDate().toISOString(),
      end:     ev.endDate.toJSDate().toISOString(),
    };
  });
}

export function buildVEvent(
  uid: string,
  start: string,
  end: string,
  name: string,
  notes: string,
): string {
  const dtstart = toCalDAVDate(new Date(start).toISOString());
  const dtend   = toCalDAVDate(new Date(end).toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//booking-calendar//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${name}`,
  ];
  if (notes) lines.push(`DESCRIPTION:${notes}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

export async function reportEvents(
  calendarUrl: string,
  token: string,
  start: string,
  end: string,
): Promise<ParsedEvent[]> {
  const dtstart = toCalDAVDate(new Date(start).toISOString());
  const dtend   = toCalDAVDate(new Date(end).toISOString());

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\r\n` +
    `  <d:prop><d:getetag/><c:calendar-data/></d:prop>\r\n` +
    `  <c:filter>\r\n` +
    `    <c:comp-filter name="VCALENDAR">\r\n` +
    `      <c:comp-filter name="VEVENT">\r\n` +
    `        <c:time-range start="${dtstart}" end="${dtend}"/>\r\n` +
    `      </c:comp-filter>\r\n` +
    `    </c:comp-filter>\r\n` +
    `  </c:filter>\r\n` +
    `</c:calendar-query>`;

  // google-caldav: Depth: 1 is required; omitting returns 400
  const resp = await fetch(calendarUrl, {
    method: "REPORT",
    headers: {
      Authorization:   `Bearer ${token}`,
      "Content-Type":  "application/xml; charset=utf-8",
      Depth:           "1",
    },
    body,
  });

  if (resp.status !== 207) {
    throw new Error(`CalDAV REPORT failed: ${resp.status}`);
  }

  const xml = await resp.text();
  const events: ParsedEvent[] = [];

  // Cloudflare Workers have no DOMParser; extract calendar-data by regex regardless of namespace prefix
  const re = /<[^:>\s]+:calendar-data[^>]*>([\s\S]*?)<\/[^:>\s]+:calendar-data>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const ics = m[1].trim();
    if (ics) events.push(...parseIcs(ics));
  }
  return events;
}

export async function putEvent(
  calendarUrl: string,
  token: string,
  uid: string,
  icsString: string,
): Promise<void> {
  const url = `${calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "text/calendar; charset=utf-8",
    },
    body: icsString,
  });
  // google-caldav: Google returns 201 on create and 204 on overwrite
  if (resp.status !== 201 && resp.status !== 204) {
    throw new Error(`CalDAV PUT failed: ${resp.status}`);
  }
}

export async function deleteEvent(
  calendarUrl: string,
  token: string,
  uid: string,
): Promise<boolean> {
  const url = `${calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return false;
  if (resp.status !== 204) {
    throw new Error(`CalDAV DELETE failed: ${resp.status}`);
  }
  return true;
}
