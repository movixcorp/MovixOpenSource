# Services backend Movix

Le dossier `API/` regroupe les services serveurs du projet. Le point clé à retenir : le backend applicatif actif est `API/Mainapi/`. Le vieux backend directement posé sous `API/` n'est plus la référence.

Movix ne tourne pas sur un seul serveur monolithique. Selon la feature, le frontend peut parler au backend principal, à la WatchParty, à un proxy Python, à un worker Cloudflare ou à un outil navigateur.

## Carte rapide

| Dossier | Rôle | Lancement | Documentation |
| --- | --- | --- | --- |
| `API/Mainapi/` | Cœur applicatif : auth, sync, scraping, social, VIP, Live TV | `cd API/Mainapi && npm run dev` | [README](Mainapi/README.md) |
| `API/watchpartyAPI/` | Service temps réel WatchParty | `node API/watchpartyAPI/watchparty.js` | [README](watchpartyAPI/README.md) |
| `API/proxiesembed/` | Proxy aiohttp pour embeds, flux et DRM | `cd API/proxiesembed && python server.py` | [README](proxiesembed/README.md) |

## Setup minimal

Commandes utiles pour préparer le dossier `API/` :

```bash
# Backend principal
cd API/Mainapi
npm install
```

```bash
# Services Python
cd API/proxiesembed
pip install -r requirements.txt
```

### Configurer les `.env`

Avant de lancer les services backend, crée et renseigne leurs fichiers de configuration :

```bash
cp API/Mainapi/.env.example API/Mainapi/.env
cp API/watchpartyAPI/.env.example API/watchpartyAPI/.env
cp API/proxiesembed/.env.example API/proxiesembed/.env
```

Note utile :

- `API/watchpartyAPI/` n'a pas son propre `package.json` ; il utilise les dépendances racine.
- `API/Mainapi/` garde ses dépendances Node.
- Il n'y a pas de workspace tooling pour tout orchestrer d'un coup.

## Comment lire cette partie du repo

- Si tu touches auth, profils ou persistance utilisateur, commence par `API/Mainapi/app.js` et `API/Mainapi/routes/`.
- Si tu touches la lecture en groupe, regarde `API/watchpartyAPI/watchparty.js` en miroir du frontend WatchParty.
- Si tu touches la lecture vidéo ou les hosters, il faut souvent croiser `API/Mainapi/`, `API/proxiesembed/` et parfois `cloudflareproxy/`.

## Stockage et dépendances

Selon les services, le backend Movix s'appuie sur :

- MySQL
- Redis
- caches JSON sur disque
- stockage local en mémoire pour certains services temps réel
- SQLite et fichiers de data sur quelques briques annexes

## Lire ensuite

- [README principal](../README.md)
- [Main API](Mainapi/README.md)
- [WatchParty API](watchpartyAPI/README.md)
- [Proxies Embed](proxiesembed/README.md)
