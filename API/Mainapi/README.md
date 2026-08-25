# Main API Movix

C'est le cœur applicatif du projet. Si le frontend affiche un catalogue, authentifie un user, synchronise du `localStorage`, gère les commentaires, le Wishboard, le Top 10, le Live TV, le debrid ou les pages VIP, il finit très souvent ici.

Le service tourne en mode cluster via `server.js` : un master lance plusieurs workers, surveille les redémarrages et gère un graceful shutdown. `app.js` monte ensuite Express, Redis, le pool MySQL, les caches disque et les routes injectées par dépendances.

## Ce que le service gère

- auth, sessions et profils
- recherche, metadata TMDB et agrégation de sources
- sync frontend <-> backend pour une partie de l'état utilisateur
- commentaires, likes, listes partagées, Wishboard et soumission de liens
- Live TV, proxies, debrid et intégrations de scraping
- VIP, invoices, wrapped et features communautaires

## Démarrage

```bash
cd API/Mainapi
cp .env.example .env
npm install
npm run dev
```

Ne lance pas le service avec un `.env` vide : MySQL, Redis, JWT, TMDB et plusieurs routes métier en dépendent directement.

Notes utiles :

- le serveur HTTP écoute actuellement sur `http://localhost:25565`
- `server.js` bind aujourd'hui le port `25565` en dur
- `NUM_WORKERS` permet de régler le nombre de workers du cluster
- MySQL et Redis sont nécessaires pour une grosse partie des routes

## Architecture

```text
API/Mainapi/
|-- server.js                 # Master cluster + workers + graceful shutdown
|-- app.js                    # Bootstrap Express, middleware, deps partagées
|-- mysqlPool.js              # Pool MySQL unique
|-- config/redis.js           # Redis
|-- middleware/               # CORS, sécurité, auth
|-- routes/                   # Modules avec configure(deps)
|-- commentsRoutes.js         # Commentaires
|-- likesRoutes.js            # Likes / dislikes
|-- sharedListsRoutes.js      # Listes partagées
|-- liveTvRoutes.js           # Live TV
|-- wishboardRoutes.js        # Wishboard
|-- top10Routes.js            # Classements
|-- wrappedRoutes.js          # Wrapped
|-- linkSubmissionsRoutes.js  # Soumission de liens
|-- utils/                    # Cache, proxies, axios helpers, VIP, etc.
|-- cache/                    # Caches disque
`-- exportscripts/            # SQL et scripts de migration
```

Le pattern important dans `routes/` : beaucoup de modules exposent `configure(deps)`. C'est `app.js` qui injecte les clients HTTP, le cache, les helpers et les constantes partagées avant montage.

## Variables d'environnement à renseigner en premier

Le fichier `API/Mainapi/.env.example` est la référence complète. En pratique, les groupes de variables à traiter en premier sont :

- cœur applicatif : `JWT_SECRET`, `TMDB_API_KEY`, `FRONTEND_BASE_URL`
- données : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- cache et coordination : `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `NUM_WORKERS`
- scraping / proxy : `PROXY_SERVER_URL`, `IPTV_STREAM_PROXY`, `SOCKS5_PROXIES`, `HTTP_PROXIES`
- anti-abuse / forms : `TURNSTILE_SECRET_KEY`, `TURNSTILE_INVISIBLE_SECRETKEY`
- paiement / VIP : variables `VIP_*`, `BLOCKCYPHER_TOKEN`

Certaines intégrations sont très spécifiques à des sources données, par exemple les cookies `DARKIWORLD_*`, `FSTREAM_LOGIN_*` ou `XTREAM_*`.

## Points d'entrée utiles

- auth et profils : `routes/authRoutes.js`, `routes/sessions.js`, `routes/profiles.js`
- persistance frontend : `routes/sync.js`
- recherche et catalogues : `routes/search.js`, `routes/tmdb.js`
- scraping / lecture : `routes/cpasmal.js`, `routes/fstream.js`, `routes/wiflix.js`, `liveTvRoutes.js`
- communautaire : `commentsRoutes.js`, `likesRoutes.js`, `sharedListsRoutes.js`, `wishboardRoutes.js`, `linkSubmissionsRoutes.js`
- VIP / paiements : `utils/vipDonations.js`, `routes/vipDonations.js`

## À garder en tête

- Le backend actif est ici, pas dans l'ancien contenu direct de `API/`.
- Plusieurs tables MySQL sont initialisées automatiquement au démarrage.
- Une partie du comportement applicatif dépend de caches disque et de proxys externes ; un bug peut venir d'ailleurs que du code route lui-même.
- Si une feature touche la lecture vidéo, regarde aussi `API/proxiesembed/` et parfois l'extension navigateur.
