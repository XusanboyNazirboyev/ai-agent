# ADR 095 — PDF and Word document import

Status: implemented locally on 2026-11-25.

PDF and `.docx` extraction happens in the browser. Knowledge import places the
extracted text in the editable draft before consent and saving. Catalog import
converts a single rectangular table to CSV for the existing column mapping,
validation, preview, and explicit save. The original file stays in the browser.
No new endpoint, storage format, or use of an LLM is needed.

For knowledge, Word imports body paragraphs and PDF imports selectable text.
For a price list, use a header row and one offer per row. Word tables must have
unmerged cells. PDF price lists must have selectable text laid out in distinct,
consistent columns. Unsupported layouts, empty text, and encrypted documents
show an import error. Convert scans to text or use Excel or CSV for complex
tables. Always compare the extracted price and currency to the source.

Word reuses the project's `fflate` dependency and reads only `word/document.xml`
with bounded decompression and without DTDs or entities. PDF uses the pinned
Mozilla `pdfjs-dist` release and a lazily loaded, same-origin module worker.
PDF extraction has page, input, time, and extracted-text limits. The production
CSP explicitly allows same-origin workers. The dependency is used for byte and
text extraction only, with no document rendering or actions.

References checked 2026-11-25: [PDF.js release 6.5.438](https://github.com/mozilla/pdf.js/releases/tag/v6.5.438)
and [PDF.js examples](https://mozilla.github.io/pdf.js/examples/).
