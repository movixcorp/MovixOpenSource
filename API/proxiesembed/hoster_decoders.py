"""Décodeurs purs des hébergeurs (Voe, Veev) — sans I/O réseau.

Isolés de `server.py` pour rester testables : ce sont des transformations
déterministes chaîne -> chaîne, alignées sur les plugins ResolveURL
(`voesx.py`, `veev.py`).
"""

from __future__ import annotations

import base64
import binascii
import codecs
import json
import re
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Voe
# ---------------------------------------------------------------------------
# Voe empile toujours la même pile (rotation ROT13 -> retrait de marqueurs ->
# base64 -> décalage -3 -> inversion -> base64 -> JSON), mais la liste des
# marqueurs à retirer est régénérée à chaque déploiement et publiée dans le
# bundle JS de la page. L'ancienne implémentation la figeait en dur, donc
# l'extraction cassait à chaque rotation ; on la lit désormais dans le bundle,
# la liste figée ne servant plus que de repli.
VOE_LEGACY_MARKERS = ('@$', '^^', '~@', '%?', '*~', '!!', '#&')

# `<script type="application/json">["…"]</script><script src="…">` : la charge
# chiffrée et le bundle qui porte la table des marqueurs sont adjacents.
VOE_PAYLOAD_RE = re.compile(
    r'json">\s*\[\s*"([^"]+)"\s*\]\s*</script>\s*<script[^>]*src="([^"]+)"',
    re.IGNORECASE,
)
# Table des marqueurs dans le bundle : `['@$','^^','~@',…]`, chaque entrée
# faisant exactement deux caractères non alphanumériques.
VOE_MARKER_TABLE_RE = re.compile(r"(\[(?:'\W{2}'[,\]]){1,9})")
# Redirection JS avant d'atteindre la vraie page embed.
VOE_REDIRECT_RE = re.compile(r"""window\.location\.href\s*=\s*['"]([^'"]+)['"]""")
VOE_REDIRECT_MARKER = 'const currentUrl'

# Repli « sources en clair » quand la page n'utilise pas la pile chiffrée.
VOE_PLAIN_SOURCE_PATTERNS = (
    re.compile(r"""["']hls["']\s*:\s*["']([^"']+)["']""", re.IGNORECASE),
    re.compile(r"""["']mp4["']\s*:\s*["']([^"']+)["']""", re.IGNORECASE),
)


def _b64decode_str(value: str) -> str:
    """base64 tolérant au padding manquant, tel que servi par Voe."""
    padding = (4 - len(value) % 4) % 4
    return base64.b64decode(value + '=' * padding).decode('utf-8')


def parse_voe_marker_table(bundle_js: str) -> Optional[List[str]]:
    """Marqueurs à retirer, lus dans le bundle JS de la page embed."""
    match = VOE_MARKER_TABLE_RE.search(str(bundle_js or ''))
    if not match:
        return None
    # `['@$','^^']` -> ['@$', '^^'] : on retire les crochets et les quotes
    # extérieures avant de découper sur le séparateur `','`.
    markers = match.group(1)[2:-2].split("','")
    return [marker for marker in markers if marker]


def decrypt_voe_payload(encrypted: str, markers=VOE_LEGACY_MARKERS) -> Optional[Dict[str, Any]]:
    """Déchiffre la charge Voe et renvoie sa configuration de lecteur."""
    try:
        step1 = codecs.encode(str(encrypted or ''), 'rot13')
        for marker in markers:
            step1 = step1.replace(marker, '')

        step2 = _b64decode_str(step1)
        step3 = ''.join(chr(ord(char) - 3) for char in step2)[::-1]
        parsed = json.loads(_b64decode_str(step3))
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        return None


# Voe range son flux sous l'une de ces clés selon la version du lecteur.
VOE_SOURCE_KEYS = ('source', 'file', 'direct_access_url')


def pick_voe_source(decrypted: Dict[str, Any]) -> Optional[str]:
    """URL de flux d'une configuration Voe déchiffrée, HLS d'abord."""
    if not isinstance(decrypted, dict):
        return None

    candidates = [
        value
        for key in VOE_SOURCE_KEYS
        for value in (decrypted.get(key),)
        if isinstance(value, str) and value.startswith('http')
    ]
    if not candidates:
        return None
    # Le HLS est proxifiable et réécrit par nos routes ; le MP4 ne sert que de
    # repli quand la page n'expose que lui.
    return next((url for url in candidates if '.m3u8' in url), candidates[0])


