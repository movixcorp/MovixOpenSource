/**
 * AnimeSama route module.
 * Extracted from server.js -- handles anime search, season/episode scraping, and caching.
 *
 * Mounted as: app.use('/anime', require('./routes/animeSama'));
 * Route paths are relative to the mount point.
 */

const express = require('express');
const router = express.Router();
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const writeFileAtomic = require('write-file-atomic');

const { ANIME_SAMA_CACHE_DIR, generateCacheKey } = require('../utils/cacheManager');
const { memoryCache } = require('../config/redis');
const { buildM3u8Map } = require('../utils/embedExtraction');

// Anime-Sama est le seul catalogue dont les lecteurs sont des chaînes brutes
// (`players: ["https://…"]`) et non des objets : impossible d'y greffer un
// champ `m3u8Url` sans casser la forme de la réponse. On joint donc à l'épisode
// une table `m3u8ByPlayer` en parallèle, que le client consulte par lien.
//
// La résolution ne porte que sur l'épisode désigné par `?season=&episode=` :
// le client n'envoie que des identifiants, jamais d'URL, et le catalogue
// entier n'est jamais extrait.
async function respondWithAnimeSources(req, res, animes) {
  if (String(req.query.resolve || '') !== '1') return res.json(animes);

  const seasonNum = Number.parseInt(req.query.season, 10);
  const episodeNum = Number.parseInt(req.query.episode, 10);
  if (!Number.isInteger(seasonNum) || !Number.isInteger(episodeNum)) return res.json(animes);

  const accessKey = req.headers['x-access-key'] || null;

  try {
    const { verifyAccessKey } = require('../checkVip');
    const vipStatus = await verifyAccessKey(accessKey);
    if (!vipStatus?.vip) return res.json(animes);

    // `season`/`episode` sont des rangs 1-based côté client.
    const episode = animes?.[0]?.seasons?.[seasonNum - 1]?.episodes?.[episodeNum - 1];
    if (!episode || !Array.isArray(episode.streaming_links)) return res.json(animes);

    const urls = episode.streaming_links.flatMap((link) =>
      Array.isArray(link.players) ? link.players : []
    );

    episode.m3u8ByPlayer = await buildM3u8Map(urls, { accessKey });
    return res.json(animes);
  } catch (error) {
    // L'extraction est un bonus : le catalogue reste servi si elle échoue.
    console.error(`[ANIME-SAMA] Extraction S${seasonNum}E${episodeNum} échouée: ${error.message}`);
    return res.json(animes);
  }
}

// ---- Lazy-bound dependencies injected via configure() ----
let deps = {
  ANIME_SAMA_URL: '',
  axiosAnimeSama: null,
  axiosAnimeSamaRequest: async () => { throw new Error('animeSama not configured'); },
  getFromCacheNoExpiration: async () => null,
  saveToCache: async () => false,
  normalizeAnimeSamaUrls: (data) => data,
  mergeStreamingLinks: () => [],
  cleanupOldCacheFiles: async () => {},
  migrateOldCacheFiles: async () => {},
  limitConcurrency10: async (fn) => fn()
};

function configure(injected) {
  Object.assign(deps, injected);
  // Re-bind normalizeAnimeSamaUrls with the current ANIME_SAMA_URL
  deps.normalizeAnimeSamaUrls = normalizeAnimeSamaUrls;
}

