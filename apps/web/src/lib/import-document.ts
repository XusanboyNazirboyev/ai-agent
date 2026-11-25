export const DOCUMENT_EXTENSIONS = /\.(?:pdf|docx)$/iu;
export const DOCUMENT_ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export class DocumentImportError extends Error {
  constructor(readonly code: 'tooLarge' | 'noText' | 'noTable' | 'unreadable') {
    super(code);
  }
}

export async function readDocument(
  file: File,
  mode: 'text' | 'table',
  limit: number,
): Promise<string> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new DocumentImportError('tooLarge');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const text = file.name.toLowerCase().endsWith('.docx')
      ? (await import('./docx-import')).readDocx(bytes, mode)
      : await (await import('./pdf-import')).readPdf(bytes, mode, limit);
    if (text.length > limit) throw new DocumentImportError('tooLarge');
    if (!text.trim()) throw new DocumentImportError('noText');
    return text;
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError('unreadable');
  }
}

export function tableToCsv(rows: readonly (readonly string[])[]): string {
  const width = rows[0]?.length ?? 0;
  if (width < 2 || rows.length < 2 || rows.some((row) => row.length !== width))
    throw new DocumentImportError('noTable');
  if (width > 60 || rows.length > 20_001)
    throw new DocumentImportError('tooLarge');
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/gu, '""')}"`).join(','))
    .join('\n');
}
