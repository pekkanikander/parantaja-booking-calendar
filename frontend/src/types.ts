export interface GCalEvent {
  id: string;
  summary: string;
  // timed events use dateTime; all-day events use date
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

export interface Slot {
  id: string;    // ISO 8601 start timestamp — the slot's identity
  start: string; // ISO 8601
  end: string;   // ISO 8601
}
