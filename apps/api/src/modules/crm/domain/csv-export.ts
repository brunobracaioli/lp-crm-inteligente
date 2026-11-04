/**
 * CSV encoding for the staff export (contract `exportLeadsCsv`, threat model C21). Pure functions:
 * RFC 4180 quoting plus the formula-injection neutralization that applies to EVERY text cell.
 */

/** UTF-8 byte-order mark: lets Excel open the file as UTF-8. */
export const CSV_BOM = '﻿';
export const CSV_LINE_BREAK = '\r\n';

/** First significant character (after ASCII spaces) that a spreadsheet may read as a formula. */
const FORMULA_TRIGGER = /^ *[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;
const NEUTRALIZING_PREFIX = "'";

/** A cell value: text is neutralized, numbers and booleans are written as they are, null is empty. */
export type CsvCell = string | number | boolean | null;

/**
 * Prefixes `'` to a text cell whose first character, ignoring leading ASCII spaces, is one of
 * `= + - @ TAB CR` (so `=1+1` becomes `'=1+1`). Applied before quoting.
 */
export function neutralizeCsvText(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `${NEUTRALIZING_PREFIX}${text}` : text;
}

function quoteIfNeeded(text: string): string {
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function encodeCell(cell: CsvCell): string {
  if (cell === null) {
    return '';
  }
  if (typeof cell === 'string') {
    return quoteIfNeeded(neutralizeCsvText(cell));
  }
  return String(cell);
}

/** One record (no trailing line break). */
export function encodeCsvRow(cells: readonly CsvCell[]): string {
  return cells.map(encodeCell).join(',');
}

/** BOM + header + records, every record terminated by CRLF. */
export function encodeCsv(
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  const lines = [header, ...rows].map((row) => `${encodeCsvRow(row)}${CSV_LINE_BREAK}`);
  return `${CSV_BOM}${lines.join('')}`;
}
