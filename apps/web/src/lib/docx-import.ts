import { unzipSync } from 'fflate';
import { DocumentImportError, tableToCsv } from './import-document';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT_WORD_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const MAIN_PART = 'word/document.xml';
const MAX_XML_BYTES = 8 * 1024 * 1024;

function wordChildren(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter(
    (child) =>
      child.namespaceURI === parent.namespaceURI && child.localName === name,
  );
}

function paragraphText(paragraph: Element): string {
  const ns = paragraph.namespaceURI;
  const nodes = paragraph.getElementsByTagNameNS(ns, '*');
  return Array.from(nodes, (node) => {
    if (node.closest('del, moveFrom, txbxContent')) return '';
    if (node.localName === 't') return node.textContent;
    if (node.localName === 'tab') return '\t';
    if (node.localName === 'br') return '\n';
    return '';
  })
    .join('')
    .trim();
}

export function readDocx(bytes: Uint8Array, mode: 'text' | 'table'): string {
  let entries = 0;
  const xml = unzipSync(bytes, {
    filter: (file) => {
      if (
        ++entries > 1000 ||
        (file.name === MAIN_PART && file.originalSize > MAX_XML_BYTES)
      )
        throw new DocumentImportError('tooLarge');
      return file.name === MAIN_PART;
    },
  })[MAIN_PART];
  if (!xml || xml.length > MAX_XML_BYTES)
    throw new DocumentImportError('unreadable');
  const source = new TextDecoder().decode(xml);
  if (/<!DOCTYPE|<!ENTITY/iu.test(source))
    throw new DocumentImportError('unreadable');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const ns = doc.documentElement.namespaceURI;
  if (ns !== WORD_NS && ns !== STRICT_WORD_NS)
    throw new DocumentImportError('unreadable');
  const body = doc.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw new DocumentImportError('unreadable');
  if (mode === 'text')
    return Array.from(body.getElementsByTagNameNS(ns, 'p'), paragraphText)
      .filter(Boolean)
      .join('\n');

  // A single regular table is easier to review and cannot mix multiple price lists.
  const tables = body.getElementsByTagNameNS(ns, 'tbl');
  if (tables.length !== 1) throw new DocumentImportError('noTable');
  const table = tables[0]!;
  for (const name of [
    'gridSpan',
    'vMerge',
    'hMerge',
    'gridBefore',
    'gridAfter',
    'del',
    'ins',
    'cellIns',
    'cellDel',
  ]) {
    if (table.getElementsByTagNameNS(ns, name).length)
      throw new DocumentImportError('noTable');
  }
  const rows = wordChildren(table, 'tr');
  if (rows.length !== table.getElementsByTagNameNS(ns, 'tr').length)
    throw new DocumentImportError('noTable');
  return tableToCsv(
    rows.map((row) => {
      const cells = wordChildren(row, 'tc');
      if (cells.length !== row.getElementsByTagNameNS(ns, 'tc').length)
        throw new DocumentImportError('noTable');
      return cells.map((cell) =>
        Array.from(cell.getElementsByTagNameNS(ns, 'p'), paragraphText).join(
          ' ',
        ),
      );
    }),
  );
}
