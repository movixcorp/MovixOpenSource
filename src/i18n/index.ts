import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import { resolveCurrentDomain } from './currentDomain';
import fr from './locales/fr.json';
import { clearHttpCache } from '../utils/httpCache';

export const SUPPORTED_LANGUAGES = [
  { code: 'fr', label: 'Fran\u00e7ais', flagUrl: 'https://flagcdn.com/w40/fr.png' },
  { code: 'en', label: 'English', flagUrl: 'https://flagcdn.com/w40/gb.png' },
  { code: 'es', label: 'Espa\u00f1ol', flagUrl: 'https://flagcdn.com/w40/es.png' },
  { code: 'de', label: 'Deutsch', flagUrl: 'https://flagcdn.com/w40/de.png' },
  { code: 'it', label: 'Italiano', flagUrl: 'https://flagcdn.com/w40/it.png' },
  { code: 'pt', label: 'Portugu\u00eas', flagUrl: 'https://flagcdn.com/w40/pt.png' },
  { code: 'nl', label: 'Nederlands', flagUrl: 'https://flagcdn.com/w40/nl.png' },
  { code: 'ru', label: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', flagUrl: 'https://flagcdn.com/w40/ru.png' },
  { code: 'ja', label: '\u65e5\u672c\u8a9e', flagUrl: 'https://flagcdn.com/w40/jp.png' },
  { code: 'ko', label: '\ud55c\uad6d\uc5b4', flagUrl: 'https://flagcdn.com/w40/kr.png' },
  { code: 'zh', label: '\u4e2d\u6587', flagUrl: 'https://flagcdn.com/w40/cn.png' },
  { code: 'ar', label: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', flagUrl: 'https://flagcdn.com/w40/sa.png' },
  { code: 'tr', label: 'T\u00fcrk\u00e7e', flagUrl: 'https://flagcdn.com/w40/tr.png' },
  { code: 'pl', label: 'Polski', flagUrl: 'https://flagcdn.com/w40/pl.png' },
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number]['code'];

// Languages that actually have translation files loaded
const LOADED_LANGUAGE_CODES = ['fr', 'en'] as const;
type LoadedLanguage = typeof LOADED_LANGUAGE_CODES[number];
const DEFAULT_LANGUAGE: LoadedLanguage = 'en';
const LOADED_LANG_CODES = new Set<SupportedLanguage>(LOADED_LANGUAGE_CODES);
export const AVAILABLE_LANGUAGES = SUPPORTED_LANGUAGES.filter(l => LOADED_LANG_CODES.has(l.code));

// Map i18n language codes to TMDB API language codes
const TMDB_LANGUAGE_MAP: Record<string, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-PT',
  nl: 'nl-NL',
  ru: 'ru-RU',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ar: 'ar-SA',
  tr: 'tr-TR',
  pl: 'pl-PL',
};

/** Returns the current TMDB language code (e.g. 'fr-FR') based on the active i18n language */
export const getTmdbLanguage = (): string => {
  return TMDB_LANGUAGE_MAP[getResolvedAppLanguage()] || TMDB_LANGUAGE_MAP[DEFAULT_LANGUAGE];
};

const normalizeLanguageCode = (lang?: string | null): string =>
  String(lang || '').split('-')[0].toLowerCase();

const resolveLoadedLanguage = (lang?: string | null): LoadedLanguage => {
  const normalizedLanguage = normalizeLanguageCode(lang);
  return LOADED_LANG_CODES.has(normalizedLanguage as SupportedLanguage)
    ? normalizedLanguage as LoadedLanguage
    : DEFAULT_LANGUAGE;
};

export const getResolvedAppLanguage = (): LoadedLanguage =>
  resolveLoadedLanguage(i18n.resolvedLanguage || i18n.language || getStoredLanguage());

// Retrieve stored language from localStorage (set by user in settings or loaded from server)
const getStoredLanguage = (): LoadedLanguage | null => {
  try {
    const storedLanguage = localStorage.getItem('user_language');
    return storedLanguage ? resolveLoadedLanguage(storedLanguage) : null;
  } catch {
    return null;
  }
};

// L'anglais n'est pas déclaré dans `resources` au boot : ~356 Ko de JSON
// parsés pour rien pour l'immense majorité des visiteurs (FR = langue
// primaire du site). On le charge dynamiquement, une seule fois (mémoïsé),
// uniquement quand la langue résolue/choisie est l'anglais.
let englishBundlePromise: Promise<void> | null = null;
const loadEnglishBundle = (): Promise<void> => {
  if (!englishBundlePromise) {
    englishBundlePromise = import('./locales/en.json').then((mod) => {
      i18n.addResourceBundle('en', 'translation', mod.default, true, true);
    });
  }
  return englishBundlePromise;
};

const maybeLoadEnglishBundle = (lang?: string | null): void => {
  if (normalizeLanguageCode(lang) === 'en') {
    void loadEnglishBundle();
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: fr },
    },
    // Empêche react-i18next d'attendre indéfiniment (ou de suspendre) une
    // langue déclarée dans supportedLngs mais pas bundlée au boot ('en') :
    // on la charge nous-mêmes via addResourceBundle plus bas.
    partialBundledLanguages: true,
    lng: getStoredLanguage() || undefined, // Use stored language if available
    // Volontairement 'fr' et non DEFAULT_LANGUAGE : fr est le seul bundle
    // garanti disponible de façon synchrone au boot, donc le seul repli
    // fiable tant que le bundle 'en' n'est pas encore chargé.
    fallbackLng: 'fr',
    supportedLngs: [...LOADED_LANGUAGE_CODES],
    load: 'languageOnly',
    cleanCode: true,
    interpolation: {
      escapeValue: false, // React already escapes
      defaultVariables: {
        currentDomain: resolveCurrentDomain(),
      },
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'user_language',
      caches: ['localStorage'],
    },
    react: {
      // Re-render les composants dès que le bundle 'en' arrive via
      // addResourceBundle (sans ça le texte resterait figé en français
      // jusqu'à un re-render déclenché par autre chose).
      bindI18nStore: 'added',
    },
  })
  .then(() => {
    // Couvre le cas où la langue résolue au boot (stockage ou détection
    // navigateur synchrone) est déjà l'anglais.
    maybeLoadEnglishBundle(i18n.resolvedLanguage || i18n.language);
  });

