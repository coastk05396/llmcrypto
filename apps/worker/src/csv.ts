/**
 * CSV cell encoding with spreadsheet formula-injection protection (OWASP "CSV Injection").
 * A text cell whose first meaningful character could start a formula in Excel/LibreOffice/Sheets is prefixed with a
 * single quote, which spreadsheets render as literal text. Numeric columns that really are integers are left untouched,
 * so a negative ledger amount stays a number; a "numeric" column holding anything else is escaped like text.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be detected
const TRIGGERS = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/u;
const INTEGER = /^-?\d+$/;

export function csvCell(value: string | null, numeric = false): string {
  if (value === null || value === "") return "";
  let v = value;
  let forceQuote = false;
  if (!(numeric && INTEGER.test(v)) && TRIGGERS.test(v)) {
    v = `'${v}`;
    forceQuote = true;
  }
  return forceQuote || /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface CsvColumn<T> {
  header: string;
  numeric?: boolean;
  get(row: T): string | null;
}

/** RFC 4180: CRLF line endings, header row first. */
export function csvLine(cells: string[]): string {
  return `${cells.join(",")}\r\n`;
}
export const csvHeader = <T>(cols: readonly CsvColumn<T>[]): string => csvLine(cols.map((c) => csvCell(c.header)));
export const csvRow = <T>(cols: readonly CsvColumn<T>[], row: T): string => csvLine(cols.map((c) => csvCell(c.get(row), c.numeric === true)));
