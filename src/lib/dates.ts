/**
 * Add business days to a date, skipping Saturday (6) and Sunday (0).
 * Plain Date arithmetic, no external dependencies.
 */
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}

/**
 * Count business days between two dates.
 * Returns negative if end is before start.
 */
export function businessDaysBetween(start: Date, end: Date): number {
  const startDate = new Date(start);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  if (endDate < startDate) {
    return -businessDaysBetween(end, start);
  }

  let count = 0;
  const current = new Date(startDate);
  while (current < endDate) {
    current.setDate(current.getDate() + 1);
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
