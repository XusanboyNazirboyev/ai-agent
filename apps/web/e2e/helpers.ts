import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { E2E_ENV } from '../playwright.config';
import { FIXTURE_FILE } from './global-setup';

export interface TenantFixture {
  tenantId: string;
  operators: Record<string, { id: string; email: string }>;
  conversations: { id: string; handoverId: string; contactName: string }[];
}
export interface Fixtures {
  password: string;
  a: TenantFixture;
  b: TenantFixture;
}

let clients = 0;
/**
 * A distinct client address per browser context, as an edge proxy would
 * append it (the e2e web server trusts exactly one hop).
 */
export function nextClientAddress(): string {
  clients += 1;
  return `198.18.${Math.floor(clients / 250) % 250}.${(clients % 250) + 1}`;
}

export const fixtures = (): Fixtures =>
  JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Fixtures;

function run(args: string[]): string {
  return execFileSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/e2e-fixtures.ts', ...args],
    {
      cwd: resolve(import.meta.dirname, '../../api'),
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_POSTGRES_HOST: E2E_ENV.POSTGRES_HOST,
        TEST_POSTGRES_PORT: E2E_ENV.POSTGRES_PORT,
        TEST_POSTGRES_DATABASE: E2E_ENV.POSTGRES_DATABASE,
        TEST_POSTGRES_USER: E2E_ENV.POSTGRES_USER,
        TEST_POSTGRES_PASSWORD: E2E_ENV.POSTGRES_PASSWORD,
        TEST_POSTGRES_SSL_MODE: E2E_ENV.POSTGRES_SSL_MODE,
      },
    },
  );
}

export function customerMessage(
  tenantId: string,
  conversationId: string,
  text: string,
): void {
  run(['customer-message', tenantId, conversationId, text]);
}

export function uncertainAction(
  tenantId: string,
  conversationId: string,
): string {
  const out = run(['uncertain-action', tenantId, conversationId])
    .trim()
    .split('\n')
    .pop()!;
  return (JSON.parse(out) as { proposalId: string }).proposalId;
}

export function newHandover(
  tenantId: string,
  name: string,
): { id: string; handoverId: string; contactName: string } {
  const out = run(['new-handover', tenantId, name]).trim().split('\n').pop()!;
  return JSON.parse(out) as {
    id: string;
    handoverId: string;
    contactName: string;
  };
}

export async function login(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/inbox/u);
}

export async function newSession(
  browser: Browser,
  email: string,
  options: {
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3010',
    extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
    ...options,
  });
  const page = await context.newPage();
  await login(page, email, fixtures().password);
  return { context, page };
}

/** Reads SSE frames from the API (through the web proxy) with a session cookie. */
export function readSse(options: {
  cookie: string;
  lastEventId?: string;
  until: (frames: string[]) => boolean;
  timeoutMs: number;
}): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const frames: string[] = [];
    const request = http.get(
      'http://127.0.0.1:3010/api/v1/events',
      {
        headers: {
          cookie: options.cookie,
          accept: 'text/event-stream',
          ...(options.lastEventId
            ? { 'last-event-id': options.lastEventId }
            : {}),
        },
      },
      (response) => {
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf('\n\n');
          while (index >= 0) {
            frames.push(buffer.slice(0, index));
            buffer = buffer.slice(index + 2);
            index = buffer.indexOf('\n\n');
          }
          if (options.until(frames)) {
            request.destroy();
            resolvePromise(frames);
          }
        });
      },
    );
    request.on('error', () => resolvePromise(frames));
    setTimeout(() => {
      request.destroy();
      resolvePromise(frames);
    }, options.timeoutMs).unref();
    request.on('close', () => resolvePromise(frames));
    void reject;
  });
}

export async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Horizontal overflow, content spilling out of its box, anything beyond the viewport. */
export async function findOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > window.innerWidth)
      problems.push(`page scrolls sideways (${root.scrollWidth}px)`);
    const describe = (el: Element): string =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}[${(el.getAttribute('data-testid') ?? el.className.toString()).slice(0, 60)}] "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.position === 'fixed') continue;
      if (box.right > window.innerWidth + 1 || box.left < -1) {
        // Skip children of horizontally scrolling containers.
        let scroller = el.parentElement;
        let inside = false;
        while (scroller) {
          const overflowX = getComputedStyle(scroller).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll') inside = true;
          scroller = scroller.parentElement;
        }
        if (!inside) problems.push(`outside viewport: ${describe(el)}`);
      }
      if (
        style.overflowX === 'visible' &&
        style.textOverflow !== 'ellipsis' &&
        el.scrollWidth > el.clientWidth + 1 &&
        el.clientWidth > 0 &&
        !(el instanceof SVGElement)
      )
        problems.push(`content spills: ${describe(el)}`);
    }
    return problems;
  });
}
