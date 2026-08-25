/**
 * embedExtraction.js — Résolution serveur des liens embed en URLs m3u8.
 *
 * Les routes catalogue (fstream, etc.) renvoient des liens d'hébergeurs
 * (`https://fsvid.lol/embed-xxxx.html`). Historiquement, le navigateur appelait
 * lui-même `proxiesembed` pour les résoudre — ce qui exposait publiquement les
 * endpoints d'extraction.
 *
 * Désormais c'est mainapi qui résout, derrière sa clé interne, et uniquement
 * pour ce que le client demande : un seul épisode par requête. Le navigateur
 * reçoit directement des m3u8 signées.
 *
 * Voir aussi : `utils/mediaSigning.js` (signature), `routes/mediaExtract.js`
 * (passerelle par source, utilisée en repli).
 */

const axios = require('axios');

const { internalHeaders, internalKeyConfigured, isPublicHttpUrl } = require('./mediaSigning');
const { isValidDiscordWebhookUrl } = require('./wiflixProxyTelemetry');

// ---------------------------------------------------------------------------
// Détection d'hébergeur
// ---------------------------------------------------------------------------
// Miroir de `src/utils/hosterRegistry.ts` (BUILTIN_HOSTER_PATTERNS). Les deux
// listes doivent évoluer ensemble : le frontend s'en sert pour l'affichage et
// les préférences de source, le backend pour décider quoi extraire.
const HOSTER_PATTERNS = Object.freeze({
    voe: [
        // voe.<tld> + les variantes `voe-unblock`, `v-o-e-unblock`, `voeunbl0ck12`…
        'voe\\.',
        '(?:v-?o-?e)?-?un-?bl[o0]?c?k\\d{0,2}(?:-?voe)?\\.',
        // Alias sans « voe » dans le nom : liste tenue à jour d'après les
        // domaines de sortie observés (miroir de ResolveURL/voesx.py).
        '(?:19turanosephantasia|20demidistance9elongations|30sensualizeexpression|321naturelikefurfuroid|35volitantplimsoles5|449unceremoniousnasoseptal|745mingiestblissfully|adrianmissionminute|alleneconomicmatter|antecoxalbobbing1010|anthonysaline|apinchcaseation|audaciousdefaulthouse|auraleanline|availedsmallest|bigclatterhomesguideservice)\\.',
        '(?:boonlessbestselling244|bradleyviewdoctor|brittneystandardwestern|brucevotewithin|caseyimpactstation|charlestoughrace|christopheruntilpoint|chromotypic|chuckle-tube|cindyeyefinal|claudiosepulchral|conscientiousedu|counterclockwisejacky|crownmakermacaronicism|crystaltreatmenteast|cyamidpulverulence530)\\.',
        '(?:dianaavoidthey|diananatureforeign|donaldlineelse|edwardarriveoften|effortlessexperim|ellenpoliticalfollow|erikcoldperson|figeterpiazine|fittingcentermondaysunday|fraudclatterflyingcar|gamoneinterrupted|garylargeavailable|generatesnitrosate|goofy-banana|graceaddresscommunity|greaseball6eventual20)\\.',
        '(?:guidon40hyporadius9|heatherdiscussionwhen|housecardsummerbutton|ianrequireadult|jamessoundcost|jamiesamewalk|jasminetesttry|jayservicestuff|jeanprofessorcentral|jefferycontrolmodel|jennifercertaindevelopment|jennifereconomicgive|jessicachoosemake|jessicayeahcatch|jilliandescribecompany|johnalwayssame)\\.',
        '(?:johnbeyondnation|jonathansociallike|josephseveralconcern|juliewomanwish|kathleenmemberhistory|kellywhatcould|kennethofficialitem|kinoger|kristiesoundsimply|lancewhosedifficult|launchreliantcleaverriver|lauradaydo|letsupload|lisatrialidea|loriwithinfamily|lukecomparetwo)\\.',
        '(?:lukesitturn|mariatheserepublican|marissasharecareer|matriculant401merited|matthewhotelscience|maxfinishseveral|metagnathtuggers|michaelapplysome|mikaylaarealike|nathanfromsubject|nectareousoverelate|nonesnanking|ogladaj|pamelachangemission|paulkitchendark|preferciseaccurate)\\.',
        '(?:prepareddare|ralphysuccessfull|realfinanceblogcenter|rebeccaneverbase|rebeccapracticeloss|reputationsheriffkennethsand|richardsignfish|roberteachfinal|robertordercharacter|robertplacespace|sandratableother|sandrataxeight|scatch176duplicities|sethniceletter|shannonpersonalcost|simpulumlamerop|smoki)\\.',
        '(?:stevenfamilyedge|stevenimaginelittle|strawberriesporail|telyn610zoanthropy|timberwoodanotia|timmaybealready|toddpartneranimal|toxitabellaeatrebates306|tracylocalschool|uptodatefinishconferenceroom|valeronevijao|walterprettytheir|wolfdyslectic|yodelswartlike)\\.',
    ],
    vidmoly: ['vidmoly'],
    uqload: ['uqload'],
    sibnet: ['sibnet'],
    // Veev partage `doods.to` avec la nébuleuse DoodStream mais a son propre
    // protocole : il doit donc être testé AVANT `doodstream`, dont le pattern
    // `dood` l'attraperait sinon (l'ordre des clés fait foi ici).
    veev: ['veev\\.', 'poophq', 'doods\\.to'],
    doodstream: [
        'doodstream', 'd0000d', 'd000d', 'd0o0d', 'do0od',
        'dood\\.', 'doodster', 'dooodster', 'dooood', 'doodcdn',
        'myvidplay', 'dsvplay', 'doply', 'playmogo',
        'ds2play', 'ds2video', 'dood2', 'all3do', 'do7go',
        'vidply', 'vide0\\.net', 'vvide0', 'd-s\\.io',
    ],
    lulustream: [
        'lulustream', 'luluvdo', 'luluvdoo', 'luluvid', 'lulu\\.st',
        'streamhihi', 'd00ds\\.site', 'cdn1\\.site', '732eg54de642sa',
    ],
    vidara: ['vidara\\.(?:to|so)'],
    seekstreaming: [
        'embedseek', 'embed4me', 'servicecatalog',
        'technicalcatalog', 'seekplayer', 'seeks.cloud', 'seekplays',
    ],
    vidzy: ['vidzy'],
    fsvid: ['fsvid'],
});

