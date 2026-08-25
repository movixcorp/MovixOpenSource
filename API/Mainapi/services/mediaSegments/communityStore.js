/**
 * Propositions de sequences relevees par la communaute Movix, et leurs votes.
 *
 * C'est la seule source d'horodatages qui appartient a Movix : les quatre
 * autres sont des bases tierces en lecture seule. Une proposition passe par
 * trois etats, entierement pilotes par le score :
 *
 *   score < ADOPTION_SCORE   → « proposee » : visible dans le lecteur, mise au
 *                              vote, mais elle ne declenche aucun saut.
 *   score >= ADOPTION_SCORE  → « adoptee » : elle rejoint le consensus au meme
 *                              titre qu'une base externe, via le fournisseur
 *                              `movix`.
 *   score <= REJECTION_SCORE → supprimee, avec ses votes (ON DELETE CASCADE).
 *
 * Tout est en millisecondes : c'est la resolution a laquelle le studio du
 * lecteur laisse regler les bornes, et arrondir a la seconde ici reviendrait a
 * jeter ce travail.
 */

const { getPool } = require('../../mysqlPool');
const { SEGMENT_TYPES } = require('./constants');

/** Score a partir duquel une proposition devient un vrai saut. */
const ADOPTION_SCORE = 3;

/**
 * Poids d'une voix du staff.
 *
 * Egal au seuil d'adoption : un membre de l'equipe valide donc une proposition
 * a lui seul, et son refus l'enterre aussi surement. Le poids est fige au
 * moment du vote plutot que relu a chaque calcul, pour qu'une perte de role
 * plus tard ne reecrive pas silencieusement l'historique.
 */
const STAFF_VOTE_WEIGHT = 3;

/**
 * Score a partir duquel une proposition est supprimee.
 *
 * A -1, un seul « je n'aime pas » suffit : c'est ce qui a ete demande, mais
 * cela rend une proposition fragile face a un vote isole. Passer a -2 demande
 * deux avis concordants sans rien changer d'autre.
 */
const REJECTION_SCORE = -1;

/** Ecart tolere entre la duree du releve et celle du flux joue. */
const DURATION_TOLERANCE_MS = 5000;

/** Bornes de bon sens, pour qu'une faute de frappe ne cree pas un saut absurde. */
const MIN_SEGMENT_MS = 500;

/**
 * Longueur maximale par type.
 *
 * Un plafond unique et large laissait trois comptes complices faire adopter une
 * « intro » couvrant la moitie d'un episode. Les valeurs suivent celles de
 * SkipDB : une intro ou un resume depassant cinq minutes n'existe pas, un
 * generique de fin peut etre long.
 */
const MAX_SEGMENT_MS_BY_TYPE = Object.freeze({
  intro: 5 * 60 * 1000,
  recap: 5 * 60 * 1000,
  outro: 15 * 60 * 1000,
  credits: 15 * 60 * 1000,
  preview: 5 * 60 * 1000,
});

/**
 * Bornes hautes des colonnes.
 *
 * `season` et `episode` sont des SMALLINT (32767) et les millisecondes des
 * INT UNSIGNED : sans plafond a la validation, une valeur plus grande produit
 * soit une erreur 1264 remontee en 500, soit — bien pire — une troncature
 * silencieuse qui rattache la proposition au mauvais episode.
 */
const MAX_SEASON = 999;
const MAX_EPISODE = 9999;
const MAX_DURATION_MS = 24 * 3600 * 1000;

/**
 * Nombre maximal de propositions par compte, tous contenus confondus.
 *
 * La cle unique limite deja a une proposition par type et par contenu, mais
 * rien ne verifie qu'un `tmdbId` existe : sans quota, un compte peut semer des
 * lignes sur des identifiants inventes aussi vite que la limite de debit
 * l'autorise. Large pour un contributeur reel, etroit pour un script.
 */
const MAX_SUBMISSIONS_PER_AUTHOR = 300;

/** Marqueur de « sans objet » pour les films, qui n'ont ni saison ni episode. */
const NOT_APPLICABLE = -1;

const ALLOWED_USER_TYPES = new Set(['oauth', 'bip39']);

let schemaPromise = null;

