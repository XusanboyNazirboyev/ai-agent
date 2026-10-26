import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repository-level check of the Claude Code project configuration (Stage D).
 * It verifies what the repository itself can guarantee: syntax, the model
 * ceiling in files we own, and rule paths that exist. Enforcement of the
 * ceiling for a user's session needs managed settings, which this repository
 * cannot write (docs/CLAUDE_CODE_SETUP.md).
 */
const root = resolve(__dirname, '../../../..');
const claude = resolve(root, '.claude');
const ALLOWED_MODELS = new Set(['haiku', 'sonnet', 'opus']);
const FORBIDDEN = /fable|mythos|\bbest\b/iu;

function frontmatter(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  expect(match, `${file} has frontmatter`).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of match![1].split('\n')) {
    const field = /^([A-Za-z]+):\s*(.*)$/u.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

describe('.claude project configuration', () => {
  it('settings.json is valid JSON and pins an allowed default model', () => {
    const settings = JSON.parse(
      readFileSync(resolve(claude, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(ALLOWED_MODELS.has(settings.model as string)).toBe(true);
    expect(JSON.stringify(settings)).not.toMatch(FORBIDDEN);
  });

  it('every subagent has complete frontmatter and an allowed model', () => {
    const dir = resolve(claude, 'agents');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.sort()).toEqual([
      'architect.md',
      'builder.md',
      'mechanical.md',
      'reviewer.md',
    ]);
    for (const file of files) {
      const meta = frontmatter(resolve(dir, file));
      expect(meta.name, file).toBe(file.replace(/\.md$/u, ''));
      expect(meta.description, file).toBeTruthy();
      expect(ALLOWED_MODELS.has(meta.model), `${file} model`).toBe(true);
      expect(['low', 'medium', 'high']).toContain(meta.effort);
      expect(Number(meta.maxTurns), file).toBeGreaterThan(0);
    }
  });

  it('read-only subagents declare no write tools', () => {
    for (const file of ['architect.md', 'reviewer.md']) {
      const { tools } = frontmatter(resolve(claude, 'agents', file));
      expect(tools, file).toBeTruthy();
      expect(tools).not.toMatch(/\b(Write|Edit|NotebookEdit)\b/u);
    }
    // The reviewer may only run read-only git commands.
    const { tools } = frontmatter(resolve(claude, 'agents', 'reviewer.md'));
    expect(tools).not.toMatch(/Bash(?!\()/u);
  });

  it('every path-scoped rule matches an existing directory', () => {
    const dir = resolve(claude, 'rules');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(resolve(dir, file), 'utf8');
      const paths = [...text.matchAll(/^\s+-\s+"([^"]+)"/gmu)].map((m) => m[1]);
      expect(paths.length, file).toBeGreaterThan(0);
      for (const glob of paths) {
        const base = glob.replace(/\/?\*\*.*$/u, '');
        expect(existsSync(resolve(root, base)), `${file}: ${glob}`).toBe(true);
      }
    }
  });

  it('project instructions and setup doc state the same ceiling', () => {
    const agents = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8');
    const setup = readFileSync(
      resolve(root, 'docs/CLAUDE_CODE_SETUP.md'),
      'utf8',
    );
    for (const text of [agents, setup]) {
      expect(text).toMatch(/Opus 5\.5/u);
      expect(text).toMatch(/"?sonnet"?/u);
    }
    expect(agents).toMatch(/`mechanical` \(haiku\)/u);
  });
});