const COMPILED_PATTERNS = Object.entries(HOSTER_PATTERNS).map(([hoster, patterns]) => ({
    hoster,
    regexes: patterns
        .map((pattern) => {
            try {
                return new RegExp(pattern, 'i');
            } catch {
                return null;
            }
        })
        .filter(Boolean),
}));

function detectHoster(url) {
    if (typeof url !== 'string' || !url) return null;
    for (const { hoster, regexes } of COMPILED_PATTERNS) {
        if (regexes.some((regex) => regex.test(url))) return hoster;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Extracteurs proxiesembed
// ---------------------------------------------------------------------------
// `pick` isole l'URL de flux dans la réponse : chaque handler proxiesembed a
// hérité d'un nom de champ différent (m3u8Url, sourceUrl, url, source…).
const EXTRACTORS = Object.freeze({
    voe: { path: '/api/voe/m3u8', base64: true, pick: (data) => data?.source },
    fsvid: { path: '/api/extract-fsvid', pick: (data) => data?.m3u8Url },
    vidzy: { path: '/api/extract-vidzy', pick: (data) => data?.m3u8Url },
    vidmoly: { path: '/api/extract-vidmoly', pick: (data) => data?.sourceUrl },
    sibnet: { path: '/api/extract-sibnet', pick: (data) => data?.sourceUrl },
    uqload: { path: '/api/extract-uqload', pick: (data) => data?.data?.url || data?.url },
    doodstream: { path: '/api/extract-doodstream', pick: (data) => data?.url },
    lulustream: { path: '/api/extract-lulustream', pick: (data) => data?.url },
    veev: { path: '/api/extract-veev', pick: (data) => data?.url },
    vidara: { path: '/api/extract-vidara', pick: (data) => data?.url },
    seekstreaming: {
        path: '/api/extract-seekstreaming',
        pick: (data) =>
            data?.hlsUrl ||
            (Array.isArray(data?.hlsCandidates) ? data.hlsCandidates[0]?.url : null) ||
            (Array.isArray(data?.candidates) ? data.candidates[0]?.url : null) ||
            data?.url,
    },
});

const EXTRACT_TIMEOUT_MS = 25000;
// Un épisode compte rarement plus de 7-8 sources. Quatre extractions
// simultanées gardent la latence basse sans marteler les hébergeurs.
const DEFAULT_CONCURRENCY = 4;

function resolveProxiesEmbedBase() {
    const candidates = [
        process.env.PROXIESEMBED_INTERNAL_URL,
        process.env.PROXIESEMBED_PUBLIC_URL,
        (process.env.PROXY_SERVER_URL || '').replace(/\/proxy\/?$/, ''),
    ];
    for (const candidate of candidates) {
        const trimmed = (candidate || '').trim().replace(/\/+$/, '');
        if (trimmed) return trimmed;
    }
    return 'http://127.0.0.1:25569';
}

// ---------------------------------------------------------------------------
// Journal Discord des échecs d'extraction
// ---------------------------------------------------------------------------
// Le catch d'`extractEmbed` est volontairement muet : un hébergeur mort est le
// cas NORMAL. Mais du coup un 0/N systémique — proxiesembed injoignable, clé
// interne désaccordée, VIP refusée côté Python — passait totalement inaperçu,
// avec pour seule trace un `resolved: 0` sans motif.
//
// On pousse donc le MOTIF sur le webhook Discord, avec un délai de garde par
// (hébergeur, type d'échec) : un hébergeur qui tombe génère une ligne, pas une
// par lien de l'épisode.
const EXTRACTION_WEBHOOK_URL = (process.env.WIFLIX_PROXY_BLOCK_WEBHOOK_URL || '').trim();
const EXTRACTION_WEBHOOK_ENABLED =
    process.env.EXTRACTION_FAILURE_WEBHOOK_ENABLED !== 'false'
    && isValidDiscordWebhookUrl(EXTRACTION_WEBHOOK_URL);
const EXTRACTION_WEBHOOK_COOLDOWN_MS = parseInt(
    process.env.EXTRACTION_FAILURE_WEBHOOK_COOLDOWN_MS || '600000', // 10 min
    10,
);

const extractionWebhookCooldown = new Map();

/** Réduit une erreur axios à un couple (type stable, libellé lisible). */
function describeExtractionFailure(error) {
    const status = error?.response?.status;
    if (status) {
        // proxiesembed répond `{ error, code }` sur ses refus : `INTERNAL_KEY_REQUIRED`
        // et `VIP_REQUIRED` sont précisément ce qu'on veut voir passer ici.
        const data = error.response?.data;
        const detail = typeof data === 'object' ? (data?.code || data?.error) : null;
        return {
            kind: `http-${status}`,
            label: `HTTP ${status}${detail ? ` — ${String(detail).slice(0, 120)}` : ''}`,
        };
    }
    if (error?.code) return { kind: error.code, label: String(error.code) };
    return { kind: 'unknown', label: String(error?.message || 'erreur inconnue').slice(0, 200) };
}

/** URL sans query string : les liens embed portent parfois un identifiant de session. */
function safeEmbedUrl(value) {
    try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
    } catch {
        return 'non disponible';
    }
}

/** Signale un échec d'extraction sur Discord. Best effort, jamais bloquant. */
function notifyExtractionFailure(hoster, embedUrl, { kind, label }) {
    if (!EXTRACTION_WEBHOOK_ENABLED) return;

    const key = `${hoster}:${kind}`;
    const nowMs = Date.now();
    if (nowMs < (extractionWebhookCooldown.get(key) || 0)) return;
    extractionWebhookCooldown.set(key, nowMs + EXTRACTION_WEBHOOK_COOLDOWN_MS);

    // La table est bornée par (hébergeur x type d'échec), mais on purge quand même
    // les entrées périmées pour qu'un pic de codes d'erreur ne la fasse pas enfler.
    if (extractionWebhookCooldown.size > 200) {
        for (const [entry, until] of extractionWebhookCooldown) {
            if (until <= nowMs) extractionWebhookCooldown.delete(entry);
        }
    }

    axios
        .post(
            EXTRACTION_WEBHOOK_URL,
            {
                username: 'Movix Extraction Monitor',
                allowed_mentions: { parse: [] },
                embeds: [{
                    title: `Extraction échouée — ${hoster}`,
                    color: 0xe67e22,
                    timestamp: new Date(nowMs).toISOString(),
                    fields: [
                        { name: 'Hébergeur', value: hoster, inline: true },
                        { name: 'Motif', value: label, inline: true },
                        { name: 'Embed', value: safeEmbedUrl(embedUrl), inline: false },
                    ],
                    footer: {
                        text: `Silence de ${Math.round(EXTRACTION_WEBHOOK_COOLDOWN_MS / 60000)} min sur ce motif`,
                    },
                }],
            },
            { timeout: 4000, maxRedirects: 0, proxy: false },
        )
        .catch(() => { /* le monitoring ne doit jamais casser une lecture */ });
}

/**
 * Résout un lien embed en URL m3u8 signée.
 * @returns {Promise<{ m3u8Url: string, hoster: string } | null>}
 */
async function extractEmbed(embedUrl, accessKey) {
    const hoster = detectHoster(embedUrl);
    if (!hoster) return null;

    const extractor = EXTRACTORS[hoster];
    if (!extractor || !isPublicHttpUrl(embedUrl)) return null;

    const urlParam = extractor.base64
        ? Buffer.from(embedUrl, 'utf8').toString('base64')
        : embedUrl;

    try {
        const response = await axios.get(`${resolveProxiesEmbedBase()}${extractor.path}`, {
            params: { url: urlParam },
            headers: internalHeaders({
                Accept: 'application/json',
                // La clé VIP de l'utilisateur est retransmise : proxiesembed la
                // revérifie, donc une fuite de la seule clé interne ne suffit
                // pas à déclencher des extractions.
                'x-access-key': accessKey || '',
            }),
            timeout: EXTRACT_TIMEOUT_MS,
            validateStatus: (status) => status >= 200 && status < 300,
        });

        const m3u8Url = extractor.pick(response.data);
        if (typeof m3u8Url === 'string' && m3u8Url) return { m3u8Url, hoster };

        // 2xx sans flux : l'extracteur a répondu mais n'a rien trouvé dans la
        // page. Signe habituel d'un hébergeur qui a changé son gabarit.
        notifyExtractionFailure(hoster, embedUrl, {
            kind: 'empty-payload',
            label: 'réponse 2xx sans m3u8',
        });
        return null;
    } catch (error) {
        // Un hébergeur mort ne doit pas faire échouer tout l'épisode : les
        // autres sources restent jouables.
        //
        // La console reste muette : un hébergeur indisponible (page retirée,
        // lien périmé, upstream qui refuse) est le cas NORMAL sur un catalogue
        // qui en interroge plusieurs par épisode, et le journaliser noyait tout
        // le reste. Le motif part sur Discord, dédoublonné par hébergeur.
        notifyExtractionFailure(hoster, embedUrl, describeExtractionFailure(error));
        return null;
    }
}

// Le champ portant l'URL change d'un catalogue à l'autre : `url` (wiflix, j1f,
// swiftflow, cpasmal), `link` (frenchstream, voirdrama), `decoded_url` (coflix).
// On les sonde dans l'ordre plutôt que d'imposer une config par route.
const URL_FIELDS = Object.freeze(['url', 'link', 'decoded_url']);

/** URL d'un lecteur, quel que soit le nom du champ qui la porte. */
function playerUrl(player) {
    if (!player || typeof player !== 'object') return null;
    for (const field of URL_FIELDS) {
        if (typeof player[field] === 'string' && player[field]) return player[field];
    }
    return null;
}

/** Exécute `worker` sur chaque élément, `limit` à la fois. */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}

