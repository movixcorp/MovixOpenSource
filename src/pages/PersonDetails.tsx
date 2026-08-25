import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import axios from 'axios';
import { motion } from 'framer-motion';
import { ExternalLink, Clock, Star } from 'lucide-react';
import { TMDB_API_KEY } from '../config/config';
import { useTranslation } from 'react-i18next';
import { getTmdbLanguage } from '../i18n';
import AgeRestrictedMedia from '../components/AgeRestrictedMedia';

interface Person {
  id: number;
  name: string;
  profile_path: string | null;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
  known_for_department: string;
}

interface Credit {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  character?: string;
  job?: string;
  media_type: 'movie' | 'tv';
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
}

const PersonDetails: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [person, setPerson] = useState<Person | null>(null);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const DEFAULT_IMAGE = 'data:image/svg+xml;utf8,<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23374151"/><g transform="translate(150,225)"><circle cx="0" cy="-50" r="40" fill="%236B7280"/><path d="M-60,20 Q-60,-10 -40,-20 Q-20,-25 0,-25 Q20,-25 40,-20 Q60,-10 60,20 L60,100 Q60,120 40,120 L-40,120 Q-60,120 -60,100 Z" fill="%236B7280"/></g><text x="50%" y="90%" fill="%239CA3AF" font-size="16" font-family="Arial, sans-serif" text-anchor="middle"></text></svg>';

  const DEFAULT_POSTER_IMAGE = 'data:image/svg+xml;utf8,<svg width="185" height="278" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 185 278" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23374151"/><g transform="translate(92.5,139)"><rect x="-30" y="-40" width="60" height="45" rx="5" fill="%236B7280"/><circle cx="-15" cy="-15" r="8" fill="%23374151"/><circle cx="15" cy="-15" r="8" fill="%23374151"/><path d="M-25,10 L25,10 L20,25 L-20,25 Z" fill="%236B7280"/></g><text x="50%" y="85%" fill="%239CA3AF" font-size="12" font-family="Arial, sans-serif" text-anchor="middle"></text></svg>';

  useEffect(() => {
    const fetchPersonData = async () => {
      setLoading(true);
      
      try {
        // Fetch person details
        const personResponse = await axios.get(`https://api.themoviedb.org/3/person/${id}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage()
          }
        });
        
        // Fetch combined credits
        const creditsResponse = await axios.get(`https://api.themoviedb.org/3/person/${id}/combined_credits`, {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage()
          }
        });
        
        setPerson(personResponse.data);
        
        // Sort credits by release date (most recent first)
        const sortedCredits = creditsResponse.data.cast.concat(creditsResponse.data.crew)
          .filter((credit: any) => credit.poster_path) // Filter out entries without posters
          .sort((a: any, b: any) => {
            const dateA = a.release_date || a.first_air_date || '';
            const dateB = b.release_date || b.first_air_date || '';
            return dateB.localeCompare(dateA);
          });
        
        setCredits(sortedCredits);
      } catch (err) {
        console.error('Error fetching person data:', err);
        setError(t('details.loadError'));
      } finally {
        setLoading(false);
      }
    };
    
    if (id) {
      fetchPersonData();
    }
  }, [id]);

  // Group credits by year
  const creditsByYear = credits.reduce<Record<string, Credit[]>>((acc, credit) => {
    const date = credit.release_date || credit.first_air_date || '';
    const year = date.slice(0, 4);
    
    if (!year) return acc;
    
    if (!acc[year]) {
      acc[year] = [];
    }
    
    acc[year].push(credit);
    return acc;
  }, {});

  const years = Object.keys(creditsByYear).sort((a, b) => b.localeCompare(a));
  
  const scrollLeft = () => {
    if (timelineRef.current) {
      timelineRef.current.scrollBy({ left: -300, behavior: 'smooth' });
    }
  };
  
  const scrollRight = () => {
    if (timelineRef.current) {
      timelineRef.current.scrollBy({ left: 300, behavior: 'smooth' });
    }
  };

  // Format date for display
  const formatDate = (dateString: string | null) => {
    if (!dateString) return t('common.unknown');
    
    try {
      const date = new Date(dateString);
      return new Intl.DateTimeFormat(i18n.language, {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).format(date);
    } catch {
      return dateString;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-purple-500"></div>
      </div>
    );
  }

  if (error || !person) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">{t('common.error')}</h2>
          <p>{error || t('details.personNotFound')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-20 pb-16 bg-black text-white min-h-screen">
      <div className="container mx-auto px-4 max-w-7xl">
        {/* Hero section */}
        <div className="flex flex-col md:flex-row gap-8 mb-12">
          {/* Profile image */}
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            className="w-full md:w-1/3 lg:w-1/4"
          >
            <div className="rounded-xl overflow-hidden shadow-2xl bg-gradient-to-br from-purple-900/50 to-blue-900/50 p-1">
              <img
                src={person.profile_path
                  ? `https://image.tmdb.org/t/p/w500${person.profile_path}`
                  : DEFAULT_IMAGE}
                alt={person.name}
                className="w-full h-auto rounded-lg object-cover"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  if (target.src !== DEFAULT_IMAGE) {
                    target.src = DEFAULT_IMAGE;
                  }
                }}
              />
            </div>
            <div className="mt-6 bg-gray-900/50 p-4 rounded-lg space-y-3">
              <div>
                <h3 className="text-gray-400 text-sm">{t('details.profession')}</h3>
                <p className="font-medium">{person.known_for_department}</p>
              </div>
              {person.birthday && (
                <div>
                  <h3 className="text-gray-400 text-sm">{t('details.birthday')}</h3>
                  <p className="font-medium">{formatDate(person.birthday)}</p>
                </div>
              )}
              {person.deathday && (
                <div>
                  <h3 className="text-gray-400 text-sm">{t('details.deathday')}</h3>
                  <p className="font-medium">{formatDate(person.deathday)}</p>
                </div>
              )}
              {person.place_of_birth && (
                <div>
                  <h3 className="text-gray-400 text-sm">{t('details.placeOfBirth')}</h3>
                  <p className="font-medium">{person.place_of_birth}</p>
                </div>
              )}
              <a 
                href={`https://www.themoviedb.org/person/${id}`} 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-yellow-400 hover:text-yellow-300 transition-colors mt-4"
              >
                <span>{t('details.viewOnTMDB')}</span>
                <ExternalLink size={16} />
              </a>
            </div>
          </motion.div>
          
          {/* Bio and details */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="w-full md:w-2/3 lg:w-3/4"
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-6">{person.name}</h1>
            
            <div className="mb-8">
              <h2 className="text-2xl font-bold mb-4">{t('details.biography')}</h2>
              {person.biography ? (
                <p className="text-gray-300 leading-relaxed">{person.biography}</p>
              ) : (
                <p className="text-gray-400 italic">{t('details.noBiography')}</p>
              )}
            </div>
          </motion.div>
        </div>
        
        {/* Filmography */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="mt-12"
        >
          <h2 className="text-3xl font-bold mb-6">{t('details.filmography')}</h2>
          
          {/* Magic Scroll Timeline */}
          <div className="relative">
            {/* Fixed timeline line - now confined to filmography section */}
            <div className="absolute left-1/2 top-0 bottom-0 w-1 bg-gradient-to-b from-purple-600 to-blue-600 z-0 transform -translate-x-1/2 opacity-75"></div>
            
            {/* Years and credits */}
            <div className="space-y-32 pb-32">
              {years.map((year, idx) => (
                <div key={year} className="relative">
                  {/* Year node */}
                  <motion.div 
                    initial={{ scale: 0, opacity: 0 }}
                    whileInView={{ scale: 1, opacity: 1 }}
                    viewport={{ once: false, margin: "-100px 0px -100px 0px" }}
                    transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                    className="sticky top-32 left-1/2 w-16 h-16 rounded-full bg-gradient-to-r from-purple-600 to-blue-600 flex items-center justify-center z-10 transform -translate-x-1/2 mb-16 shadow-lg shadow-purple-900/30"
                  >
                    <span className="text-white font-bold text-xl">{year}</span>
                  </motion.div>
                  
                  {/* Credits for this year */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
                    {creditsByYear[year].map((credit, creditIdx) => (
                      <AgeRestrictedMedia key={`${credit.id}-${credit.character || credit.job}`} item={credit}>
                      <motion.div
                        key={`${credit.id}-${credit.character || credit.job}`}
                        initial={{ opacity: 0, y: 50 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: false, margin: "-50px 0px" }}
                        transition={{ delay: creditIdx * 0.1, duration: 0.5 }}
                      >
                        <Link 
                          to={`/${credit.media_type}/${credit.id}`}
                          className="block"
                        >
                          <motion.div 
                            whileHover={{ 
                              scale: 1.03, 
                              boxShadow: "0px 10px 25px rgba(0, 0, 0, 0.3)"
                            }}
                            className="bg-gray-900/80 backdrop-blur-sm rounded-lg overflow-hidden flex h-32 transition-all border border-gray-800"
                          >
                            <div className="w-24 h-full flex-none">
                              <img
                                src={credit.poster_path
                                  ? `https://image.tmdb.org/t/p/w185${credit.poster_path}`
                                  : DEFAULT_POSTER_IMAGE}
                                alt={credit.title || credit.name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement;
                                  if (target.src !== DEFAULT_POSTER_IMAGE) {
                                    target.src = DEFAULT_POSTER_IMAGE;
                                  }
                                }}
                              />
                            </div>
                            <div className="p-3 flex flex-col justify-between flex-1">
                              <div>
                                <h3 className="font-bold text-sm md:text-base">
                                  {credit.title || credit.name}
                                </h3>
                                <p className="text-gray-400 text-xs md:text-sm mt-1">
                                  {credit.character 
                                    ? t('details.actorRole', { character: credit.character })
                                    : t('details.crewRole', { job: credit.job })}
                                </p>
                              </div>
                              <div className="flex items-center gap-3 mt-2">
                                <div className="flex items-center text-xs text-gray-400">
                                  <Clock size={12} className="mr-1" />
                                  <span>
                                    {credit.release_date
                                      ? new Date(credit.release_date).toLocaleDateString(i18n.language)
                                      : credit.first_air_date
                                        ? new Date(credit.first_air_date).toLocaleDateString(i18n.language)
                                        : t('details.unknownDate')}
                                  </span>
                                </div>
                                <div className="flex items-center text-xs text-yellow-400">
                                  <Star size={12} className="mr-1" />
                                  <span>{credit.vote_average.toFixed(1)}</span>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        </Link>
                      </motion.div>
                      </AgeRestrictedMedia>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default PersonDetails;
