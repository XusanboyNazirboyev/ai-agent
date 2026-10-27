import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(import.meta.dirname, '../app/globals.css'),
  'utf8',
);

type Tokens = Record<string, string>;

function parse(block: string): Tokens {
  const tokens: Tokens = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/giu))
    tokens[match[1]] = match[2];
  return tokens;
}

const light = parse(css.slice(0, css.indexOf('@media (prefers-color-scheme')));
const darkBlock = css.slice(
  css.indexOf('@media (prefers-color-scheme: dark)'),
  css.indexOf('@theme inline'),
);
const explicitDarkBlock = css.slice(
  css.indexOf(":root[data-theme='dark']"),
  css.indexOf(":root[data-theme='light']"),
);
const dark = { ...light, ...parse(darkBlock) };

describe('theme override', () => {
  it('the explicit dark theme has exactly the tokens of the system dark theme', () => {
    expect(parse(explicitDarkBlock)).toEqual(parse(darkBlock));
  });
});

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
/** Utility name (as used in class names) -> CSS variable name. */
const VARIABLE: Record<string, string> = {
  muted: 'fg-muted',
  brand: 'brand-text',
};

/** [foreground token or hex, background token, minimum ratio, where it is used] */
const PAIRS: [string, string, number, string][] = [
  ['fg', 'canvas', 4.5, 'body text'],
  ['fg', 'surface', 4.5, 'cards, list rows'],
  ['fg', 'surface-2', 4.5, 'segmented control, assistant bubbles'],
  ['muted', 'canvas', 4.5, 'secondary text'],
  ['muted', 'surface', 4.5, 'secondary text on cards'],
  ['muted', 'surface-2', 4.5, 'badges, inactive tabs'],
  ['muted', 'primary-soft', 4.5, 'secondary text on the selected row'],
  [WHITE, 'primary', 4.5, 'primary buttons, operator bubbles'],
  [WHITE, 'primary-hover', 4.5, 'primary button hover'],
  [WHITE, 'danger', 4.5, 'destructive button'],
  [WHITE, 'danger-hover', 4.5, 'destructive button hover'],
  ['on-primary-muted', 'primary', 4.5, 'meta text in operator bubbles'],
  ['primary-fg', 'surface', 4.5, 'accent text'],
  ['primary-fg', 'primary-soft', 4.5, 'accent badges'],
  ['brand', 'surface', 4.5, 'wordmark in the header'],
  ['brand', 'canvas', 4.5, 'wordmark on the login page'],
  ['success-fg', 'success-soft', 4.5, 'success badge'],
  ['success-fg', 'surface', 4.5, 'toast check icon'],
  ['warning-fg', 'warning-soft', 4.5, 'warning badge, SLA banner, notes'],
  ['danger-fg', 'danger-soft', 4.5, 'error banners, danger badge'],
  ['danger-fg', 'surface', 4.5, 'overdue text'],
  // Non-text (WCAG 1.4.11): focus ring and logo mark against their surface.
  ['ring', 'surface', 3, 'focus ring'],
  ['ring', 'canvas', 3, 'focus ring'],
  ['primary', 'surface', 3, 'logo mark'],
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme contrast (WCAG AA)', (_name, tokens) => {
  it.each(PAIRS)('%s on %s >= %s (%s)', (fg, bg, minimum) => {
    const front = fg.startsWith('#') ? fg : tokens[VARIABLE[fg] ?? fg];
    const back = tokens[VARIABLE[bg] ?? bg];
    expect(front, `token ${fg}`).toBeDefined();
    expect(back, `token ${bg}`).toBeDefined();
    expect(contrast(front, back)).toBeGreaterThanOrEqual(minimum);
  });
});

describe('contrast helper', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});