/**
 * Primitive de résolution : prend une map `langue -> [lecteurs]` et renvoie une
 * copie où chaque lecteur extractible porte en plus `m3u8Url`.
 *
 * C'est la forme partagée par tous les catalogues du projet, que le contenu
 * soit un épisode (`episodes[N].languages`) ou un film (`players`).
 *
 * Les liens embed d'origine sont conservés : le client garde son repli
 * (extension, lecteur iframe) pour tout ce qui n'a pas pu être résolu.
 *
 * @returns {Promise<{ languages: object, attempted: number, resolved: number }>}
 */
async function extractLanguageMap(languageMap, options = {}) {
    const { accessKey, concurrency = DEFAULT_CONCURRENCY } = options;

    // On aplatit d'abord pour paralléliser sur tout le contenu, toutes langues
    // confondues, plutôt que langue par langue.
    const jobs = [];
    for (const [language, players] of Object.entries(languageMap)) {
        if (!Array.isArray(players)) continue;
        players.forEach((player, index) => {
            const url = playerUrl(player);
            if (url && detectHoster(url)) jobs.push({ language, index, url });
        });
    }

    const outcomes = await mapWithConcurrency(jobs, concurrency, (job) =>
        extractEmbed(job.url, accessKey)
    );

    const resolvedByKey = new Map();
    outcomes.forEach((outcome, position) => {
        if (outcome) {
            const job = jobs[position];
            resolvedByKey.set(`${job.language}:${job.index}`, outcome);
        }
    });

    const languages = {};
    for (const [language, players] of Object.entries(languageMap)) {
        languages[language] = Array.isArray(players)
            ? players.map((player, index) => {
                  const resolved = resolvedByKey.get(`${language}:${index}`);
                  return resolved ? { ...player, m3u8Url: resolved.m3u8Url } : player;
              })
            : players;
    }

    return { languages, attempted: jobs.length, resolved: resolvedByKey.size };
}

