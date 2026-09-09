import type { PersonProfile } from "@chief-of-staff-demo/shared";

/** Exact source slices, with offsets into the retained original for review/expansion. */
export function extractionPassages(text: string, profile: PersonProfile) {
  const size = text.length > 60000 ? 15000 : 16000;
  const passages = [];
  const signals = [
    profile.fullName,
    ...profile.emails,
    profile.currentEmployer,
    ...profile.employerHints,
  ]
    .filter((value): value is string => !!value?.trim())
    .map((value) => value.toLowerCase());
  for (let offset = 0; offset < text.length; offset += size) {
    const value = text.slice(offset, offset + size);
    const folded = value.toLowerCase();
    const passage = {
      text: value,
      offset,
      score: signals.filter((signal) => folded.includes(signal)).length,
    };
    if (text.length <= 60000 || offset === 0) passages.push(passage);
    else {
      // Only the best three non-opening candidates remain live. Scanning
      // another source window cannot grow retained candidate memory.
      const best = [...passages.slice(1), passage]
        .sort((a, b) => b.score - a.score || a.offset - b.offset)
        .slice(0, 3);
      passages.splice(1, passages.length - 1, ...best);
    }
  }
  // Restore document order; disjoint slices never masquerade as continuous text.
  return passages.sort((a, b) => a.offset - b.offset);
}
