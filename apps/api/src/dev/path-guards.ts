import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Whether `target` (relative paths resolve against `cwd`) is `root` or lies
 * inside it. Compares path segments, so `/repo-other` is not inside `/repo`,
 * and a child named `..x` is inside.
 */
export function isInsideDirectory(
  target: string,
  root: string,
  cwd: string = process.cwd(),
): boolean {
  const path = relative(resolve(root), resolve(cwd, target));
  if (path === '') return true;
  if (isAbsolute(path)) return false;
  return path !== '..' && !path.startsWith(`..${sep}`);
}

/** Refuses a script output directory inside the repository working tree. */
export function assertOutsideRepository(
  target: string,
  repoRoot: string,
  cwd: string = process.cwd(),
): string {
  if (isInsideDirectory(target, repoRoot, cwd))
    throw new Error('Pass an output directory outside the repository.');
  return resolve(cwd, target);
}
