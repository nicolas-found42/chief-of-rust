/**
 * What to ask public search on behalf of a watchlist: who is named alongside
 * each watched person. One query per person keeps the Run bounded.
 */
export function coMentionQueries(approvedPeople: { name: string }[], limit = 5): string[] {
  return approvedPeople.slice(0, limit).map((person) => `"${person.name}" interview OR podcast`);
}
