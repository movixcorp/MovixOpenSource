<p align="center">
  <img src="./movix.png" alt="Movix" width="120" />
</p>

<h1 align="center">Movix</h1>

<p align="center">
  <strong>Le 1er site de streaming open source made in France et 100% vibecodé.</strong>
</p>

<p align="center">
  <a href="https://react.dev">React</a> |
  <a href="https://vite.dev">Vite</a> |
  <a href="https://www.typescriptlang.org">TypeScript</a> |
  <a href="https://nodejs.org">Node.js</a> |
  <a href="https://www.mysql.com">MySQL</a> |
  <a href="https://redis.io">Redis</a> |
  <a href="https://socket.io">Socket.IO</a> |
  <a href="https://www.python.org">Python</a> |
  <a href="https://www.rust-lang.org">Rust</a>
</p>

<p align="center">
  <a href="https://react.dev">
    <img alt="React" src="https://img.shields.io/badge/React-149ECA?style=flat-square&logo=react&logoColor=white" />
  </a>
  <a href="https://vite.dev">
    <img alt="Vite" src="https://img.shields.io/badge/Vite-7C3AED?style=flat-square&logo=vite&logoColor=white" />
  </a>
  <a href="https://www.typescriptlang.org">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  </a>
  <a href="https://nodejs.org">
    <img alt="Node.js" src="https://img.shields.io/badge/Node.js-3C873A?style=flat-square&logo=nodedotjs&logoColor=white" />
  </a>
  <a href="https://www.mysql.com">
    <img alt="MySQL" src="https://img.shields.io/badge/MySQL-005C84?style=flat-square&logo=mysql&logoColor=white" />
  </a>
  <a href="https://redis.io">
    <img alt="Redis" src="https://img.shields.io/badge/Redis-D82C20?style=flat-square&logo=redis&logoColor=white" />
  </a>
  <a href="https://socket.io">
    <img alt="Socket.IO" src="https://img.shields.io/badge/Socket.IO-010101?style=flat-square&logo=socketdotio&logoColor=white" />
  </a>
  <a href="https://www.python.org">
    <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white" />
  </a>
  <a href="https://www.rust-lang.org">
    <img alt="Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" />
  </a>
</p>

<p align="center">
  <strong>Licence :</strong> Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) · <a href="./LICENSE">LICENSE</a>
</p>

Movix est un monorepo produit pour une plateforme de streaming communautaire. Le frontend, l'API principale, la WatchParty, les proxies, les outils navigateur et plusieurs briques d'infra vivent dans le même dépôt parce qu'ils évoluent ensemble.

Ce n'est pas un simple duo "frontend + backend". Une feature peut très vite traverser plusieurs couches à la fois : interface React, persistance locale, sync backend, extraction vidéo, proxy Python et parfois extension navigateur.

## Ce que contient le repo

| Zone | Rôle | Documentation |
| --- | --- | --- |
| `src/` | Frontend Vite + React + TypeScript | [Frontend](src/README.md) |
| `API/Mainapi/` | Backend principal clusterisé | [Main API](API/Mainapi/README.md) |
| `API/watchpartyAPI/` | Service temps réel WatchParty | [WatchParty API](API/watchpartyAPI/README.md) |
| `API/proxiesembed/` | Proxy aiohttp pour embeds, flux et DRM | [Proxies Embed](API/proxiesembed/README.md) |
| `extension/` + `userscript/` | Outils navigateur Movix | [Movix OS](README_MOVIX_OS.md) |
| `app/` | App mobile React Native (Android OK, iOS non testé) | [App mobile](app/README.md) |
| `wasm/watchparty-sync/` | Moteur Rust/WASM de la Sync Pro | [WatchParty Sync WASM](wasm/watchparty-sync/README.md) |
| `cloudflareproxy/` | Worker Cloudflare CORS/proxy | [Cloudflare Proxy](cloudflareproxy/README.md) |

## Architecture du monorepo

```text
movix-main/
|-- src/                        # Frontend principal
|-- public/                     # Assets statiques et artefacts WASM publiés
|-- API/
|   |-- Mainapi/                # Backend actif
|   |-- watchpartyAPI/          # Temps réel WatchParty
|   `-- proxiesembed/           # Proxy Python haute charge
|-- extension/                  # Extension Chrome / Firefox
|-- userscript/                 # Variante Tampermonkey
|-- app/                        # App mobile React Native (Android/iOS)
|-- wasm/watchparty-sync/       # Sync Pro en Rust/WASM
|-- cloudflareproxy/            # Worker Cloudflare
|-- functions/                  # Handlers serverless annexes
`-- PreMid/                     # Présence PreMiD
```

## Démarrage rapide

<p align="center">
  <strong>⚠️ L'utilisation de ce code implique le maintien des crédits et l'interdiction stricte de le monétiser (Zéro pub et abonnements). Voir la License complète </strong>
</p>

### Prérequis

