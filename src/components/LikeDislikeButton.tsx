import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { useProfile } from '../context/ProfileContext';
import { useTurnstile } from '../context/TurnstileContext';
import Counter from './ui/counter';

const API_URL = import.meta.env.VITE_MAIN_API;

interface LikeDislikeButtonProps {
  contentType: 'movie' | 'tv' | 'shared-list';
  contentId: string;
  onStatsChange?: (stats: LikeDislikeStats) => void;
}

export interface LikeDislikeStats {
  likes: number;
  dislikes: number;
}

const MIN_MOVIX_RATING_VOTES = 50;

export const calculateLikeDislikeRating = ({ likes, dislikes }: LikeDislikeStats): number | null => {
  const totalVotes = likes + dislikes;
  if (likes < MIN_MOVIX_RATING_VOTES && dislikes < MIN_MOVIX_RATING_VOTES) {
    return null;
  }

  // Keep the score conservative: truncate to one decimal instead of rounding up.
  return Math.floor((likes * 100) / totalVotes) / 10;
};

// Helper function to calculate places array based on value
const getPlacesForValue = (value: number): number[] => {
  if (value === 0) return [1];
  const digits = Math.floor(Math.log10(Math.max(1, value))) + 1;
  const places: number[] = [];
  for (let i = digits - 1; i >= 0; i--) {
    places.push(Math.pow(10, i));
  }
  return places;
};

