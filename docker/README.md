# Movix — Docker

Stack containerisée pour lancer tout le monorepo en isolation (MySQL, Redis, backends, frontend).

## Prérequis

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS) ou Docker Engine + Compose v2
- ~4 Go RAM libres recommandés

## Démarrage rapide

```bash
# 1. Génère .env.docker + tous les .env des services
node scripts/docker-setup.mjs

# 2. Ajoute ta clé TMDB dans .env.docker (obligatoire pour la recherche)
#    TMDB_API_KEY=ta_cle_ici
#    Puis relance le script pour propager la clé, ou édite .env et API/Mainapi/.env

# 3. Lance toute la stack
docker compose up -d --build

# 4. Ouvre l'app
# http://localhost:3000
```

## Services exposés

| Service | URL hôte | Réseau interne |
|---------|----------|----------------|
| Frontend (Vite) | http://localhost:3000 | `frontend:3000` |
| Main API | http://localhost:25565 | `mainapi:25565` |
| WatchParty | http://localhost:25566 | `watchparty:25566` |
| bypass403 | http://localhost:25568 | `bypass403:25568` |
| Proxies Embed | http://localhost:25569 | `proxiesembed:25569` |
| MySQL | *(non exposé)* | `mysql:3306` |
| Redis | *(non exposé)* | `redis:6379` |

MySQL et Redis ne sont **pas** mappés sur l'hôte : seuls les conteneurs y accèdent.

## Commandes utiles

```powershell
docker compose ps
docker compose logs -f mainapi
docker compose down
docker compose down -v   # supprime aussi les volumes (reset DB)
```

## Fichiers de config

| Fichier | Rôle |
|---------|------|
| `.env.docker` | Secrets partagés compose (MySQL, Redis, TMDB) |
| `.env` | Frontend Vite |
| `API/Mainapi/.env` | Backend principal |
| `API/watchpartyAPI/.env` | WatchParty |
| `API/proxiesembed/.env` | Proxy Python |
| `API/miscs/.env` | bypass403 |

## Notes

- Les mots de passe par défaut sont pour le **dev local uniquement**.
- Certaines features (Turnstile, VIP, scraping avancé) nécessitent des clés/API externes — voir les `.env.example` de chaque service.
- Les fichiers SQLite Darkino ne sont pas inclus ; la source téléchargements reste limitée sans eux.
