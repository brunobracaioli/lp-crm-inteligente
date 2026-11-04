import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  encodeCsv,
  encodeCsvRow,
  neutralizeCsvText,
  type CsvCell,
} from '#/modules/crm/domain/csv-export.ts';

/** Reference RFC 4180 reader (CRLF records, quoted fields with doubled quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += char;
    }
  }
  return rows;
}

const FORMULA_START = /^ *[=+\-@\t\r]/;

describe('neutralizeCsvText (C21)', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+5511999990000', "'+5511999990000"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', "'\rcmd"],
    ['   =1+1', "'   =1+1"],
    [' @x', "' @x"],
  ])('prefixes %j', (input, expected) => {
    expect(neutralizeCsvText(input)).toBe(expected);
  });

  it.each(['maria', 'a=b', '1+1', ' x=1', '', "'=1+1", 'João', '0.5'])(
    'leaves %j alone',
    (input) => {
      expect(neutralizeCsvText(input)).toBe(input);
    },
  );

  it('never leaves a formula trigger first, for any text (ST-19)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(FORMULA_START.test(neutralizeCsvText(text))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('only ever adds one leading apostrophe', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const out = neutralizeCsvText(text);
        expect(out === text || out === `'${text}`).toBe(true);
      }),
    );
  });
});

describe('encodeCsv', () => {
  it('starts with the BOM, ends every record with CRLF', () => {
    const csv = encodeCsv(['a', 'b'], [[1, 'x']]);
    expect(csv).toBe(`${CSV_BOM}a,b\r\n1,x\r\n`);
  });

  it('quotes cells with comma, quote, CR or LF and doubles the quotes', () => {
    expect(encodeCsvRow(['a,b', 'say "hi"', 'line1\nline2', 'cr\rx', 'plain'])).toBe(
      '"a,b","say ""hi""","line1\nline2","cr\rx",plain',
    );
  });

  it('writes null as an empty cell and leaves numbers and booleans untouched', () => {
    expect(encodeCsvRow([null, 0, -5, true, false, 42.5])).toBe(',0,-5,true,false,42.5');
  });

  it('neutralizes before quoting', () => {
    expect(encodeCsvRow(['=A1,B1'])).toBe('"\'=A1,B1"');
  });

  it('round-trips arbitrary text through a CSV reader (ST-19)', () => {
    const cell = fc.string({ unit: 'binary' }).filter((text) => !text.includes('\u0000'));
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 1, maxLength: 5 }), { maxLength: 6 }),
        (rows) => {
          const width = Math.max(1, ...rows.map((row) => row.length));
          const padded = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
          const header = Array.from({ length: width }, (_, i) => `h${String(i)}`);
          const parsed = parseCsv(encodeCsv(header, padded).slice(CSV_BOM.length));
          expect(parsed[0]).toEqual(header);
          expect(parsed.slice(1).map((row) => row.map((value) => value))).toEqual(
            padded.map((row) => row.map((value) => neutralizeCsvText(value))),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps numeric and boolean cells unquoted and un-prefixed', () => {
    const cells: CsvCell[] = [-1, 3, false];
    expect(encodeCsvRow(cells)).toBe('-1,3,false');
  });
});
