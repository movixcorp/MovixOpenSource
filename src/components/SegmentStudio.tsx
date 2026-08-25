// src/components/SegmentStudio.tsx
//
// Studio de repérage : permet de relever une séquence à sauter directement
// depuis le lecteur, à la milliseconde, et de la proposer à la communauté.
//
// Le parti pris est qu'on repère en regardant, pas en tapant des chiffres :
// les deux boutons « Prendre la position » posent les bornes pendant la
// lecture, et le réglage fin ne sert qu'à rattraper les quelques dizaines de
// millisecondes qui séparent le moment où l'on voit et celui où l'on clique.
// Chaque ajustement replace la vidéo sur la borne modifiée, pour qu'on voie
// immédiatement où l'on est — c'est l'aperçu, en pleine qualité.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useDragControls } from 'framer-motion';
import { Check, Copy, ExternalLink, GripHorizontal, Loader2, PauseCircle, Play, Target, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import type { CommunitySubmission } from '../services/mediaSegmentsService';
import { SEGMENT_KINDS, type SegmentKind } from '../utils/skipSegmentPrefs';
import {
  CONTRIB_SITES,
  formatContribClipboard,
  getContribBlockReason,
  getContribUrl,
  type ContribBlockReason,
} from '../utils/segmentContribSites';

/** Une séquence déjà relevée, telle que le studio la voit. */
export interface KnownRange {
  type: SegmentKind;
  startMs: number;
  endMs: number;
}

interface SegmentStudioProps {
  open: boolean;
  /** Durée réelle du flux, en secondes. Sert de borne haute et de référence. */
  duration: number;
  /** Position de lecture courante, en secondes. */
  currentTime: number;
  colors: Record<SegmentKind, string>;
  /** Propositions déjà déposées pour cet épisode, pour reprendre les siennes. */
  submissions: CommunitySubmission[];
  /**
   * Séquences déjà connues pour cet épisode, tous types confondus.
   *
   * Sert à empêcher qu'une intro et un générique se chevauchent : deux
   * séquences actives au même instant, c'est deux marqueurs superposés et deux
   * cartes qui se disputent le même coin de l'écran.
   */
  knownRanges: KnownRange[];
  /**
   * La passation automatique à l'épisode suivant est-elle suspendue par
   * l'ouverture de ce panneau ? Sert uniquement à le dire à l'utilisateur : la
   * suspension elle-même est appliquée par le lecteur.
   */
  autoNextSuspended: boolean;
  adoptionScore: number;
  /** `false` quand la session n'est pas connectée. */
  canContribute: boolean;
  /** Contenu en cours, pour les liens vers les bases externes. */
  mediaType: 'tv' | 'movie';
  season: number | null;
  episode: number | null;
  /** Identifiants résolus par le serveur, pour tomber sur la bonne fiche. */
  imdbId: string | null;
  malId: number | null;
  /**
   * Conteneur du lecteur : borne le déplacement du panneau, qui ne doit jamais
   * pouvoir sortir de la vidéo.
   */
  constraintsRef?: React.RefObject<HTMLElement>;
  onSeek: (seconds: number) => void;
  onSubmit: (input: { segmentType: SegmentKind; startMs: number; endMs: number }) => Promise<void>;
  onDelete: (submissionId: string) => Promise<void>;
  onClose: () => void;
}

const SEGMENT_LABEL_KEY: Record<SegmentKind, string> = {
  intro: 'watch.segmentIntro',
  recap: 'watch.segmentRecap',
  outro: 'watch.segmentOutro',
  credits: 'watch.segmentCredits',
  preview: 'watch.segmentPreview',
};

/** Paliers de réglage fin, du plus grossier au plus précis. */
const NUDGES = [-1000, -100, -10, -1, 1, 10, 100, 1000] as const;

/**
 * Au-delà, le relevé décrit la même séquence qu'une autre, sous un autre nom :
 * le dépôt est refusé. En dessous, c'est un simple débordement — on le signale
 * sans bloquer, parce qu'un générique qui commence pendant l'outro existe.
 *
 * Même seuil que `OVERLAP_MERGE_RATIO` dans `utils/segmentConsensus.ts`, qui
 * décide de la même chose côté lecture.
 */
const OVERLAP_BLOCK_RATIO = 0.6;

/** `h:mm:ss.mmm` — les millisecondes sont toujours visibles, c'est le sujet. */
function formatMs(totalMs: number): string {
  const clamped = Math.max(0, Math.round(totalMs));
  const ms = clamped % 1000;
  const totalSeconds = Math.floor(clamped / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${hours > 0 ? `${hours}:` : ''}${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
}

/** Accepte `mm:ss.mmm`, `h:mm:ss.mmm` ou un nombre de millisecondes brut. */
function parseTimeInput(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);

  const match = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const ms = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  return ((Number(hours || 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + ms;
}

/** Champ d'une borne : valeur, saisie libre, prise de position et réglage fin. */
const BoundField: React.FC<{
  label: string;
  valueMs: number;
  maxMs: number;
  onChange: (ms: number) => void;
  onTake: () => void;
  onPreview: () => void;
  takeLabel: string;
  previewLabel: string;
}> = ({ label, valueMs, maxMs, onChange, onTake, onPreview, takeLabel, previewLabel }) => {
  const [draft, setDraft] = useState(() => formatMs(valueMs));
  const [editing, setEditing] = useState(false);

  // Tant que l'utilisateur tape, sa saisie fait foi ; sinon on suit la valeur.
  useEffect(() => {
    if (!editing) setDraft(formatMs(valueMs));
  }, [valueMs, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = parseTimeInput(draft);
    if (parsed === null) {
      setDraft(formatMs(valueMs));
      return;
    }
    onChange(Math.min(maxMs, Math.max(0, parsed)));
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-400">{label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPreview}
            title={previewLabel}
            aria-label={previewLabel}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Play size={13} />
          </button>
          <button
            type="button"
            onClick={onTake}
            className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-[11px] text-white transition-colors hover:bg-white/20"
          >
            <Target size={12} />
            {takeLabel}
          </button>
        </div>
      </div>

      <input
        type="text"
        value={draft}
        onChange={(event) => { setEditing(true); setDraft(event.target.value); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') { setEditing(false); setDraft(formatMs(valueMs)); }
        }}
        inputMode="numeric"
        className="mb-2 w-full rounded border border-white/10 bg-black/40 px-2 py-1.5 text-center font-mono text-base tabular-nums text-white focus:border-red-500/60 focus:outline-none"
      />

      {/* `flex-wrap` + largeur plancher : les huit paliers passent sur deux
          rangées quand le lecteur est trop étroit, plutôt que de se tasser
          jusqu'à devenir illisibles. */}
      <div className="flex flex-wrap gap-1">
        {NUDGES.map((delta) => (
          <button
            key={delta}
            type="button"
            onClick={() => onChange(Math.min(maxMs, Math.max(0, valueMs + delta)))}
            className="min-w-[2.5rem] flex-1 rounded bg-white/5 py-1 text-[10px] tabular-nums text-gray-300 transition-colors hover:bg-white/15 hover:text-white"
          >
            {delta > 0 ? '+' : '−'}
            {Math.abs(delta) >= 1000 ? `${Math.abs(delta) / 1000}s` : Math.abs(delta)}
          </button>
        ))}
      </div>
    </div>
  );
};

/** Motif du grisage d'une base externe, en clair sous le bouton. */
const BLOCK_REASON_KEY: Record<ContribBlockReason, string> = {
  media: 'watch.contribBlockedMedia',
  type: 'watch.contribBlockedType',
  id: 'watch.contribBlockedId',
};

const SegmentStudio: React.FC<SegmentStudioProps> = ({
  open,
  duration,
  currentTime,
  colors,
  submissions,
  knownRanges,
  autoNextSuspended,
  adoptionScore,
  canContribute,
  mediaType,
  season,
  episode,
  imdbId,
  malId,
  constraintsRef,
  onSeek,
  onSubmit,
  onDelete,
  onClose,
}) => {
  const { t } = useTranslation();
  const dragControls = useDragControls();
  const durationMs = Math.max(0, Math.round(duration * 1000));
  const currentMs = Math.max(0, Math.round(currentTime * 1000));

  const [segmentType, setSegmentType] = useState<SegmentKind>('intro');
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  /**
   * Les bornes affichées correspondent-elles à un relevé réel ?
   *
   * `false` juste après un changement de catégorie : les champs sont à zéro et
   * attendent qu'on pose le début et la fin. Sans ce drapeau, « 0:00.000 »
   * serait indiscernable d'un relevé qui commence vraiment à zéro.
   */
  const [boundsSet, setBoundsSet] = useState(false);
  /** Replace la lecture sur la borne modifiée, pour voir ce qu'on règle. */
  const [followEdits, setFollowEdits] = useState(true);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mine = useMemo(
    () => submissions.find((submission) => submission.isMine && submission.type === segmentType) ?? null,
    [submissions, segmentType],
  );

  /**
   * Ce qui a déjà été appliqué : distingue l'ouverture du panneau d'un simple
   * changement de catégorie. Les deux ne méritent pas le même traitement.
   */
  const appliedRef = useRef<{ opened: boolean; type: SegmentKind }>({ opened: false, type: segmentType });

  // Trois cas, dans cet ordre :
  //
  //  1. Une proposition à soi existe pour cette catégorie → on la recharge. On
  //     ne perd jamais ce qu'on a déjà déposé.
  //  2. Ouverture du panneau → on part de la position courante, c'est une
  //     avance gratuite sur le repérage.
  //  3. Changement de catégorie → on repart à vide. Les bornes du type
  //     précédent n'ont rien à voir avec celui-ci : les garder revenait à
  //     proposer le relevé de l'intro comme générique. Repartir de la position
  //     de lecture ne suffisait pas non plus — le réglage fin y a justement
  //     amené la vidéo, on retombait donc sur les valeurs qu'on croyait effacer.
  useEffect(() => {
    if (!open) {
      appliedRef.current.opened = false;
      return;
    }
    const opening = !appliedRef.current.opened;
    const typeChanged = appliedRef.current.type !== segmentType;
    appliedRef.current = { opened: true, type: segmentType };

    setStatus('idle');
    setErrorMessage(null);

    if (mine) {
      setStartMs(mine.startMs);
      setEndMs(mine.endMs);
      setBoundsSet(true);
      return;
    }
    if (opening) {
      setStartMs(currentMs);
      setEndMs(Math.min(durationMs, currentMs + 30_000));
      setBoundsSet(true);
      return;
    }
    if (typeChanged) {
      setStartMs(0);
      setEndMs(0);
      setBoundsSet(false);
    }
    // Ni `currentMs` ni `durationMs` en dépendances : le premier change quatre
    // fois par seconde et réinitialiserait les bornes en permanence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, segmentType, mine?.id]);

  const applyStart = useCallback((ms: number) => {
    const next = Math.min(ms, Math.max(0, durationMs));
    setStartMs(next);
    setEndMs((end) => (end <= next ? Math.min(durationMs, next + 1000) : end));
    setBoundsSet(true);
    if (followEdits) onSeek(next / 1000);
  }, [durationMs, followEdits, onSeek]);

  const applyEnd = useCallback((ms: number) => {
    const next = Math.max(ms, 0);
    setEndMs(next);
    setStartMs((start) => (start >= next ? Math.max(0, next - 1000) : start));
    setBoundsSet(true);
    if (followEdits) onSeek(next / 1000);
  }, [followEdits, onSeek]);

  const lengthMs = Math.max(0, endMs - startMs);

  /**
   * Séquence d'un AUTRE type que le relevé recouvre le plus.
   *
   * Le même type est ignoré volontairement : deux relevés d'intro qui se
   * recouvrent, c'est la situation normale que le vote départage. Ce qui n'a
   * pas de sens, c'est une intro et un générique actifs au même instant.
   */
  const conflict = useMemo(() => {
    if (lengthMs <= 0) return null;
    let worst: { range: KnownRange; overlapMs: number; ratio: number } | null = null;
    for (const range of knownRanges) {
      if (range.type === segmentType) continue;
      const overlapMs = Math.min(endMs, range.endMs) - Math.max(startMs, range.startMs);
      if (overlapMs <= 0) continue;
      const shortest = Math.min(lengthMs, Math.max(1, range.endMs - range.startMs));
      const ratio = overlapMs / shortest;
      if (!worst || overlapMs > worst.overlapMs) worst = { range, overlapMs, ratio };
    }
    return worst;
  }, [knownRanges, segmentType, startMs, endMs, lengthMs]);

  const overlapBlocked = conflict !== null && conflict.ratio >= OVERLAP_BLOCK_RATIO;
  /** Le relevé tient-il debout tout seul, indépendamment de ce qui l'entoure ? */
  const boundsInvalid = !boundsSet || lengthMs < 500 || endMs > durationMs + 1000;
  const invalid = boundsInvalid || overlapBlocked;

  const handleSubmit = async () => {
    if (invalid || !canContribute) return;
    setStatus('saving');
    setErrorMessage(null);
    try {
      await onSubmit({ segmentType, startMs, endMs });
      setStatus('saved');
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  // ==========================================================================
  // Contribuer chez les bases externes
  //
  // Movix ne réenvoie rien à leur place : chacune a ses règles et ses comptes,
  // et un relais serveur signerait toutes les contributions du même nom. On
  // copie le relevé et on ouvre leur site — c'est l'utilisateur qui dépose.
  // ==========================================================================
  const [copiedSite, setCopiedSite] = useState<string | null>(null);

  const contribContext = useMemo(
    () => ({ mediaType, imdbId, malId, segmentType }),
    [mediaType, imdbId, malId, segmentType],
  );

  const contribSites = useMemo(
    () => CONTRIB_SITES.map((site) => ({
      site,
      blocked: getContribBlockReason(site, contribContext),
      url: getContribUrl(site, contribContext),
    })),
    [contribContext],
  );

  // Le message « copié » ne doit pas survivre à un changement de bornes ou de
  // type : il porterait alors sur un relevé qui n'est plus celui affiché.
  useEffect(() => { setCopiedSite(null); }, [segmentType, startMs, endMs]);

  const openContribSite = useCallback(async (siteId: string, url: string) => {
    const payload = formatContribClipboard({
      segmentType, startMs, endMs, season, episode, imdbId, malId,
    });
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedSite(siteId);
    } catch {
      // Presse-papier refusé (contexte non sécurisé, permission) : ce n'est pas
      // une raison de ne pas ouvrir le site, les bornes restent lisibles ici.
      setCopiedSite(null);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [segmentType, startMs, endMs, season, episode, imdbId, malId]);

  if (!open) return null;

  return (
    <motion.div
      data-player-controls=""
      // L'ouverture joue sur l'opacité et l'échelle, jamais sur `y` : le
      // panneau se redessine à chaque image (`currentTime`), et un `animate`
      // portant sur `y` le ramènerait à sa place d'origine en plein
      // déplacement.
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      drag
      // Le déplacement ne part que de l'en-tête : ailleurs, il volerait le
      // glissement aux champs de saisie et aux boutons de réglage fin.
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={constraintsRef}
      dragMomentum={false}
      dragElastic={0}
      onClick={(event) => event.stopPropagation()}
      // Largeur en pourcentage du LECTEUR, pas du navigateur : `92vw` débordait
      // dès que le lecteur était plus étroit que la fenêtre (page de détail,
      // fenêtre large, lecteur en colonne).
      className="absolute inset-x-0 bottom-24 z-50 mx-auto max-h-[70%] w-[min(92%,30rem)] max-w-[calc(100%-1.5rem)] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-gray-950/95 p-3 shadow-2xl backdrop-blur-sm"
    >
      {/* Poignée de déplacement. Collante : elle reste attrapable une fois le
          contenu défilé. Les marges négatives compensent le `p-3` du panneau
          pour que le fond couvre toute la largeur en position collée. */}
      <div
        onPointerDown={(event) => dragControls.start(event)}
        className="sticky -top-3 z-10 -mx-3 -mt-3 mb-3 flex cursor-grab touch-none select-none items-start justify-between gap-3 rounded-t-xl bg-gray-950/95 px-3 pb-2 pt-3 active:cursor-grabbing"
      >
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 font-semibold text-white">
            <GripHorizontal size={15} className="shrink-0 text-gray-500" aria-hidden="true" />
            {t('watch.studioTitle')}
          </h3>
          <p className="text-xs leading-relaxed text-gray-400">{t('watch.studioDesc')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          // Le pointeur ne doit pas remonter à la poignée, sinon fermer le
          // panneau démarrerait un déplacement au moindre tremblement.
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={t('watch.dismiss')}
          className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:text-white"
        >
          <X size={16} />
        </button>
      </div>

      {/* Type de séquence */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {SEGMENT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={segmentType === kind}
            onClick={() => setSegmentType(kind)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              segmentType === kind
                ? 'border-white/40 bg-white/10 text-white'
                : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors[kind] }} />
            {t(SEGMENT_LABEL_KEY[kind])}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <BoundField
          label={t('watch.studioStart')}
          valueMs={startMs}
          maxMs={durationMs}
          onChange={applyStart}
          onTake={() => applyStart(currentMs)}
          onPreview={() => onSeek(startMs / 1000)}
          takeLabel={t('watch.studioTake')}
          previewLabel={t('watch.studioGoTo')}
        />
        <BoundField
          label={t('watch.studioEnd')}
          valueMs={endMs}
          maxMs={durationMs}
          onChange={applyEnd}
          onTake={() => applyEnd(currentMs)}
          onPreview={() => onSeek(endMs / 1000)}
          takeLabel={t('watch.studioTake')}
          previewLabel={t('watch.studioGoTo')}
        />
      </div>

      {/* Longueur relevée, en clair */}
      <div className="mt-2 flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
        <span className="text-xs text-gray-400">{t('watch.studioLength')}</span>
        <span className="font-mono text-sm tabular-nums text-white">
          {formatMs(lengthMs)}
          <span className="ml-1.5 text-xs text-gray-500">({lengthMs} ms)</span>
        </span>
      </div>

      {/* Situation de la séquence dans l'épisode, avec les autres séquences
          déjà connues en fond : le chevauchement se voit avant d'être expliqué. */}
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-white/10">
        {durationMs > 0 && knownRanges
          .filter((range) => range.type !== segmentType)
          .map((range) => (
            <div
              key={`${range.type}-${range.startMs}`}
              className="absolute inset-y-0 rounded-full opacity-40"
              style={{
                left: `${Math.min(100, (range.startMs / durationMs) * 100)}%`,
                width: `${Math.max(0.5, Math.min(100, ((range.endMs - range.startMs) / durationMs) * 100))}%`,
                backgroundColor: colors[range.type],
              }}
            />
          ))}
        {durationMs > 0 && boundsSet && (
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${Math.min(100, (startMs / durationMs) * 100)}%`,
              width: `${Math.max(0.5, Math.min(100, (lengthMs / durationMs) * 100))}%`,
              backgroundColor: colors[segmentType],
            }}
          />
        )}
      </div>

      {/* Chevauchement : refusé quand le relevé décrit la même séquence sous un
          autre nom, simplement signalé quand il ne fait que déborder. */}
      {conflict && (
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
            overlapBlocked ? 'bg-red-500/10 text-red-300' : 'bg-amber-500/10 text-amber-300'
          }`}
        >
          {t(overlapBlocked ? 'watch.studioOverlapBlocked' : 'watch.studioOverlapWarning', {
            name: t(SEGMENT_LABEL_KEY[conflict.range.type]),
            seconds: (conflict.overlapMs / 1000).toFixed(1),
          })}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-white">{t('watch.studioFollow')}</p>
          <p className="text-[11px] leading-relaxed text-gray-500">{t('watch.studioFollowDesc')}</p>
        </div>
        <Switch
          checked={followEdits}
          onCheckedChange={setFollowEdits}
          aria-label={t('watch.studioFollow')}
          size="sm"
        />
      </div>

      {/* Relever un générique demande d'aller au bout de l'épisode : autant dire
          tout de suite que la passation automatique attendra. */}
      {autoNextSuspended && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-[11px] leading-relaxed text-gray-400">
          <PauseCircle size={13} className="mt-px shrink-0 text-gray-500" aria-hidden="true" />
          {t('watch.studioAutoNextPaused')}
        </p>
      )}

      {/* État de la proposition existante */}
      {mine && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
          <span className="text-xs text-gray-300">
            {mine.adopted
              ? t('watch.studioMineAdopted', { score: mine.score })
              : t('watch.studioMinePending', { score: mine.score, needed: adoptionScore })}
          </span>
          <button
            type="button"
            onClick={() => onDelete(mine.id)}
            aria-label={t('watch.studioDelete')}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {!canContribute && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('watch.studioSignInRequired')}
        </p>
      )}

      {status === 'error' && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {errorMessage || t('watch.studioError')}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={invalid || !canContribute || status === 'saving'}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-gray-500"
      >
        {status === 'saving' && <Loader2 size={15} className="animate-spin" />}
        {status === 'saved' && <Check size={15} />}
        {status === 'saved'
          ? t('watch.studioSaved')
          : mine
            ? t('watch.studioUpdate')
            : t('watch.studioSubmit')}
      </button>

      <p className="mt-2 text-center text-[11px] leading-relaxed text-gray-500">
        {!boundsSet
          ? t('watch.studioBoundsUnset')
          : overlapBlocked
            ? t('watch.studioOverlapHint')
            : invalid
              ? t('watch.studioTooShort')
              : t('watch.studioAdoptionHint', { needed: adoptionScore })}
      </p>

      {/* Bases externes : on ouvre chez elles, on ne poste pas à leur place. */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-xs font-medium text-white">{t('watch.contribElsewhereTitle')}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
          {t('watch.contribElsewhereDesc')}
        </p>

        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          {contribSites.map(({ site, blocked, url }) => (
            <button
              key={site.id}
              type="button"
              disabled={blocked !== null || boundsInvalid}
              onClick={() => openContribSite(site.id, url)}
              title={blocked ? t(BLOCK_REASON_KEY[blocked], { site: site.label }) : url}
              className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-left text-xs text-gray-200 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:border-white/5 disabled:bg-transparent disabled:text-gray-600 disabled:hover:bg-transparent"
            >
              <span className="min-w-0 truncate">{site.label}</span>
              {copiedSite === site.id
                ? <Check size={13} className="shrink-0 text-green-400" />
                : <ExternalLink size={13} className="shrink-0 opacity-60" />}
            </button>
          ))}
        </div>

        <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-[11px] leading-relaxed text-gray-500">
          <Copy size={11} className="shrink-0" />
          {copiedSite ? t('watch.contribCopied') : t('watch.contribCopyHint')}
        </p>
      </div>
    </motion.div>
  );
};

export default memo(SegmentStudio);
