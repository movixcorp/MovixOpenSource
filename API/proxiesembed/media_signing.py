"""Signature HMAC des URLs média émises par le backend.

Ce module ferme la faille SSRF de `/proxy` : le service n'accepte plus une URL
arbitraire fournie par le client, mais uniquement une URL que *nous* avons
signée (soit mainapi, soit ce service lui-même en réécrivant une playlist).

Principe
--------
Chaque URL proxifiée porte deux paramètres supplémentaires :

    ?exp=<epoch_secondes>&sig=<base64url(HMAC-SHA256)>

La signature couvre `route` + `cible` + `exp`. Un client ne peut donc ni
changer la destination, ni prolonger la validité, sans connaître le secret
partagé `MEDIA_SIGNING_SECRET` (le même côté Node dans
`API/Mainapi/utils/mediaSigning.js` — les deux implémentations doivent rester
strictement alignées sur la construction du payload).

Le TTL doit couvrir la durée d'une lecture : une playlist VOD signée au début
du film sert encore ses segments à la fin. D'où un défaut généreux (12 h) —
la signature borne le rejeu, elle ne sert pas de session courte.
"""

import base64
import hashlib
import hmac
import ipaddress
import logging
import os
import re
import socket
import time
import urllib.parse
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Secret partagé avec mainapi. Sans lui, aucune URL ne peut être signée ni
# vérifiée : le service refuse alors tout le trafic média (fail-closed).
SIGNING_SECRET = str(os.environ.get('MEDIA_SIGNING_SECRET', '') or '').strip()

# Clé interne mainapi -> proxiesembed pour les surfaces d'extraction.
INTERNAL_API_KEY = str(os.environ.get('INTERNAL_API_KEY', '') or '').strip()

INTERNAL_KEY_HEADER = 'x-internal-key'


def _get_env_int(name: str, fallback: int) -> int:
    raw = str(os.environ.get(name, '') or '').strip()
    if not raw:
        return fallback
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning('[signing] %s invalide, fallback=%s', name, fallback)
        return fallback


# 12 h par défaut : couvre une lecture complète, y compris une pause longue.
SIGNATURE_TTL = _get_env_int('MEDIA_SIGNATURE_TTL', 43200)

# Tolérance de dérive d'horloge entre mainapi et ce service.
CLOCK_SKEW_TOLERANCE = 300

# Paramètres réservés à la signature : ils ne doivent jamais fuiter en amont.
SIGNATURE_PARAMS = ('exp', 'sig')


class SigningNotConfigured(RuntimeError):
    """Levée quand une URL doit être signée sans secret configuré."""


def signing_configured() -> bool:
    return bool(SIGNING_SECRET)


def internal_key_configured() -> bool:
    return bool(INTERNAL_API_KEY)


def _build_payload(route: str, target: str, exp: int) -> bytes:
    # `\n` comme séparateur : il ne peut apparaître ni dans une route ni dans
    # une URL valide, donc aucune confusion de frontière n'est possible.
    return f'{route}\n{target}\n{exp}'.encode('utf-8')


