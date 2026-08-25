/**
 * Utility functions for search operations
 */

/**
 * Cleans a search term by removing special characters while preserving hyphens and connecting characters
 * This is used for fallback searches when the initial search returns no results
 *
 * Examples:
 * - "Yu-Gi-Oh! GX" -> "Yu-Gi-Oh GX"
 * - "Fate/stay night" -> "Fate stay night"
 * - "JoJo's Bizarre Adventure" -> "JoJo's Bizarre Adventure"
 * - "Re:Zero" -> "Re Zero"
 *
 * @param searchTerm The original search term
 * @returns The cleaned search term with special characters removed
 */
export function cleanSearchTerm(searchTerm: string): string {
  if (!searchTerm) return "";

  // Remove special characters but keep:
  // - Hyphens (-)
  // - Apostrophes (')
  // - Colons (:) but convert them to spaces
  // - Forward slashes (/) but convert them to spaces
  // - Spaces and alphanumeric characters

  return (
    searchTerm
      // Replace colons and forward slashes with spaces
      .replace(/[:/]/g, " ")
      // Remove exclamation marks, question marks, and other special punctuation
      .replace(/[!?.,;""''""''`~@#$%^&*()+=\[\]{}|\\<>]/g, "")
      // Keep hyphens, apostrophes, spaces, and alphanumeric characters
      .replace(/[^a-zA-Z0-9\s\-']/g, "")
      // Clean up multiple spaces
      .replace(/\s+/g, " ")
      // Trim whitespace
      .trim()
  );
}

/**
 * Mots à un seul terme considérés trop génériques pour être une variation de recherche.
 * Sinon "Stranger Things : Chroniques de 1985" se dégrade en "Stranger" et matche
 * n'importe quel anime qui contient "stranger".
 */
const GENERIC_SINGLE_WORDS: ReadonlySet<string> = new Set([
  "the",
  "one",
  "two",
  "three",
  "hero",
  "boy",
  "girl",
  "king",
  "queen",
  "god",
  "war",
  "life",
  "dead",
  "true",
  "lost",
  "star",
  "stranger",
  "love",
  "hate",
  "fight",
  "dark",
  "light",
  "last",
  "first",
  "new",
  "old",
  "man",
  "men",
  "woman",
  "world",
  "city",
  "dream",
  "night",
  "day",
  "story",
  "time",
  "way",
  "beast",
  "devil",
  "saint",
  "demon",
  "knight",
  "prince",
  "princess",
  "secret",
  "great",
  "wild",
  "blue",
  "red",
  "black",
  "white",
  "green",
  "ghost",
  "tales",
  "legend",
]);

const MIN_SINGLE_WORD_LENGTH = 6;

function isAcceptableVariation(variation: string): boolean {
  const trimmed = variation.trim();
  if (!trimmed) return false;
  const cleanedWords = cleanSearchTerm(trimmed).split(" ").filter(Boolean);
  if (cleanedWords.length > 1) return true;
  const word = (cleanedWords[0] || "").toLowerCase();
  if (!word) return false;
  if (word.length < MIN_SINGLE_WORD_LENGTH) return false;
  if (GENERIC_SINGLE_WORDS.has(word)) return false;
  return true;
}

/**
 * Generates multiple search term variations for fallback searches
 *
 * @param originalTerm The original search term
 * @returns Array of search term variations to try
 */
export function generateSearchVariations(originalTerm: string): string[] {
  const variations: string[] = [];

  // Add the original term first
  variations.push(originalTerm);

  // Add lowercase version if the original term is all uppercase
  if (
    originalTerm === originalTerm.toUpperCase() &&
    originalTerm !== originalTerm.toLowerCase()
  ) {
    const lowercase = originalTerm.toLowerCase();
    if (!variations.includes(lowercase)) {
      variations.push(lowercase);
    }
  }

  // Add cleaned version (removes special characters)
  const cleaned = cleanSearchTerm(originalTerm);
  if (cleaned && cleaned !== originalTerm) {
    variations.push(cleaned);
  }

  // Special handling for titles with hyphens that might indicate subtitles or additional info
  // Pattern: "MainTitle -Subtitle-" or "MainTitle - Subtitle"
  if (originalTerm.includes("-")) {
    // Check for pattern like "Kakuriyo -Bed & Breakfast for Spirits-"
    const hyphenPattern = /^([^-]+)\s*-([^-]+)-?\s*$/;
    const match = originalTerm.match(hyphenPattern);

    if (match) {
      const mainTitle = match[1].trim();
      const subtitle = match[2].trim();

      // Add just the main title (e.g., "Kakuriyo")
      if (mainTitle && !variations.includes(mainTitle)) {
        variations.push(mainTitle);
      }

      // Add main title + subtitle without hyphens (e.g., "Kakuriyo Bed & Breakfast for Spirits")
      const combined = `${mainTitle} ${subtitle}`.trim();
      if (combined && !variations.includes(combined)) {
        variations.push(combined);
      }

      // Add cleaned version of the combined title
      const cleanedCombined = cleanSearchTerm(combined);
      if (
        cleanedCombined &&
        cleanedCombined !== combined &&
        !variations.includes(cleanedCombined)
      ) {
        variations.push(cleanedCombined);
      }
    } else {
      // Standard hyphen replacement for cases like "One-Punch Man" -> "One Punch Man"
      const withoutHyphens = originalTerm
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (withoutHyphens && !variations.includes(withoutHyphens)) {
        variations.push(withoutHyphens);
      }
    }
  }

  // If the term contains special characters that might indicate a subtitle or additional info
  // Try removing everything after certain characters
  const specialChars = ["!", "?", ":", "~", "–", "—"];
  for (const char of specialChars) {
    if (originalTerm.includes(char)) {
      const beforeSpecial = originalTerm.split(char)[0].trim();
      if (
        beforeSpecial &&
        beforeSpecial !== originalTerm &&
        !variations.includes(beforeSpecial)
      ) {
        variations.push(beforeSpecial);

        // Also add cleaned version of the truncated term
        const cleanedBeforeSpecial = cleanSearchTerm(beforeSpecial);
        if (
          cleanedBeforeSpecial &&
          cleanedBeforeSpecial !== beforeSpecial &&
          !variations.includes(cleanedBeforeSpecial)
        ) {
          variations.push(cleanedBeforeSpecial);
        }

        // Also add version without hyphens for the truncated term
        if (beforeSpecial.includes("-")) {
          const beforeSpecialNoHyphens = beforeSpecial
            .replace(/-/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (
            beforeSpecialNoHyphens &&
            !variations.includes(beforeSpecialNoHyphens)
          ) {
            variations.push(beforeSpecialNoHyphens);
          }
        }
      }
    }
  }

  // Special case for "Bienvenue dans la NHK !" -> "Bienvenue dans la NHK"
  // This ensures the variation without exclamation mark is tried early
  if (
    originalTerm.includes("!") &&
    originalTerm.toLowerCase().includes("bienvenue") &&
    originalTerm.toLowerCase().includes("nhk")
  ) {
    const withoutExclamation = originalTerm.replace(/!/g, "").trim();
    if (withoutExclamation && !variations.includes(withoutExclamation)) {
      // Insert this variation early in the list for priority
      variations.splice(1, 0, withoutExclamation);
    }
  }

  // Special case for "Star Wars" titles - preserve the original format
  // Star Wars titles should be searched with their exact original name
  if (originalTerm.toLowerCase().includes("star wars")) {
    // Return early with only the original term and a cleaned version
    // This prevents excessive variations that might break Star Wars searches
    return [originalTerm, cleaned].filter(
      (term, index, arr) => term && term.trim() && arr.indexOf(term) === index,
    );
  }

  // For terms with multiple words, try progressively shorter versions
  const words = cleaned.split(" ").filter((word) => word.length > 0);
  if (words.length > 2) {
    // Try first 3 words
    if (words.length > 3) {
      const first3Words = words.slice(0, 3).join(" ");
      if (!variations.includes(first3Words)) {
        variations.push(first3Words);
      }
    }

    // Try first 2 words
    const first2Words = words.slice(0, 2).join(" ");
    if (!variations.includes(first2Words)) {
      variations.push(first2Words);
    }

    // Try just the first word if it's long enough (for cases like "Kakuriyo")
    const firstWord = words[0];
    if (firstWord && firstWord.length >= 4 && !variations.includes(firstWord)) {
      variations.push(firstWord);
    }
  }

  // Remove duplicates, empty strings, and variations considered too generic (single short/common word).
  // Le titre original échappe au garde anti-générique : sinon les titres courts d'un seul mot
  // ("Baki", "Gantz"…) produisent 0 variation et aucune recherche anime n'est lancée.
  return variations.filter(
    (term, index, arr) =>
      term &&
      term.trim() &&
      arr.indexOf(term) === index &&
      (term === originalTerm || isAcceptableVariation(term)),
  );
}

const ANIME_MODE_HIDDEN_IDS = new Set([
  "132123",
  "94954",
  "114478",
  "456",
  "2190",
  "45950",
  "45854",
  "79141",
  "2085",
  "78173",
  "110316",
]);

const ANIME_MODE_DEFAULT_OFF_IDS = new Set([
  "94605",
  "92885",
  "291904",
  "271607",
  "132005",
]);

export function shouldHideAnimeModeForId(id: string | number): boolean {
  return ANIME_MODE_HIDDEN_IDS.has(String(id));
}

export function shouldDefaultAnimeModeToOff(id: string | number): boolean {
  return ANIME_MODE_DEFAULT_OFF_IDS.has(String(id));
}

/**
 * Gets the appropriate search name for special cases based on content ID
 *
 * @param id The content ID (string or number)
 * @param defaultName The default name to use if no special case applies
 * @returns The search name to use for this content
 */
export function getSearchNameForId(
  id: string | number,
  defaultName: string,
): string {
  const idStr = String(id);

  // Special cases for specific content IDs
  switch (idStr) {
    case "291904":
      return "Le Monde merveilleusement bizarre de Gumball";
    case "62745":
      return "DanMachi";
    case "60863":
      return "Haikyuu"; // Sans les points d'exclamation pour la recherche
    case "62273":
      return "Food Wars";
    case "259140":
      return "Ranma 1/2"; // Cas spécial pour Ranma 1/2
    case "63926":
      return "One Punch Man"; // Cas spécial pour One-Punch Man (sans tiret)
    case "278635":
      return "My Gift Lvl 9999 Unlimited Gacha";
    case "30983":
      return "DETECTIVE CONAN"; // Cas spécial pour Detective Conan
    case "285070":
      return "Ninja To Gokudou"; // Cas spécial pour l'anime avec ID 285070
    case "65844":
      return "Konosuba"; // Cas spécial pour Konosuba : Sois béni monde merveilleux !
    case "309933":
      return "Death Note"; // Cas spécial pour Death Note (anime)
    case "250598":
      return "The Ossan Newbie Adventurer"; // Cas spécial pour Shinmai Ossan Bokensha
    case "70881":
      return "Boruto"; // Cas spÃ©cial pour Boruto: Naruto Next Generations
    default:
      return defaultName;
  }
}

/**
 * Builds a normalized list of terms to compare against anime names and alternative names.
 *
 * @param terms Preferred terms to use for matching
 * @returns Unique lowercase terms and fallback variations
 */
export function getAnimeMatchTerms(
  ...terms: Array<string | null | undefined>
): string[] {
  const normalizedTerms: string[] = [];

  for (const term of terms) {
    if (!term || !term.trim()) {
      continue;
    }

    const variations = generateSearchVariations(term);
    for (const variation of variations) {
      const normalizedVariation = variation.trim().toLowerCase();
      if (
        normalizedVariation &&
        !normalizedTerms.includes(normalizedVariation)
      ) {
        normalizedTerms.push(normalizedVariation);
      }
    }
  }

  return normalizedTerms;
}

/**
 * Performs a search with automatic fallback using multiple search term variations
 *
 * @param searchFunction Function that performs the actual search
 * @param originalTerm The original search term
 * @param logPrefix Prefix for console logs
 * @returns Search results from the first successful variation
 */
export async function searchWithFallback<T>(
  searchFunction: (term: string) => Promise<T[]>,
  originalTerm: string,
  logPrefix: string = "Search",
): Promise<T[]> {
  const variations = generateSearchVariations(originalTerm);

  console.log(
    `${logPrefix}: Generated ${variations.length} search variations for "${originalTerm}":`,
    variations,
  );

  for (let i = 0; i < variations.length; i++) {
    const variation = variations[i];
    console.log(
      `${logPrefix}: Attempting search ${i + 1}/${variations.length} with: "${variation}"`,
    );

    try {
      const results = await searchFunction(variation);
      if (results && results.length > 0) {
        console.log(
          `${logPrefix}: Found ${results.length} results with variation: "${variation}"`,
        );
        return results;
      }
    } catch (error) {
      console.error(
        `${logPrefix}: Error with variation "${variation}":`,
        error,
      );
    }
  }

  console.log(
    `${logPrefix}: No results found with any variation for "${originalTerm}"`,
  );
  return [];
}

/**
 * Gets specialized anime matcher function for specific content IDs
 * Returns a predicate function that can be used to find the best match from search results
 *
 * @param id The content ID (string or number)
 * @returns A matcher function or null if no special case applies
 */
export function getAnimeMatcherForId(
  id: string | number,
): ((anime: { name: string; seasons?: any[] }) => boolean) | null {
  const idStr = String(id);

  switch (idStr) {
    case "62745": // DanMachi
      return (anime) => anime.seasons !== undefined && anime.seasons.length > 0;
    case "60863": // Haikyu!!
      return (anime) =>
        anime.name?.toLowerCase() === "haikyuu" &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "85937": // Demon Slayer
      return (anime) =>
        anime.name?.toLowerCase() === "demon slayer" &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "259140": // Ranma 1/2
      return (anime) =>
        (anime.name?.toLowerCase().includes("ranma") ||
          anime.name?.toLowerCase().includes("らんま")) &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "63926": // One-Punch Man
      return (anime) =>
        (anime.name?.toLowerCase().includes("one punch man") ||
          anime.name?.toLowerCase().includes("one-punch man")) &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "285070": // Ninja To Gokudou
      return (anime) =>
        anime.name?.toLowerCase().includes("ninja to gokudou") &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "65844": // Konosuba
      return (anime) =>
        anime.name?.toLowerCase().includes("konosuba") &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "250598": // Shinmai Ossan Bokensha
      return (anime) =>
        (anime.name?.toLowerCase().includes("ossan") ||
          anime.name?.toLowerCase().includes("shinmai")) &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    case "70881": // Boruto: Naruto Next Generations
      return (anime) =>
        anime.name?.toLowerCase() === "boruto" &&
        anime.seasons !== undefined &&
        anime.seasons.length > 0;
    default:
      return null;
  }
}
