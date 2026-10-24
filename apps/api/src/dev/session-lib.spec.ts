import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = resolve(__dirname, '../../scripts/telegram-session-lib.sh');

interface Run {
  output: string;
  code: number | null;
  calls: number;
  alive: number[];
}

/** Runs the real cleanup library with a fake delete command and fake children. */
async function run(options: {
  deleteOutput: string;
  action: 'term' | 'int' | 'hup' | 'exit-twice';
  stubbornChild?: boolean;
}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'session-lib-'));
  const calls = join(dir, 'calls');
  const pids = join(dir, 'pids');
  const fake = join(dir, 'fake-delete.sh');
  writeFileSync(
    fake,
    `#!/bin/sh\necho x >> "${calls}"\necho "${options.deleteOutput}"\n`,
  );
  chmodSync(fake, 0o755);
  const stubborn = options.stubbornChild
    ? `( trap '' TERM; exec sleep 60 ) & register_pid $!; echo $! >> "${pids}"`
    : '';
  const harness = `
set -u
. "${LIB}"
DELETE_WEBHOOK_CMD=("${fake}")
install_session_traps
sleep 60 & register_pid $!; echo $! >> "${pids}"
sleep 60 & register_pid $!; echo $! >> "${pids}"
${stubborn}
${options.action === 'exit-twice' ? 'session_cleanup; session_cleanup; exit 0' : 'echo READY; wait'}
`;
  const child = spawn('bash', ['-c', harness], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  if (options.action !== 'exit-twice') {
    await new Promise<void>((done) => {
      const timer = setInterval(() => {
        if (output.includes('READY')) {
          clearInterval(timer);
          done();
        }
      }, 20);
    });
    child.kill(
      { term: 'SIGTERM', int: 'SIGINT', hup: 'SIGHUP' }[
        options.action
      ] as NodeJS.Signals,
    );
  }
  const code = await new Promise<number | null>((done) =>
    child.on('close', done),
  );
  const recorded = existsSync(pids)
    ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)
    : [];
  const alive = recorded.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  for (const pid of alive) process.kill(pid, 'SIGKILL'); // never leak from a failing test
  const count = existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length
    : 0;
  return { output, code, calls: count, alive };
}

describe('telegram session cleanup', () => {
  it('is idempotent: two calls delete the webhook once and stop the children', async () => {
    const result = await run({
      deleteOutput: 'deleteWebhook: ok=true',
      action: 'exit-twice',
    });
    expect(result.calls).toBe(1);
    expect(result.output).toContain('cleanup: webhook deleted');
    expect(result.alive).toEqual([]);
  });

  it.each([
    ['term', 143],
    ['int', 130],
    ['hup', 129],
  ] as const)(
    'on %s deletes the webhook once, stops children and exits %i',
    async (action, exit) => {
      const result = await run({
        deleteOutput: 'deleteWebhook: ok=true',
        action,
      });
      expect(result.calls).toBe(1);
      expect(result.code).toBe(exit);
      expect(result.alive).toEqual([]);
      expect(result.output).toContain('cleanup: webhook deleted');
    },
  );

  it('reports a failed webhook deletion clearly and still stops the children', async () => {
    const result = await run({
      deleteOutput: 'deleteWebhook: ok=false',
      action: 'term',
    });
    expect(result.calls).toBe(1);
    expect(result.output).toContain('WEBHOOK DELETE NOT CONFIRMED');
    expect(result.output).toContain('telegram:live delete');
    expect(result.alive).toEqual([]);
  });

  it('escalates to SIGKILL for a child that ignores SIGTERM and says so', async () => {
    const result = await run({
      deleteOutput: 'deleteWebhook: ok=true',
      action: 'term',
      stubbornChild: true,
    });
    expect(result.output).toContain('needed SIGKILL');
    expect(result.alive).toEqual([]);
  });
});
