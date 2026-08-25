/**
 * Shared certification utilities for TMDB age classifications.
 * Used by MovieDetails, TVDetails, and profile age restriction checks.
 */

export const allAgesCerts = new Set([
  'TP', 'TP+', 'G', 'PG', 'TV-Y', 'TV-G', 'TV-PG', 'U', '0', 'T', 'ALL', 'L', 'AA', 'A', 'ATP'
]);

export const ageMap: Record<string, number> = {
  '6': 6, '6+': 6,
  '7': 7, 'TV-Y7': 7,
  '10': 10,
  '12': 12, '12A': 12, 'PG12': 12, 'IIB': 12,
  'PG-13': 13, 'R13': 13, 'R-13': 13, '+13': 13,
  '14': 14, '14A': 14, '14+': 14, 'TV-14': 14,
  '15': 15, 'MA 15+': 15, 'M': 15, 'R15+': 15, 'K15': 15, 'B': 15, 'B-15': 15,
  '16': 16, '+16': 16, 'NC16': 16, 'K-16': 16, 'N-16': 16, '16+': 16,
  'R': 17, 'TV-MA': 17, 'NC-17': 17,
  '18': 18, '18+': 18, '18A': 18, 'R18+': 18, 'M18': 18, 'III': 18, 'R-18': 18, '18SG': 18, 'N-18': 18, 'C': 18, 'D': 18,
  '19': 19, '21+': 21,
};

export const getClassificationLabel = (certification: string, t: (key: string, options?: Record<string, unknown>) => string): string => {
  if (allAgesCerts.has(certification)) {
    return t('details.allAges');
  }
  if (certification in ageMap) {
    return t('details.ageAndAbove', { age: ageMap[certification] });
  }
  return certification;
};

/** Get the numeric minimum age for a TMDB certification string. Returns 0 for all-ages or unknown. */
export const getNumericAge = (certification: string): number => {
  if (allAgesCerts.has(certification)) return 0;
  return ageMap[certification] ?? 0;
};

/**
 * Check if content is allowed for a profile's age restriction.
 * @param contentCert - TMDB certification string (e.g. "PG-13", "R", "18+")
 * @param profileAgeRestriction - Profile age restriction (0 = no restriction, 7, 12, 16, 18)
 * @returns true if content is allowed
 */
export const isContentAllowed = (contentCert: string, profileAgeRestriction: number): boolean => {
  if (!profileAgeRestriction || profileAgeRestriction === 0) return true;
  const normalizedCert = contentCert?.trim().toUpperCase();
  // A missing/unrecognised classification must not expose a title to a minor
  // profile while the app cannot establish that it is suitable. Adults (18+)
  // retain access to these unrated titles.
  if (!normalizedCert || (!allAgesCerts.has(normalizedCert) && !(normalizedCert in ageMap))) {
    return profileAgeRestriction >= 18;
  }
  const contentAge = getNumericAge(normalizedCert);
  return contentAge <= profileAgeRestriction;
};