/**
 * Variante « tableau plat » : certains catalogues ne séparent pas les langues
 * (`data[]` chez voirdrama, `player_links[]` chez coflix/frenchstream).
 *
 * @returns {Promise<{ players: Array, attempted: number, resolved: number }>}
 */
async function extractPlayerList(players, options = {}) {
    const { languages, attempted, resolved } = await extractLanguageMap({ _: players }, options);
    return { players: languages._, attempted, resolved };
}

/**
 * Résout une liste d'URLs et renvoie la table « lien -> m3u8 ».
 *
 * Pour les catalogues dont les lecteurs ne sont pas des objets auxquels on
 * pourrait ajouter un champ : chaînes brutes (Anime-Sama) ou listes mixtes
 * chaînes/objets (les liens communautaires stockés en MySQL). Le client lit
 * cette table par lien (cf. `registerServerResolvedSources` côté frontend).
 *
 * @returns {Promise<Object<string,string>>}
 */
async function buildM3u8Map(urls, options = {}) {
    if (!Array.isArray(urls) || !extractionAvailable()) return {};

    const { accessKey, concurrency = DEFAULT_CONCURRENCY } = options;
    const cibles = [...new Set(urls.filter((url) => typeof url === 'string' && detectHoster(url)))];

    const resolus = await mapWithConcurrency(cibles, concurrency, (url) =>
        extractEmbed(url, accessKey)
    );

    const table = {};
    resolus.forEach((resolu, index) => {
        if (resolu) table[cibles[index]] = resolu.m3u8Url;
    });
    return table;
}