/**
 * Colonnes ENUM attendues sur `reports` pour accueillir un signalement de
 * sequence. Doivent rester identiques, valeur pour valeur et dans le meme
 * ordre, a `db/schema/community.js` : le planificateur de schema compare les
 * definitions telles quelles et signalerait une derive au moindre ecart.
 */
const REPORT_TARGET_TYPE_ENUM = "ENUM('comment', 'reply', 'shared_list', 'segment')";
const REPORT_REASON_ENUM =
  "ENUM('spam', 'harassment', 'sexual_content', 'unmarked_spoiler', 'impersonation', 'other', 'wrong_timestamp')";

let reportSchemaPromise = null;

/**
 * Ouvre la table `reports` aux signalements de sequences.
 *
 * Le planificateur de schema (`db/schemaPlanner.js`) ajoute des colonnes mais
 * ne modifie jamais celles qui existent : il se contente de signaler la derive.
 * Elargir un ENUM demande donc un ALTER explicite, fait ici parce que c'est ce
 * module qui introduit le nouveau type de cible.
 *
 * DELIBEREMENT HORS de `ensureSchema` : cette DDL prend un verrou de metadonnees
 * sur `reports`, et `ensureSchema` est attendu par `listSubmissions`, donc par
 * CHAQUE lecture de segments. Un ALTER lent ou bloque y aurait retarde toutes
 * les propositions, et une erreur les aurait fait disparaitre en silence — la
 * route rattrape l'echec de `listSubmissions` en renvoyant une liste vide.
 * Elle n'est donc appelee que depuis le chemin du signalement.
 *
 * Ne rejette jamais : renvoie `true` quand la table accepte le nouveau type,
 * `false` sinon, a charge pour l'appelant de refuser proprement.
 */
function ensureReportSchema() {
  if (!reportSchemaPromise) reportSchemaPromise = ensureReportTargets();
  return reportSchemaPromise;
}

