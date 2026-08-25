const { KisskhError } = require('./errors');

const MAX_TITLE_CANDIDATES = 12;
const MAX_QUERIES = 12;
const MATCH_THRESHOLD = 85;
const AMBIGUITY_MARGIN = 4;

const SOURCE_SCORES = Object.freeze({
  localized: 100,
  original: 95,
  alternative: 90,
});

const COUNTRY_ALIASES = new Map([
  ['kr', 'kr'],
  ['korea', 'kr'],
  ['south korea', 'kr'],
  ['republic of korea', 'kr'],
  ['kor', 'kr'],
  ['jp', 'jp'],
  ['japan', 'jp'],
  ['cn', 'cn'],
  ['china', 'cn'],
  ['tw', 'tw'],
  ['taiwan', 'tw'],
  ['th', 'th'],
  ['thailand', 'th'],
]);

function normalizeTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutLeadingEnglishArticle(value) {
  return value.replace(/^(?:a|an|the)\s+/u, '');
}

function firstTitle(value, fields) {
  if (!value || typeof value !== 'object') return '';
  for (const field of fields) {
    if (typeof value[field] === 'string' && value[field].trim()) return value[field].trim();
  }
  return '';
}

function buildTmdbTitleCandidates({ localized, original, alternatives } = {}) {
  const inputs = [
    { value: firstTitle(localized, ['name', 'title']), source: 'localized' },
    { value: firstTitle(original, ['original_name', 'original_title', 'name', 'title']), source: 'original' },
    ...(Array.isArray(alternatives?.results) ? alternatives.results : [])
      .map((entry) => ({ value: firstTitle(entry, ['title', 'name']), source: 'alternative' })),
  ];
  const seen = new Set();
  const titles = [];
  for (const input of inputs) {
    const normalized = normalizeTitle(input.value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    titles.push(Object.freeze({ value: input.value, normalized, source: input.source }));
    if (titles.length === MAX_TITLE_CANDIDATES) break;
  }
  return titles;
}

function assertSeasonNumber(seasonNumber) {
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) {
    throw new TypeError('seasonNumber invalide');
  }
}

function normalizedTitleEntries(titles) {
  if (!Array.isArray(titles)) return [];
  return titles.map((entry, index) => {
    const value = typeof entry === 'string' ? entry : entry?.value;
    const normalized = normalizeTitle(value);
    const source = typeof entry === 'object' && SOURCE_SCORES[entry?.source]
      ? entry.source
      : index === 0 ? 'localized' : 'alternative';
    return { value: typeof value === 'string' ? value.trim() : '', normalized, source };
  }).filter((entry) => entry.value && entry.normalized);
}

function buildSeasonAwareQueries(titles, seasonNumber) {
  assertSeasonNumber(seasonNumber);
  const entries = normalizedTitleEntries(titles);
  const selected = seasonNumber === 0
    ? entries.filter((entry) => entry.source === 'localized' || entry.source === 'original')
    : entries;
  const queries = [];
  const seen = new Set();
  const add = (query) => {
    const normalized = normalizeTitle(query);
    if (!normalized || seen.has(normalized) || queries.length >= MAX_QUERIES) return;
    seen.add(normalized);
    queries.push(query);
  };
  if (seasonNumber > 1) {
    for (const entry of entries) {
      if (entry.source === 'localized' || entry.source === 'original') add(entry.value);
    }
  }
  for (const entry of selected) {
    if (seasonNumber === 0) {
      add(`${entry.value} Special`);
      add(`${entry.value} Specials`);
    } else {
      if (seasonNumber === 1) add(entry.value);
      add(`${entry.value} Season ${seasonNumber}`);
      add(`${entry.value} S${seasonNumber}`);
    }
  }
  return queries;
}

const ROMAN_DIGITS = Object.freeze({ i: 1, v: 5, x: 10, l: 50, c: 100 });

function parseSeasonMarker(value) {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (!/^[ivxlc]{1,5}$/.test(value)) return null;
  let total = 0;
  let previous = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const digit = ROMAN_DIGITS[value[index]];
    total += digit < previous ? -digit : digit;
    previous = Math.max(previous, digit);
  }
  return total > 0 && total <= 99 ? total : null;
}

