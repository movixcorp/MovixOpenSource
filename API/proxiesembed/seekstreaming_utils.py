from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass
from typing import Literal, Mapping, Sequence
from urllib.parse import unquote, urlencode, urlsplit, urlunsplit

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

SEEKSTREAMING_HOSTS = frozenset({
    "embed4me.com",
    "servicecatalog.site",
    "technicalcatalog.site",
    "embedseek.com",
    "embedseek.online",
    "embedseek.xyz",
    "seekplayer.me",
    "seekplayer.vip",
    "seeks.cloud",
    "seekplays.com",
    "seekplays.ink",
    "seekplays.online",
    "seekplays.pro",
})
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
LEGACY_IPV4_PART_RE = re.compile(r"(?:[0-9]+|0[xX][0-9A-Fa-f]+)")


@dataclass(frozen=True, slots=True)
class SeekStreamingEmbed:
    host: str
    video_id: str
    origin: str
    referer: str


@dataclass(frozen=True, slots=True)
class SeekStreamingCandidate:
    kind: Literal["cfNative", "source"]
    url: str


def is_seekstreaming_host(host: str) -> bool:
    normalized = host.rstrip(".").lower()
    return any(normalized == root or normalized.endswith(f".{root}") for root in SEEKSTREAMING_HOSTS)


def _decode_url(raw_url: str) -> str:
    decoded = raw_url.strip()
    for _ in range(2):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    return decoded


