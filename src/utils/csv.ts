/**
 * Minimal RFC 4180 CSV writer.
 *
 * - Quotes a field iff it contains comma, double-quote, CR, or LF.
 * - Doubles any internal double-quote.
 * - Joins rows with CRLF for spreadsheet-app compatibility.
 */

export function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: Array<string | number | boolean | null | undefined>): string {
  return values.map(csvEscape).join(",");
}

export function csvLines(rows: Array<Array<string | number | boolean | null | undefined>>): string {
  return rows.map(csvRow).join("\r\n");
}
