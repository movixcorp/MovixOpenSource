import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { visualizer } from 'rollup-plugin-visualizer'

const buildId = process.env.CF_PAGES_COMMIT_SHA || process.env.COMMIT_REF || new Date().toISOString()
process.env.VITE_APP_BUILD_ID = buildId

const normalizeSiteUrl = (value?: string): string => {
  const candidate = value?.trim()
  if (!candidate) {
    throw new Error('VITE_SITE_URL is required')
  }

  try {
    const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    return url.origin
  } catch {
    throw new Error('VITE_SITE_URL must contain a valid public URL')
  }
}

function injectPublicConfig(): Plugin {
  let siteUrl: string | undefined

  const replacePlaceholders = (source: string): string => {
    const mirrors = (process.env.VITE_DEFAULT_MIRRORS || 'movix.health')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const configUrl =
      process.env.VITE_MIRRORS_CONFIG_URL || 'https://rentry.co/movix'
    return source
      .replace(/__MOVIX_DEFAULT_MIRRORS__/g, JSON.stringify(mirrors))
      .replace(/__MOVIX_CONFIG_URL__/g, JSON.stringify(configUrl))
      .replace(/__MOVIX_SITE_URL__/g, () => {
        if (!siteUrl) throw new Error('VITE_SITE_URL was not resolved')
        return siteUrl
      })
  }
  return {
    name: 'movix-public-config-inject',
    configResolved(config) {
      siteUrl = normalizeSiteUrl(config.env.VITE_SITE_URL)
    },
    transformIndexHtml(html) {
      return replacePlaceholders(html)
    },
    // Mode build : transforme dist/sw.js après que Vite ait copié public/sw.js
    closeBundle() {
      for (const fileName of ['sw.js', 'sitemap.xml', 'robots.txt']) {
        const outputPath = resolve(__dirname, 'dist', fileName)
        if (!existsSync(outputPath)) continue
        const contents = readFileSync(outputPath, 'utf-8')
        writeFileSync(outputPath, replacePlaceholders(contents), 'utf-8')
      }
    },
    // Mode dev : intercepte GET /sw.js et sert une version transformée
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathOnly = (req.url || '').split('?')[0]
        const publicFiles: Record<string, { fileName: string; contentType: string }> = {
          '/sw.js': {
            fileName: 'sw.js',
            contentType: 'application/javascript; charset=utf-8',
          },
          '/sitemap.xml': {
            fileName: 'sitemap.xml',
            contentType: 'application/xml; charset=utf-8',
          },
          '/robots.txt': {
            fileName: 'robots.txt',
            contentType: 'text/plain; charset=utf-8',
          },
        }
        const publicFile = publicFiles[pathOnly]
        if (!publicFile) return next()

        const publicPath = resolve(__dirname, 'public', publicFile.fileName)
        if (!existsSync(publicPath)) return next()
        const contents = readFileSync(publicPath, 'utf-8')
        res.setHeader('Content-Type', publicFile.contentType)
        res.setHeader('Cache-Control', 'no-store')
        res.end(replacePlaceholders(contents))
      })
    },
  }
}

export default defineConfig({
  logLevel: 'warn',
  plugins: [
    react(),
    injectPublicConfig(),
    ...(process.env.ANALYZE === 'true'
      ? [
          visualizer({
            filename: 'dist/stats.html',
            gzipSize: true,
            brotliSize: true,
            template: 'treemap',
            open: false,
          }),
        ]
      : []),
  ],
  server: {
    host: true,
    // 3000 par défaut. `PORT` permet d'ouvrir un second serveur de dev en
    // parallèle du premier (deux sessions d'agent, deux branches) sans se
    // disputer le port.
    port: Number(process.env.PORT) || 3000,
    hmr: true,
    watch: {
      // Polling utile sur WSL/Docker/FS réseau où inotify/FSEvents ne remontent
      // pas les changements. Sur Windows natif ou macOS, il faut le couper :
      // chokidar scanne TOUS les fichiers à `interval` ms → démarrage Vite
      // qui prend plusieurs minutes + CPU saturé. Override possible avec
      // VITE_USE_POLLING=1 pour ceux qui codent en WSL2 vers un dossier
      // monté sur le FS Windows (cas où linux+polling ne suffit pas).
      usePolling: process.env.VITE_USE_POLLING === '1' || process.platform === 'linux',
      interval: 100,
      // Exclut tout ce qui n'est PAS source Vite. Sans ça, chokidar passe
      // le démarrage à indexer 150MB d'avatars + le dist + les API Node +
      // l'app mobile + les extensions — autant de fichiers qui sont soit
      // servis tels quels (public/), soit n'ont rien à voir avec le bundle
      // frontend (API/, app/, extension/, etc.).
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/public/avatars/**',
        '**/public/WatchpartyTutorial/**',
        '**/public/help/**',
        '**/public/live/**',
        '**/public/wasm/**',
        '**/API/**',
        '**/app/**',
        '**/extension/**',
        '**/PreMid/**',
        '**/cloudflareproxy/**',
        '**/functions/**',
        '**/docs/**',
        '**/wasm/**',
        '**/userscript/**',
        '**/others/**',
      ],
    },
  },
  preview: {
    host: true,
    port: 3000,
  },
  build: {
    target: 'es2020', // explicit, was implicit es2020 in Vite 5
    chunkSizeWarningLimit: 600, // uncompressed kB; warning only, doesn't fail
    reportCompressedSize: false, // skip per-chunk gzip/brotli computation (slow + verbose)
    commonjsOptions: {
      include: [/node_modules/],
      sourceMap: false,
      transformMixedEsModules: true
    },
    rollupOptions: {
      input: './index.html',
      // Silence per-occurrence noise from minified CJS-in-ESM bundles (dashjs floods 2 MiB+)
      onLog(level, log, defaultHandler) {
        if (log.code === 'COMMONJS_VARIABLE_IN_ESM') return
        defaultHandler(level, log)
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom|react-helmet-async|scheduler|uuid)[\\/]/,
            },
            {
              name: 'radix',
              test: /[\\/]node_modules[\\/](@radix-ui|@headlessui|class-variance-authority|tailwind-merge|clsx|tailwindcss-animate)[\\/]/,
            },
            {
              name: 'motion',
              test: /[\\/]node_modules[\\/](framer-motion|lenis|sonner)[\\/]/,
            },
            {
              name: 'i18n',
              test: /[\\/]node_modules[\\/](i18next|i18next-browser-languagedetector|react-i18next)[\\/]/,
            },
            {
              name: 'markdown',
              test: /[\\/]node_modules[\\/](react-markdown|remark-emoji)[\\/]/,
            },
            // remark-gfm + its mdast-util-gfm-* / micromark-extension-gfm-* deps are
            // kept in their own chunk so they only load on engines that support regex
            // lookbehinds. Bundling them with react-markdown would force-evaluate
            // mdast-util-gfm-autolink-literal's lookbehind regex on Safari < 16.4 and
            // crash with "Invalid regular expression: invalid group specifier name".
            // Shared deps (ccount, mdast-util-find-and-replace, unified, etc.) are left
            // out of this rule so Rollup can keep them in the static markdown chunk
            // and avoid making the static chunk depend on this dynamic one.
            {
              name: 'remark-gfm',
              test: /[\\/]node_modules[\\/](remark-gfm|mdast-util-gfm[^\\/]*|micromark-extension-gfm[^\\/]*)[\\/]/,
            },
          ],
        },
      },
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    }
  }
})