def normalize_seekstreaming_origin(raw_url: str) -> str:
    if not isinstance(raw_url, str) or CONTROL_RE.search(raw_url):
        raise ValueError("Invalid SeekStreaming origin")
    parsed = urlsplit(raw_url.strip())
    host = (parsed.hostname or "").rstrip(".").lower()
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid SeekStreaming origin") from exc
    if (
        parsed.scheme != "https"
        or not host
        or not is_seekstreaming_host(host)
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        raise ValueError("Invalid SeekStreaming origin")
    return f"https://{host}"


def parse_seekstreaming_embed_url(raw_url: str) -> SeekStreamingEmbed:
    if not isinstance(raw_url, str) or CONTROL_RE.search(raw_url):
        raise ValueError("Invalid SeekStreaming URL")
    decoded = _decode_url(raw_url)
    parsed = urlsplit(decoded)
    host = (parsed.hostname or "").rstrip(".").lower()
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid SeekStreaming URL") from exc
    if (
        parsed.scheme != "https"
        or not host
        or not is_seekstreaming_host(host)
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        raise ValueError("Invalid SeekStreaming URL")
    video_id = parsed.fragment.split("&", 1)[0].split("?", 1)[0].strip()
    if not video_id:
        path_parts = [part for part in parsed.path.split("/") if part]
        if len(path_parts) >= 2 and path_parts[-2].lower() == "embed":
            video_id = path_parts[-1]
        elif path_parts:
            candidate = path_parts[-1]
            video_id = candidate[1:] if candidate.startswith("#") else candidate
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise ValueError("Invalid SeekStreaming video ID")
    origin = normalize_seekstreaming_origin(decoded)
    return SeekStreamingEmbed(host=host, video_id=video_id, origin=origin, referer=f"{origin}/")


def validate_seekstreaming_media_url(raw_url: object) -> str:
    if not isinstance(raw_url, str) or CONTROL_RE.search(raw_url):
        raise ValueError("Invalid SeekStreaming media URL")
    parsed = urlsplit(raw_url.strip())
    host = (parsed.hostname or "").rstrip(".").lower()
    if (
        parsed.scheme not in ("http", "https")
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or host == "localhost"
        or host.endswith(".local")
    ):
        raise ValueError("Invalid SeekStreaming media URL")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid SeekStreaming media URL") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("Invalid SeekStreaming media URL")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        try:
            validate_seekstreaming_resolved_address(host)
        except ValueError as exc:
            raise ValueError("Invalid SeekStreaming media URL") from exc
    if address is None:
        parts = host.split(".")
        if parts and all(LEGACY_IPV4_PART_RE.fullmatch(part) for part in parts):
            raise ValueError("Invalid SeekStreaming media URL")
    return urlunsplit(parsed)


def validate_seekstreaming_resolved_address(raw_address: object) -> str:
    if not isinstance(raw_address, str):
        raise ValueError("Invalid SeekStreaming resolved address")
    try:
        address = ipaddress.ip_address(raw_address)
    except ValueError as exc:
        raise ValueError("Invalid SeekStreaming resolved address") from exc
    if not address.is_global or address.is_multicast:
        raise ValueError("Invalid SeekStreaming resolved address")
    return str(address)


def decrypt_seekstreaming_payload(ciphertext: str, key: bytes, iv: bytes) -> dict[str, object]:
    if not isinstance(ciphertext, str):
        raise ValueError("Invalid encrypted payload")
    cleaned = ciphertext.strip().strip('"')
    if not cleaned or len(cleaned) % 32 != 0 or not re.fullmatch(r"[0-9a-fA-F]+", cleaned):
        raise ValueError("Invalid encrypted payload")
    decrypted = unpad(AES.new(key, AES.MODE_CBC, iv).decrypt(bytes.fromhex(cleaned)), AES.block_size)
    payload = json.loads(decrypted.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Invalid decrypted payload")
    return payload


def _is_historical_cf_master(raw_url: object) -> bool:
    if not isinstance(raw_url, str):
        return False
    decoded = raw_url.strip()
    for _ in range(16):
        if "cf-master" in decoded.lower():
            return True
        next_value = unquote(decoded)
        if next_value == decoded:
            return False
        decoded = next_value
    # Excessive encoding cannot be a directly playable URL. Reject it rather
    # than letting an opaque legacy candidate shadow master/masterUrl.
    return True


def extract_seekstreaming_candidates(payload: Mapping[str, object]) -> tuple[SeekStreamingCandidate, ...]:
    ordered: list[SeekStreamingCandidate] = []
    seen: set[str] = set()

    source_value = None
    for source_key in ("source", "master", "masterUrl"):
        raw_source = payload.get(source_key)
        if _is_historical_cf_master(raw_source):
            continue
        try:
            source_value = validate_seekstreaming_media_url(raw_source)
        except ValueError:
            continue
        break

    for kind, raw_url in (("cfNative", payload.get("cfNative")), ("source", source_value)):
        try:
            url = validate_seekstreaming_media_url(raw_url)
        except ValueError:
            continue
        if url in seen:
            continue
        seen.add(url)
        ordered.append(SeekStreamingCandidate(kind=kind, url=url))
    return tuple(ordered)


def build_seekstreaming_cache_key(host: str, video_id: str) -> str:
    return hashlib.sha256(f"{host.lower()}\0{video_id}".encode("utf-8")).hexdigest()


def _proxy_candidate_url(
    candidate: SeekStreamingCandidate,
    *,
    proxy_base: str,
    embed_origin: str,
    cache_key: str,
) -> str:
    query = urlencode({
        "url": candidate.url,
        "referer": f"{embed_origin}/",
        "origin": embed_origin,
        "cache_key": cache_key,
    })
    return f"{proxy_base.rstrip('/')}/seekstreaming-proxy?{query}"


def build_seekstreaming_result(
    candidates: Sequence[SeekStreamingCandidate],
    *,
    proxy_base: str,
    embed_origin: str,
    cache_key: str,
) -> dict[str, object]:
    proxied = [
        {
            "kind": candidate.kind,
            "url": _proxy_candidate_url(
                candidate,
                proxy_base=proxy_base,
                embed_origin=embed_origin,
                cache_key=cache_key,
            ),
        }
        for candidate in candidates
    ]
    if not proxied:
        raise ValueError("No SeekStreaming playback candidate")
    result: dict[str, object] = {
        "source": "seekstreaming",
        "url": proxied[0]["url"],
        "candidates": proxied,
    }
    source = next((item for item in proxied if item["kind"] == "source"), None)
    if source:
        result["ip_url"] = source["url"]
    return result


def redact_url_for_log(raw_url: str) -> str:
    try:
        parsed = urlsplit(raw_url)
        host = parsed.hostname
        port = parsed.port
        if not parsed.scheme or not host:
            return "<redacted>"
        authority = f"[{host}]" if ":" in host else host
        if port is not None:
            authority = f"{authority}:{port}"
        return f"{parsed.scheme}://{authority}/<redacted>"
    except Exception:
        return "<redacted>"


def is_hls_response(
    request_url: str,
    response_url: str,
    content_type: str,
    body_prefix: bytes | None = None,
) -> bool:
    if body_prefix is not None:
        return has_hls_manifest_signature(body_prefix)
    urls = (request_url.lower().split("?", 1)[0], response_url.lower().split("?", 1)[0])
    return (
        any(url.endswith((".m3u8", ".m3u")) for url in urls)
        or "mpegurl" in content_type.lower()
    )


def has_hls_manifest_signature(body: bytes) -> bool:
    return bool(body) and body.lstrip().startswith(b"#EXTM3U")
