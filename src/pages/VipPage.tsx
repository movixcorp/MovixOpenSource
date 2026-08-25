import React from "react";
import { motion } from "framer-motion";
import {
  Crown,
  Zap,
  MessageCircle,
  Shield,
  ArrowLeft,
  Radio,
  Tv,
  Heart,
  Unlock,
  FolderClock,
} from "lucide-react";
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
import { SquareBackground } from "../components/ui/square-background";
import BlurText from "../components/ui/blur-text";
import ShinyText from "../components/ui/shiny-text";
import AnimatedBorderCard from "../components/ui/animated-border-card";

const VipPage: React.FC = () => {
  const { t } = useTranslation();
  const features = [
    {
      icon: Zap,
      text: t("vip.adFreePlayers"),
      desc: t("vip.adFreePlayersDesc"),
    },
    {
      icon: Shield,
      text: t("vip.noAdBeforeContent"),
      desc: t("vip.noAdBeforeContentDesc"),
    },
    {
      icon: Crown,
      text: t("vip.priorityRequests"),
      desc: t("vip.priorityRequestsDesc"),
    },
    {
      icon: MessageCircle,
      text: t("vip.vipCommentTag"),
      desc: t("vip.vipCommentTagDesc"),
    },
    {
      icon: Radio,
      text: t("vip.franceTvAccess"),
      desc: t("vip.franceTvAccessDesc"),
    },
    {
      icon: Tv,
      text: t("vip.liveTvOtherSources"),
      desc: t("vip.liveTvOtherSourcesDesc"),
    },
    {
      icon: Unlock,
      text: t("vip.debridService"),
      desc: t("vip.debridServiceDesc"),
    },
  ];

  return (
    <SquareBackground
      squareSize={48}
      borderColor="rgba(239, 68, 68, 0.2)"
      className="min-h-screen bg-black text-white"
    >
      <div className="container mx-auto px-6 py-12 relative z-10 h-full overflow-y-auto">
        {/* Back Button */}
        <Link
          to="/"
          className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8"
        >
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t("common.backToHome")}
        </Link>

        <div className="max-w-4xl mx-auto text-center space-y-12">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <div className="inline-flex items-center justify-center p-3 bg-yellow-500/10 rounded-full mb-4 ring-1 ring-yellow-500/50">
              <Crown className="w-8 h-8 text-yellow-500" />
            </div>
            <BlurText
              text={t("vip.becomeVip") + " Movix"}
              delay={300}
              animateBy="words"
              direction="top"
              className="text-4xl md:text-6xl font-bold text-white justify-center"
            />
            <p className="text-xl text-white/60 max-w-2xl mx-auto">
              {t("vip.supportPlatform")}{" "}
              <ShinyText
                text={t("vip.yearlyPrice")}
                speed={2}
                color="#fbbf24"
                shineColor="#ffffff"
                className="font-bold"
              />
              .
            </p>
            <div className="mt-4 max-w-xl mx-auto">
              <BlurText
                text={t("vip.perfectOffer")}
                delay={100}
                className="text-sm md:text-base text-white/40 italic justify-center"
              />
            </div>
          </motion.div>

          {/* Features Grid */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="grid md:grid-cols-2 gap-6 text-left"
          >
            {features.map((feature, idx) => (
              <motion.div
                key={idx}
                whileHover={{ scale: 1.02 }}
                className="h-full group"
              >
                <AnimatedBorderCard
                  highlightColor="234 179 8" // Gold/Yellow
                  backgroundColor="10 10 10"
                  className="p-6 h-full backdrop-blur-sm"
                >
                  <div className="flex items-start gap-4">
                    <div className="p-3 rounded-lg bg-yellow-500/10 group-hover:bg-yellow-500/20 transition-colors">
                      <feature.icon className="w-6 h-6 text-yellow-500" />
                    </div>
                    <div>
                      <div className="mb-1">
                        <ShinyText
                          text={feature.text}
                          speed={2}
                          color="#fbbf24"
                          shineColor="#ffffff"
                          className="text-lg font-bold"
                        />
                      </div>
                      <BlurText
                        text={feature.desc}
                        delay={30 + idx * 20}
                        className="text-sm text-white/50"
                      />
                    </div>
                  </div>
                </AnimatedBorderCard>
              </motion.div>
            ))}
          </motion.div>

          {/* Contact / CTA Section */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <AnimatedBorderCard
              highlightColor="234 179 8"
              backgroundColor="10 10 10"
              className="p-8 text-center space-y-6 backdrop-blur-sm"
            >
              <div>
                <BlurText
                  text={t("vip.howToSubscribe")}
                  delay={150}
                  className="text-2xl font-bold text-white mb-2 justify-center"
                />
                <BlurText
                  text={t("vip.contactToActivate")}
                  delay={200}
                  className="text-white/60 justify-center"
                />
              </div>

              <div className="flex flex-col md:flex-row items-center justify-center gap-4">
                <Link
                  to="/vip/don"
                  className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-yellow-500 px-8 text-black transition-colors hover:bg-yellow-400 md:w-auto"
                >
                  <Crown className="w-4 h-4 mr-2" />
                  {t("vip.donate")}
                </Link>
                <Link
                  to="/vip/invoices"
                  className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-white/15 px-8 text-white transition-colors hover:bg-white/5 md:w-auto"
                >
                  <FolderClock className="w-4 h-4 mr-2" />
                  {t("vipDonations.page.myInvoicesButton")}
                </Link>
                <a
                  href="https://t.me/movix_site"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button className="h-12 px-8 bg-[#229ED9] hover:bg-[#229ED9]/80 text-white w-full md:w-auto">
                    <Zap className="w-4 h-4 mr-2" />
                    {t("vip.telegramChannel")}
                  </Button>
                </a>
                <a
                  href="https://discord.com/users/1516102413835305021"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button className="h-12 px-8 bg-[#5865F2] hover:bg-[#5865F2]/80 text-white w-full md:w-auto">
                    <MessageCircle className="w-4 h-4 mr-2" />
                    {t("vip.discordContact")}
                  </Button>
                </a>
              </div>
              <div className="pt-4 border-t border-white/10">
                <p className="text-sm text-white/40">
                  {t("vip.telegramPersonal")}{" "}
                  <span className="text-white">@MysticSaba</span>
                </p>
              </div>
            </AnimatedBorderCard>
          </motion.div>

          {/* Support Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex justify-center"
          >
            <AnimatedBorderCard
              backgroundColor="10 10 10"
              className="p-8 text-center space-y-4 backdrop-blur-sm max-w-2xl"
              style={
                {
                  "--border-color": `conic-gradient(from var(--border-angle, 0deg),
                                    #ff0000, #ff8000, #ffff00, #00ff00, #0080ff, #8000ff, #ff00ff, #ff0000)`,
                } as React.CSSProperties
              }
            >
              <div className="inline-flex items-center justify-center p-3 bg-red-500/10 rounded-full ring-1 ring-red-500/50">
                <Heart className="w-6 h-6 text-red-500" />
              </div>
              <p className="text-lg text-white/80 leading-relaxed">
                {t("vip.supportMessage")}
              </p>
            </AnimatedBorderCard>
          </motion.div>
        </div>
      </div>
    </SquareBackground>
  );
};

export default VipPage;