function extractionSummary(attempted, resolved) {
    return { attempted, resolved, extractedAt: new Date().toISOString() };
}

/** Vrai si l'extraction serveur peut tourner (clé interne présente). */
function extractionAvailable() {
    if (internalKeyConfigured()) return true;
    console.error('[EXTRACTION] INTERNAL_API_KEY absent — extraction serveur désactivée');
    return false;
}

/**
 * Résout les sources d'UN épisode (`episodes[N]`, forme séries).
 *
 * Les catalogues rangent la map de langues de deux façons :
 * - sous une clé dédiée : `{ number, title, languages: { VF: [...] } }` (fstream)
 * - à même l'épisode    : `{ vf: [...], vostfr: [...] }` (wiflix)
 *
 * `languageKey` dit laquelle ; à `null`, l'épisode EST la map. Les champs qui
 * ne sont pas des tableaux (`number`, `title`…) traversent inchangés.
 *
 * @param {{ accessKey?: string, concurrency?: number, languageKey?: string|null }} options
 */
async function extractEpisodeSources(episode, options = {}) {
    if (!episode || typeof episode !== 'object' || Array.isArray(episode)) return episode;

    const { languageKey = 'languages' } = options;
    const languageMap = languageKey ? episode[languageKey] : episode;
    if (!languageMap || typeof languageMap !== 'object' || Array.isArray(languageMap)) {
        return episode;
    }
    if (!extractionAvailable()) return episode;

    const { languages, attempted, resolved } = await extractLanguageMap(languageMap, options);
    const summary = extractionSummary(attempted, resolved);

    return languageKey
        ? { ...episode, [languageKey]: languages, extraction: summary }
        : { ...languages, extraction: summary };
}

