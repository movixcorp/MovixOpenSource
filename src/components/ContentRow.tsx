import React from 'react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import ContentRowSkeleton from './skeletons/ContentRowSkeleton';
import { encodeId } from '../utils/idEncoder';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';

interface Media {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  media_type: 'movie' | 'tv';
}

interface ContentRowProps {
  title: string;
  items: Media[];
  mediaType: string;
  onLoadMore: (direction: 'left' | 'right') => void;
  isLoading?: boolean;
}

export const ContentRow: React.FC<ContentRowProps> = ({ title, items, mediaType: _mediaType, onLoadMore, isLoading }) => {
  const { items: allowedItems } = useAgeRestrictedContent(items);
  if (isLoading) {
    return <ContentRowSkeleton />;
  }

  // Filter out items without poster
  const validItems = allowedItems.filter(item => item && (item.poster_path || item.backdrop_path));

  if (validItems.length === 0) {
    return null;
  }

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-bold mb-4">{title}</h2>
      <div className="relative">
        <button 
          className="absolute left-0 top-0 bottom-0 z-10 hidden md:flex items-center justify-center w-16 
          bg-gradient-to-r from-black/50 to-transparent hover:from-black/80 transition-all duration-300 group"
          onClick={() => onLoadMore('left')}
        >
          <ChevronLeft className="w-8 h-8 text-white transform transition-transform duration-300 group-hover:-translate-x-1" />
        </button>

        <div className="flex overflow-x-auto scrollbar-hide space-x-4">
          {validItems.map((item, index) => (
            <Link 
              key={item.id}
              to={`/${item.media_type}/${encodeId(item.id)}`}
              className={`flex-none w-[150px] hover:scale-105 transition-transform duration-300 ${index === 9 ? "ml-7" : ""}`}
            >
              {item.poster_path ? (
                <motion.img
                  src={`https://image.tmdb.org/t/p/w300${item.poster_path}`}
                  alt={item.title || item.name || 'Movie poster'}
                  className="w-full h-[225px] object-cover rounded-lg"
                  loading="lazy"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.onerror = null;
                    target.src = item.backdrop_path 
                      ? `https://image.tmdb.org/t/p/w300${item.backdrop_path}` 
                      : 'https://via.placeholder.com/150x225/1f1f1f/ffffff?text=No+Image';
                  }}
                />
              ) : (
                <div className="w-full h-[225px] flex items-center justify-center bg-gray-800 rounded-lg">
                  <ImageOff className="w-8 h-8 text-gray-500" />
                  <span className="sr-only">{item.title || item.name || 'No image available'}</span>
                </div>
              )}
            </Link>
          ))}
        </div>
        
        <button 
          className="absolute right-0 top-0 bottom-0 z-10 hidden md:flex items-center justify-center w-16 
          bg-gradient-to-l from-black/50 to-transparent hover:from-black/80 transition-all duration-300 group"
          onClick={() => onLoadMore('right')}
        >
          <ChevronRight className="w-8 h-8 text-white transform transition-transform duration-300 group-hover:translate-x-1" />
        </button>
      </div>
    </div>
  );
};
