// Simple, transparent subject-based pricing. Kept server-side so the amount
// charged is always derived from the subject count, never taken from the
// client.
export const PRICE_PER_SUBJECT_INR = 299;

export function amountForSubjects(subjectCount: number): number {
  return subjectCount * PRICE_PER_SUBJECT_INR * 100; // paise
}
