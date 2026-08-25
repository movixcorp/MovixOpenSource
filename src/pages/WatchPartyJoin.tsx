import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion } from 'framer-motion';
import axios from 'axios';
import { ArrowLeft, Users, Play, Film, Tv, Hash, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { WATCHPARTY_API } from '../config/runtime';
import { storeRoomToken } from '../utils/watchparty';

const MAIN_API = WATCHPARTY_API;

const WatchPartyJoin: React.FC = () => {
  const { code } = useParams<{ code?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState(code || '');
  const [error, setError] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [roomInfo, setRoomInfo] = useState<{ title?: string; mediaType?: string } | null>(null);

  useEffect(() => {
    // Try to get saved nickname from localStorage
    const savedNickname = localStorage.getItem('watchPartyNickname');
    if (savedNickname) {
      setNickname(savedNickname);
    }

    // If we have a room code from the URL, try to get room info
    if (code) {
      fetchRoomInfo(code);
    }
  }, [code]);

  const fetchRoomInfo = async (roomCode: string) => {
    try {
      const response = await axios.get(`${MAIN_API}/api/watchparty/info/${roomCode}`);
      if (response.data.success) {
        setRoomInfo(response.data.room);
      }
    } catch (err) {
      console.error('Error fetching room info:', err);
      setError(t('watchParty.invalidOrExpired'));
    }
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    setRoomCode(value);

    // Clear any previous errors
    setError('');

    // If we have 6 characters, try to fetch room info
    if (value.length === 6) {
      fetchRoomInfo(value);
    } else {
      setRoomInfo(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (roomCode.length !== 6) {
      setError(t('watchParty.codeMustBe6'));
      return;
    }

    if (!nickname.trim()) {
      setError(t('watchParty.enterNickname'));
      return;
    }

    setIsJoining(true);

    try {
      // Save nickname for future use
      localStorage.setItem('watchPartyNickname', nickname);

      const response = await axios.post(`${MAIN_API}/api/watchparty/join`, {
        roomCode,
        nickname
      });

      if (response.data.success) {
        // Token d'accès délivré par le serveur : requis pour lire la room et
        // ouvrir la socket.
        storeRoomToken(response.data.roomId, response.data.token);
        navigate(`/watchparty/room/${response.data.roomId}`, {
          state: {
            isHost: false,
            nickname,
            roomCode,
            token: response.data.token
          }
        });
      } else {
        setError(response.data.message || t('watchParty.cannotJoin'));
      }
    } catch (err: any) {
      console.error('Error joining watch party:', err);
      setError(err.response?.data?.message || t('watchParty.errorOccurred'));
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Background gradient */}
      <div className="fixed inset-0 h-52 z-0 bg-gradient-to-t from-transparent to-black/50 pointer-events-none" />

      {/* Back link */}
      <div className="w-full absolute top-8 z-20">
        <div className="container px-6 md:px-10">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-white/70 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('watchParty.backToHome')}
          </Link>
        </div>
      </div>

      <div className="container px-4 py-20 mx-auto max-w-lg relative z-10 flex items-center justify-center min-h-[80vh]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white/5 border border-white/10 rounded-xl overflow-hidden backdrop-blur-sm w-full shadow-2xl"
        >
          <div className="p-8">
            <h1 className="text-2xl md:text-3xl font-bold mb-8 text-center flex items-center justify-center gap-3">
              <Users className="h-8 w-8 text-red-500" />
              {roomInfo ? t('watchParty.joinSession') : t('watchParty.joinParty')}
            </h1>

            {roomInfo && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="mb-8 p-4 bg-white/5 border border-white/10 rounded-lg"
              >
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-red-500/10 rounded-lg shrink-0 text-red-400">
                    {roomInfo.mediaType === 'movie' ? <Film size={24} /> : <Tv size={24} />}
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white mb-1">{roomInfo.title}</h2>
                    <Badge variant="default" className="border border-white/20 text-white/70 bg-white/5 hover:bg-white/10">
                      {roomInfo.mediaType === 'movie' ? t('watchParty.movieType') : t('watchParty.tvType')}
                    </Badge>
                  </div>
                </div>
              </motion.div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="roomCode" className="block text-sm font-medium mb-2 text-white/80 flex items-center gap-2">
                  <Hash className="h-4 w-4 text-red-500" /> {t('watchParty.watchPartyCode')}
                </label>
                <input
                  type="text"
                  id="roomCode"
                  value={roomCode}
                  onChange={handleCodeChange}
                  maxLength={6}
                  placeholder={t('watchParty.code')}
                  className="w-full px-4 py-4 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 tracking-[0.5em] uppercase font-mono text-center text-xl text-white placeholder-white/20 transition-all"
                  autoComplete="off"
                />
              </div>

              <div>
                <label htmlFor="nickname" className="block text-sm font-medium mb-2 text-white/80 flex items-center gap-2">
                  <User className="h-4 w-4 text-red-500" /> {t('watchParty.yourPseudo')}
                </label>
                <input
                  type="text"
                  id="nickname"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder={t('watchParty.enterPseudo')}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 text-white placeholder-white/30 transition-all"
                  maxLength={32}
                />
              </div>

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <Button
                type="submit"
                disabled={isJoining || !roomCode || !nickname}
                className={`
                  w-full h-12 text-base rounded-lg transition-all shadow-lg hover:shadow-red-600/20 hover:scale-[1.02]
                  ${isJoining || !roomCode || !nickname ? 'bg-white/10 text-white/50 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700 text-white border-0'}
                `}
              >
                {isJoining ? (
                  <>{t('watchParty.connectingLabel')}</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" /> {t('watchParty.joinLabel')}</>
                )}
              </Button>
            </form>

            <div className="mt-8 text-center pt-6 border-t border-white/10">
              <p className="text-sm text-white/40">
                {t('watchParty.noCodePrompt')}
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default WatchPartyJoin;
