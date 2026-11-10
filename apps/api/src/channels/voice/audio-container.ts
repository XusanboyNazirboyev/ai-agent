/**
 * The audio container of a downloaded clip, decided from its first bytes
 * (ADR 042 amendment 2026-11-10). A CDN's `Content-Type` is not evidence:
 * Instagram serves an Ogg/Opus voice message as `video/mp4`. This is a
 * check of what arrived, not a guess: only the containers the voice policy
 * allows are recognised, and anything else is `null` (the clip is refused).
 */
export function sniffAudioContainer(data: Uint8Array): string | null {
  if (data.byteLength < 12) return null;
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...data.subarray(from, to));
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  const first = data[0] as number;
  const second = data[1] as number;
  // ADTS AAC: sync 0xFFF with layer bits 00; MPEG audio: sync 0xFFE+ with a
  // non-zero layer.
  if (first === 0xff && (second & 0xf6) === 0xf0) return 'audio/aac';
  if (first === 0xff && (second & 0xe0) === 0xe0 && (second >> 1) & 3)
    return 'audio/mpeg';
  return null;
}
