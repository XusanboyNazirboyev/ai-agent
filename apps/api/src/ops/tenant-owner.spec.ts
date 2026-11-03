import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOMAIN_PACKS } from '../packs/registry.js';
import {
  generateOwnerPassword,
  parseTenantOwnerArgs,
  writePasswordFile,
} from './tenant-owner.js';

const PACK = [...DOMAIN_PACKS.keys()][0] as string;
const VALID = [
  '--slug',
  'eduflow',
  '--name',
  'EduFlow',
  '--pack',
  PACK,
  '--locale',
  'uz-Latn',
  '--timezone',
  'Asia/Tashkent',
  '--email',
  ' Owner@Example.COM ',
  '--owner-name',
  'Owner',
  '--password-file',
  '/out/owner.password',
];

function withFlag(flag: string, value: string): string[] {
  const args = [...VALID];
  args[args.indexOf(flag) + 1] = value;
  return args;
}

describe('create-tenant-owner arguments', () => {
  it('accepts a complete command and normalizes the email', () => {
    expect(parseTenantOwnerArgs(VALID)).toEqual({
      slug: 'eduflow',
      name: 'EduFlow',
      pack: PACK,
      defaultLocale: 'uz-Latn',
      timezone: 'Asia/Tashkent',
      email: 'owner@example.com',
      ownerName: 'Owner',
      passwordFile: '/out/owner.password',
    });
  });

  it('names every missing flag and prints the usage', () => {
    expect(() => parseTenantOwnerArgs(['--slug', 'x'])).toThrow(
      /--name is required[\s\S]*--password-file is required[\s\S]*usage:/,
    );
  });

  it('refuses unknown flags and flags without a value', () => {
    expect(() => parseTenantOwnerArgs([...VALID, '--role', 'ADMIN'])).toThrow(
      /unknown argument --role/,
    );
    expect(() =>
      parseTenantOwnerArgs(['--slug', '--name', ...VALID.slice(2)]),
    ).toThrow(/--slug needs a value/);
  });

  it.each([
    ['--slug', 'Edu Flow', /--slug:/],
    ['--slug', '-eduflow', /--slug:/],
    ['--pack', 'unknown@1', /--pack: one of/],
    ['--locale', 'de', /--locale: one of/],
    ['--timezone', 'Mars/Olympus', /--timezone:/],
    ['--email', 'not-an-email', /--email:/],
    ['--name', 'x'.repeat(201), /--name:/],
  ])('refuses %s %s', (flag, value, message) => {
    expect(() => parseTenantOwnerArgs(withFlag(flag, value))).toThrow(message);
  });
});

describe('owner password file', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is written with mode 0600 and never overwritten', async () => {
    dir = await mkdtemp(join(tmpdir(), 'owner-'));
    const file = join(dir, 'owner.password');
    const password = generateOwnerPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);

    await writePasswordFile(file, password);
    expect(await readFile(file, 'utf8')).toBe(`${password}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writePasswordFile(file, 'other')).rejects.toThrow(/EEXIST/);
    expect(await readFile(file, 'utf8')).toBe(`${password}\n`);
  });
});