- Node.js 18+ et npm
- Python 3.10+ pour les services Python
- MySQL et Redis pour `API/Mainapi`
- Rust + `wasm-bindgen` seulement si tu touches la Sync Pro WASM
- React Native CLI + Android Studio (et Xcode + CocoaPods sur Mac) seulement si tu touches l'app mobile `app/` — iOS n'a pas été testé, voir [`app/README.md`](app/README.md)

### Installer les dépendances utiles

```bash
npm install
cd API/Mainapi
npm install
```

`API/watchpartyAPI/` n'a pas son propre `package.json` : il consomme les dépendances du `node_modules` racine.

### Configurer les `.env` avant de lancer quoi que ce soit

Ne saute pas cette étape. Une bonne partie du monorepo dépend des variables d'environnement pour les URLs, la base de données, Redis, les proxys, TMDB, Turnstile et plusieurs intégrations de lecture.

```bash
# Frontend
cp .env.example .env

# API principale
cp API/Mainapi/.env.example API/Mainapi/.env

# WatchParty
cp API/watchpartyAPI/.env.example API/watchpartyAPI/.env

# Proxy embed
cp API/proxiesembed/.env.example API/proxiesembed/.env
```

### Lancer le minimum utile en local

```bash
# Frontend - http://localhost:3000
npm run dev
```

```bash
# Backend principal - http://localhost:25565
cd API/Mainapi
npm run dev
```

```bash
# WatchParty - http://localhost:25566
node API/watchpartyAPI/watchparty.js
```

Services optionnels selon la zone que tu touches :

```bash
# Proxy embed
cd API/proxiesembed
pip install -r requirements.txt
python server.py
```

## Configuration

Les fichiers d'exemple ou de config existants sont déjà dans le repo :

- Frontend : `.env.example`
- API principale : `API/Mainapi/.env.example`
- WatchParty : `API/watchpartyAPI/.env.example`
- Proxy embed : `API/proxiesembed/.env.example`

Les variables frontend les plus importantes sont `VITE_MAIN_API`, `VITE_WATCHPARTY_API`, `VITE_PROXIES_EMBED_API` et `VITE_SITE_URL`.

Pour un premier lancement local, configure au minimum :

- `/.env`
- `API/Mainapi/.env`
- `API/watchpartyAPI/.env`

## Comment s'orienter vite

- Feature frontend : commence par `src/App.tsx`, puis la page cible dans `src/pages/`.
- Auth, profils, persistance : regarde `src/context/`, `src/App.tsx`, `API/Mainapi/routes/authRoutes.js` et `API/Mainapi/routes/sync.js`.
- Lecture vidéo et proxies : recoupe `src/pages/Watch/`, les composants player, `API/Mainapi/liveTvRoutes.js`, `API/proxiesembed/` et parfois `extension/`.
- WatchParty : vérifie à la fois `API/watchpartyAPI/watchparty.js`, `src/pages/WatchParty*.tsx`, `src/hooks/useWatchParty.ts`, `src/utils/watchparty*.ts` et `src/workers/watchpartySync.worker.ts`.
- Browser tooling : si tu modifies l'extension, compare toujours `extension/Chrome/` et `extension/Firefox/`, puis vérifie si le userscript doit suivre.
- Sync Rust/WASM : modifie `wasm/watchparty-sync/`, puis rebuild `public/wasm/watchparty-sync/`.

## Points importants avant de contribuer

- Le backend actif est `API/Mainapi/`. Le vieux contenu directement sous `API/` n'est plus la référence.
- Ce monorepo n'utilise pas de workspace tooling : chaque sous-projet garde ses scripts.
- Une partie importante de l'état produit vit dans `localStorage` et dans la sync backend. Ne raisonne pas "base de données only".
- Le lint frontend se lance à la racine avec `npm run lint`.
- Il n'y a pas de suite de tests globale fiable pour tout le repo. Vérifie au minimum les scripts touchés et le comportement manuel.

## Documentation par module

- [Frontend](src/README.md)
- [Services backend](API/README.md)
- [Main API](API/Mainapi/README.md)
- [WatchParty API](API/watchpartyAPI/README.md)
- [Proxies Embed](API/proxiesembed/README.md)
- [Movix OS](README_MOVIX_OS.md)
- [Extension navigateur](extension/README.md)
- [Userscript Tampermonkey](userscript/README.md)
- [App mobile React Native](app/README.md) — Android fonctionnel, iOS non testé (aide recherchée)
- [WatchParty Sync WASM](wasm/watchparty-sync/README.md)
- [Cloudflare Proxy](cloudflareproxy/README.md)

## Licence

Ce projet est distribué sous licence Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0). Le texte complet est disponible dans [LICENSE](LICENSE).

## Avertissement

Ce projet est fourni uniquement à des fins éducatives, de recherche et de démonstration.
Il n'encourage ni ne cautionne une utilisation illégale, le contournement de droits, ou toute violation des lois applicables.
Chaque utilisateur est seul responsable de l'usage qu'il en fait.