function seasonAnalysis(base, markerValues) {
  const markers = markerValues.map(parseSeasonMarker);
  if (!base || markers.some((marker) => marker === null || marker > 99)
      || new Set(markers).size !== markers.length) return null;
  return { base, markers };
}

function analyzeSeasonTitle(value) {
  const normalized = normalizeTitle(value);
  const match = normalized.match(
    /(?:^| )(?:season|saison|s|part|pt) ?([0-9ivxlc]{1,5}(?: [0-9ivxlc]{1,5})*)$/u,
  );
  if (match) {
    return seasonAnalysis(
      normalized.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
      match[1].split(' '),
    ) || { base: normalized, markers: [] };
  }
  const ordinalMatch = normalized.match(/(?:^| )(\d{1,2})(?:st|nd|rd|th) season$/u);
  if (ordinalMatch) {
    return seasonAnalysis(
      normalized.replace(ordinalMatch[0], ' ').replace(/\s+/g, ' ').trim(),
      [ordinalMatch[1]],
    ) || { base: normalized, markers: [] };
  }
  const specialMatch = normalized.match(/(?:^| )(?:specials?|sp|ova)(?: |$)/u);
  if (specialMatch) {
    return {
      base: normalized.replace(specialMatch[0], ' ').replace(/\s+/g, ' ').trim(),
      markers: [0],
    };
  }
  const numericMatch = normalized.match(/(?:^| )(\d{1,2})$/u);
  if (numericMatch) {
    const base = normalized.replace(numericMatch[0], ' ').replace(/\s+/g, ' ').trim();
    if (base) return seasonAnalysis(base, [numericMatch[1]]) || { base: normalized, markers: [] };
  }
  return { base: normalized, markers: [] };
}

function regularEpisodeCount(episodes) {
  if (!Array.isArray(episodes)) return 0;
  return episodes.filter((episode) => Number.isSafeInteger(episode?.number) && episode.number > 0).length;
}

function hasSeasonMarker(analyzed, seasonNumber) {
  return analyzed.markers.includes(seasonNumber);
}

function segmentKey(analyzed) {
  return `${analyzed.base}\u0000${analyzed.markers.join(',')}`;
}