async function ensureReportTargets() {
  try {
    const pool = getPool();
    if (!pool) return false;
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'reports'
          AND COLUMN_NAME IN ('target_type', 'reason')`,
    );
    // Table absente : `initDatabase` la creera avec la definition a jour, mais
    // pas avant le prochain demarrage. Rien a signaler d'ici la.
    if (columns.length === 0) return false;

    const current = new Map(columns.map((row) => [row.COLUMN_NAME, String(row.COLUMN_TYPE)]));

    if (!/'segment'/i.test(current.get('target_type') || '')) {
      await pool.execute(
        `ALTER TABLE reports MODIFY COLUMN target_type ${REPORT_TARGET_TYPE_ENUM} NOT NULL`,
      );
    }
    if (!/'wrong_timestamp'/i.test(current.get('reason') || '')) {
      await pool.execute(
        `ALTER TABLE reports MODIFY COLUMN reason ${REPORT_REASON_ENUM} NOT NULL`,
      );
    }
    return true;
  } catch (error) {
    console.warn('[segments] signalements de sequence indisponibles:', error?.message || error);
    // Ne pas memoiser l'echec : une panne passagere ne doit pas condamner le
    // signalement jusqu'au prochain redemarrage.
    reportSchemaPromise = null;
    return false;
  }
}

/**
 * Cree les tables au premier appel. Idempotent et memoise : les routes peuvent
 * l'appeler sans se soucier de l'ordre de demarrage.
 */
function ensureSchema() {
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const pool = getPool();
    if (!pool) throw new Error('MySQL pool not ready for community segments');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS segment_submissions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        media_type ENUM('tv', 'movie') NOT NULL,
        tmdb_id INT UNSIGNED NOT NULL,
        season SMALLINT NOT NULL DEFAULT -1,
        episode SMALLINT NOT NULL DEFAULT -1,
        reference_duration_ms INT UNSIGNED NOT NULL,
        segment_type ENUM('intro', 'recap', 'outro', 'credits', 'preview') NOT NULL,
        start_ms INT UNSIGNED NOT NULL,
        end_ms INT UNSIGNED NOT NULL,
        author_user_type ENUM('oauth', 'bip39') NOT NULL,
        author_user_id VARCHAR(255) NOT NULL,
        author_label VARCHAR(64) NULL,
        votes_up INT NOT NULL DEFAULT 0,
        votes_down INT NOT NULL DEFAULT 0,
        score INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_segment_lookup (media_type, tmdb_id, season, episode),
        KEY idx_segment_adopted (media_type, tmdb_id, season, episode, score),
        -- Une proposition par type et par auteur : reproposer met a jour la
        -- sienne au lieu d'empiler des doublons.
        UNIQUE KEY uniq_author_segment (
          media_type, tmdb_id, season, episode, segment_type,
          author_user_type, author_user_id
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS segment_votes (
        submission_id BIGINT UNSIGNED NOT NULL,
        voter_user_type ENUM('oauth', 'bip39') NOT NULL,
        voter_user_id VARCHAR(255) NOT NULL,
        value TINYINT NOT NULL,
        weight TINYINT UNSIGNED NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (submission_id, voter_user_type, voter_user_id),
        CONSTRAINT fk_segment_votes_submission
          FOREIGN KEY (submission_id) REFERENCES segment_submissions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // MySQL ne connait pas `ADD COLUMN IF NOT EXISTS` : on interroge le
    // catalogue. Necessaire pour les installations ou la table a ete creee
    // avant l'introduction des voix ponderees.
    const [[column]] = await pool.execute(
      `SELECT COUNT(*) AS present
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'segment_votes'
          AND COLUMN_NAME = 'weight'`,
    );
    if (Number(column.present) === 0) {
      await pool.execute(
        'ALTER TABLE segment_votes ADD COLUMN weight TINYINT UNSIGNED NOT NULL DEFAULT 1',
      );
    }
  })().catch((error) => {
    // Ne pas memoiser un echec : le prochain appel doit pouvoir reessayer une
    // fois MySQL revenu.
    schemaPromise = null;
    throw error;
  });

  return schemaPromise;
}

class CommunityError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assertValidTarget({ mediaType, tmdbId, season, episode }) {
  if (mediaType !== 'tv' && mediaType !== 'movie') {
    throw new CommunityError(400, 'invalid_media_type', 'Type de media invalide');
  }
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) {
    throw new CommunityError(400, 'invalid_tmdb_id', 'Identifiant TMDB invalide');
  }
  if (mediaType === 'tv') {
    if (!Number.isSafeInteger(season) || season < 0 || season > MAX_SEASON) {
      throw new CommunityError(400, 'invalid_season', 'Saison invalide');
    }
    if (!Number.isSafeInteger(episode) || episode < 1 || episode > MAX_EPISODE) {
      throw new CommunityError(400, 'invalid_episode', 'Episode invalide');
    }
  }
}

/** Normalise saison/episode : les films n'en ont pas, d'ou le marqueur -1. */
function normalizeTarget({ mediaType, tmdbId, season, episode }) {
  assertValidTarget({ mediaType, tmdbId, season, episode });
  return {
    mediaType,
    tmdbId,
    season: mediaType === 'tv' ? season : NOT_APPLICABLE,
    episode: mediaType === 'tv' ? episode : NOT_APPLICABLE,
  };
}

function assertValidInterval({ startMs, endMs, durationMs, segmentType }) {
  if (!SEGMENT_TYPES.includes(segmentType)) {
    throw new CommunityError(400, 'invalid_type', 'Type de sequence invalide');
  }
  for (const [name, value] of [['startMs', startMs], ['endMs', endMs], ['durationMs', durationMs]]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CommunityError(400, 'invalid_interval', `Valeur invalide: ${name}`);
    }
  }
  if (durationMs < 1000 || durationMs > MAX_DURATION_MS) {
    throw new CommunityError(400, 'invalid_duration', 'Duree de reference invalide');
  }
  if (endMs <= startMs) {
    throw new CommunityError(400, 'invalid_interval', 'La fin doit suivre le debut');
  }
  const length = endMs - startMs;
  if (length < MIN_SEGMENT_MS) {
    throw new CommunityError(400, 'segment_too_short', 'Sequence trop courte');
  }
  if (length > MAX_SEGMENT_MS_BY_TYPE[segmentType]) {
    throw new CommunityError(400, 'segment_too_long', 'Sequence trop longue');
  }
  // Une seconde de marge : la duree rapportee par le navigateur varie un peu
  // d'un decodage a l'autre.
  if (endMs > durationMs + 1000) {
    throw new CommunityError(400, 'segment_out_of_range', 'Sequence hors de la video');
  }
}

function assertValidAuthor(author) {
  if (!author || !ALLOWED_USER_TYPES.has(author.userType) || !author.userId) {
    throw new CommunityError(401, 'unauthorized', 'Authentification requise');
  }
}

function rowToSubmission(row, viewer) {
  const score = Number(row.score);
  return {
    id: String(row.id),
    type: row.segment_type,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    referenceDurationMs: Number(row.reference_duration_ms),
    votesUp: Number(row.votes_up),
    votesDown: Number(row.votes_down),
    /** Nombre de voix du staff, pour l'afficher comme telles. */
    staffVotes: Number(row.staff_votes ?? 0),
    score,
    adopted: score >= ADOPTION_SCORE,
    /** Ce qu'il manque pour l'adoption, pour l'afficher sans le recalculer. */
    scoreToAdoption: Math.max(0, ADOPTION_SCORE - score),
    authorLabel: row.author_label || null,
    isMine: Boolean(
      viewer && row.author_user_type === viewer.userType && row.author_user_id === viewer.userId,
    ),
    myVote: row.my_vote === null || row.my_vote === undefined ? 0 : Number(row.my_vote),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Toutes les propositions d'un episode, adoptees ou non.
 *
 * Filtre sur la duree de reference : un releve fait sur un autre encodage ne
 * vaut rien ici, exactement comme pour les bases externes.
 */
async function listSubmissions({ mediaType, tmdbId, season, episode, durationMs, viewer }) {
  await ensureSchema();
  const pool = getPool();
  const target = normalizeTarget({ mediaType, tmdbId, season, episode });

  const params = [
    viewer?.userType ?? null,
    viewer?.userId ?? null,
    target.mediaType, target.tmdbId, target.season, target.episode,
  ];

  let durationClause = '';
  if (Number.isSafeInteger(durationMs) && durationMs > 0) {
    durationClause = 'AND ABS(CAST(s.reference_duration_ms AS SIGNED) - ?) <= ?';
    params.push(durationMs, DURATION_TOLERANCE_MS);
  }

  const [rows] = await pool.execute(
    `SELECT s.*, v.value AS my_vote,
            (SELECT COUNT(*) FROM segment_votes w
              WHERE w.submission_id = s.id AND w.weight > 1) AS staff_votes
       FROM segment_submissions s
       LEFT JOIN segment_votes v
         ON v.submission_id = s.id
        AND v.voter_user_type = ?
        AND v.voter_user_id = ?
      WHERE s.media_type = ? AND s.tmdb_id = ? AND s.season = ? AND s.episode = ?
        ${durationClause}
      ORDER BY s.score DESC, s.votes_up DESC, s.id ASC`,
    params,
  );

  return rows.map((row) => rowToSubmission(row, viewer));
}

/** Cree ou met a jour la proposition de cet auteur pour ce type de sequence. */
async function submitSegment({
  mediaType, tmdbId, season, episode,
  segmentType, startMs, endMs, durationMs,
  author,
}) {
  await ensureSchema();
  const pool = getPool();
  const target = normalizeTarget({ mediaType, tmdbId, season, episode });
  assertValidInterval({ startMs, endMs, durationMs, segmentType });
  assertValidAuthor(author);

  // Le libelle d'auteur n'est PAS accepte depuis la requete : affiche aux
  // autres utilisateurs sur la carte de vote, il permettrait de s'annoncer
  // « Equipe Movix ». La colonne reste, pour une valeur derivee du compte le
  // jour ou on en affichera une.
  const label = null;

  // Quota : compte uniquement quand il s'agit d'une nouvelle ligne. Mettre a
  // jour une proposition existante reste toujours possible, meme au plafond.
  const [[existing]] = await pool.execute(
    `SELECT id FROM segment_submissions
      WHERE media_type = ? AND tmdb_id = ? AND season = ? AND episode = ?
        AND segment_type = ? AND author_user_type = ? AND author_user_id = ?`,
    [
      target.mediaType, target.tmdbId, target.season, target.episode,
      segmentType, author.userType, author.userId,
    ],
  );

  if (!existing) {
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) AS total FROM segment_submissions WHERE author_user_type = ? AND author_user_id = ?',
      [author.userType, author.userId],
    );
    if (Number(total) >= MAX_SUBMISSIONS_PER_AUTHOR) {
      throw new CommunityError(429, 'submission_quota_reached', 'Quota de propositions atteint');
    }
  }

  // Reproposer remet le compteur a zero : les votes portaient sur les bornes
  // precedentes, les conserver reviendrait a adopter des valeurs que personne
  // n'a validees.
  await pool.execute(
    `INSERT INTO segment_submissions
       (media_type, tmdb_id, season, episode, reference_duration_ms,
        segment_type, start_ms, end_ms, author_user_type, author_user_id, author_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       start_ms = VALUES(start_ms),
       end_ms = VALUES(end_ms),
       reference_duration_ms = VALUES(reference_duration_ms),
       author_label = VALUES(author_label),
       votes_up = 0, votes_down = 0, score = 0`,
    [
      target.mediaType, target.tmdbId, target.season, target.episode, durationMs,
      segmentType, startMs, endMs, author.userType, author.userId, label,
    ],
  );

  const [[row]] = await pool.execute(
    `SELECT * FROM segment_submissions
      WHERE media_type = ? AND tmdb_id = ? AND season = ? AND episode = ?
        AND segment_type = ? AND author_user_type = ? AND author_user_id = ?`,
    [
      target.mediaType, target.tmdbId, target.season, target.episode,
      segmentType, author.userType, author.userId,
    ],
  );

  // Une remise a jour efface aussi les votes de la version precedente.
  await pool.execute('DELETE FROM segment_votes WHERE submission_id = ?', [row.id]);

  return rowToSubmission(row, author);
}

/**
 * Enregistre un vote et applique les consequences de score.
 *
 * @param {1|-1|0} value 0 annule le vote.
 * @returns {{ deleted: boolean, submission: object|null }}
 */
async function voteSegment({ submissionId, value, voter, weight = 1 }) {
  await ensureSchema();
  const pool = getPool();
  assertValidAuthor(voter);

  if (![1, -1, 0].includes(value)) {
    throw new CommunityError(400, 'invalid_vote', 'Vote invalide');
  }
  const voteWeight = weight === STAFF_VOTE_WEIGHT ? STAFF_VOTE_WEIGHT : 1;

  const [[submission]] = await pool.execute(
    'SELECT * FROM segment_submissions WHERE id = ?',
    [submissionId],
  );
  if (!submission) throw new CommunityError(404, 'not_found', 'Proposition introuvable');

  // On ne vote pas pour soi-meme : sinon trois comptes suffiraient a adopter
  // n'importe quoi, et le seuil ne voudrait plus rien dire.
  if (submission.author_user_type === voter.userType && submission.author_user_id === voter.userId) {
    throw new CommunityError(403, 'own_submission', 'On ne vote pas sa propre proposition');
  }

  if (value === 0) {
    await pool.execute(
      'DELETE FROM segment_votes WHERE submission_id = ? AND voter_user_type = ? AND voter_user_id = ?',
      [submissionId, voter.userType, voter.userId],
    );
  } else {
    await pool.execute(
      `INSERT INTO segment_votes (submission_id, voter_user_type, voter_user_id, value, weight)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), weight = VALUES(weight)`,
      [submissionId, voter.userType, voter.userId, value, voteWeight],
    );
  }

  // Les compteurs sont recalcules depuis les votes plutot qu'incrementes : un
  // changement d'avis (pouce haut puis bas) fausserait tout increment naif.
  // `votes_up` et `votes_down` restent des comptes de PERSONNES — c'est ce
  // qu'on affiche. Le score, lui, est la somme ponderee : c'est lui qui decide
  // de l'adoption et du rejet.
  await pool.execute(
    `UPDATE segment_submissions s
        SET votes_up = (SELECT COUNT(*) FROM segment_votes WHERE submission_id = s.id AND value = 1),
            votes_down = (SELECT COUNT(*) FROM segment_votes WHERE submission_id = s.id AND value = -1),
            score = (SELECT COALESCE(SUM(value * weight), 0) FROM segment_votes WHERE submission_id = s.id)
      WHERE s.id = ?`,
    [submissionId],
  );

  const [[updated]] = await pool.execute(
    'SELECT * FROM segment_submissions WHERE id = ?',
    [submissionId],
  );

  if (Number(updated.score) <= REJECTION_SCORE) {
    await pool.execute('DELETE FROM segment_submissions WHERE id = ?', [submissionId]);
    return { deleted: true, submission: null };
  }

  const [[withVote]] = await pool.execute(
    `SELECT s.*, v.value AS my_vote,
            (SELECT COUNT(*) FROM segment_votes w
              WHERE w.submission_id = s.id AND w.weight > 1) AS staff_votes
       FROM segment_submissions s
       LEFT JOIN segment_votes v
         ON v.submission_id = s.id AND v.voter_user_type = ? AND v.voter_user_id = ?
      WHERE s.id = ?`,
    [voter.userType, voter.userId, submissionId],
  );

  return { deleted: false, submission: rowToSubmission(withVote, voter) };
}

/** Retire sa propre proposition. */
async function deleteSubmission({ submissionId, author }) {
  await ensureSchema();
  const pool = getPool();
  assertValidAuthor(author);

  const [result] = await pool.execute(
    'DELETE FROM segment_submissions WHERE id = ? AND author_user_type = ? AND author_user_id = ?',
    [submissionId, author.userType, author.userId],
  );
  if (result.affectedRows === 0) {
    throw new CommunityError(404, 'not_found', 'Proposition introuvable');
  }
  return { deleted: true };
}

/**
 * Une proposition par identifiant, sans filtre de duree ni de contenu.
 *
 * Sert au signalement et au panneau d'administration : les deux partent d'un
 * identifiant deja affiche, pas d'une recherche par episode. Renvoie la ligne
 * brute — l'appelant a besoin du contenu vise (`media_type`, `tmdb_id`) et de
 * l'auteur, que `rowToSubmission` ne porte pas.
 */
async function getSubmissionRow(submissionId) {
  await ensureSchema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    'SELECT * FROM segment_submissions WHERE id = ?',
    [submissionId],
  );
  return row || null;
}

/**
 * Supprime une proposition sans verifier qui en est l'auteur.
 *
 * Reserve a la moderation : la suppression par l'auteur passe par
 * `deleteSubmission`, qui exige la correspondance. Les votes suivent
 * (ON DELETE CASCADE).
 */
async function deleteSubmissionAsModerator(submissionId) {
  await ensureSchema();
  const pool = getPool();
  const [result] = await pool.execute(
    'DELETE FROM segment_submissions WHERE id = ?',
    [submissionId],
  );
  return result.affectedRows > 0;
}

/**
 * Propositions adoptees, au format « proposition de fournisseur » attendu par
 * le consensus. C'est le point d'entree du fournisseur `movix`.
 */
async function getAdoptedCandidates({ mediaType, tmdbId, season, episode, durationSec }) {
  const durationMs = Number.isFinite(durationSec) && durationSec > 0
    ? Math.round(durationSec * 1000)
    : null;

  const submissions = await listSubmissions({
    mediaType, tmdbId, season, episode, durationMs, viewer: null,
  });

  return submissions
    .filter((submission) => submission.adopted)
    .map((submission) => ({
      type: submission.type,
      start: submission.startMs / 1000,
      end: submission.endMs / 1000,
      // La confiance monte avec le nombre de voix, sans jamais atteindre 1 :
      // une base externe verifiee garde l'avantage a egalite de rang.
      confidence: Math.min(0.98, 0.7 + 0.03 * submission.votesUp),
      source: 'movix',
      match: 'exact',
      referenceLength: submission.referenceDurationMs / 1000,
    }));
}

module.exports = {
  ADOPTION_SCORE,
  REJECTION_SCORE,
  STAFF_VOTE_WEIGHT,
  MAX_SUBMISSIONS_PER_AUTHOR,
  CommunityError,
  ensureSchema,
  listSubmissions,
  submitSegment,
  voteSegment,
  deleteSubmission,
  deleteSubmissionAsModerator,
  ensureReportSchema,
  getSubmissionRow,
  getAdoptedCandidates,
};
