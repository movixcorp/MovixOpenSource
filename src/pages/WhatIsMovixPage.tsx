import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { ArrowLeft, Crown, Sparkles, Heart, Rocket, Globe, Tv, Film, Users, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import { Button } from '../components/ui/button';

// Sources supportées
const supportedSources = [
  { name: 'Wiflix', color: '#f97316' },
  { name: '1jour1film', color: '#eab308' },
  { name: 'SwiftFlow', color: '#818cf8' },
  { name: 'Coflix', color: '#3b82f6' },
  { name: 'Cpasmal', color: '#8b5cf6' },
  { name: 'Anime-Sama', color: '#ec4899' },
  { name: 'France.tv', color: '#14b8a6' },
  { name: 'Northlive', color: '#f59e0b' },
  { name: 'Vavoo', color: '#10b981' },
  { name: 'Frembed', color: '#6366f1' },
  { name: 'Darkiworld', color: '#22c55e' },
  { name: 'VoirDrama', color: '#a855f7' },
  { name: 'FStream', color: '#06b6d4' },
  { name: 'French-Stream', color: '#e11d48' },
  { name: 'Purstream', color: '#d946ef' },
];

// Timeline / Histoire de Movix
const historyItems = [
  {
    icon: <Sparkles className="w-5 h-5" />,
    titleKey: 'whatIsMovix.observation',
    descKey: 'whatIsMovix.observationDesc',
    color: '#f59e0b',
  },
  {
    icon: <Rocket className="w-5 h-5" />,
    titleKey: 'whatIsMovix.theIdea',
    descKey: 'whatIsMovix.theIdeaDesc',
    color: '#3b82f6',
  },
  {
    icon: <Heart className="w-5 h-5" />,
    titleKey: 'whatIsMovix.passionProject',
    descKey: 'whatIsMovix.passionProjectDesc',
    color: '#ec4899',
  },
  {
    icon: <Users className="w-5 h-5" />,
    titleKey: 'whatIsMovix.community',
    descKey: 'whatIsMovix.communityDesc',
    color: '#22c55e',
  },
  {
    icon: <Star className="w-5 h-5" />,
    titleKey: 'whatIsMovix.alwaysFurther',
    descKey: 'whatIsMovix.alwaysFurtherDesc',
    color: '#a855f7',
  },
];

const WhatIsMovixPage: React.FC = () => {
  const { t } = useTranslation();
  // Masquer le footer
  useEffect(() => undefined, []);

  useEffect(() => undefined, []);

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.1 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(220, 38, 38, 0.10)" className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10 h-full overflow-y-auto">
        {/* Back Button */}
        <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('whatIsMovix.backToHome')}
        </Link>

        {/* Hero Section */}
        <div className="max-w-4xl mx-auto text-center mb-16">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-6 relative"
          >
            {/* Logo Movix - tilted left like the mammoth image */}
            <motion.div
              initial={{ opacity: 0, rotate: -15, scale: 0.7 }}
              animate={{ opacity: 1, rotate: -8, scale: 1 }}
              transition={{ type: 'spring', stiffness: 120, damping: 14, delay: 0.1 }}
              className="flex justify-center mb-8"
            >
              <img
                src="/movix.png"
                alt="Movix Logo"
                className="w-28 h-28 sm:w-36 sm:h-36 md:w-44 md:h-44 drop-shadow-[0_0_40px_rgba(220,38,38,0.35)]"
                style={{ transform: 'rotate(-8deg)' }}
              />
            </motion.div>

            <h1 className="text-4xl md:text-6xl font-black tracking-tight mb-4 pb-4">
              <span className="block py-2 leading-tight">
                <ShinyText text={t('whatIsMovix.title').split('Movix')[0]} speed={3} color="#ffffff" shineColor="#dc2626" className="inline" />
                <ShinyText text="Movix" speed={2} color="#dc2626" shineColor="#ffffff" className="inline" />
                <ShinyText text={t('whatIsMovix.title').includes('?') ? ' ?' : ''} speed={3} color="#ffffff" shineColor="#dc2626" className="inline" />
              </span>
            </h1>
          </motion.div>

          {/* Main pitch */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="max-w-3xl mx-auto mb-8"
          >
            <p className="text-lg sm:text-xl text-white/70 leading-relaxed">
              {t('whatIsMovix.accessTo')}
            </p>
          </motion.div>

          {/* Source badges - like the AI chips in the image */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            className="flex flex-wrap justify-center gap-2.5 sm:gap-3 max-w-3xl mx-auto mb-6"
          >
            {supportedSources.map((source, index) => (
              <motion.div
                key={source.name}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 + index * 0.04 }}
                whileHover={{ scale: 1.08, y: -2 }}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm hover:border-white/25 transition-colors cursor-default"
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: source.color }}
                />
                <span className="text-sm font-medium text-white/90">{source.name}</span>
              </motion.div>
            ))}
          </motion.div>

          {/* Tagline */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9 }}
            className="mb-10"
          >
            <p className="text-xl sm:text-2xl text-white/50 font-light">
              {t('whatIsMovix.inOnePlace')} <span className="text-white font-semibold">{t('whatIsMovix.forFree')}</span>.
            </p>
          </motion.div>

          {/* CTA - Get Started */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.1 }}
          >
            <Link to="/">
              <Button className="bg-red-600 hover:bg-red-700 text-white px-10 h-13 text-lg font-semibold gap-2 rounded-full shadow-lg shadow-red-600/25">
                <Tv className="w-5 h-5" />
                {t('whatIsMovix.startWatching')}
              </Button>
            </Link>
          </motion.div>
        </div>

        {/* VIP Discover Banner */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto mb-20"
        >
          <Link to="/vip" className="block group">
            <AnimatedBorderCard
              highlightColor="234 179 8"
              backgroundColor="12 12 12"
              className="p-5 sm:p-6 text-center hover:scale-[1.01] transition-transform duration-300"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center justify-center gap-3">
                  <Crown className="w-6 h-6 text-yellow-500 group-hover:scale-110 transition-transform" />
                  <div>
                    <p className="text-white/50 text-sm">{t('whatIsMovix.wantMore')}</p>
                    <p className="text-yellow-400 font-semibold text-base sm:text-lg group-hover:text-yellow-300 transition-colors">
                      {t('whatIsMovix.discoverVip')}
                    </p>
                  </div>
                  <Crown className="w-6 h-6 text-yellow-500 group-hover:scale-110 transition-transform" />
                </div>
                <p className="text-white/40 text-xs sm:text-sm text-center max-w-md leading-relaxed">
                  {t('whatIsMovix.vipKeepsSiteAlive')}
                </p>
              </div>
            </AnimatedBorderCard>
          </Link>
        </motion.div>

        {/* Histoire de Movix */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-50px' }}
          className="max-w-4xl mx-auto mb-20"
        >
          <motion.div variants={itemVariants} className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">{t('whatIsMovix.historyTitle')}</h2>
            <p className="text-white/50 max-w-2xl mx-auto">
              {t('whatIsMovix.historyDesc')}
            </p>
          </motion.div>

          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-6 sm:left-8 top-0 bottom-0 w-px bg-gradient-to-b from-red-500/50 via-white/10 to-transparent" />

            <div className="space-y-8">
              {historyItems.map((item) => (
                <motion.div
                  key={item.titleKey}
                  variants={itemVariants}
                  className="relative pl-16 sm:pl-20"
                >
                  {/* Timeline dot */}
                  <div
                    className="absolute left-6 sm:left-8 top-6 w-5 h-5 -translate-x-1/2 rounded-full border-2 flex items-center justify-center"
                    style={{
                      borderColor: item.color,
                      backgroundColor: `${item.color}20`,
                    }}
                  >
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                  </div>

                  <AnimatedBorderCard
                    highlightColor={hexToRgb(item.color)}
                    backgroundColor="12 12 12"
                    className="p-5 sm:p-6"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="p-2 rounded-lg flex-shrink-0"
                        style={{ backgroundColor: `${item.color}15`, color: item.color }}
                      >
                        {item.icon}
                      </div>
                      <div>
                        <h3 className="text-white font-semibold text-lg mb-1">{t(item.titleKey)}</h3>
                        <p className="text-white/50 text-sm leading-relaxed">{t(item.descKey)}</p>
                      </div>
                    </div>
                  </AnimatedBorderCard>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Features summary */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-50px' }}
          className="max-w-5xl mx-auto mb-20"
        >
          <motion.div variants={itemVariants} className="text-center mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">{t('whatIsMovix.allYouNeed')}</h2>
            <p className="text-white/50 max-w-xl mx-auto">
              {t('whatIsMovix.allYouNeedDesc')}
            </p>
          </motion.div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: <Globe className="w-6 h-6" />, title: t('whatIsMovix.multiSources'), desc: t('whatIsMovix.multiSourcesDesc'), color: '#3b82f6' },
              { icon: <Film className="w-6 h-6" />, title: t('whatIsMovix.hugeCatalog'), desc: t('whatIsMovix.hugeCatalogDesc'), color: '#f97316' },
              { icon: <Tv className="w-6 h-6" />, title: t('whatIsMovix.directTV'), desc: t('whatIsMovix.directTVDesc'), color: '#14b8a6' },
              { icon: <Users className="w-6 h-6" />, title: t('whatIsMovix.watchPartyFeature'), desc: t('whatIsMovix.watchPartyFeatureDesc'), color: '#ec4899' },
              { icon: <Star className="w-6 h-6" />, title: t('whatIsMovix.sharedLists'), desc: t('whatIsMovix.sharedListsDesc'), color: '#f59e0b' },
              { icon: <Sparkles className="w-6 h-6" />, title: t('whatIsMovix.modernUI'), desc: t('whatIsMovix.modernUIDesc'), color: '#a855f7' },
            ].map((feature) => (
              <motion.div key={feature.title} variants={itemVariants}>
                <AnimatedBorderCard
                  highlightColor={hexToRgb(feature.color)}
                  backgroundColor="12 12 12"
                  className="p-5 h-full"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="p-2 rounded-lg flex-shrink-0"
                      style={{ backgroundColor: `${feature.color}15`, color: feature.color }}
                    >
                      {feature.icon}
                    </div>
                    <div>
                      <h4 className="text-white font-semibold mb-1">{feature.title}</h4>
                      <p className="text-white/45 text-sm leading-relaxed">{feature.desc}</p>
                    </div>
                  </div>
                </AnimatedBorderCard>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Bottom CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto text-center pb-12"
        >
          <AnimatedBorderCard
            highlightColor="220 38 38"
            backgroundColor="10 10 10"
            className="p-8 backdrop-blur-sm"
          >
            <img
              src="/movix.png"
              alt="Movix Logo"
              className="w-12 h-12 mx-auto mb-4 drop-shadow-lg"
            />
            <h3 className="text-xl font-bold text-white mb-2">{t('whatIsMovix.readyToTry')}</h3>
            <p className="text-white/50 text-sm mb-6 max-w-md mx-auto">
              {t('whatIsMovix.readyToTryDesc')}
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link to="/">
                <Button className="bg-red-600 hover:bg-red-700 text-white px-6 h-11 gap-2">
                  <Tv className="w-4 h-4" />
                  {t('whatIsMovix.exploreMovix')}
                </Button>
              </Link>
              <Link to="/vip">
                <Button variant="secondary" className="px-6 h-11 gap-2 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10">
                  <Crown className="w-4 h-4" />
                  {t('whatIsMovix.becomeVip')}
                </Button>
              </Link>
              <Link to="/">
                <Button variant="ghost" className="border border-white/20 hover:border-white/40 text-white h-11 px-5 gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  {t('whatIsMovix.returnBtn')}
                </Button>
              </Link>
            </div>
          </AnimatedBorderCard>
        </motion.div>
      </div>
    </SquareBackground>
  );
};

// Helper: convert hex color to RGB string for AnimatedBorderCard
function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '220 38 38';
  return `${parseInt(result[1], 16)} ${parseInt(result[2], 16)} ${parseInt(result[3], 16)}`;
}

export default WhatIsMovixPage;