function parseYear(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function normalizeCountry(value) {
  const normalized = normalizeTitle(value);
  return COUNTRY_ALIASES.get(normalized) || normalized;
}

function candidateTitle(candidate) {
  return firstTitle(candidate, ['title', 'name', 'dramaName']);
}

function splitTrailingParenthesizedYear(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  const match = title.match(/\s*[\(\uFF08]\s*((?:18|19|20|21)\d{2})\s*[\)\uFF09]\s*$/u);
  if (!match) return { title, year: null };
  return {
    title: title.slice(0, match.index).trim(),
    year: Number(match[1]),
  };
}

function candidateTitleAnalyses(candidate) {
  const rawTitle = candidateTitle(candidate);
  const fullMetadata = splitTrailingParenthesizedYear(rawTitle);
  const variants = [
    fullMetadata.title,
    ...fullMetadata.title.split(/\s+[-\u2013\u2014]\s+/u),
  ];
  const seen = new Set();
  const analyses = [];
  for (const variant of variants) {
    const editorialBase = variant.replace(
      /\s*(?::|-)\s*(?:uncut(?:\s+ver(?:sion)?)?|director'?s\s+cut)\s*$/iu,
      '',
    ).trim();
    for (const value of [variant, editorialBase]) {
      const metadata = splitTrailingParenthesizedYear(value);
      const analyzed = analyzeSeasonTitle(metadata.title);
      const key = `${analyzed.base}\u0000${analyzed.markers.join(',')}`;
      if (!analyzed.base || seen.has(key)) continue;
      seen.add(key);
      analyses.push({ analyzed, year: metadata.year ?? fullMetadata.year });
    }
  }
  return analyses;
}

function rankKisskhCandidates(criteria = {}, candidates = []) {
  const titles = normalizedTitleEntries(criteria.titles);
  if (!titles.length || !Array.isArray(candidates)) return [];
  const requestedSeason = criteria.seasonNumber;
  if (requestedSeason !== undefined) assertSeasonNumber(requestedSeason);
  const hasMultipleTmdbSeasons = Number(criteria.seasonCount) > 1;
  const requiresExplicitMarker = hasMultipleTmdbSeasons
    && Number.isSafeInteger(requestedSeason)
    && requestedSeason > 1;
  const expectedCountries = new Set((Array.isArray(criteria.countries) ? criteria.countries : [])
    .map(normalizeCountry).filter(Boolean));
  const expectedYear = parseYear(criteria.year);
  const ranked = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate !== 'object') continue;
    let best = null;
    for (const analysis of candidateTitleAnalyses(candidate)) {
      const { analyzed } = analysis;
      if (Number.isSafeInteger(requestedSeason)) {
        if (requestedSeason === 0 && !hasSeasonMarker(analyzed, 0)) continue;
        if (hasMultipleTmdbSeasons && analyzed.markers.length > 0
            && !hasSeasonMarker(analyzed, requestedSeason)) continue;
        if (requiresExplicitMarker && analyzed.markers.length === 0) continue;
      }
      let title = titles.find((entry) => entry.normalized === analyzed.base);
      let articlePenalty = 0;
      if (!title) {
        const candidateWithoutArticle = withoutLeadingEnglishArticle(analyzed.base);
        title = titles.find((entry) => withoutLeadingEnglishArticle(entry.normalized) === candidateWithoutArticle);
        if (title) articlePenalty = 5;
      }
      if (!title) continue;
      let score = (SOURCE_SCORES[title.source] || SOURCE_SCORES.alternative) - articlePenalty;
      if (hasSeasonMarker(analyzed, requestedSeason)) score += 20;
      const candidateYear = parseYear(candidate.releaseDate ?? candidate.release_date ?? candidate.year)
        ?? analysis.year;
      const candidateEpisodeCount = regularEpisodeCount(candidate.episodes);
      if (requestedSeason === 1 && analyzed.markers.length === 0
          && expectedYear !== null && candidateYear !== null
          && Math.abs(expectedYear - candidateYear) > 1
          && Number.isSafeInteger(criteria.expectedEpisodeCount)
          && criteria.expectedEpisodeCount > 1
          && candidateEpisodeCount === 1) continue;
      if (expectedYear !== null && candidateYear !== null && Math.abs(expectedYear - candidateYear) <= 1) {
        score += candidateYear === expectedYear ? 6 : 4;
      }
      const country = normalizeCountry(candidate.country ?? candidate.countryCode ?? candidate.country_code);
      if (country && expectedCountries.has(country)) score += 4;
      if (Number.isSafeInteger(criteria.expectedEpisodeCount) && criteria.expectedEpisodeCount > 0
          && candidateEpisodeCount === criteria.expectedEpisodeCount) score += 6;
      if (!best || score > best.score) best = {
        candidate,
        score,
        titleSource: title.source,
        index,
        base: analyzed.base,
        segment: segmentKey(analyzed),
      };
    }
    if (best && best.score >= MATCH_THRESHOLD) ranked.push(best);
  }

  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  if (!criteria.retainAmbiguous
      && ranked.length > 1 && ranked[0].score - ranked[1].score <= AMBIGUITY_MARGIN) {
    const closeMatches = ranked.filter((entry) => ranked[0].score - entry.score <= AMBIGUITY_MARGIN);
    const bases = new Set(closeMatches.map((entry) => entry.base));
    const segments = new Set(closeMatches.map((entry) => entry.segment));
    if (bases.size !== 1 || segments.size !== closeMatches.length) return [];
  }
  return ranked.map(({ index: _index, base: _base, segment: _segment, ...entry }) => entry);
}

