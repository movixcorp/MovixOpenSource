import React from 'react';
import { motion } from 'framer-motion';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import {
  ArrowLeft,
  Smartphone,
  Download,
  Apple,
  FlaskConical,
  Github,
  ShieldCheck,
  Zap,
  Wifi,
  CheckCircle,
  Puzzle,
  Plus,
  Minus,
} from 'lucide-react';
import { SquareBackground } from '../components/ui/square-background';
import BlurText from '../components/ui/blur-text';
import ShinyText from '../components/ui/shiny-text';
import AnimatedBorderCard from '../components/ui/animated-border-card';

const APK_URL = 'https://github.com/movixcorp/MovixOpenSource/raw/refs/heads/main/app/movix-android.apk';
const IOS_GITHUB_URL = 'https://github.com/movixcorp/MovixOpenSource/tree/main/app';

const features = [
  {
    icon: <Zap className="w-6 h-6" />,
    title: 'Rapide & fluide',
    desc: 'Une expérience native optimisée pour Android, bien plus fluide que le navigateur.',
    color: '#f59e0b',
  },
  {
    icon: <Wifi className="w-6 h-6" />,
    title: 'Toujours connecté',
    desc: 'Accédez à vos films, séries et animés en un clic depuis votre écran d\'accueil.',
    color: '#3b82f6',
  },
  {
    icon: <ShieldCheck className="w-6 h-6" />,
    title: '100% gratuit',
    desc: 'Pas d\'abonnement, pas de pub intrusive, pas de compte obligatoire.',
    color: '#22c55e',
  },
  {
    icon: <Smartphone className="w-6 h-6" />,
    title: 'Optimisé mobile',
    desc: 'Interface pensée pour le tactile, lecture vidéo adaptée à votre appareil.',
    color: '#a855f7',
  },
];

const androidSteps = [
  {
    step: 1,
    title: 'Téléchargez le fichier APK',
    desc: 'Cliquez sur le bouton de téléchargement ci-dessous pour récupérer movix-android.apk.',
  },
  {
    step: 2,
    title: 'Autorisez l\'installation',
    desc: 'Dans les paramètres Android, autorisez l\'installation depuis des sources inconnues pour votre navigateur.',
  },
  {
    step: 3,
    title: 'Ouvrez le fichier téléchargé',
    desc: 'Depuis vos téléchargements ou la notification, appuyez sur l\'APK pour lancer l\'installation.',
  },
  {
    step: 4,
    title: 'Profitez de Movix',
    desc: 'L\'icône Movix apparaît sur votre écran d\'accueil, prête à être utilisée.',
  },
];

