import React, { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';

const TMDB_IMAGE = 'https://image.tmdb.org/t/p';

interface CalendarPosterProps {
  /** Chemin TMDB (`/abc.jpg`). Absent quand la source n'en fournit pas. */
  path?: string | null;
  /** Taille imposée par l'appelant — la vignette n'a pas d'avis là-dessus. */
  className?: string;
}

/**
 * Affiche d'un événement du calendrier.
 *
 * Trois choses qu'un `<img>` posé à la main ne faisait pas :
 *
 *  - la définition suit l'écran. `w92` servait une image de 92 pixels dans une
 *    vignette de 40 : net sur un écran ordinaire, flou sur tout écran dense.
 *    `srcSet` laisse le navigateur choisir.
 *  - une affiche introuvable — chemin périmé, image retirée de TMDB — ne
 *    laisse plus l'icône de lien cassé du navigateur, mais le même cadre neutre
 *    que les événements sans affiche.
 *  - le cadre neutre a exactement la taille de l'affiche, donc rien ne saute
 *    quand une image arrive ou manque.
 */
const CalendarPoster: React.FC<CalendarPosterProps> = ({ path, className = '' }) => {
  const [failed, setFailed] = useState(false);

  // Une autre affiche mérite sa chance : le composant est réutilisé d'un
  // événement à l'autre au fil du défilement, et un échec ne doit pas
  // condamner le suivant.
  useEffect(() => { setFailed(false); }, [path]);

  if (!path || failed) {
    return (
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-md bg-white/[0.06] ${className}`}
      >
        <CalendarDays className="h-4 w-4 text-white/25" />
      </span>
    );
  }

  return (
    <img
      src={`${TMDB_IMAGE}/w154${path}`}
      srcSet={`${TMDB_IMAGE}/w154${path} 1x, ${TMDB_IMAGE}/w342${path} 2x`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md bg-white/[0.06] object-cover ${className}`}
    />
  );
};

export default CalendarPoster;
