/**
 * The operator's calendar day, `YYYY-MM-DD`, in local time.
 *
 * Local rather than UTC because "one Run per day" is a promise about the day the
 * person is living in: a Run at 23:00 local and one at 00:30 the next morning
 * are two days to them, whatever UTC says.
 */
export function localDay(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `day` minus `days`, as the same string shape. */
export function dayBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}
