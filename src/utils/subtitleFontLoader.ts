import type { SubtitleFontFamily } from './subtitlePreferences';

const CDN_ORIGIN = 'https://cdn.jsdelivr.net';

const SUBTITLE_FONT_STYLESHEETS: Readonly<Partial<Record<SubtitleFontFamily, readonly string[]>>> = Object.freeze({
  standard: [
    `${CDN_ORIGIN}/npm/@fontsource/inter@5.2.8/latin-400.css`,
    `${CDN_ORIGIN}/npm/@fontsource/inter@5.2.8/latin-700.css`,
  ],
  atkinson: [
    `${CDN_ORIGIN}/npm/@fontsource/atkinson-hyperlegible@5.3.0/latin-400.css`,
    `${CDN_ORIGIN}/npm/@fontsource/atkinson-hyperlegible@5.3.0/latin-700.css`,
  ],
  lexend: [
    `${CDN_ORIGIN}/npm/@fontsource/lexend@5.3.0/latin-400.css`,
    `${CDN_ORIGIN}/npm/@fontsource/lexend@5.3.0/latin-700.css`,
  ],
  opendyslexic: [
    `${CDN_ORIGIN}/npm/@fontsource/opendyslexic@5.3.0/latin-400.css`,
    `${CDN_ORIGIN}/npm/@fontsource/opendyslexic@5.3.0/latin-700.css`,
  ],
});

const injectedStylesheets = new Set<string>();

function ensureSubtitleFontPreconnect(): void {
  if (document.head.querySelector('link[data-subtitle-font-cdn]')) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = CDN_ORIGIN;
  link.crossOrigin = 'anonymous';
  link.dataset.subtitleFontCdn = 'true';
  document.head.appendChild(link);
}

export function ensureSubtitleFontLoaded(fontFamily: SubtitleFontFamily): void {
  if (typeof document === 'undefined') return;
  const stylesheets = SUBTITLE_FONT_STYLESHEETS[fontFamily];
  if (!stylesheets) return;

  ensureSubtitleFontPreconnect();
  stylesheets.forEach((href) => {
    if (injectedStylesheets.has(href)) return;
    injectedStylesheets.add(href);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.subtitleFont = fontFamily;
    link.addEventListener('error', () => injectedStylesheets.delete(href), { once: true });
    document.head.appendChild(link);
  });
}