const LikeDislikeButton: React.FC<LikeDislikeButtonProps> = ({ contentType, contentId, onStatsChange }) => {
  const { currentProfile } = useProfile();
  const { isVerifying: verifying, resetToken: resetTurnstile, getValidToken } = useTurnstile();
  const [likes, setLikes] = useState(0);
  const [dislikes, setDislikes] = useState(0);
  const [userVote, setUserVote] = useState<'like' | 'dislike' | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [animatingLike, setAnimatingLike] = useState(false);
  const [animatingDislike, setAnimatingDislike] = useState(false);
  const previousLikes = useRef(0);
  const previousDislikes = useRef(0);
  const previousDisplayLikes = useRef(0);
  const previousDisplayDislikes = useRef(0);
  const animationStartLikes = useRef(0);
  const animationStartDislikes = useRef(0);
  const [displayLikes, setDisplayLikes] = useState(0);
  const [displayDislikes, setDisplayDislikes] = useState(0);

  // Fetch like/dislike stats
  useEffect(() => {
    const fetchLikes = async () => {
      try {
        const authToken = localStorage.getItem('auth_token');
        const profileId = currentProfile?.id;

        const params = profileId ? { profileId } : {};
        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};

        const response = await axios.get(
          `${API_URL}/api/likes/${contentType}/${contentId}`,
          { params, headers }
        );

        previousLikes.current = 0;
        previousDislikes.current = 0;
        const fetchedLikes = Number(response.data.likes) || 0;
        const fetchedDislikes = Number(response.data.dislikes) || 0;

        // Set likes/dislikes which will trigger animation from 0 to actual value
        setLikes(fetchedLikes);
        setDislikes(fetchedDislikes);
        onStatsChange?.({ likes: fetchedLikes, dislikes: fetchedDislikes });
        // Keep display at 0 - the useEffect will animate them up
        previousDisplayLikes.current = 0;
        previousDisplayDislikes.current = 0;
        animationStartLikes.current = 0;
        animationStartDislikes.current = 0;
        setUserVote(response.data.userVote);
      } catch (error) {
        console.error('Error fetching likes:', error);
      }
    };

    fetchLikes();
  }, [contentType, contentId, currentProfile, onStatsChange]);

  // Handle like/dislike
  const handleVote = async (voteType: 'like' | 'dislike') => {
    const authToken = localStorage.getItem('auth_token');
    const profileId = currentProfile?.id;

    if (!authToken || !profileId) {
      console.log('User must be authenticated and have a profile to vote');
      return;
    }

    if (verifying) {
      console.log('Turnstile verification in progress, please wait');
      return;
    }

    // Sauvegarder les valeurs actuelles pour pouvoir les restaurer en cas d'erreur
    const oldLikes = likes;
    const oldDislikes = dislikes;
    const oldUserVote = userVote;

    // Calculer les nouvelles valeurs immédiatement (optimistic update)
    let newLikes = likes;
    let newDislikes = dislikes;
    let newUserVote: 'like' | 'dislike' | null = userVote;

    if (userVote === voteType) {
      // Toggle off : retirer le vote
      if (voteType === 'like') {
        newLikes = Math.max(0, likes - 1);
      } else {
        newDislikes = Math.max(0, dislikes - 1);
      }
      newUserVote = null;
    } else if (userVote === null) {
      // Ajouter un nouveau vote
      if (voteType === 'like') {
        newLikes = likes + 1;
      } else {
        newDislikes = dislikes + 1;
      }
      newUserVote = voteType;
    } else {
      // Changer de vote (like -> dislike ou dislike -> like)
      if (voteType === 'like') {
        newLikes = likes + 1;
        newDislikes = Math.max(0, dislikes - 1);
      } else {
        newLikes = Math.max(0, likes - 1);
        newDislikes = dislikes + 1;
      }
      newUserVote = voteType;
    }

    // Mettre à jour immédiatement l'état local
    previousLikes.current = likes;
    previousDislikes.current = dislikes;
    setLikes(newLikes);
    setDislikes(newDislikes);
    setUserVote(newUserVote);
    onStatsChange?.({ likes: newLikes, dislikes: newDislikes });

    // Déclencher l'animation immédiatement
    if (voteType === 'like') {
      setAnimatingLike(true);
      setTimeout(() => setAnimatingLike(false), 600);
    } else {
      setAnimatingDislike(true);
      setTimeout(() => setAnimatingDislike(false), 600);
    }

    setIsLoading(true);

    // Faire l'appel API en arrière-plan
    try {
      const newVoteType = newUserVote;

      // Obtenir un token Turnstile frais (reset automatique si expiré)
      const freshToken = await getValidToken();
      if (!freshToken) {
        throw { response: { status: 403 } };
      }

      const response = await axios.post(
        `${API_URL}/api/likes`,
        {
          contentType,
          contentId,
          voteType: newVoteType,
          profileId,
          turnstileToken: freshToken
        },
        {
          headers: { Authorization: `Bearer ${authToken}` }
        }
      );

      // Synchroniser avec les valeurs du serveur (au cas où il y aurait une différence)
      const serverLikes = Number(response.data.likes) || 0;
      const serverDislikes = Number(response.data.dislikes) || 0;

      // Mettre à jour les valeurs avec celles du serveur
      // Si elles sont différentes des valeurs actuelles, les useEffect déclencheront automatiquement l'animation
      setLikes(serverLikes);
      setDislikes(serverDislikes);
      onStatsChange?.({ likes: serverLikes, dislikes: serverDislikes });

      setUserVote(response.data.userVote);

      // Reset Turnstile pour le prochain vote
      resetTurnstile();
    } catch (error: any) {
      console.error('Error voting:', error);
      // En cas d'erreur, restaurer les anciennes valeurs
      setLikes(oldLikes);
      setDislikes(oldDislikes);
      setUserVote(oldUserVote);
      previousLikes.current = oldLikes;
      previousDislikes.current = oldDislikes;
      onStatsChange?.({ likes: oldLikes, dislikes: oldDislikes });
      // Si 403 (token Turnstile expiré/invalide), reset pour en obtenir un nouveau
      if (error?.response?.status === 403) {
        resetTurnstile();
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Animate number with wheel effect
  useEffect(() => {
    const diff = likes - displayLikes;
    if (diff !== 0) {
      const duration = 200;
      // Limit steps for large numbers to keep animation smooth
      const maxSteps = 50;
      const steps = Math.min(Math.abs(diff) + 1, maxSteps);
      const stepDuration = duration / steps;
      const increment = Math.abs(diff) / steps;
      let current = displayLikes;
      const direction = diff > 0 ? 1 : -1;
      let step = 0;

      // Store initial value at start of animation
      animationStartLikes.current = displayLikes;
      previousDisplayLikes.current = displayLikes;

      const timer = setInterval(() => {
        step++;
        current = displayLikes + (direction * increment * step);
        const newValue = Math.round(current);
        setDisplayLikes(newValue);
        if (step >= steps) {
          setDisplayLikes(likes);
          previousDisplayLikes.current = likes;
          animationStartLikes.current = likes;
          clearInterval(timer);
        }
      }, stepDuration);

      return () => clearInterval(timer);
    }
  }, [likes]);

  useEffect(() => {
    const diff = dislikes - displayDislikes;
    if (diff !== 0) {
      const duration = 200;
      // Limit steps for large numbers to keep animation smooth
      const maxSteps = 50;
      const steps = Math.min(Math.abs(diff) + 1, maxSteps);
      const stepDuration = duration / steps;
      const increment = Math.abs(diff) / steps;
      let current = displayDislikes;
      const direction = diff > 0 ? 1 : -1;
      let step = 0;

      // Store initial value at start of animation
      animationStartDislikes.current = displayDislikes;
      previousDisplayDislikes.current = displayDislikes;

      const timer = setInterval(() => {
        step++;
        current = displayDislikes + (direction * increment * step);
        const newValue = Math.round(current);
        setDisplayDislikes(newValue);
        if (step >= steps) {
          setDisplayDislikes(dislikes);
          previousDisplayDislikes.current = dislikes;
          animationStartDislikes.current = dislikes;
          clearInterval(timer);
        }
      }, stepDuration);

      return () => clearInterval(timer);
    }
  }, [dislikes]);

  return (
    <div className="flex flex-col items-start gap-2">
      {verifying && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 text-gray-300 text-sm"
        >
          <svg className="animate-spin h-4 w-4 text-gray-300" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          On vérifie que vous n'êtes pas un robot...
        </motion.div>
      )}
      <div className="flex items-center gap-3">
      {/* Like Button */}
      <motion.button
        onClick={() => handleVote('like')}
        disabled={isLoading || verifying}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-300 ${userVote === 'like'
          ? 'bg-green-500/30 text-green-300 shadow-lg shadow-green-500/20'
          : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        animate={{
          scale: animatingLike ? [1, 1.2, 1] : 1,
          backgroundColor: userVote === 'like'
            ? 'rgba(34, 197, 94, 0.3)'
            : 'rgba(255, 255, 255, 0.1)',
        }}
        transition={{
          duration: 0.3,
          backgroundColor: { duration: 0.4 }
        }}
      >
        <motion.svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5"
          animate={{
            scale: animatingLike ? [1, 1.3, 1] : 1,
            rotate: animatingLike ? [0, -10, 10, 0] : 0,
          }}
          transition={{ duration: 0.4 }}
        >
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
        </motion.svg>
        <div className="relative overflow-hidden flex items-center justify-center" style={{ minWidth: '2ch' }}>
          <Counter
            value={displayLikes}
            fontSize={14}
            padding={0}
            places={getPlacesForValue(Math.max(displayLikes, 1))}
            gap={0}
            borderRadius={0}
            horizontalPadding={0}
            textColor="currentColor"
            fontWeight="500"
            gradientHeight={0}
          />
        </div>
      </motion.button>

      {/* Dislike Button */}
      <motion.button
        onClick={() => handleVote('dislike')}
        disabled={isLoading || verifying}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-300 ${userVote === 'dislike'
          ? 'bg-red-500/30 text-red-300 shadow-lg shadow-red-500/20'
          : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        animate={{
          scale: animatingDislike ? [1, 1.2, 1] : 1,
          backgroundColor: userVote === 'dislike'
            ? 'rgba(239, 68, 68, 0.3)'
            : 'rgba(255, 255, 255, 0.1)',
        }}
        transition={{
          duration: 0.3,
          backgroundColor: { duration: 0.4 }
        }}
      >
        <motion.svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5"
          animate={{
            scale: animatingDislike ? [1, 1.3, 1] : 1,
            rotate: animatingDislike ? [0, 10, -10, 0] : 0,
          }}
          transition={{ duration: 0.4 }}
        >
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z" />
        </motion.svg>
        <div className="relative overflow-hidden flex items-center justify-center" style={{ minWidth: '2ch' }}>
          <Counter
            value={displayDislikes}
            fontSize={14}
            padding={0}
            places={getPlacesForValue(Math.max(displayDislikes, 1))}
            gap={0}
            borderRadius={0}
            horizontalPadding={0}
            textColor="currentColor"
            fontWeight="500"
            gradientHeight={0}
          />
        </div>
      </motion.button>
      </div>
    </div>
  );
};

export default LikeDislikeButton;
