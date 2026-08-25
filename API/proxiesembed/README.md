# Proxies Embed

`API/proxiesembed/` est le gros proxy Python du projet. Il sert à la fois de proxy de streaming, de boîte à outils pour certains extracteurs d'hosters, de passerelle DRM et de couche de contournement pour des cas où le frontend ou le backend Node ne suffisent plus.

Le service est écrit avec `aiohttp` et pensé pour la charge : connexions concurrentes, caches mémoire, coalescing de requêtes, pools proxy et endpoints spécialisés par hoster.

## Ce que le service fait

- proxy générique de flux via `/proxy`
- extracteurs dédiés pour plusieurs hosters embed
- endpoints proxy spécialisés par source
- debrid unlock via API
- surface DRM avec extraction de manifestes et réécriture de ressources
- vérification d'accès VIP via MySQL
- support de pools SOCKS5 et de sessions dédiées pour certains cas comme france.tv

## Démarrage

```bash
cd API/proxiesembed
cp .env.example .env
pip install -r requirements.txt
python server.py
```

Notes utiles :

- le code bind actuellement sur `http://localhost:25569`
- le fichier `.env.example` contient `PORT`, mais `server.py` écoute aujourd'hui `25569` en dur
- certaines routes DRM s'appuient sur des utilitaires additionnels dans `drmproxy/` ; si ces utilitaires sont absents, le serveur démarre quand même mais la partie DRM avancée reste limitée

## Modèle d'accès (important)

Ce service n'est **plus** appelable librement. Deux verrous, tous deux
*fail-closed* : si le secret correspondant manque, la surface est refusée plutôt
qu'ouverte.

**1. Les surfaces de streaming exigent une URL signée.**
`/proxy`, tous les `/*-proxy` dédiés et les routes `/drm/*` n'acceptent qu'une
URL accompagnée de `exp` + `sig`, une signature HMAC-SHA256 calculée sur
`route\ncible\nexpiration` avec `MEDIA_SIGNING_SECRET`. La signature est produite
soit par mainapi (`API/Mainapi/utils/mediaSigning.js`), soit par ce service
lui-même quand il réécrit une playlist. Conséquence : `/proxy?url=<n'importe
quoi>` renvoie 403 — c'est ce qui ferme la SSRF.

Comme la route fait partie du message signé, une URL signée pour
`/fsvid-proxy` ne peut pas être rejouée sur `/vidmoly-proxy` pour emprunter la
sortie SOCKS de ce dernier.

Aucune route de streaming n'est exemptée (`SELF_VALIDATED_PROXY_ROUTES` est vide
dans `server.py` ; la constante subsiste pour qu'ajouter une exception reste un
geste explicite et relisible).

**2. Les surfaces d'extraction exigent la clé interne.**
`/api/extract-*`, `/api/voe/m3u8`, `/drm/extract` et `/api/debrid/unlock`
réclament le header `x-internal-key` (`INTERNAL_API_KEY`), que seul mainapi
connaît, **et** une clé VIP valide (`x-access-key`) que mainapi retransmet. Une
fuite de la seule clé interne ne suffit donc pas.

Le navigateur passe désormais par mainapi. Les routes catalogue résolvent
elles-mêmes les m3u8, à la demande, quand la requête porte **`?resolve=1`** et
une clé VIP valide :

| Catalogue | Film | Série |
| --- | --- | --- |
| fstream | `/api/fstream/movie/:id` | `/api/fstream/tv/:id/season/:s?episode=N` |
| wiflix | `/api/wiflix/movie/:id` | `/api/wiflix/tv/:id/:season` |
| 1jour1film | `/api/j1f/movie/:id` | `/api/j1f/tv/:id/season/:s?episode=N` |
| swiftflow | `/api/swiftflow/movie/:id` | `/api/swiftflow/tv/:id/season/:s?episode=N` |
| cpasmal | `/api/cpasmal/movie/:id` | `/api/cpasmal/tv/:id/:season/:episode` |
| voirdrama | — | `/api/drama/tv/:id?season=&episode=` |
| coflix | `/api/tmdb/movie/:id` | `/api/tmdb/tv/:id?season=&episode=` |
| frenchstream | `/api/imdb/movie/:id` | — (voir ci-dessous) |

Sans `resolve=1`, aucune extraction : le serveur ne doit pas résoudre pour un
client qui refait le travail de son côté. La résolution ne porte que sur ce qui
est demandé — un épisode, ou le film — jamais sur une saison entière.

Chaque lecteur résolu reçoit un champ `m3u8Url` en plus de son lien embed, que
le client conserve pour son repli (extension, lecteur iframe).

**Anime-Sama** liste ses lecteurs en chaînes brutes (`players: ["https://…"]`)
et non en objets : y greffer un champ casserait la forme de la réponse. Sa
route joint donc à l'épisode une table parallèle `m3u8ByPlayer` (« lien →
m3u8 »), demandée par `?resolve=1&season=N&episode=M`.

