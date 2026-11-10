import { describe, expect, it } from 'vitest';
import { sniffAudioContainer } from './audio-container.js';

const bytes = (head: number[] | string, length = 64): Uint8Array => {
  const out = new Uint8Array(length);
  const values =
    typeof head === 'string'
      ? [...head].map((char) => char.charCodeAt(0))
      : head;
  out.set(values, 0);
  return out;
};
const at = (offset: number, text: string, length = 64): Uint8Array => {
  const out = new Uint8Array(length);
  out.set(
    [...text].map((char) => char.charCodeAt(0)),
    offset,
  );
  return out;
};

describe('sniffAudioContainer', () => {
  it('recognises the containers the voice policy allows', () => {
    expect(sniffAudioContainer(bytes('OggS'))).toBe('audio/ogg');
    expect(sniffAudioContainer(at(4, 'ftypM4A '))).toBe('audio/mp4');
    expect(sniffAudioContainer(bytes('ID3'))).toBe('audio/mpeg');
    expect(sniffAudioContainer(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe(
      'audio/mpeg',
    );
    expect(sniffAudioContainer(bytes([0xff, 0xf1, 0x50, 0x80]))).toBe(
      'audio/aac',
    );
    const wav = bytes('RIFF');
    wav.set(
      [...'WAVE'].map((char) => char.charCodeAt(0)),
      8,
    );
    expect(sniffAudioContainer(wav)).toBe('audio/wav');
  });

  it('refuses everything else, including look-alikes and short input', () => {
    expect(sniffAudioContainer(new Uint8Array(64))).toBeNull();
    expect(sniffAudioContainer(bytes('<html><body>'))).toBeNull();
    expect(sniffAudioContainer(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffAudioContainer(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
    expect(sniffAudioContainer(bytes('OggS', 8))).toBeNull();
    // RIFF that is not WAVE (e.g. AVI), and a sync with layer bits 00 but
    // other flags that are neither AAC nor MPEG.
    const avi = bytes('RIFF');
    avi.set(
      [...'AVI '].map((char) => char.charCodeAt(0)),
      8,
    );
    expect(sniffAudioContainer(avi)).toBeNull();
    expect(sniffAudioContainer(bytes([0xff, 0xe0, 0, 0]))).toBeNull();
  });
});
