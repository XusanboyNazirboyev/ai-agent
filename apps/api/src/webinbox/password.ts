import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** OWASP-recommended scrypt setting (N=2^16, r=8, p=2). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 65_536, r: 8, p: 2 };
const KEY_LENGTH = 32;
const MAX_N = 2 ** 18;

function derive(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 256 * 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$salt$hash` (base64url): parameters travel with the hash. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (
    !Number.isInteger(params.N) ||
    params.N < 2 ||
    params.N > MAX_N ||
    !Number.isInteger(params.r) ||
    params.r < 1 ||
    params.r > 16 ||
    !Number.isInteger(params.p) ||
    params.p < 1 ||
    params.p > 4
  )
    return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