// ---- normalizeAnimeSamaUrls (was inline in server.js) ----
const normalizeAnimeSamaUrls = (data) => {
  if (!data) return data;
  const currentDomain = (deps.ANIME_SAMA_URL || '').replace(/\/$/, '');

  const isValidPlayerUrl = (url) => {
    if (typeof url !== 'string' || url.length === 0) return false;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    if (!url.includes('.')) return false;
    const invalidPatterns = ['_self', 'containerSamedi', '\u00e9lite', 'Sectes', 'prouesses', 'discord.gg'];
    if (invalidPatterns.some(pattern => url.includes(pattern))) return false;
    return true;
  };

    const replaceUrls = (obj, key = null) => {
    if (typeof obj === 'string') {
      let cleanedUrl = obj.replace(/https:\/\/proxy\.movix\.(blog|club|site)\/proxy\//gi, '');
      return cleanedUrl.replace(/https?:\/\/anime-sama\.[a-z]+/gi, currentDomain);
    }
    if (Array.isArray(obj)) {
      if (key === 'players') {
        return obj.map(item => replaceUrls(item)).filter(item => {
          if (item && typeof item === 'object' && item.link) return true;
          return isValidPlayerUrl(item);
        });
      }
      if (key === 'streaming_links') {
        return obj.map(item => replaceUrls(item)).filter(item => item && item.players && item.players.length > 0);
      }
      return obj.map(item => replaceUrls(item));
    }
    if (obj && typeof obj === 'object') {
      const newObj = {};
      for (const [k, value] of Object.entries(obj)) {
        newObj[k] = replaceUrls(value, k);
      }
      return newObj;
    }
    return obj;
  };

  return replaceUrls(data);
};

// ---- Utility functions ----

const zipVarlen = (...arrays) => {
  const maxLength = Math.max(...arrays.map(arr => arr.length));
  const result = [];

  for (let i = 0; i < maxLength; i++) {
    result.push(arrays.map(arr => i < arr.length ? arr[i] : []));
  }

  return result;
};

const splitAndStrip = (str, delimiter) => {
  return str.split(delimiter).map(item => item.trim()).filter(item => item);
};

const removeQuotes = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/^["'](.*)["']$/, '$1');
};

const safeFilename = (str) => {
  return str.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
};

// Language constants
const LANG = {
  VOSTFR: 'VOSTFR',
  VF: 'VF',
  VOST_ENG: 'VOSTEng',
  VOST_SPA: 'VOSTSpa',
  VJ: 'VJ'
};

const LANG_ID = {
  VOSTFR: 'vostfr',
  VF: 'vf',
  VOST_ENG: 'vosteng',
  VOST_SPA: 'vostspa',
  VJ: 'vj'
};

const flags = {
  'VOSTFR': '\ud83c\uddef\ud83c\uddf5',
  'VF': '\ud83c\uddeb\ud83c\uddf7',
  'VOSTEng': '\ud83c\uddec\ud83c\udde7',
  'VOSTSpa': '\ud83c\uddea\ud83c\uddf8',
  'VJ': '\ud83c\uddef\ud83c\uddf5'
};

const id2lang = {
  'vostfr': LANG.VOSTFR,
  'vf': LANG.VF,
  'vosteng': LANG.VOST_ENG,
  'vostspa': LANG.VOST_SPA,
  'vj': LANG.VJ
};

const lang2ids = {
  [LANG.VOSTFR]: [LANG_ID.VOSTFR],
  [LANG.VF]: [LANG_ID.VF],
  [LANG.VOST_ENG]: [LANG_ID.VOST_ENG],
  [LANG.VOST_SPA]: [LANG_ID.VOST_SPA],
  [LANG.VJ]: [LANG_ID.VJ]
};

const langIds = ['vostfr', 'vf', 'vosteng', 'vostspa', 'vj', 'va', 'vf1', 'vf2', 'vkr'];

// Helper function to validate player URLs
const isValidPlayerUrl = (url) => {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  if (!url.includes('.')) return false;
  const invalidPatterns = ['_self', 'containerSamedi', '\u00e9lite', 'Sectes', 'prouesses', 'discord.gg'];
  if (invalidPatterns.some(pattern => url.includes(pattern))) return false;
  return true;
};

// Gabarits d'embed sans identifiant : anime-sama les emet quand un lecteur est
// annonce mais vide. Le test porte sur un motif et non sur une URL exacte, car
// ces hebergeurs font tourner leurs TLD — une liste en dur laissait passer le
// meme gabarit sur un nouveau domaine (vidmoly.org apres vidmoly.to).
const EMPTY_PLAYER_PATTERNS = [
  /sibnet\.[a-z0-9-]+\/shell\.php\?videoid=$/i,
  /vidmoly\.[a-z0-9-]+\/embed-\.html$/i,
  /sendvid\.[a-z0-9-]+\/embed\/$/i,
  /vk\.[a-z0-9-]+\/video_ext\.php\?oid=&hd=3$/i,
];

const isEmptyPlayerUrl = (url) =>
  typeof url === 'string' && EMPTY_PLAYER_PATTERNS.some((re) => re.test(url));

// ---- Classes ----

class Players {
  constructor(availables = []) {
    this.availables = availables;
    this._best = null;
    this.index = 1;
  }

  get best() {
    if (!this._best) {
      this.setBest();
    }
    return this._best;
  }

  setBest(prefers = [], bans = []) {
    if (!this.availables.length) {
      return;
    }

    for (const prefer of prefers) {
      for (const player of this.availables) {
        if (player.includes(prefer)) {
          this._best = player;
          return;
        }
      }
    }

    for (let i = this.index; i < this.availables.length + this.index; i++) {
      const candidate = this.availables[i % this.availables.length];
      if (bans.every(ban => !candidate.includes(ban))) {
        this._best = candidate;
        return;
      }
    }

    if (!this._best) {
      console.warn(`WARNING: No suitable player found. Defaulting to ${this.availables[0]}`);
      this._best = this.availables[0];
    }
  }
}

class Languages {
  constructor(players, preferLanguages = []) {
    this.players = players;
    this.preferLanguages = preferLanguages;

    Object.keys(this.players).forEach(langId => {
      if (!this.players[langId].availables.length) {
        delete this.players[langId];
      }
    });

    if (Object.keys(this.players).length === 0) {
      console.warn('WARNING: No player available');
    }

    this.availables = {};
    for (const langId in this.players) {
      const lang = id2lang[langId];
      if (!this.availables[lang]) {
        this.availables[lang] = [];
      }
      this.availables[lang].push(this.players[langId]);
    }
  }

  get best() {
    for (const preferLanguage of this.preferLanguages) {
      if (this.availables[preferLanguage]) {
        for (const player of this.availables[preferLanguage]) {
          if (player.availables.length) {
            return player.best;
          }
        }
      }
    }

    for (const language in this.availables) {
      for (const player of this.availables[language]) {
        if (player.availables.length) {
          console.warn(`WARNING: Language preference not respected. Defaulting to ${language}`);
          return player.best;
        }
      }
    }

    return null;
  }

  setBest(...args) {
    for (const langId in this.players) {
      this.players[langId].setBest(...args);
    }
  }
}

class Episode {
  constructor(languages, serieName = "", seasonName = "", episodeName = "", index = 1) {
    this.languages = languages;
    this.serieName = serieName;
    this.seasonName = seasonName;
    this.episodeName = episodeName;
    this._index = index;

    this.name = this.episodeName;
    this.fancyName = this.name;

    for (const lang in this.languages.availables) {
      this.fancyName += ` ${flags[lang]}`;
    }

    this.index = this._index;

    const seasonNumberMatch = seasonName.match(/\d+/);
    this.seasonNumber = seasonNumberMatch ? parseInt(seasonNumberMatch[0]) : 0;

    this.longName = `${this.seasonName} - ${this.episodeName}`;
    this.shortName = `${this.serieName} S${this.seasonNumber.toString().padStart(2, '0')}E${this.index.toString().padStart(2, '0')}`;
  }

  get index() {
    return this._index;
  }

  set index(value) {
    this._index = value;
    for (const langId in this.languages.players) {
      this.languages.players[langId].index = this._index;
    }
  }

  toString() {
    return this.fancyName;
  }
}

class Season {
  constructor(url, name = "", serieName = "", client = null) {
    const normalizedUrl = url.endsWith('/') ? url : url + '/';
    this.pages = langIds.map(lang => normalizedUrl + lang + "/");
    this.siteUrl = url.split('/').slice(0, 3).join('/') + '/';

    this.name = name || url.split('/').slice(-2)[0];
    this.serieName = serieName || url.split('/').slice(-3)[0];

    this.client = client || deps.axiosAnimeSama;
  }

  async _getPlayersLinksFrom(page) {
    try {
      const episodesUrl = page + 'episodes.js';
      const episodesJsResponse = await deps.axiosAnimeSamaRequest({
        method: 'get',
        url: episodesUrl,
        timeout: 10000
      });

      if (episodesJsResponse.status !== 200) {
        return [];
      }

      const episodesJs = episodesJsResponse.data;

      if (typeof episodesJs === 'string' && (
        episodesJs.includes('<!doctype html>') ||
        episodesJs.includes('<!DOCTYPE html>') ||
        episodesJs.includes('<html') ||
        episodesJs.includes('Page introuvable') ||
        episodesJs.includes('Acces Introuvable')
      )) {
        return [];
      }

      if (typeof episodesJs !== 'string' || !episodesJs.includes('[')) {
        return [];
      }

      const playersList = episodesJs.split('[').slice(1);
      const playersListLinks = playersList.map(player => {
        const matches = player.match(/'(.+?)'/g);
        if (!matches) return [];

        const allLinks = matches.map(link => {
          let cleanLink = link.replace(/'/g, '');
          const proxyPrefix = 'https://proxy.liyao.space/------';
          if (cleanLink.startsWith(proxyPrefix)) {
            cleanLink = cleanLink.substring(proxyPrefix.length);
          }
          return cleanLink;
        });

        const validLinks = allLinks.filter(isValidPlayerUrl);
        return validLinks;
      });

      const result = zipVarlen(...playersListLinks);
      return result;
    } catch (error) {
      if (!error.response || error.response.status !== 404) {
        // Non-404 error
      }
      return [];
    }
  }

  async episodes(existingEpisodes = null) {
    const episodesPagesPromises = this.pages.map(page => this._getPlayersLinksFrom(page));
    const episodesPages = await Promise.all(episodesPagesPromises);
    const episodesInSeason = Math.max(...episodesPages.map(ep => ep.length));

    const padding = episodesInSeason.toString().length;
    const episodeNames = Array.from({ length: episodesInSeason }, (_, i) =>
      `Episode ${(i + 1).toString().padStart(padding, '0')}`
    );

    const episodeObjs = episodeNames.map((name, index) => {
      const playersLinks = episodesPages.map(pages => pages[index] || []);

      const languages = new Languages(
        Object.fromEntries(
          langIds.map((langId, i) => [langId, new Players(playersLinks[i])])
        )
      );
      return new Episode(languages, this.serieName, this.name, name, index + 1);
    });

    if (!existingEpisodes) {
      return episodeObjs.map(ep => ({
        name: ep.name,
        serie_name: ep.serieName,
        season_name: ep.seasonName,
        index: ep.index,
        streaming_links: Object.entries(ep.languages.players).map(([langId, players]) => ({
          language: langId,
          players: (Array.isArray(players.availables) ? players.availables : []).filter(isValidPlayerUrl)
        })).filter(link => link.players.length > 0)
      }));
    }

    return episodeObjs.map((ep, idx) => {
      const oldEp = existingEpisodes[idx];
      if (!oldEp) {
        return {
          name: ep.name,
          serie_name: ep.serieName,
          season_name: ep.seasonName,
          index: ep.index,
          streaming_links: Object.entries(ep.languages.players).map(([langId, players]) => ({
            language: langId,
            players: (Array.isArray(players.availables) ? players.availables : []).filter(isValidPlayerUrl)
          })).filter(link => link.players.length > 0)
        };
      }
      const oldLinks = oldEp.streaming_links || [];
      const newLinks = Object.entries(ep.languages.players).map(([langId, players]) => ({
        language: langId,
        players: (Array.isArray(players.availables) ? players.availables : []).filter(isValidPlayerUrl)
      }));
      const mergedLinks = deps.mergeStreamingLinks(oldLinks, newLinks);
      return {
        name: ep.name,
        serie_name: ep.serieName,
        season_name: ep.seasonName,
        index: ep.index,
        streaming_links: mergedLinks.filter(link => link.players && link.players.length > 0)
      };
    });
  }
}

class Catalogue {
  constructor(url, name = "", client = null, additionalData = null) {
    if (url.startsWith('/')) {
      this.url = deps.ANIME_SAMA_URL + url.substring(1);
    } else if (url.startsWith('http')) {
      try {
        const urlObj = new URL(url);
        let urlPath = urlObj.pathname;
        if (urlPath.startsWith('/')) urlPath = urlPath.substring(1);
        this.url = deps.ANIME_SAMA_URL + urlPath + urlObj.search;
      } catch (e) {
        console.error("Error parsing URL in Catalogue constructor:", url);
        this.url = url;
      }
    } else {
      this.url = url.endsWith('/') ? url : url + '/';
    }
    this.name = name || url.split('/').slice(-2)[0];
    this.siteUrl = url.split('/').slice(0, 3).join('/') + '/';
    this.client = client || deps.axiosAnimeSama;

    if (additionalData) {
      this.image = additionalData.image || '';
      this.alternative_names = additionalData.alternative_names || [];
      this.alternative_names_string = additionalData.alternative_names_string || '';
    } else {
      this.image = '';
      this.alternative_names = [];
      this.alternative_names_string = '';
    }
  }

  async seasons() {
    try {
      const response = await deps.axiosAnimeSamaRequest({
        method: 'get',
        url: this.url
      });
      const responseData = response.data;

      const seasonsMatches = responseData.match(/panneauAnime\("(.+?)", *"(.+?)(?:vostfr|vf)"\);/g) || [];

      const seasons = [];
      for (const match of seasonsMatches) {
        const [_, name, link] = match.match(/panneauAnime\("(.+?)", *"(.+?)(?:vostfr|vf)"\);/) || [];

        if (name && link) {
          const urlParts = this.url.split('/');
          const animeNameFromUrl = urlParts[urlParts.length - 2] || urlParts[urlParts.length - 1];

          let normalizedLink = link;
          if (animeNameFromUrl && normalizedLink.startsWith(animeNameFromUrl)) {
            normalizedLink = normalizedLink.substring(animeNameFromUrl.length);
          }

          if (!normalizedLink.startsWith('/')) {
            normalizedLink = '/' + normalizedLink;
          }

          const baseUrl = this.url.endsWith('/') ? this.url.slice(0, -1) : this.url;
          const seasonUrl = baseUrl + normalizedLink;

          seasons.push(
            new Season(
              seasonUrl,
              name,
              this.name,
              this.client
            )
          );
        }
      }

      return seasons;
    } catch (error) {
      console.error(`Error getting seasons for ${this.name}:`, error.message);
      return [];
    }
  }
}

class AnimeSama {
  constructor(siteUrl) {
    this.siteUrl = siteUrl;
    this.client = deps.axiosAnimeSama;
  }

  async search(query, forceNoCache = false) {
    try {
      const cacheKey = generateCacheKey(query);
      if (!forceNoCache) {
        const cachedResults = await deps.getFromCacheNoExpiration(ANIME_SAMA_CACHE_DIR, cacheKey);
        if (cachedResults) {
          return cachedResults.map(result =>
            new Catalogue(result.url, result.name, this.client, result)
          );
        }
      }

      const requestUrl = `${this.siteUrl}template-php/defaut/fetch.php`;
      const requestData = `query=${encodeURIComponent(query)}`;
      console.log(`\n[AnimeSama Search] DEBUG INFO:`);
      console.log(`[AnimeSama Search] Query: ${query}`);
      console.log(`[AnimeSama Search] URL: ${requestUrl}`);
      console.log(`[AnimeSama Search] Payload: ${requestData}`);

      const response = await deps.axiosAnimeSamaRequest({
        method: 'post',
        url: requestUrl,
        data: requestData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      console.log(`[AnimeSama Search] Response status: ${response.status}`);
      console.log(`[AnimeSama Search] Response content-type: ${response.headers?.['content-type'] || 'n/a'}`);

      if (response.status !== 200) {
        console.warn(`[AnimeSama Search] Non-200 status, abort. Body snippet:`, typeof response.data === 'string' ? response.data.slice(0, 500) : response.data);
        return [];
      }

      const responseData = response.data;
      const bodyLen = typeof responseData === 'string' ? responseData.length : -1;
      console.log(`[AnimeSama Search] Body length: ${bodyLen}`);
      if (typeof responseData === 'string') {
        console.log(`[AnimeSama Search] Body snippet (first 500):`, responseData.slice(0, 500));
        console.log(`[AnimeSama Search] Body snippet (last 500):`, responseData.slice(-500));
      }

      const results = this.parseSearchResults(responseData);
      console.log(`[AnimeSama Search] parseSearchResults -> ${results.length} results`);

      await deps.saveToCache(ANIME_SAMA_CACHE_DIR, cacheKey, results);

      return results.map(result =>
        new Catalogue(result.url, result.name, this.client, result)
      );
    } catch (error) {
      console.error(`\n[AnimeSama Search] ERROR FAIL:`);
      console.error(`[AnimeSama Search] Query: ${query}`);
      console.error(`[AnimeSama Search] Error Message: ${error.message}`);
      if (error.response) {
        console.error(`[AnimeSama Search] Status Code: ${error.response.status}`);
        console.error(`[AnimeSama Search] Response Data:`, JSON.stringify(error.response.data, null, 2));
      }
      if (error.config) {
        console.error(`[AnimeSama Search] Request Config URL:`, error.config.url);
      }
      return [];
    }
  }

  parseSearchResults(htmlData) {
    const results = [];

    try {
      if (typeof htmlData !== 'string') {
        console.warn('[AnimeSama Parse] htmlData is not a string, type:', typeof htmlData);
        return [];
      }

      // Diagnostic counters
      const allAnchors = (htmlData.match(/<a\b/gi) || []).length;
      const asnAnchors = (htmlData.match(/class="asn-search-result"/gi) || []).length;
      const catalogueHrefs = (htmlData.match(/href="[^"]*\/catalogue\/[^"]*"/gi) || []).length;
      console.log(`[AnimeSama Parse] anchors=${allAnchors} asn-class=${asnAnchors} catalogue-hrefs=${catalogueHrefs}`);

      const anchorRegex = /<a\b([^>]*\bclass="asn-search-result"[^>]*)>([\s\S]*?)<\/a>/gi;
      let match;
      let iterations = 0;

      while ((match = anchorRegex.exec(htmlData)) !== null) {
        iterations++;
        const attrs = match[1];
        const inner = match[2];

        const hrefMatch = attrs.match(/href="([^"]+)"/i);
        if (!hrefMatch) {
          console.log(`[AnimeSama Parse] block #${iterations}: no href in attrs:`, attrs.slice(0, 200));
          continue;
        }
        const href = hrefMatch[1];

        if (!href.includes('/catalogue/')) {
          console.log(`[AnimeSama Parse] block #${iterations}: skipped (not catalogue): ${href}`);
          continue;
        }
        if (!/\/catalogue\/[a-zA-Z0-9][a-zA-Z0-9\-_.]+/.test(href)) {
          console.log(`[AnimeSama Parse] block #${iterations}: skipped (bad slug): ${href}`);
          continue;
        }

        const imgMatch = inner.match(/<img\b[^>]*\bsrc="([^"]+)"/i);
        const imageUrl = imgMatch ? imgMatch[1] : '';

        const titleMatch = inner.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
        const mainTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        const subtitleMatch = inner.match(/<p\b[^>]*class="asn-search-result-subtitle"[^>]*>([\s\S]*?)<\/p>/i);
        const alternativeNames = subtitleMatch ? subtitleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        const altNamesArray = alternativeNames
          ? alternativeNames.split(',').map(name => name.trim()).filter(name => name.length > 0)
          : [];

        if (mainTitle) {
          results.push({
            url: href,
            name: mainTitle,
            image: imageUrl,
            alternative_names: altNamesArray,
            alternative_names_string: alternativeNames
          });
        } else {
          console.log(`[AnimeSama Parse] block #${iterations}: skipped (no title). inner snippet:`, inner.slice(0, 300));
        }
      }

      console.log(`[AnimeSama Parse] iterations=${iterations} kept=${results.length}`);
      return results;
    } catch (error) {
      console.error('[AnimeSama Parse] Error:', error.message);
      return [];
    }
  }
}

// Episode cache for Anime Sama
class EpisodeCache {
  constructor(cacheDir = ANIME_SAMA_CACHE_DIR, ttl = 3600) {
    this.cacheDir = cacheDir;
    this.ttl = ttl * 1000;
  }

  _getCachePath(serieName) {
    const safeSerie = safeFilename(serieName);
    return path.join(this.cacheDir, `${safeSerie}.json`);
  }

  async getAnimeData(serieName) {
    const cachePath = this._getCachePath(serieName);

    try {
      const fileContent = await fsp.readFile(cachePath, 'utf-8');
      const data = deps.normalizeAnimeSamaUrls(JSON.parse(fileContent));

      if (Date.now() - data.timestamp > this.ttl) {
        return null;
      }

      return data.seasons || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error reading cache:', error);
      }
      return null;
    }
  }

  async getEpisodes(serieName, seasonName) {
    const animeData = await this.getAnimeData(serieName);
    if (!animeData) return null;

    const seasonData = animeData[seasonName];
    return seasonData ? seasonData.episodes : null;
  }

  async saveAnimeData(serieName, seasonsData) {
    const cachePath = this._getCachePath(serieName);

    const data = {
      timestamp: Date.now(),
      seasons: seasonsData
    };

    try {
      await writeFileAtomic(cachePath, JSON.stringify(data), 'utf-8');
      await memoryCache.set(`anime:${serieName}`, data);
    } catch (error) {
      console.error('Error saving cache:', error);
    }
  }

  async saveEpisodes(serieName, seasonName, episodesData) {
    let animeData = await this.getAnimeData(serieName) || {};

    animeData[seasonName] = {
      timestamp: Date.now(),
      episodes: episodesData
    };

    await this.saveAnimeData(serieName, animeData);
  }
}

// ---- Routes ----

router.get('/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const cacheKey = generateCacheKey(query);
    const animeCacheDir = ANIME_SAMA_CACHE_DIR;
    let cachedResults = await deps.getFromCacheNoExpiration(animeCacheDir, cacheKey);
    let dataReturned = false;

    if (!cachedResults || !Array.isArray(cachedResults) || cachedResults.length === 0) {
      try {
        const client = new AnimeSama(deps.ANIME_SAMA_URL);
        const searchResults = await client.search(query, false);
        const serializedResults = searchResults.map(cat => ({
          url: cat.url,
          name: cat.name,
          image: cat.image,
          alternative_names: cat.alternative_names,
          alternative_names_string: cat.alternative_names_string
        }));
        await deps.saveToCache(animeCacheDir, cacheKey, serializedResults);
        cachedResults = serializedResults;
      } catch (err) {
        console.error('Erreur scraping Anime Sama:', err);
        return res.status(500).json({ error: 'Erreur lors de la recherche Anime Sama' });
      }
    }

    const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);

    const animesWithSeasons = await Promise.all(cachedResults.map(async (anime) => {
      const safeAnimeName = anime.name.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
      const animeFile = `${safeAnimeName}.json`;

      let saisons = [];

      if (allCacheFiles.includes(animeFile)) {
        try {
          const animeContent = await fsp.readFile(path.join(animeCacheDir, animeFile), 'utf-8');
          const animeCache = deps.normalizeAnimeSamaUrls(JSON.parse(animeContent));

          if (animeCache.seasons) {
            saisons = Object.entries(animeCache.seasons).map(([seasonName, seasonData]) => ({
              name: seasonName,
              episodes: seasonData.episodes || [],
              episodeCount: (seasonData.episodes || []).length,
              cacheFile: animeFile,
              timestamp: seasonData.timestamp || animeCache.timestamp || null
            }));
          }
        } catch (e) {
          console.error(`Error reading unified cache for ${anime.name}:`, e.message);
        }
      } else {
        const seasonFiles = allCacheFiles.filter(f => f.startsWith(safeAnimeName + '_') && f !== cacheKey + '.json');

        saisons = (await Promise.all(seasonFiles.map(async seasonFile => {
          try {
            const seasonContent = await fsp.readFile(path.join(animeCacheDir, seasonFile), 'utf-8');
            const seasonCache = deps.normalizeAnimeSamaUrls(JSON.parse(seasonContent));
            return {
              name: seasonFile.replace(safeAnimeName + '_', '').replace('.json', ''),
              episodes: seasonCache.episodes || [],
              episodeCount: (seasonCache.episodes || []).length,
              cacheFile: seasonFile,
              timestamp: seasonCache.timestamp || null
            };
          } catch (e) {
            return null;
          }
        }))).filter(Boolean);
      }

      const sortSeasons = (seasons) => {
        return seasons;
      };

      return {
        ...anime,
        seasons: sortSeasons(saisons)
      };
    }));

    // --- Filtering unwanted URLs before response ---
    animesWithSeasons.forEach(anime => {
      if (anime.seasons && Array.isArray(anime.seasons)) {
        anime.seasons.forEach(season => {
          if (season.episodes && Array.isArray(season.episodes)) {
            season.episodes.forEach(ep => {
              if (ep.streaming_links && Array.isArray(ep.streaming_links)) {
                ep.streaming_links.forEach(linkObj => {
                  if (linkObj.players && Array.isArray(linkObj.players)) {
                    linkObj.players = linkObj.players.filter(url => !isEmptyPlayerUrl(url));
                  }
                });
              }
            });
            season.episodes = season.episodes.filter(ep =>
              Array.isArray(ep.streaming_links) &&
              ep.streaming_links.some(linkObj => Array.isArray(linkObj.players) && linkObj.players.length > 0)
            );
            season.episodeCount = season.episodes.length;
          }
        });

        anime.seasons = anime.seasons.filter(season =>
          Array.isArray(season.episodes) && season.episodes.length > 0
        );
      }
    });

    await respondWithAnimeSources(req, res, animesWithSeasons);
    dataReturned = true;

    // --- Background update ---
    (async () => {
      const client = new AnimeSama(deps.ANIME_SAMA_URL);

      for (const anime of animesWithSeasons) {
        // Skip entries without valid catalogue URLs
        if (!anime.url || !anime.url.includes('/catalogue/') || !anime.name) {
          continue;
        }
        let catalogueObj = null;
        try {
          catalogueObj = new Catalogue(anime.url, anime.name, client.client, anime);
        } catch (e) {
          continue;
        }
        if (!catalogueObj) continue;

        let seasonsList = [];
        try {
          seasonsList = await catalogueObj.seasons();
        } catch (e) {
          continue;
        }

        const safeAnimeName = anime.name.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
        const animeCacheFile = `${safeAnimeName}.json`;
        const animeCachePath = path.join(animeCacheDir, animeCacheFile);

        let existingAnimeCache = {};
        try {
          const animeContent = await fsp.readFile(animeCachePath, 'utf-8');
          const animeData = JSON.parse(animeContent);
          existingAnimeCache = animeData.seasons || {};
        } catch (e) {
          // No existing cache
        }

        const RECENT_UPDATE_THRESHOLD = 1 * 60 * 60 * 1000;
        let shouldSkipAnime = false;
        try {
          const stats = await fsp.stat(animeCachePath);
          const timeSinceLastUpdate = Date.now() - stats.mtime.getTime();
          if (timeSinceLastUpdate < RECENT_UPDATE_THRESHOLD) {
            shouldSkipAnime = true;
          }
        } catch (e) {
          // File doesn't exist
        }

        if (shouldSkipAnime) continue;

        let animeDataUpdated = false;
        const updatedAnimeCache = { ...existingAnimeCache };

        for (const seasonObj of seasonsList) {
          const safeSeasonName = seasonObj.name.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
          let cachedEpisodes = null;
          let shouldUpdate = false;

          try {
            const seasonCache = existingAnimeCache[seasonObj.name];
            if (seasonCache && seasonCache.episodes) {
              cachedEpisodes = seasonCache.episodes;

              const scrapedEpisodes = await seasonObj.episodes(cachedEpisodes);

              const hasNewEpisodes = scrapedEpisodes.length > cachedEpisodes.length;
              const hasNewLang = scrapedEpisodes.some((ep, idx) => {
                const oldEp = cachedEpisodes[idx];
                if (!oldEp) return true;
                const oldLangs = (oldEp.streaming_links || []).map(l => l.language);
                const newLangs = (ep.streaming_links || []).map(l => l.language);
                return newLangs.some(l => !oldLangs.includes(l));
              });

              const hasNewPlayers = scrapedEpisodes.some((ep, idx) => {
                const oldEp = cachedEpisodes[idx];
                if (!oldEp) return false;

                return (ep.streaming_links || []).some(newLink => {
                  const oldLink = (oldEp.streaming_links || []).find(ol => ol.language === newLink.language);
                  if (!oldLink) return false;

                  const oldPlayers = Array.isArray(oldLink.players) ? oldLink.players : [];
                  const newPlayers = Array.isArray(newLink.players) ? newLink.players : [];
                  return newPlayers.length > oldPlayers.length ||
                    newPlayers.some(player => !oldPlayers.includes(player));
                });
              });

              if (hasNewEpisodes || hasNewLang || hasNewPlayers) {
                shouldUpdate = true;
                cachedEpisodes = scrapedEpisodes;
              }
            } else {
              shouldUpdate = true;
              cachedEpisodes = await seasonObj.episodes();
            }
          } catch (e) {
            shouldUpdate = true;
            cachedEpisodes = await seasonObj.episodes();
          }

          if (shouldUpdate) {
            try {
              const episodesData = cachedEpisodes.map(episode => ({
                name: episode.name,
                serie_name: episode.serie_name || episode.serieName,
                season_name: episode.season_name || episode.seasonName,
                index: episode.index,
                streaming_links: (episode.streaming_links || []).map(linkObj => ({
                  language: linkObj.language,
                  players: Array.isArray(linkObj.players)
                    ? linkObj.players.filter(url => !isEmptyPlayerUrl(url))
                    : linkObj.players
                }))
              }));

              updatedAnimeCache[seasonObj.name] = {
                timestamp: Date.now(),
                episodes: episodesData
              };
              animeDataUpdated = true;

            } catch (e) {
              console.error(`Erreur lors du scraping de la saison ${seasonObj.name} (${anime.name}):`, e.message);
            }
          }
        }

        if (animeDataUpdated) {
          try {
            const unifiedCacheData = {
              timestamp: Date.now(),
              seasons: updatedAnimeCache
            };
            await writeFileAtomic(animeCachePath, JSON.stringify(unifiedCacheData), 'utf-8');

            await deps.cleanupOldCacheFiles(safeAnimeName, animeCacheDir);
          } catch (e) {
            // ignore
          }
        } else if (Object.keys(existingAnimeCache).length === 0) {
          await deps.migrateOldCacheFiles(safeAnimeName, animeCacheDir);
        }
      }
    })();

  } catch (error) {
    console.error('Erreur /anime/search/:query:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete anime cache
router.delete('/search/:query/cache', async (req, res) => {
  try {
    const { query } = req.params;
    const cacheKey = generateCacheKey(query);
    const animeCacheDir = ANIME_SAMA_CACHE_DIR;

    let deletedFiles = [];
    let errors = [];

    // 1. Delete search cache file
    try {
      const searchCacheFile = path.join(animeCacheDir, `${cacheKey}.json`);
      await fsp.unlink(searchCacheFile);
      deletedFiles.push(`search cache: ${cacheKey}.json`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        errors.push(`Erreur suppression cache de recherche: ${err.message}`);
      }
    }

    // 2. Delete unified anime cache
    try {
      const decodedQuery = decodeURIComponent(query);
      const safeAnimeName = decodedQuery.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
      const animeFile = path.join(animeCacheDir, `${safeAnimeName}.json`);

      try {
        await fsp.unlink(animeFile);
        deletedFiles.push(`unified cache: ${safeAnimeName}.json`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          errors.push(`Erreur suppression cache unifie: ${err.message}`);
        }
      }

      // 3. Delete old separate cache files
      const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);
      const oldSeasonFiles = allCacheFiles.filter(f =>
        f.startsWith(safeAnimeName + '_') && f.endsWith('.json')
      );

      for (const oldFile of oldSeasonFiles) {
        try {
          await fsp.unlink(path.join(animeCacheDir, oldFile));
          deletedFiles.push(`old season cache: ${oldFile}`);
        } catch (err) {
          errors.push(`Erreur suppression ancien cache ${oldFile}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Erreur lors de la recherche des fichiers: ${err.message}`);
    }

    if (deletedFiles.length > 0) {
      return res.status(200).json({
        success: true,
        message: `Cache anime "${decodeURIComponent(query)}" supprime.`,
        deletedFiles,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      return res.status(404).json({
        success: false,
        error: 'Aucun cache trouve pour cet anime.',
        errors: errors.length > 0 ? errors : undefined
      });
    }
  } catch (err) {
    console.error('Erreur suppression cache anime:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.configure = configure;