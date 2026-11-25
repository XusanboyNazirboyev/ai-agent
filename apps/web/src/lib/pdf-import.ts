import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { DocumentImportError, tableToCsv } from './import-document';

type Cell = { text: string; x: number; end: number };
type TextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

function pageRows(items: TextItem[]): Cell[][] {
  const lines: { y: number; items: TextItem[] }[] = [];
  items.sort((a, b) => b.transform[5]! - a.transform[5]!);
  for (const item of items) {
    const y = item.transform[5]!;
    const line = lines.at(-1);
    if (line && Math.abs(line.y - y) <= 2) line.items.push(item);
    else lines.push({ y, items: [item] });
  }
  return lines.map(({ items: line }) => {
    const cells: Cell[] = [];
    line.sort((a, b) => a.transform[4]! - b.transform[4]!);
    for (const item of line) {
      const x = item.transform[4]!;
      const end = x + item.width;
      const previous = cells.at(-1);
      const gap = previous ? x - previous.end : 0;
      if (previous && gap < Math.max(6, item.height * 0.9)) {
        const space =
          gap > item.height * 0.12 ||
          /\s$/u.test(previous.text) ||
          /^\s/u.test(item.str);
        previous.text =
          previous.text.trimEnd() + (space ? ' ' : '') + item.str.trimStart();
        previous.end = Math.max(previous.end, end);
      } else cells.push({ text: item.str, x, end });
    }
    return cells;
  });
}

function pdfTable(pages: Cell[][][]): string {
  const rows: Cell[][] = [];
  let header: string | undefined;
  for (const page of pages) {
    const first = page.findIndex((row) => row.length > 1);
    if (first === -1) throw new DocumentImportError('noTable');
    for (const row of page.slice(first)) {
      const label = row.map(({ text }) => text.trim().toLowerCase()).join('\t');
      if (
        row.length === 1 &&
        /^(?:page\s+)?\d+(?:\s*\/\s*\d+)?$/iu.test(label) &&
        row === page.at(-1)
      )
        continue;
      if (!header) header = label;
      else if (row === page[first] && label === header) continue;
      rows.push(row);
    }
  }
  const width = rows[0]?.length ?? 0;
  if (rows.length > 20_001 || width > 60)
    throw new DocumentImportError('tooLarge');
  if (rows.some((row) => row.length !== width))
    throw new DocumentImportError('noTable');
  // PDF gives positions, not cells. Reject overlapping or drifting columns.
  for (let column = 1; column < width; column += 1) {
    const prevEnd = Math.max(...rows.map((row) => row[column - 1]!.end));
    const nextStart = Math.min(...rows.map((row) => row[column]!.x));
    if (prevEnd >= nextStart) throw new DocumentImportError('noTable');
  }
  return tableToCsv(rows.map((row) => row.map(({ text }) => text.trim())));
}

export async function readPdf(
  bytes: Uint8Array,
  mode: 'text' | 'table',
  limit: number,
): Promise<string> {
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).href;
  const task = getDocument({
    data: bytes,
    useWasm: false,
    useWorkerFetch: false,
    stopAtErrors: true,
  });
  const timeout = setTimeout(() => void task.destroy().catch(() => {}), 20_000);
  try {
    const doc = await task.promise;
    if (doc.numPages > 100) throw new DocumentImportError('tooLarge');
    const pages: Cell[][][] = [];
    let chars = 0;
    let pieces = 0;
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const reader = page.streamTextContent().getReader();
      const items: TextItem[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const item of (value as { items: Array<TextItem | object> })
          .items) {
          if (!('str' in item) || !item.str.trim()) continue;
          chars += item.str.length;
          pieces += 1;
          if (chars > limit || pieces > 100_000)
            throw new DocumentImportError('tooLarge');
          if (
            mode === 'table' &&
            (item.transform[0]! <= 0 || item.transform[1] !== 0)
          )
            throw new DocumentImportError('noTable');
          items.push(item);
        }
      }
      pages.push(pageRows(items));
      page.cleanup();
    }
    if (chars === 0) throw new DocumentImportError('noText');
    if (mode === 'table') return pdfTable(pages);
    return pages
      .map((rows) =>
        rows
          .map((row) => row.map((cell) => cell.text.trim()).join(' '))
          .join('\n'),
      )
      .join('\n\n');
  } finally {
    clearTimeout(timeout);
    await task.destroy();
  }
}
