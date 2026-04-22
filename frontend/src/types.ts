export interface Slot {
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

export interface BookRequest {
  slot_start: string;
  attendee: { name: string; email?: string };
  notes?: string;
}

export interface BookResponse {
  uid: string;
  start: string;
  end: string;
  cancellation_nonce: string;
}
