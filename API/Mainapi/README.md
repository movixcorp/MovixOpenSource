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
- notifications quotidiennes quand un film, un épisode ou une saison suivie devient réellement lisible

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

## Initialiser ou compléter le schéma MySQL

L'initialiseur requiert **MySQL 8.0.13 ou plus récent**. Cette version minimale permet de comparer les expressions, préfixes, ordres, types et visibilité des index via `INFORMATION_SCHEMA`, en plus du moteur, des charsets, collations et règles de clés étrangères.

Depuis `API/Mainapi` :

```bash
npm run db:init
```

La commande analyse d'abord les tables, colonnes, index et contraintes, puis affiche toutes les opérations prévues avant la première écriture. Un drift bloquant affiche les définitions `expected` et `actual`. Si le schéma change pendant l'acquisition du verrou, aucune DDL n'est appliquée et le diagnostic demande de relancer l'initialiseur.

Si la base contient déjà des tables, elle demande `Continuer ? (O/N)`. Si des changements concernent `wrapped_viewing_data` ou `wrapped_pages_data`, elle avertit avant le second prompt que les opérations peuvent causer des verrous longs, augmenter la charge, la durée et l'espace disque utilisé, puis demande exactement `Modifier les tables Wrapped ? (O/N)`.

Le script est uniquement additif : aucune suppression, aucun renommage et aucune reconstruction de données. Une réponse autre que `O` ou `o` annule la confirmation concernée. N'interromps pas une création d'index Wrapped déjà confirmée : sur une table volumineuse, MySQL peut travailler longtemps.

Pour afficher le plan sans exécuter de DDL :

```bash
npm run db:init -- --dry-run
```

Le dry-run se connecte tout de même à la base configurée dans `.env`. Il ne doit donc pas être confondu avec une vérification locale hors connexion.

Les notifications de disponibilité utilisent les tables `content_notification_trackers` et `content_notification_events`. Il faut donc exécuter `npm run db:init` avant d'activer le planificateur sur une base existante. Le premier scan crée une référence sans envoyer les disponibilités historiques ; les scans suivants n'alertent que les nouvelles transitions et regroupent les épisodes d'une même série.

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
|-- services/contentNotifications/ # Scan quotidien, disponibilité et Web Push
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
- scraping / proxy : `PROXY_SERVER_URL`, `CF_PROXY_403_URL`, `BYPASS403_SERVER_URL`, `SOCKS5_PROXIES`, `HTTP_PROXIES`
- anti-abuse / forms : `TURNSTILE_SECRET_KEY`, `TURNSTILE_INVISIBLE_SECRETKEY`
- paiement / VIP : variables `VIP_*`, `BLOCKCYPHER_TOKEN`

Certaines intégrations sont très spécifiques à des sources données, par exemple les cookies `DARKIWORLD_*`, `FSTREAM_LOGIN_*` ou `XTREAM_*`.

## Source téléchargements (Darkino)

La source téléchargements (`routes/darkiworld.js` + `utils/darkiworldSqlite.js`) lit des snapshots SQLite locaux au lieu de scraper à chaud : `mirror.sqlite`, `darkino.sqlite` et `links_small.sqlite`. Ces fichiers ne sont pas versionnés — il faut les récupérer et les extraire dans `darkino-backups/` :

1. Télécharger l'archive : https://pixeldrain.com/u/n2M1s1MA
2. Extraire les `.sqlite` dans `API/Mainapi/darkino-backups/`
3. (Optionnel) pointer `DARKIWORLD_SQLITE_DIR` vers un autre dossier absolu — ex Pterodactyl : `/home/container/darkino-backups`

Sans ces fichiers, chaque décodage de lien renvoie `sqlite_miss` (le fallback live hydracker ne s'active que si `HYDRACKER_LIVE_ENABLED=true`).

## Points d'entrée utiles

- auth et profils : `routes/authRoutes.js`, `routes/sessions.js`, `routes/profiles.js`
- persistance frontend : `routes/sync.js`
- recherche et catalogues : `routes/search.js`, `routes/tmdb.js`
- scraping / lecture : `routes/cpasmal.js`, `routes/fstream.js`, `routes/wiflix.js`, `liveTvRoutes.js`
- communautaire : `commentsRoutes.js`, `likesRoutes.js`, `sharedListsRoutes.js`, `wishboardRoutes.js`, `linkSubmissionsRoutes.js`
- VIP / paiements : `utils/vipDonations.js`, `routes/vipDonations.js`

## À garder en tête

- Le backend actif est ici, pas dans l'ancien contenu direct de `API/`.
- Un petit bootstrap de compatibilité initialise encore quelques tables au démarrage ; pour créer ou compléter le schéma MainAPI, utilise [l'initialiseur MySQL](#initialiser-ou-compléter-le-schéma-mysql).
- Une partie du comportement applicatif dépend de caches disque et de proxys externes ; un bug peut venir d'ailleurs que du code route lui-même.
- Si une feature touche la lecture vidéo, regarde aussi `API/proxiesembed/`, `API/miscs/` et parfois l'extension navigateur.
