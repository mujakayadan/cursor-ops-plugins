export function orderTotals(lines: number[]): number {
  return lines.reduce((sum, n) => sum + n, 0);
}