**frenchstream en série** reste la seule source non résolue : sa réponse porte
toutes les saisons et l'endpoint n'accepte pas d'épisode, donc résoudre
reviendrait à extraire une série entière. Ses films sont couverts. Ces sources
restent lisibles via l'extension, qui extrait localement dans le navigateur.

## Ce qui n'existe volontairement pas

- **Aucun endpoint « signe-moi cette URL »** : ce serait un oracle de signature.
- **Aucun endpoint « extrais-moi cette URL »**. `/api/media/extract/:provider`
  a été supprimé : même bordé (VIP, adresse publique, allowlist de providers),
  il laissait le client choisir la cible. Les m3u8 sont désormais résolues
  uniquement à partir des liens que le serveur a lui-même scrapés, et le client
  ne transmet que des identifiants (tmdbId, saison, épisode).

France.tv ne fait pas exception. L'adresse de la page doit transiter par le
navigateur (catalogue → lecteur), mais elle part emballée dans un **jeton
signé** : `/api/ftv/search` joint un `url_token` à chaque résultat, et
`/api/ftv/info`, `/api/ftv/episodes` et `/api/media/drm/extract` n'acceptent
plus que ce jeton. Le client transporte, il ne choisit pas — un jeton forgé,
modifié ou expiré est rejeté.

Au passage, les anciens `?url=` de `/api/ftv/info` et `/api/ftv/episodes` se
contentaient d'un `url.includes('france.tv')`, que
`https://interne.exemple/france.tv` satisfaisait.

## Variables d'environnement utiles

Le fichier `API/proxiesembed/.env.example` couvre les besoins principaux :

- base de données : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- exposition publique : `PROXY_BASE`
- **sécurité** : `MEDIA_SIGNING_SECRET`, `INTERNAL_API_KEY`, `MEDIA_SIGNATURE_TTL`
  — les deux secrets doivent porter **exactement la même valeur** que côté
  mainapi, sinon plus rien ne se lit
- pools proxies : `PROXIES_SOCKS5_JSON`, `SIBNET_PROXY_SOCKS5_JSON`
- france.tv : `FRANCETV_EMAIL`, `FRANCETV_PASSWORD`
- debrid : `DEEPBRID_API_KEY`

## Endpoints à connaître

Légende : 🔏 = URL signée obligatoire · 🔑 = clé interne mainapi + clé VIP

| Route | Rôle |
| --- | --- |
| `GET /proxy` et `GET /proxy/{path}` | 🔏 Proxy streaming générique |
| `GET /health` | Healthcheck |
| `GET /stats` | Stats runtime |
| `GET /api/voe/m3u8` | 🔑 Extraction VOE (paramètre `url` en base64) |
| `GET /api/extract-fsvid` | 🔑 Extraction FSVid |
| `GET /api/extract-vidzy` | 🔑 Extraction Vidzy |
| `GET /api/extract-vidmoly` | 🔑 Extraction Vidmoly |
| `GET /api/extract-sibnet` | 🔑 Extraction Sibnet |
| `GET /api/extract-uqload` | 🔑 Extraction Uqload |
| `GET /api/extract-doodstream` | 🔑 Extraction Doodstream |
| `GET /api/extract-seekstreaming` | 🔑 Extraction SeekStreaming |
| `GET /voe-proxy`, `/fsvid-proxy`, `/vidzy-proxy`, `/vidmoly-proxy`, `/sibnet-proxy`, `/uqload-proxy`, `/doodstream-proxy`, `/cinep-proxy`, `/kisskh-proxy`, `/seekstreaming-proxy` | 🔏 Proxies dédiés par source |
| `GET/POST /drm/extract` | 🔑 Extraction de manifeste DRM |
| `GET /drm/manifest` | 🔏 Réécriture de manifeste HLS ou DASH |
| `GET /drm/resource` | 🔏 Proxy de ressources DRM |
| `GET /drm/b/{base_b64}/{subpath}` | 🔏 Proxy path-based pour DASH (signature dans le blob) |
| `POST /api/debrid/unlock` | 🔑 Unlock de liens debrid |

## Notes d'architecture

- le serveur initialise plusieurs sessions HTTP spécialisées
- certaines ressources lourdes sont cachées en mémoire avec eviction TTL
- la partie france.tv peut utiliser une session SOCKS5H distincte pour l'extraction
- la partie DRM tente de charger les utilitaires WideFrog au démarrage, mais reste optionnelle
- la vérification VIP s'appuie sur MySQL avant d'autoriser certaines surfaces

## Quand regarder aussi ailleurs

Si tu touches ce dossier, il faut souvent vérifier en miroir :

- `API/Mainapi/liveTvRoutes.js`
- `API/Mainapi/routes/debrid.js`
- `src/pages/Watch/`
- `src/components/*Player*`
- `cloudflareproxy/` selon les flux concernés
