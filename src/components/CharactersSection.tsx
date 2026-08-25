import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { UserRound, Users } from 'lucide-react';

import type { DetailCharacter, DetailCharacters } from '../services/detailCharacters';

/**
 * La galerie de personnages d'une fiche.
 *
 * Le personnage passe devant l'interprète : c'est lui qu'on cherche à
 * reconnaître en ouvrant la fiche, alors que l'onglet Distribution range déjà
 * les choses dans l'autre sens. Les rôles principaux sont séparés des
 * secondaires quand la source les distingue — AniList le fait, le générique
 * TMDB non, et inventer une coupure tromperait.
 */

interface CharacterCardProps {
  character: DetailCharacter;
  performerLabel: string;
}

const CharacterCard: React.FC<CharacterCardProps> = ({ character, performerLabel }) => {
  const [failed, setFailed] = useState(false);

  // Une autre illustration mérite sa chance quand la carte est réutilisée.
  useEffect(() => { setFailed(false); }, [character.imageUrl]);

  const body = (
    <>
      {character.imageUrl && !failed ? (
        <img
          src={character.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-105"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center bg-gray-700" aria-hidden="true">
          <UserRound className="h-10 w-10 text-gray-500" />
        </span>
      )}

      {/* Le dégradé n'est pas décoratif : sans lui, un nom clair posé sur une
          illustration claire devient illisible. */}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-3 pt-8">
        <span className="block truncate text-sm font-semibold text-white" title={character.name}>
          {character.name}
        </span>
        {character.performer && (
          <span className="mt-0.5 block truncate text-xs text-gray-400" title={character.performer}>
            {performerLabel} · {character.performer}
          </span>
        )}
      </span>
    </>
  );

  // Même habillage que les cartes de l'onglet Détails : fond gris 800, bordure
  // gris 700, et le même éclaircissement au survol.
  const className = 'group relative block aspect-[2/3] overflow-hidden rounded-lg border border-gray-700 bg-gray-800 transition-colors hover:border-gray-500';

  return character.href
    ? <Link to={character.href} className={className}>{body}</Link>
    : <div className={className}>{body}</div>;
};

interface CharactersSectionProps {
  data: DetailCharacters | null;
  loading?: boolean;
}

const CharactersSection: React.FC<CharactersSectionProps> = ({ data, loading = false }) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div>
        <div className="mb-3 h-6 w-40 animate-pulse rounded bg-gray-800" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-gray-800" />
          ))}
        </div>
      </div>
    );
  }

  if (!data || data.total === 0) return null;

  const performerLabel = t(`details.characters.performer.${data.performerKind}`);

  return (
    <section>
      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
        <Users className="w-5 h-5" />
        {t('details.characters.title')}
        <span className="text-sm font-normal text-gray-400 tabular-nums">{data.total}</span>
      </h3>

      <div className="space-y-8">
        {data.groups.map((group, index) => (
          <div key={group.role ?? `group-${index}`}>
            {group.role && (
              <div className="mb-4 flex items-center gap-4">
                <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
                  {t(`details.characters.role.${group.role}`)}
                </h4>
                <div className="h-px flex-1 bg-gray-700" />
                <span className="shrink-0 text-[11px] text-gray-500 tabular-nums">
                  {t('details.characters.count', { count: group.characters.length })}
                </span>
              </div>
            )}

            {/* `auto-fill` plutôt qu'un nombre de colonnes figé : la section est
                posée tantôt sur toute la largeur, tantôt dans une colonne plus
                étroite, et un nombre fixe y écrasait les cartes jusqu'à tronquer
                les noms. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
              {group.characters.map((character) => (
                <CharacterCard
                  key={character.key}
                  character={character}
                  performerLabel={performerLabel}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default CharactersSection;