def compute_signature(route: str, target: str, exp: int) -> str:
    if not SIGNING_SECRET:
        raise SigningNotConfigured('MEDIA_SIGNING_SECRET absent')
    digest = hmac.new(
        SIGNING_SECRET.encode('utf-8'),
        _build_payload(route, target, exp),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')


def sign_query(route: str, target: str, ttl: Optional[int] = None) -> str:
    """Retourne le fragment `exp=...&sig=...` (sans `?` ni `&` initial)."""
    exp = int(time.time()) + int(ttl if ttl is not None else SIGNATURE_TTL)
    sig = compute_signature(route, target, exp)
    return f'exp={exp}&sig={urllib.parse.quote(sig, safe="")}'


def append_signature(url: str, route: str, target: str, ttl: Optional[int] = None) -> str:
    """Ajoute la signature à une URL déjà construite (relative ou absolue)."""
    separator = '&' if '?' in url else '?'
    return f'{url}{separator}{sign_query(route, target, ttl)}'


def verify_signature(route: str, target: str, exp_raw, sig_raw) -> Tuple[bool, str]:
    """Vérifie une signature. Retourne `(valide, raison_du_refus)`."""
    if not SIGNING_SECRET:
        return False, 'signing_not_configured'
    if not exp_raw or not sig_raw:
        return False, 'missing_signature'

    try:
        exp = int(str(exp_raw).strip())
    except (TypeError, ValueError):
        return False, 'invalid_exp'

    now = int(time.time())
    if exp < now - CLOCK_SKEW_TOLERANCE:
        return False, 'expired'
    # Une expiration trop lointaine trahit une signature forgée ou un secret
    # fuité réutilisé : on borne aussi par le haut.
    if exp > now + SIGNATURE_TTL + CLOCK_SKEW_TOLERANCE:
        return False, 'exp_too_far'

    try:
        expected = compute_signature(route, target, exp)
    except SigningNotConfigured:
        return False, 'signing_not_configured'

    # compare_digest : temps constant, pas d'oracle de timing sur la signature.
    if not hmac.compare_digest(expected, str(sig_raw).strip()):
        return False, 'bad_signature'

    return True, ''


def verify_request(request, route: str, target: str) -> Tuple[bool, str]:
    """Vérifie la signature portée par les query params d'une requête aiohttp."""
    return verify_signature(
        route,
        target,
        request.query.get('exp'),
        request.query.get('sig'),
    )


def check_internal_key(request) -> bool:
    """Vrai si la requête porte la clé interne mainapi -> proxiesembed."""
    if not INTERNAL_API_KEY:
        return False
    provided = request.headers.get(INTERNAL_KEY_HEADER, '')
    if not provided:
        return False
    return hmac.compare_digest(INTERNAL_API_KEY, provided.strip())


def redact_url(url: Optional[str]) -> str:
    """Réduit une URL à `schéma://hôte/chemin` pour les logs.

    Les query strings des CDN portent des jetons d'authentification : les
    journaliser telles quelles les expose à quiconque lit les logs.
    """
    if not url:
        return '(none)'
    try:
        parsed = urllib.parse.urlparse(str(url))
        if not parsed.netloc:
            return '(invalid-url)'
        suffix = '?…' if parsed.query else ''
        return f'{parsed.scheme}://{parsed.netloc}{parsed.path}{suffix}'
    except (TypeError, ValueError):
        return '(invalid-url)'


# ---------------------------------------------------------------------------
#  Encodage base signée pour les BaseURL DASH (/drm/b/<blob>/<subpath>)
# ---------------------------------------------------------------------------
# Une BaseURL DASH est un préfixe de chemin : y accrocher `?exp=&sig=` casserait
# la résolution des URLs relatives que le player construit par-dessus. On glisse
# donc la signature dans le blob base64 lui-même.

DRM_BASE_ROUTE = '/drm/b'


def encode_signed_drm_base(base_url: str, ttl: Optional[int] = None) -> str:
    exp = int(time.time()) + int(ttl if ttl is not None else SIGNATURE_TTL)
    sig = compute_signature(DRM_BASE_ROUTE, base_url, exp)
    blob = f'{exp}:{sig}:{base_url}'
    return base64.urlsafe_b64encode(blob.encode('utf-8')).decode('ascii').rstrip('=')


def decode_signed_drm_base(blob_b64: str) -> Tuple[Optional[str], str]:
    """Décode et vérifie un blob de BaseURL. Retourne `(base_url, raison)`."""
    padding = (4 - len(blob_b64) % 4) % 4
    try:
        decoded = base64.urlsafe_b64decode(blob_b64 + '=' * padding).decode('utf-8')
    except Exception:
        return None, 'invalid_encoding'

    parts = decoded.split(':', 2)
    if len(parts) != 3:
        return None, 'invalid_payload'

    exp_raw, sig_raw, base_url = parts
    valid, reason = verify_signature(DRM_BASE_ROUTE, base_url, exp_raw, sig_raw)
    if not valid:
        return None, reason
    return base_url, ''


# ---------------------------------------------------------------------------
#  Garde anti-SSRF sur la destination
# ---------------------------------------------------------------------------
# Défense en profondeur : même signée, une URL ne doit jamais viser le réseau
# interne. Protège contre un secret fuité et contre nos propres bugs de
# construction d'URL.

_BLOCKED_HOSTNAMES = frozenset({
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    # Endpoints de métadonnées cloud : cible SSRF classique (vol de creds IAM).
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
})


def is_public_http_url(url: str) -> bool:
    """Vrai si l'URL est http(s) et ne vise pas une adresse interne.

    N'effectue pas de résolution DNS : ce contrôle porte sur ce qui est
    littéralement écrit dans l'URL. La protection contre le DNS rebinding
    relève du resolver (cf. `PublicOnlyResolver`).
    """
    if not url or not isinstance(url, str):
        return False

    try:
        parsed = urllib.parse.urlparse(url)
    except (TypeError, ValueError):
        return False

    if parsed.scheme.lower() not in ('http', 'https'):
        return False

    hostname = (parsed.hostname or '').strip().rstrip('.').lower()
    if not hostname:
        return False

    if hostname in _BLOCKED_HOSTNAMES:
        return False

    # `.internal`, `.local`, `.localhost` : espaces de noms non routables.
    if hostname.endswith(('.internal', '.local', '.localhost', '.home.arpa')):
        return False

    ip = _parse_ip_literal(hostname.strip('[]'))
    if ip is None:
        # Nom de domaine : on ne peut rien conclure sans résolution DNS.
        return True

    # Une adresse IPv4 encapsulée dans de l'IPv6 doit être jugée sur l'IPv4
    # qu'elle transporte, sinon `::ffff:127.0.0.1` passerait pour publique.
    mapped = getattr(ip, 'ipv4_mapped', None)
    if mapped is not None:
        ip = mapped

    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _parse_ip_literal(host: str):
    """Reconnaît une IP écrite sous n'importe quelle forme acceptée par la résolution.

    `ipaddress` ne connaît que la notation canonique, alors que la résolution
    système accepte aussi les formes entière (`2130706433`), octale
    (`0177.0.0.1`) et abrégée (`127.1`) — toutes équivalentes à 127.0.0.1.
    Sans cette normalisation, elles étaient prises pour des noms de domaine et
    échappaient au contrôle.

    Retourne None si `host` n'est pas une IP littérale.
    """
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass

    # `inet_aton` couvre exactement les formes tolérées par le résolveur.
    try:
        packed = socket.inet_aton(host)
    except (OSError, UnicodeEncodeError):
        return None

    # inet_aton accepte aussi des noms purement numériques déjà gérés au-dessus ;
    # ici on ne retient que ce qui n'est pas un nom de domaine plausible.
    if not re.fullmatch(r'[0-9a-fA-FxX.]+', host):
        return None

    try:
        return ipaddress.IPv4Address(packed)
    except ValueError:
        return None
