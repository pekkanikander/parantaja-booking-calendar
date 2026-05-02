interface PuzzleRequest {
  nonce: string;
  slotStart: string;
  difficulty: number;
}

self.onmessage = async (e: MessageEvent<PuzzleRequest>) => {
  const { nonce, slotStart, difficulty } = e.data;
  const encoder = new TextEncoder();
  const fullBytes = Math.floor(difficulty / 8);
  const remainBits = difficulty % 8;
  const mask = remainBits > 0 ? (0xff << (8 - remainBits)) & 0xff : 0;

  for (let solution = 0; solution <= 0xffffffff; solution++) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${nonce}:${slotStart}:${solution}`),
    );
    const b = new Uint8Array(buf);
    let ok = true;
    for (let i = 0; i < fullBytes; i++) {
      if (b[i] !== 0) { ok = false; break; }
    }
    if (ok && remainBits > 0 && (b[fullBytes] & mask) !== 0) ok = false;
    if (ok) {
      self.postMessage({ solution });
      return;
    }
  }
};