// Couvre les changements de langue ultérieurs vers l'anglais (sélecteur de
// langue via changeLanguage, détection async par IP dans detectInitialLanguage).
i18n.on('languageChanged', maybeLoadEnglishBundle);

// Le cache des lectures de catalogue est indexé sur l'URL, et la plupart des
// appels TMDB portent déjà `language=` — mais pas tous. Un vrai changement de
// langue le vide donc entièrement, pour ne pas resservir des titres dans
// l'ancienne. Seulement un vrai changement : i18next émet aussi l'événement au
// démarrage, quand la langue est simplement *établie*, et vider le cache à ce
// moment-là jetterait à chaque boot ce qui venait d'être mis de côté.
let lastKnownLanguage: string | null = null;
i18n.on('languageChanged', (lng: string) => {
  if (lastKnownLanguage !== null && lastKnownLanguage !== lng) clearHttpCache();
  lastKnownLanguage = lng;
});

// Helper to change language and persist locally
export const changeLanguage = async (lang: SupportedLanguage): Promise<void> => {
  const resolvedLanguage = resolveLoadedLanguage(lang);
  await i18n.changeLanguage(resolvedLanguage);
  try {
    localStorage.setItem('user_language', resolvedLanguage);
  } catch {
    // Ignore storage errors
  }
};

/** Maps country codes to the most commonly spoken language supported by the app */
const COUNTRY_TO_LANG: Record<string, string> = {
  FR: 'fr', BE: 'fr', CH: 'fr', LU: 'fr', MC: 'fr', // French
  GB: 'en', US: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en', // English
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', // Spanish
  DE: 'de', AT: 'de', // German
  IT: 'it', // Italian
  PT: 'pt', BR: 'pt', // Portuguese
  NL: 'nl', // Dutch
  RU: 'ru', BY: 'ru', KZ: 'ru', // Russian
  JP: 'ja', // Japanese
  KR: 'ko', // Korean
  CN: 'zh', TW: 'zh', HK: 'zh', SG: 'zh', // Chinese
  SA: 'ar', AE: 'ar', EG: 'ar', MA: 'ar', DZ: 'ar', TN: 'ar', IQ: 'ar', JO: 'ar', LB: 'ar', LY: 'ar', // Arabic
  TR: 'tr', // Turkish
  PL: 'pl', // Polish
};

/**
 * Detects the best language for a first-time visitor.
 * Priority: 1) browser language if supported  2) IP geolocation  3) English fallback.
 * Only runs when no language has been stored yet (i.e., first visit).
 */
export const detectInitialLanguage = async (): Promise<void> => {
  const storedLanguage = localStorage.getItem('user_language');
  if (storedLanguage) {
    const resolvedStoredLanguage = resolveLoadedLanguage(storedLanguage);
    if (storedLanguage !== resolvedStoredLanguage || getResolvedAppLanguage() !== resolvedStoredLanguage) {
      await changeLanguage(resolvedStoredLanguage);
    }
    return;
  }

  // 1. Try browser language
  const rawBrowserLang = navigator.language || navigator.languages?.[0] || '';
  const browserLang = normalizeLanguageCode(rawBrowserLang);
  if (browserLang && LOADED_LANG_CODES.has(browserLang as SupportedLanguage)) {
    await changeLanguage(browserLang as SupportedLanguage);
    return;
  }

  // 2. Try IP geolocation (free service, no key required)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      const countryLang = COUNTRY_TO_LANG[data.country_code as string];
      if (countryLang && LOADED_LANG_CODES.has(countryLang as SupportedLanguage)) {
        await changeLanguage(countryLang as SupportedLanguage);
        return;
      }
    }
  } catch {
    // IP detection failed -- fall through to English
  }

  // 3. Fallback to English
  await changeLanguage(DEFAULT_LANGUAGE);
};

export default i18n;