function episodeCountForCandidate(candidate) {
  const count = candidate?.episodesCount ?? candidate?.episodes_count;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function tmdbEpisodeCount(tmdbSeasons, seasonNumber) {
  const season = tmdbSeasons.find((entry) => entry?.season_number === seasonNumber
    || entry?.seasonNumber === seasonNumber);
  const count = season?.episode_count ?? season?.episodeCount;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function selectEpisodeSegment(ranked, criteria = {}) {
  const { seasonNumber, episodeNumber } = criteria;
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0
    || !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0
    || !Array.isArray(ranked)) return null;

  const entries = ranked.map((entry, index) => {
    const candidate = entry?.candidate || entry;
    const title = splitTrailingParenthesizedYear(candidateTitle(candidate)).title;
    return { ranked: entry, candidate, analyzed: analyzeSeasonTitle(title), index };
  }).filter((entry) => entry.candidate && entry.analyzed.base);
  const segments = new Set();
  for (const entry of entries) {
    const key = segmentKey(entry.analyzed);
    if (segments.has(key)) return null;
    segments.add(key);
  }

  if (Number(criteria.seasonCount) <= 1) {
    const ordered = entries.sort((left, right) => {
      const leftOrder = left.analyzed.markers[0] ?? -1;
      const rightOrder = right.analyzed.markers[0] ?? -1;
      return leftOrder - rightOrder || left.index - right.index;
    });
    let precedingEpisodes = 0;
    for (const entry of ordered) {
      const count = episodeCountForCandidate(entry.candidate);
      if (count === null) return null;
      if (episodeNumber <= precedingEpisodes + count) {
        return { ranked: entry.ranked, localEpisodeNumber: episodeNumber - precedingEpisodes };
      }
      precedingEpisodes += count;
    }
    return null;
  }

  const matching = entries.filter((entry) => hasSeasonMarker(entry.analyzed, seasonNumber));
  if (matching.length !== 1) return null;
  const selected = matching[0];
  let localEpisodeNumber = episodeNumber;
  for (const marker of selected.analyzed.markers) {
    if (marker === seasonNumber) break;
    const count = tmdbEpisodeCount(Array.isArray(criteria.tmdbSeasons) ? criteria.tmdbSeasons : [], marker);
    if (count === null) return null;
    localEpisodeNumber += count;
  }
  return { ranked: selected.ranked, localEpisodeNumber };
}

function episodeNumberFromTmdb(entry) {
  return entry?.episodeNumber ?? entry?.episode_number ?? entry?.number;
}

function selectConfirmedDrama(entries, seasonNumber, episodeNumber) {
  assertSeasonNumber(seasonNumber);
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
    throw new TypeError('episodeNumber invalide');
  }
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new KisskhError('not_found', 'Correspondance KissKH introuvable');
  }
  const ranked = entries[0];
  const drama = ranked?.candidate || ranked;
  if (!drama || typeof drama !== 'object') {
    throw new KisskhError('not_found', 'Correspondance KissKH introuvable');
  }
  const analyzed = analyzeSeasonTitle(candidateTitle(drama));
  if (analyzed.markers.length > 0 && !hasSeasonMarker(analyzed, seasonNumber)) {
    throw new KisskhError('not_found', 'Correspondance KissKH introuvable');
  }
  if (analyzed.markers.length === 0 && Array.isArray(drama.tmdbSeasons)) {
    const possibleSeasons = drama.tmdbSeasons.filter((season) => Array.isArray(season?.episodes)
      && season.episodes.some((episode) => episodeNumberFromTmdb(episode) === episodeNumber));
    if (possibleSeasons.length > 1) {
      throw new KisskhError('not_found', 'Correspondance KissKH introuvable');
    }
  }
  const episode = Array.isArray(drama.episodes)
    ? drama.episodes.find((entry) => entry?.number === episodeNumber)
    : null;
  if (!episode) throw new KisskhError('episode_missing', 'Episode KissKH introuvable');
  return Object.freeze({ drama, episode });
}

module.exports = {
  AMBIGUITY_MARGIN,
  MATCH_THRESHOLD,
  MAX_QUERIES,
  MAX_TITLE_CANDIDATES,
  buildSeasonAwareQueries,
  buildTmdbTitleCandidates,
  analyzeSeasonTitle,
  normalizeTitle,
  regularEpisodeCount,
  rankKisskhCandidates,
  selectEpisodeSegment,
  selectConfirmedDrama,
};
