import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Sparkles, Tags, Type } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { regionLabel, type AlternateTitle } from '../utils/tmdbMetadata';

/**
 * La fin de l'onglet Détails : thèmes, titres alternatifs, mots-clés.
 *
 * Les thèmes sont montrés d'emblée — ils disent de quoi l'œuvre parle, là où le
 * genre dit seulement à quel rayon elle appartient. Les titres alternatifs et
 * les mots-clés se comptent en dizaines : les dérouler d'office noierait
 * l'onglet, ils tiennent donc derrière un bouton qui annonce combien il y en a.
 * Une fois ouvert, tout est là — aucune troncature, c'est bien l'exhaustivité
 * qu'on vient chercher.
 *
 * L'habillage reprend celui des rubriques voisines de l'onglet (sociétés de
 * production, pays, langues) : même intertitre à icône, mêmes pastilles, mêmes
 * cartes. Rien ici ne doit se distinguer d'une rubrique d'origine.
 */

/** Pastille de la fiche, identique à celle des pays et des langues. */
const PILL = 'bg-gray-800 px-3 py-2 rounded-lg border border-gray-700 text-sm';

const PILL_HOVER = {
  backgroundColor: 'rgba(75,85,99, 0.8)',
  y: -2,
  borderColor: 'rgba(107,114,128, 0.8)',
  transition: { duration: 0.2 },
};

/**
 * Le décalage d'apparition est plafonné : la fiche voisine le calcule sur une
 * poignée de pays, alors qu'on peut avoir cinquante mots-clés — la dernière
 * pastille arriverait deux secondes et demie après la première.
 */
const stagger = (index: number): number => 0.1 + Math.min(index, 12) * 0.04;

interface DetailExtraMetadataProps {
  themes: string[];
  alternateTitles: AlternateTitle[];
  keywords: string[];
}

const DetailExtraMetadata: React.FC<DetailExtraMetadataProps> = ({
  themes,
  alternateTitles,
  keywords,
}) => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const locale = i18n.language || 'fr';

  const hiddenCount = alternateTitles.length + keywords.length;

  /**
   * Les titres regroupés par pays. TMDB en donne souvent plusieurs pour un même
   * pays — titre de travail, titre court, titre de ressortie — et les lister à
   * plat répéterait le pays une ligne sur deux.
   */
  const titlesByRegion = useMemo(() => {
    const groups = new Map<string, AlternateTitle[]>();
    for (const entry of alternateTitles) {
      const key = entry.region || '??';
      const list = groups.get(key);
      if (list) list.push(entry); else groups.set(key, [entry]);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === '??') return 1;
      if (b[0] === '??') return -1;
      return regionLabel(a[0], locale).localeCompare(regionLabel(b[0], locale), locale);
    });
  }, [alternateTitles, locale]);

  if (themes.length === 0 && hiddenCount === 0) return null;

  return (
    <>
      {themes.length > 0 && (
        <motion.div
          className="mb-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            {t('details.themesLabel')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {themes.map((theme, index) => (
              <motion.div
                key={theme}
                className={PILL}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: stagger(index) }}
                whileHover={PILL_HOVER}
              >
                {theme}
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}

      {hiddenCount > 0 && (
        <motion.div
          className="mb-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
        >
          <motion.button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className={`${PILL} flex items-center gap-2 text-gray-200`}
            whileHover={PILL_HOVER}
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            {t('details.showAllTitlesAndKeywords')}
            <span className="text-gray-400 tabular-nums">{hiddenCount}</span>
          </motion.button>

          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                {alternateTitles.length > 0 && (
                  <div className="mt-4">
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Type className="w-5 h-5" />
                      {t('details.alternateTitles')}
                      <span className="text-sm font-normal text-gray-400 tabular-nums">
                        {alternateTitles.length}
                      </span>
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {titlesByRegion.map(([region, entries], index) => (
                        <motion.div
                          key={region}
                          className="bg-gray-800 p-3 rounded-lg"
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: stagger(index) }}
                          whileHover={{
                            backgroundColor: 'rgba(75,85,99, 0.8)',
                            y: -3,
                            transition: { duration: 0.2 },
                          }}
                        >
                          <p className="text-sm text-gray-400 mb-1">
                            {region === '??' ? t('details.alternateTitleUnknownRegion') : regionLabel(region, locale)}
                          </p>
                          {entries.map((entry, entryIndex) => (
                            <p key={`${entry.title}-${entryIndex}`} className="font-medium">
                              {entry.title}
                              {entry.kind && (
                                <span className="ml-2 text-sm font-normal text-gray-400">({entry.kind})</span>
                              )}
                            </p>
                          ))}
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}

                {keywords.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Tags className="w-5 h-5" />
                      {t('details.keywordsLabel')}
                      <span className="text-sm font-normal text-gray-400 tabular-nums">
                        {keywords.length}
                      </span>
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {keywords.map((keyword, index) => (
                        <motion.div
                          key={keyword}
                          className={PILL}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: stagger(index) }}
                          whileHover={PILL_HOVER}
                        >
                          {keyword}
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </>
  );
};

export default DetailExtraMetadata;
