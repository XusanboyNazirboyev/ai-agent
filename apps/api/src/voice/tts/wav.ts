/** Minimal WAV helpers: header parsing and generation (PCM s16le). */

export interface WavInfo {
  readonly sampleRateHz: number;
  readonly durationMs: number | null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WAVE'
  );
}

/** Reads sample rate and duration from the `fmt ` and `data` chunks. */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (!isWav(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let byteRate = 0;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      sampleRate = view.getUint32(body + 4, true);
      byteRate = view.getUint32(body + 8, true);
    } else if (id === 'data') {
      // A streamed WAV may carry 0 or 0xFFFFFFFF; use what is present.
      dataBytes =
        size === 0 || size === 0xffff_ffff || body + size > bytes.length
          ? bytes.length - body
          : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (sampleRate <= 0) return null;
  const durationMs =
    byteRate > 0 && dataBytes !== null
      ? Math.round((dataBytes / byteRate) * 1000)
      : null;
  return { sampleRateHz: sampleRate, durationMs };
}

/** A valid mono PCM s16le WAV of `samples` samples (a quiet tone). */
export function buildWav(sampleRateHz: number, samples: number): Uint8Array {
  const dataBytes = samples * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const put = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      out[offset + i] = text.charCodeAt(i);
    }
  };
  put(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((i / sampleRateHz) * 2 * Math.PI * 440) * 3000),
      true,
    );
  }
  return out;
}
