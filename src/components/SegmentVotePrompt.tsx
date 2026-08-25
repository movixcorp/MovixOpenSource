// src/components/SegmentVotePrompt.tsx
//
// Carte de vote sur une proposition de la communauté, affichée quand la
// lecture traverse une séquence proposée mais pas encore adoptée.
//
// Elle ne propose PAS de sauter : une proposition non adoptée ne déclenche
// aucun saut, c'est tout l'intérêt du seuil. Le geste demandé est de dire si
// les bornes tombent juste — deux boutons, pas de captcha, pas de formulaire.
//
// Le drapeau à côté de la croix est pour l'autre cas : des bornes qui ne
// correspondent à rien, posées au hasard. Un pouce en bas les efface (score
// négatif), mais n'apprend rien à personne ; le signalement, lui, remonte dans
// la file de modération avec l'auteur et le contenu visé.
//
// Même ancrage et même habillage que `SkipSegmentPrompt` : les deux cartes ne
// s'affichent jamais ensemble (une séquence est soit adoptée, soit proposée),
// donc elles peuvent occuper la même place.

import React, { memo, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Flag, Loader2, ShieldCheck, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  SEGMENT_REPORT_REASONS,
  type CommunitySubmission,
  type SegmentReportReason,
} from '../services/mediaSegmentsService';
import type { SegmentKind } from '../utils/skipSegmentPrefs';
import { getPromptBottomRem, readViewportShape } from '../utils/playerPromptOffset';

interface SegmentVotePromptProps {
  submission: CommunitySubmission | null;
  color: string;
  adoptionScore: number;
  /** `false` quand la session n'est pas connectée : la carte explique pourquoi. */
  canVote: boolean;
  /** Poids de la voix du lecteur : 3 pour l'équipe, 1 sinon. */
  voteWeight: number;
  controlsVisible: boolean;
  busy: boolean;
  /** Code d'erreur renvoyé par la dernière tentative de vote, s'il y en a eu. */
  errorCode: string | null;
  onVote: (value: 1 | -1) => void;
  /**
   * Envoie un signalement à la modération. Rejette en cas d'échec : la carte
   * s'en sert pour distinguer « envoyé » de « pas passé ».
   */
  onReport: (reason: SegmentReportReason) => Promise<void>;
  onDismiss: () => void;
}

/**
 * Codes d'erreur de l'API traduits sur la carte.
 *
 * Un vote qui échoue en silence est indiscernable d'un bouton mort : c'est
 * exactement ce qui donnait l'impression que le vote « ne marchait pas ».
 */
const VOTE_ERROR_KEY: Record<string, string> = {
  unauthorized: 'watch.voteErrorUnauthorized',
  own_submission: 'watch.voteErrorOwnSubmission',
  not_found: 'watch.voteErrorNotFound',
  invalid_vote: 'watch.voteErrorInvalid',
};

/** Libellés des motifs, dans l'ordre de `SEGMENT_REPORT_REASONS`. */
const REPORT_REASON_KEY: Record<SegmentReportReason, string> = {
  wrong_timestamp: 'watch.reportReasonWrongTimestamp',
  spam: 'watch.reportReasonSpam',
  other: 'watch.reportReasonOther',
};

const SEGMENT_LABEL_KEY: Record<SegmentKind, string> = {
  intro: 'watch.segmentIntro',
  recap: 'watch.segmentRecap',
  outro: 'watch.segmentOutro',
  credits: 'watch.segmentCredits',
  preview: 'watch.segmentPreview',
};