def extract_voe_plain_source(html: str) -> Optional[str]:
    """Flux d'une page Voe qui n'utilise pas la pile chiffrée."""
    content = str(html or '')
    for pattern in VOE_PLAIN_SOURCE_PATTERNS:
        match = pattern.search(content)
        if match:
            candidate = match.group(1).replace('\\/', '/')
            if candidate.startswith('http'):
                return candidate
    return None


def extract_voe_subtitles(decrypted: Dict[str, Any], base_url: str) -> Dict[str, str]:
    """Table `langue -> URL` des sous-titres d'une configuration Voe."""
    captions = decrypted.get('captions') if isinstance(decrypted, dict) else None
    if not isinstance(captions, list):
        return {}

    origin = ''
    match = re.match(r'(https?://[^/]+)', str(base_url or ''))
    if match:
        origin = match.group(1)

    subtitles: Dict[str, str] = {}
    for caption in captions:
        if not isinstance(caption, dict) or caption.get('kind') != 'captions':
            continue
        label = caption.get('label')
        file_url = caption.get('file')
        if not isinstance(label, str) or not isinstance(file_url, str) or not file_url:
            continue
        subtitles[label] = file_url if file_url.startswith('http') else f'{origin}{file_url}'
    return subtitles


# ---------------------------------------------------------------------------
# Veev
# ---------------------------------------------------------------------------
# Veev cache la clé `ch` de son API dans la page sous forme LZW, puis renvoie
# l'URL du flux elle-même encodée (LZW + n passes hex, l'ordre des passes étant
# dérivé de `ch`).
VEEV_CHALLENGE_RE = re.compile(
    r"""[.\s'](?:fc|_vvto\[[^\]]*)(?:['\]]*)?\s*[:=]\s*['"]([^'"]+)['"]"""
)
VEEV_UTF8_PADDING = 'dXRmOA=='
# Une charge saine tient largement dedans ; au-delà on est sur une page piégée
# ou corrompue et le décodage ne ferait que consommer du CPU.
VEEV_MAX_PAYLOAD = 200_000


def veev_lzw_decode(encoded: str) -> str:
    """Décompression LZW telle qu'implémentée par le lecteur Veev."""
    text = str(encoded or '')
    if not text:
        return ''

    result = [text[0]]
    lut: Dict[int, str] = {}
    next_code = 256
    current = text[0]

    for char in text[1:]:
        code = ord(char)
        nxt = char if code < 256 else lut.get(code, current + current[0])
        result.append(nxt)
        lut[next_code] = current + nxt[0]
        next_code += 1
        current = nxt

    return ''.join(result)


def _js_int(value: str) -> int:
    """`parseInt` façon JS : un caractère non numérique vaut 0, pas une erreur."""
    return int(value) if value.isdigit() else 0


def veev_build_array(challenge: str) -> List[List[int]]:
    """Décode la clé `ch` en la suite d'opérations à rejouer sur l'URL."""
    groups: List[List[int]] = []
    chars = list(str(challenge or ''))
    if not chars:
        return groups

    count = _js_int(chars.pop(0))
    while count:
        current: List[int] = []
        for _ in range(count):
            if not chars:
                return groups
            current.insert(0, _js_int(chars.pop(0)))
        groups.append(current)
        if not chars:
            break
        count = _js_int(chars.pop(0))

    return groups


def veev_decode_url(encoded: str, operations: List[int]) -> Optional[str]:
    """Rejoue les passes hex (et l'inversion éventuelle) sur l'URL encodée."""
    decoded = str(encoded or '')
    if not decoded or len(decoded) > VEEV_MAX_PAYLOAD:
        return None

    try:
        for operation in operations:
            if operation == 1:
                decoded = decoded[::-1]
            decoded = binascii.unhexlify(decoded).decode('utf-8')
            decoded = decoded.replace(VEEV_UTF8_PADDING, '')
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None

    return decoded if decoded.startswith('http') else None


def extract_veev_challenges(html: str) -> List[str]:
    """Clés `ch` candidates d'une page Veev, de la plus récente à la plus ancienne."""
    matches = VEEV_CHALLENGE_RE.findall(str(html or ''))
    challenges = []
    for raw in reversed(matches):
        if len(raw) > VEEV_MAX_PAYLOAD:
            continue
        decoded = veev_lzw_decode(raw)
        # Une charge non compressée se décode en elle-même : ce n'est pas une clé.
        if decoded and decoded != raw:
            challenges.append(decoded)
    return challenges