/**
 * Résout les sources d'un FILM.
 *
 * Les catalogues films exposent la map de langues à la racine de la réponse
 * (`players` chez fstream, `organized` ailleurs) : `mapKey` dit laquelle lire.
 *
 * @param {object} payload  Réponse catalogue complète
 * @param {string} mapKey   Clé portant la map `langue -> [lecteurs]`
 */
/** Lit une valeur par chemin pointé (`current_episode.player_links`). */
function getByPath(source, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), source);
}

/** Copie `source` en remplaçant la valeur au chemin pointé. Ne mute rien. */
function setByPath(source, path, value) {
    const [head, ...rest] = path.split('.');
    if (rest.length === 0) return { ...source, [head]: value };
    return { ...source, [head]: setByPath(source[head] || {}, rest.join('.'), value) };
}

async function extractMovieSources(payload, mapKey, options = {}) {
    if (!payload || typeof payload !== 'object') return payload;

    const container = getByPath(payload, mapKey);
    if (!container || typeof container !== 'object') return payload;
    // Rien à résoudre : on renvoie tel quel plutôt que d'ajouter un résumé
    // d'extraction vide à une réponse qui n'a aucune source.
    if (Array.isArray(container) ? container.length === 0 : Object.keys(container).length === 0) {
        return payload;
    }
    if (!extractionAvailable()) return payload;

    // Tableau plat (voirdrama, coflix…) ou map par langue (la majorité).
    if (Array.isArray(container)) {
        const { players, attempted, resolved } = await extractPlayerList(container, options);
        return {
            ...setByPath(payload, mapKey, players),
            extraction: extractionSummary(attempted, resolved),
        };
    }

    const { languages, attempted, resolved } = await extractLanguageMap(container, options);
    return {
        ...setByPath(payload, mapKey, languages),
        extraction: extractionSummary(attempted, resolved),
    };
}

