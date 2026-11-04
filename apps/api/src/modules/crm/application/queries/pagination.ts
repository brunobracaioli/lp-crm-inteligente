/** Contract `PageLimit` / `ActivitiesLimit` / detail `submissions` bounds. */
export const DEFAULT_LEAD_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_ACTIVITIES_PAGE_SIZE = 20;
/** The detail returns the 50 most recent submissions; the total is `lead.submissions_count`. */
export const MAX_DETAIL_SUBMISSIONS = 50;

/** The route validates the limit; a use case receiving a bad one is a programming error. */
export function assertPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`page limit must be an integer between 1 and ${String(MAX_PAGE_SIZE)}`);
  }
}