function formatSeconds(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const SegmentVotePrompt: React.FC<SegmentVotePromptProps> = ({
  submission,
  color,
  adoptionScore,
  canVote,
  voteWeight,
  controlsVisible,
  busy,
  errorCode,
  onVote,
  onReport,
  onDismiss,
}) => {
  const { t } = useTranslation();

  // Le signalement se déplie DANS la carte : ouvrir une fenêtre par-dessus le
  // lecteur pour trois mots serait disproportionné, et la carte disparaît de
  // toute façon dès qu'on sort de la séquence.
  const [reporting, setReporting] = useState(false);
  const [reportStatus, setReportStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  // Changer de proposition remet la carte à plat : le panneau de signalement
  // resterait sinon ouvert sur une séquence qui n'est plus celle affichée.
  const submissionId = submission?.id ?? null;
  useEffect(() => {
    setReporting(false);
    setReportStatus('idle');
  }, [submissionId]);

  const sendReport = async (reason: SegmentReportReason) => {
    setReportStatus('sending');
    try {
      await onReport(reason);
      setReportStatus('sent');
    } catch {
      setReportStatus('error');
    }
  };

  // Même géométrie que `SkipSegmentPrompt`, au rem près : les deux cartes se
  // relaient au même endroit selon qu'une séquence est adoptée ou proposée.
  const bottomRem = getPromptBottomRem(readViewportShape(), controlsVisible);

  return (
    <AnimatePresence>
      {submission && (
        <motion.div
          data-player-controls=""
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={(event) => event.stopPropagation()}
          // `transition-[bottom]` : la carte glisse quand la barre de contrôles
          // apparaît, au lieu de sauter d'un cran — même timing que la barre
          // elle-même et que `SkipSegmentPrompt`.
          className="absolute right-4 z-50 w-[min(88vw,20rem)] overflow-hidden rounded-lg bg-black/85 backdrop-blur-sm transition-[bottom] duration-200 ease-out"
          style={{ bottom: `${bottomRem}rem` }}
        >
          <div className="flex items-stretch">
            <span aria-hidden="true" className="w-1 shrink-0" style={{ backgroundColor: color }} />

            <div className="min-w-0 flex-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-white">
                  {t('watch.voteQuestion', { name: t(SEGMENT_LABEL_KEY[submission.type]) })}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Signaler : pour les bornes fantaisistes, celles qu'aucun
                      pouce en bas ne suffit à qualifier. Absent pour l'auteur,
                      qui a un bouton « supprimer » dans le studio. */}
                  {canVote && !submission.isMine && !reporting && (
                    <button
                      type="button"
                      onClick={() => { setReporting(true); setReportStatus('idle'); }}
                      aria-label={t('watch.reportSegment')}
                      title={t('watch.reportSegment')}
                      className="rounded p-0.5 text-gray-400 transition-colors hover:text-amber-300"
                    >
                      <Flag size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onDismiss}
                    aria-label={t('watch.dismiss')}
                    className="rounded p-0.5 text-gray-400 transition-colors hover:text-white"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>

              <p className="mt-0.5 font-mono text-[11px] tabular-nums text-gray-400">
                {formatSeconds(submission.startMs)} → {formatSeconds(submission.endMs)}
                {submission.authorLabel && (
                  <span className="ml-1.5 font-sans text-gray-500">· {submission.authorLabel}</span>
                )}
              </p>

              {/* Progression vers l'adoption : rend le seuil concret. */}
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{
                      width: `${Math.min(100, (Math.max(0, submission.score) / adoptionScore) * 100)}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-gray-400">
                  {Math.max(0, submission.score)}/{adoptionScore}
                </span>
                {submission.staffVotes > 0 && (
                  <ShieldCheck size={12} className="shrink-0 text-amber-300" aria-label={t('watch.voteStaffBadge')} />
                )}
              </div>

              {/* Trois états pour la même zone : le formulaire de signalement
                  quand il est déplié, sinon le vote — dont l'auteur est exclu,
                  lui montrer deux boutons qui renverraient un refus serait un
                  piège. */}
              {reporting ? (
                <div className="mt-2.5">
                  {reportStatus === 'sent' ? (
                    <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-green-300">
                      <Check size={12} className="shrink-0" />
                      {t('watch.reportSent')}
                    </p>
                  ) : (
                    <>
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        {t('watch.reportPrompt')}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {SEGMENT_REPORT_REASONS.map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            disabled={reportStatus === 'sending'}
                            onClick={() => sendReport(reason)}
                            className="rounded bg-white/10 px-2 py-1 text-[11px] text-white transition-colors hover:bg-amber-500/25 hover:text-amber-200 disabled:opacity-50"
                          >
                            {t(REPORT_REASON_KEY[reason])}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        {reportStatus === 'sending' && (
                          <Loader2 size={12} className="animate-spin text-gray-400" aria-hidden="true" />
                        )}
                        <button
                          type="button"
                          onClick={() => { setReporting(false); setReportStatus('idle'); }}
                          className="text-[11px] text-gray-400 underline-offset-2 transition-colors hover:text-white hover:underline"
                        >
                          {t('watch.reportCancel')}
                        </button>
                      </div>
                      {reportStatus === 'error' && (
                        <p className="mt-1.5 text-[11px] leading-relaxed text-red-300">
                          {t('watch.reportError')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : submission.isMine ? (
                <p className="mt-2.5 text-[11px] leading-relaxed text-gray-400">
                  {t('watch.voteOwnSubmission', {
                    score: Math.max(0, submission.score),
                    needed: adoptionScore,
                  })}
                </p>
              ) : canVote ? (
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onVote(1)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                      submission.myVote === 1
                        ? 'bg-green-500/25 text-green-300'
                        : 'bg-white/10 text-white hover:bg-white/20'
                    }`}
                  >
                    <ThumbsUp size={14} />
                    {t('watch.voteUp')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onVote(-1)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                      submission.myVote === -1
                        ? 'bg-red-500/25 text-red-300'
                        : 'bg-white/10 text-white hover:bg-white/20'
                    }`}
                  >
                    <ThumbsDown size={14} />
                    {t('watch.voteDown')}
                  </button>
                </div>
              ) : (
                <p className="mt-2.5 text-[11px] leading-relaxed text-gray-400">
                  {t('watch.voteSignInRequired')}
                </p>
              )}

              {/* Une voix de l'équipe pèse le seuil d'adoption à elle seule :
                  autant que celui qui vote le sache avant de cliquer. */}
              {!reporting && !submission.isMine && canVote && voteWeight > 1 && (
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-300">
                  <ShieldCheck size={12} />
                  {t('watch.voteStaffWeight', { weight: voteWeight })}
                </p>
              )}

              {!reporting && errorCode && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-red-300">
                  {t(VOTE_ERROR_KEY[errorCode] || 'watch.voteErrorUnknown')}
                </p>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default memo(SegmentVotePrompt);