/**
 * Répond à une requête catalogue en y résolvant les m3u8 du contenu demandé.
 *
 * C'est le point d'entrée que les modules de routes utilisent : il regroupe la
 * décision (faut-il extraire ?), le contrôle VIP et la tolérance aux pannes.
 *
 * L'extraction ne se déclenche que si l'appelant présente une clé VIP valide,
 * et ne porte que sur ce qui est demandé : un seul épisode, ou le film. Le
 * reste d'une saison reste sous forme de liens embed — inutile de solliciter
 * des dizaines d'hébergeurs pour une seule lecture.
 *
 * Les m3u8 résolues ne doivent JAMAIS être écrites dans le cache disque de la
 * route : elles portent une signature à durée de vie limitée, alors que le
 * catalogue se cache longtemps. D'où l'enrichissement ici, après la mise en
 * cache, sur une copie.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} payload  Réponse catalogue déjà construite (et déjà cachée)
 * @param {{ status?: number, movieMapKey?: string, episode?: string|number,
 *           languageKey?: string|null, label?: string }} options
 *        movieMapKey : pour un film, la clé portant la map de langues
 *                      (`players`, `organized`…). Absente => contenu épisodique.
 *        episode     : force la clé d'épisode ; par défaut `req.query.episode`.
 *        languageKey : où la map de langues vit dans un épisode ; `null` quand
 *                      l'épisode est lui-même la map (cf. extractEpisodeSources).
 */
async function respondWithResolvedSources(req, res, payload, options = {}) {
    const { status = 200, movieMapKey = null, label = 'CATALOGUE' } = options;
    const languageKey = 'languageKey' in options ? options.languageKey : 'languages';
    const send = () => res.status(status).json(payload);

    if (!payload || typeof payload !== 'object') return send();

    // Le client doit demander explicitement la résolution (`?resolve=1`).
    // Sans ce garde-fou, on extrairait pour des clients qui ignorent encore le
    // champ `m3u8Url` et refont l'extraction de leur côté : le travail amont
    // serait fait deux fois. Cela permet aussi de basculer le frontend
    // catalogue par catalogue.
    if (String(req.query.resolve || '') !== '1') return send();

    // Rien à résoudre : on évite le coût d'une vérification VIP inutile.
    const episodeKey = movieMapKey
        ? null
        : String(options.episode ?? req.query.episode ?? '');
    if (movieMapKey) {
        const container = getByPath(payload, movieMapKey);
        if (!container || typeof container !== 'object') return send();
        const empty = Array.isArray(container)
            ? container.length === 0
            : Object.keys(container).length === 0;
        if (empty) return send();
    } else if (!episodeKey || !payload.episodes || !payload.episodes[episodeKey]) {
        return send();
    }

    try {
        // Chargé à la demande : les primitives d'extraction ci-dessus n'ont
        // aucune raison de tirer le pool MySQL au simple chargement du module.
        const { verifyAccessKey } = require('../checkVip');

        const accessKey = req.headers['x-access-key'] || null;
        const vipStatus = await verifyAccessKey(accessKey);
        if (!vipStatus?.vip) return send();

        if (movieMapKey) {
            const enriched = await extractMovieSources(payload, movieMapKey, { accessKey });
            return res.status(status).json(enriched);
        }

        const enrichedEpisode = await extractEpisodeSources(payload.episodes[episodeKey], {
            accessKey,
            languageKey,
        });
        return res.status(status).json({
            ...payload,
            episodes: { ...payload.episodes, [episodeKey]: enrichedEpisode },
        });
    } catch (error) {
        // L'extraction est un bonus : si elle casse, le catalogue reste
        // utilisable et le client retombe sur son extraction locale.
        console.error(`[${label}] Extraction échouée: ${error.message}`);
        return send();
    }
}

module.exports = {
    HOSTER_PATTERNS,
    detectHoster,
    playerUrl,
    extractEmbed,
    extractLanguageMap,
    extractPlayerList,
    buildM3u8Map,
    extractEpisodeSources,
    extractMovieSources,
    respondWithResolvedSources,
};