const AppDownloadPage: React.FC = () => {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.1 } },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <SquareBackground
      squareSize={48}
      borderColor="rgba(99, 102, 241, 0.12)"
      className="min-h-screen bg-black text-white"
    >
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10 h-full overflow-y-auto">
        <Link
          to="/"
          className="inline-flex items-center text-white opacity-50 hover:opacity-100 transition-opacity mb-8"
        >
          <ArrowLeft className="w-5 h-5 mr-2" />
          Retour à l'accueil
        </Link>

        <div className="max-w-4xl mx-auto text-center mb-16">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-6 relative"
          >
            <div className="inline-flex items-center justify-center p-3 bg-indigo-500/10 rounded-full mb-4 ring-1 ring-indigo-500/50">
              <Smartphone className="w-8 h-8 text-indigo-500" />
            </div>
            <h1 className="flex flex-col gap-2 text-4xl md:text-6xl font-black tracking-tight mb-4 pb-4">
              <ShinyText
                text="Movix dans votre poche"
                speed={3}
                color="#ffffff"
                shineColor="#6366f1"
                className="block py-2 leading-tight"
              />
              <ShinyText
                text="L'application officielle"
                speed={2}
                color="#6366f1"
                shineColor="#ffffff"
                className="block py-2 leading-tight"
              />
            </h1>
            <BlurText
              text="Téléchargez l'application Movix et profitez de tous vos contenus préférés directement depuis votre smartphone."
              delay={150}
              className="text-lg text-white/60 max-w-2xl mx-auto justify-center"
            />
          </motion.div>
        </div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-50px' }}
          className="max-w-5xl mx-auto mb-20 grid md:grid-cols-2 gap-6"
        >
          <motion.div variants={itemVariants}>
            <AnimatedBorderCard
              highlightColor="34 197 94"
              backgroundColor="10 10 10"
              className="p-6 sm:p-8 h-full flex flex-col"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2.5 rounded-xl bg-green-500/10 ring-1 ring-green-500/30">
                  <Smartphone className="w-6 h-6 text-green-400" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                    Android
                  </p>
                  <h2 className="text-xl font-bold text-white">Disponible maintenant</h2>
                </div>
              </div>
              <p className="text-white/55 text-sm leading-relaxed mb-6">
                Installez Movix sur votre appareil Android en téléchargeant directement
                le fichier APK officiel. Rapide, léger et sans compte obligatoire.
              </p>
              <div className="flex flex-wrap gap-2 mb-6">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
                  <Puzzle className="w-3.5 h-3.5" />
                  Extension intégrée
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Gratuit
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Android 7+
                </span>
              </div>
              <a
                href={APK_URL}
                download="movix-android.apk"
                className="mt-auto inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-green-600 text-white shadow-lg shadow-green-500/20 hover:bg-green-700 px-6 text-sm sm:text-base font-semibold transition-all duration-200 active:scale-95"
              >
                <Download className="w-5 h-5 flex-shrink-0" />
                Télécharger l'APK Android
              </a>
            </AnimatedBorderCard>
          </motion.div>

          <motion.div variants={itemVariants}>
            <AnimatedBorderCard
              highlightColor="59 130 246"
              backgroundColor="10 10 10"
              className="p-6 sm:p-8 h-full flex flex-col"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2.5 rounded-xl bg-blue-500/10 ring-1 ring-blue-500/30">
                  <Apple className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                    iOS
                  </p>
                  <h2 className="text-xl font-bold text-white">Déjà disponible, en test</h2>
                </div>
              </div>
              <p className="text-white/55 text-sm leading-relaxed mb-6">
                L'application iOS est déjà disponible en version de test, et tout le
                monde peut l'essayer dès maintenant : récupère l'IPA sur GitHub,
                signe-la avec l'outil de ton choix (AltStore, Sideloadly, ESign…)
                puis installe-la sur ton iPhone ou iPad.
              </p>
              <div className="flex flex-wrap gap-2 mb-6">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/30">
                  <FlaskConical className="w-3.5 h-3.5" />
                  Version de test
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-white/5 text-white/60 border border-white/10">
                  iPhone & iPad
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-white/5 text-white/60 border border-white/10">
                  Signature IPA requise
                </span>
              </div>
              <a
                href={IOS_GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-auto inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 text-white shadow-lg shadow-blue-500/20 hover:bg-blue-700 px-6 text-sm sm:text-base font-semibold transition-all duration-200 active:scale-95"
              >
                <Github className="w-5 h-5 flex-shrink-0" />
                Récupérer l'IPA sur GitHub
              </a>
            </AnimatedBorderCard>
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          className="max-w-5xl mx-auto mb-20"
        >
          <AnimatedBorderCard
            highlightColor="99 102 241"
            backgroundColor="10 10 10"
            className="p-6 sm:p-8 backdrop-blur-sm"
          >
            <div className="flex flex-col md:flex-row items-center gap-6 md:gap-8">
              <div className="flex-shrink-0">
                <div className="relative">
                  <div className="absolute inset-0 bg-indigo-500/20 blur-2xl rounded-full" />
                  <div className="relative p-4 rounded-2xl bg-indigo-500/10 ring-1 ring-indigo-500/40">
                    <Puzzle className="w-10 h-10 text-indigo-400" />
                  </div>
                </div>
              </div>
              <div className="flex-1 text-center md:text-left">
                <h3 className="text-xl sm:text-2xl font-bold text-white mb-2">
                  L'extension Movix est intégrée dans l'application
                </h3>
                <p className="text-white/55 text-sm sm:text-base leading-relaxed">
                  Pas besoin d'installer quoi que ce soit en plus : l'extension est
                  embarquée nativement dans l'app Android pour vous offrir une
                  expérience décuplée.
                </p>
              </div>
              <div className="flex flex-row md:flex-col gap-3 w-full md:w-auto md:min-w-[180px]">
                <div className="flex-1 md:flex-none flex items-center gap-3 p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                  <div className="p-1.5 rounded-lg bg-green-500/20">
                    <Plus className="w-4 h-4 text-green-400" strokeWidth={3} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white leading-tight">de lecteurs</p>
                    <p className="text-[11px] text-green-400/80 leading-tight">plus de sources</p>
                  </div>
                </div>
                <div className="flex-1 md:flex-none flex items-center gap-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                  <div className="p-1.5 rounded-lg bg-red-500/20">
                    <Minus className="w-4 h-4 text-red-400" strokeWidth={3} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white leading-tight">de pubs</p>
                    <p className="text-[11px] text-red-400/80 leading-tight">navigation allégée</p>
                  </div>
                </div>
              </div>
            </div>
          </AnimatedBorderCard>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          className="max-w-5xl mx-auto mb-10"
        >
          <div className="text-center mb-6">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
              Pourquoi utiliser l'application ?
            </h2>
            <p className="text-white/50 max-w-2xl mx-auto">
              Une expérience optimisée pour votre appareil mobile, avec toutes les
              fonctionnalités de Movix à portée de main.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {features.map((feature) => (
              <div key={feature.title}>
                <AnimatedBorderCard
                  highlightColor={hexToRgb(feature.color)}
                  backgroundColor="12 12 12"
                  className="p-5 h-full"
                >
                  <div className="flex items-start gap-4">
                    <div
                      className="p-2.5 rounded-lg flex-shrink-0"
                      style={{ backgroundColor: `${feature.color}15` }}
                    >
                      <div style={{ color: feature.color }}>{feature.icon}</div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-white mb-1">{feature.title}</h3>
                      <p className="text-sm text-white/50 leading-relaxed">
                        {feature.desc}
                      </p>
                    </div>
                  </div>
                </AnimatedBorderCard>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          className="max-w-3xl mx-auto mb-20"
        >
          <div className="text-center mb-6">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
              Comment installer sur Android ?
            </h2>
            <p className="text-white/50 max-w-xl mx-auto">
              Suivez ces quelques étapes simples pour installer Movix sur votre appareil.
            </p>
          </div>

          <AnimatedBorderCard
            highlightColor="99 102 241"
            backgroundColor="10 10 10"
            className="p-6 sm:p-8 backdrop-blur-sm"
          >
            <div className="space-y-6">
              {androidSteps.map((item, index) => (
                <div key={item.step} className="flex gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-sm">
                      {item.step}
                    </div>
                    {index < androidSteps.length - 1 && (
                      <div className="w-px h-8 bg-indigo-500/20 mx-auto mt-2" />
                    )}
                  </div>
                  <div className="pt-1.5">
                    <h4 className="font-semibold text-white mb-1">{item.title}</h4>
                    <p className="text-sm text-white/50 leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-8 pt-6 border-t border-white/10">
              <a
                href={APK_URL}
                download="movix-android.apk"
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-700 px-6 text-sm sm:text-base font-semibold transition-all duration-200 active:scale-95"
              >
                <Download className="w-5 h-5 flex-shrink-0" />
                Télécharger movix-android.apk
              </a>
              <p className="mt-3 text-xs text-white/30 text-center">
                Si votre navigateur bloque le téléchargement, autorisez-le manuellement
                dans les paramètres.
              </p>
            </div>
          </AnimatedBorderCard>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto text-center pb-12"
        >
          <AnimatedBorderCard
            highlightColor="99 102 241"
            backgroundColor="10 10 10"
            className="p-8 backdrop-blur-sm"
          >
            <Smartphone className="w-10 h-10 text-indigo-500 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-white mb-2">Prêt à installer Movix ?</h3>
            <p className="text-white/50 text-sm mb-6 max-w-md mx-auto">
              Téléchargez l'application Android dès maintenant et profitez d'une
              expérience optimale sur votre smartphone.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href={APK_URL}
                download="movix-android.apk"
                className="inline-flex h-11 w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-green-600 text-white hover:bg-green-700 px-6 text-sm font-semibold transition-all duration-200 active:scale-95"
              >
                <Download className="w-4 h-4 flex-shrink-0" />
                Télécharger pour Android
              </a>
              <Link
                to="/"
                className="inline-flex h-11 w-full sm:w-auto items-center justify-center gap-2 rounded-lg border border-white/20 hover:border-white/40 text-white hover:bg-white/10 px-5 text-sm font-semibold transition-all duration-200 active:scale-95"
              >
                <ArrowLeft className="w-4 h-4 flex-shrink-0" />
                Retour à l'accueil
              </Link>
            </div>
          </AnimatedBorderCard>
        </motion.div>
      </div>
    </SquareBackground>
  );
};

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '99 102 241';
  return `${parseInt(result[1], 16)} ${parseInt(result[2], 16)} ${parseInt(result[3], 16)}`;
}

export default AppDownloadPage;
