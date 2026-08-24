#!/usr/bin/env python3
"""
Python Proxy Server - Ultra High Performance Version
Optimized for massive concurrent connections and high-load streaming
"""

import asyncio
import aiohttp
import json
import base64
import re
import urllib.parse
from urllib.parse import urlparse, urljoin
from aiohttp import web, ClientTimeout, TCPConnector
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import DefaultResolver
from aiohttp.web import Request, Response
import logging
import sys
from typing import Optional, Dict, Any, Tuple, Set
from dataclasses import dataclass
from functools import lru_cache
import codecs
import time
import hashlib
from bs4 import BeautifulSoup
from datetime import datetime, timezone
import ssl
import random
import socket
from aiohttp_socks import ProxyConnector
from collections import OrderedDict
import gc
import binascii
from string import ascii_letters, digits
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
import aiomysql
import os
import builtins
import traceback
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from uqload_utils import (
    extract_uqload_media_url,
    get_uqload_site_origin,
    normalize_uqload_embed_url,
    parse_allowed_uqload_url,
)
from seekstreaming_utils import (
    build_seekstreaming_cache_key,
    build_seekstreaming_result,
    decrypt_seekstreaming_payload,
    extract_seekstreaming_candidates,
    has_hls_manifest_signature,
    is_hls_response,
    normalize_seekstreaming_origin,
    parse_seekstreaming_embed_url,
    redact_url_for_log,
    validate_seekstreaming_media_url,
    validate_seekstreaming_resolved_address,
)
from fsvid_vidzy_sandbox import execute_player_scripts

# Load local .env from proxiesembed folder
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))


class PublicOnlyResolver(AbstractResolver):
    """Resolve once, reject non-public answers, and return only verified IPs."""

    def __init__(self, delegate: Optional[AbstractResolver] = None):
        self._delegate = delegate or DefaultResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        resolved = await self._delegate.resolve(host, port, family)
        if not resolved:
            raise OSError("SeekStreaming DNS resolution returned no addresses")
        for item in resolved:
            try:
                validate_seekstreaming_resolved_address(item.get("host"))
            except (AttributeError, ValueError) as exc:
                raise OSError(
                    "SeekStreaming DNS resolution returned a non-public address"
                ) from exc
        return resolved

    async def close(self):
        await self._delegate.close()


def _load_json_env(env_name: str, fallback: Any) -> Any:
    raw_value = os.environ.get(env_name)
    if raw_value is None:
        return fallback

    raw_value = str(raw_value).strip()
    if not raw_value:
        return fallback

    try:
        return json.loads(raw_value)
    except Exception:
        logging.getLogger(__name__).warning(f"[config] Invalid JSON in {env_name}; using fallback")
        return fallback


def _get_env_int(env_name: str, fallback: int) -> int:
    raw_value = str(os.environ.get(env_name, '') or '').strip()
    if not raw_value:
        return fallback

    try:
        return int(raw_value)
    except (TypeError, ValueError):
        logging.getLogger(__name__).warning(f"[config] Invalid integer in {env_name}; using fallback={fallback}")
        return fallback


def _build_socks5_proxy_url(proxy: Any, default_type: str = 'socks5h') -> Optional[str]:
    """Build a SOCKS proxy URL from either a raw url field or host/port/auth parts."""
    if not isinstance(proxy, dict):
        return None

    raw_url = str(proxy.get('url', '') or '').strip()
    if raw_url:
        return raw_url

    host = str(proxy.get('host', '') or '').strip()
    port = str(proxy.get('port', '') or '').strip()
    if not host or not port:
        return None

    proxy_type = str(proxy.get('type', default_type) or default_type).strip()
    auth = str(proxy.get('auth', '') or '').strip()
    return f"{proxy_type}://{auth}@{host}:{port}" if auth else f"{proxy_type}://{host}:{port}"


def _redact_proxy_url(proxy_url: Optional[str]) -> str:
    if not proxy_url:
        return 'none'
    try:
        if '@' in proxy_url:
            scheme, rest = proxy_url.split('://', 1) if '://' in proxy_url else ('proxy', proxy_url)
            _, hostpart = rest.split('@', 1)
            return f"{scheme}://***@{hostpart}"
        return proxy_url
    except Exception:
        return 'proxy'


def _build_aiohttp_socks_proxy_url(proxy: Any, default_type: str = 'socks5') -> Optional[str]:
    """Build a SOCKS URL compatible with aiohttp_socks/python-socks."""
    proxy_url = _build_socks5_proxy_url(proxy, default_type=default_type)
    if not proxy_url:
        return None
    if proxy_url.lower().startswith('socks5h://'):
        return f"socks5://{proxy_url[10:]}"
    return proxy_url


def _load_proxy_list_env(env_name: str) -> list:
    parsed = _load_json_env(env_name, [])
    if not isinstance(parsed, list):
        return []
    return [proxy for proxy in parsed if _build_socks5_proxy_url(proxy)]


def _load_proxy_dict_env(env_name: str) -> Optional[Dict]:
    parsed = _load_json_env(env_name, {})
    if isinstance(parsed, dict) and _build_socks5_proxy_url(parsed):
        return parsed
    return None

# ---------------------------------------------------------------------------
#  WideFrog / DRM Proxy integration
# ---------------------------------------------------------------------------
# Add drmproxy directory to sys.path so we can import widefrog utilities
_DRMPROXY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'drmproxy')
if _DRMPROXY_DIR not in sys.path:
    sys.path.insert(0, _DRMPROXY_DIR)

# Thread pool for blocking widefrog calls
_DRM_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix='drm')

# Try to import widefrog utilities (optional â€” server starts without them)
_WIDEFROG_AVAILABLE = False
try:
    from utils.constants.macros import CONFIG_FILE, DEFAULT_DEBUG_MODE
    from utils.structs import BaseElement
    from utils.tools.args import get_config as wf_get_config
    from utils.tools.cdm import init_cdm, close_cdm
    from utils.tools.common import get_base_url as wf_get_base_url
    from utils.tools.service import get_service, get_all_services
    import requests as sync_requests  # Used by widefrog extraction (sync)
    _WIDEFROG_AVAILABLE = True
    logger_early = logging.getLogger(__name__)
    logger_early.info('[DRM] WideFrog utilities loaded successfully')
except Exception as _wf_err:
    logger_early = logging.getLogger(__name__)
    logger_early.warning(f'[DRM] WideFrog utilities not available: {_wf_err}')


def _init_widefrog():
    """Initialise widefrog config (once, thread-safe).
    
    Widefrog uses relative paths (app_files/config.json, *.wvd) so we
    must chdir to the drmproxy directory before calling its functions.
    """
    if not _WIDEFROG_AVAILABLE:
        return
    if hasattr(builtins, 'CONFIG'):
        return
    # Switch CWD to drmproxy/ so relative paths (config.json, .wvd) resolve
    _prev_cwd = os.getcwd()
    os.chdir(_DRMPROXY_DIR)
    try:
        args = []
        builtins.CONFIG = wf_get_config(args)
        builtins.CONFIG['QUERY'] = {
            'MIN': {'COLLECTION': None, 'ELEMENT': None},
            'MAX': {'COLLECTION': None, 'ELEMENT': None},
        }
        builtins.CONFIG['DEBUG_MODE'] = DEFAULT_DEBUG_MODE
        builtins.SERVICES = get_all_services()
        builtins.CONFIG['DOWNLOAD_COMMANDS']['WAIT_BEFORE_DOWNLOADING'] = None
        
        # Convert CDM .wvd path to absolute so it works from any CWD later
        wvd_path = builtins.CONFIG.get('CDM_WVD_FILE_PATH', '')
        if wvd_path and not os.path.isabs(wvd_path):
            abs_wvd = os.path.join(_DRMPROXY_DIR, wvd_path)
            if os.path.isfile(abs_wvd):
                builtins.CONFIG['CDM_WVD_FILE_PATH'] = abs_wvd
    finally:
        os.chdir(_prev_cwd)


# ---------------------------------------------------------------------------
#  SOCKS5H proxy session for france.tv extraction (NOT for streaming)
# ---------------------------------------------------------------------------
def _build_ftv_proxy_session():
    """Create a requests.Session pre-configured with a SOCKS5H proxy.
    
    This session is used ONLY for extraction/API calls to france.tv
    (page download, manifest fetch, DRM token, auth).
    The actual video streaming goes through separate aiohttp sessions WITHOUT proxy.
    """
    proxies_list = _load_proxy_list_env('PROXIES_SOCKS5_JSON')
    if not proxies_list:
        return None
    # Pick a random proxy from the list
    import random as _rand
    proxy = _rand.choice(proxies_list)
    proxy_url = _build_socks5_proxy_url(proxy)
    if not proxy_url:
        return None
    sess = sync_requests.Session()
    sess.proxies = {
        'http': proxy_url,
        'https': proxy_url,
    }
    sess.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
    })
    logging.getLogger(__name__).info(f'[france.tv] Proxy session created: {_redact_proxy_url(proxy_url)}')
    return sess

if _WIDEFROG_AVAILABLE:
    _FTV_PROXY_SESSION = _build_ftv_proxy_session()
    # Expose via builtins so france_tv.py service can use it
    builtins.FTV_PROXY_SESSION = _FTV_PROXY_SESSION
else:
    _FTV_PROXY_SESSION = None
    builtins.FTV_PROXY_SESSION = None


# ---------------------------------------------------------------------------
#  france.tv authentication
# ---------------------------------------------------------------------------
_FRANCETV_SESSION_LOCK = None  # Will be a threading.Lock, lazily created
_FRANCETV_CREDENTIALS = {
    'email': os.environ.get('FRANCETV_EMAIL', ''),
    'password': os.environ.get('FRANCETV_PASSWORD', ''),
}


def _francetv_authenticate() -> dict:
    """Authenticate with france.tv and return session cookies.
    
    Flow:
      1. GET /api/auth/csrf/  â†’ csrfToken
      2. POST /api/auth/callback/credentials/  â†’ session cookie in Set-Cookie
    Stores cookies in builtins.FRANCETV_COOKIES for the france_tv service to use.
    """
    if not _FRANCETV_CREDENTIALS['email'] or not _FRANCETV_CREDENTIALS['password']:
        raise ValueError('france.tv credentials not configured (set FRANCETV_EMAIL and FRANCETV_PASSWORD in .env)')

    import threading
    global _FRANCETV_SESSION_LOCK
    if _FRANCETV_SESSION_LOCK is None:
        _FRANCETV_SESSION_LOCK = threading.Lock()

    # If we already have valid cookies, return them
    existing = getattr(builtins, 'FRANCETV_COOKIES', None)
    if existing and existing.get('_expires', 0) > time.time():
        return existing
    
    with _FRANCETV_SESSION_LOCK:
        # Double-check after acquiring lock
        existing = getattr(builtins, 'FRANCETV_COOKIES', None)
        if existing and existing.get('_expires', 0) > time.time():
            return existing
        
        _log = logging.getLogger(__name__)
        _log.info('[france.tv] Authenticating...')
        
        try:
            # Use proxied session if available, otherwise create a plain one
            if _FTV_PROXY_SESSION:
                sess = sync_requests.Session()
                sess.proxies = dict(_FTV_PROXY_SESSION.proxies)
            else:
                sess = sync_requests.Session()
            sess.headers.update({
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
            })
            
            # Step 1: Get CSRF token
            csrf_resp = sess.get('https://www.france.tv/api/auth/csrf/', timeout=15)
            csrf_resp.raise_for_status()
            csrf_token = csrf_resp.json().get('csrfToken', '')
            if not csrf_token:
                raise ValueError('Empty CSRF token')
            _log.info(f'[france.tv] Got CSRF token: {csrf_token[:16]}...')
            
            # Step 2: POST credentials
            login_resp = sess.post(
                'https://www.france.tv/api/auth/callback/credentials/',
                data={
                    'email': _FRANCETV_CREDENTIALS['email'],
                    'password': _FRANCETV_CREDENTIALS['password'],
                    'rememberMe': 'true',
                    'redirect': 'false',
                    'csrfToken': csrf_token,
                    'callbackUrl': 'https://www.france.tv/connexion/?callbackUrl=https%3A%2F%2Fwww.france.tv%2Frecherche%2F',
                    'json': 'true',
                },
                timeout=15,
            )
            login_resp.raise_for_status()
            
            # Step 3: Extract session cookie from response
            cookies_dict = {}
            for cookie in sess.cookies:
                cookies_dict[cookie.name] = cookie.value
            
            # Look for the session token in Set-Cookie headers
            session_token = None
            for cookie_name in ('__Secure-next-auth.session-token', 'next-auth.session-token'):
                if cookie_name in cookies_dict:
                    session_token = cookies_dict[cookie_name]
                    break
            
            if not session_token:
                _log.warning(f'[france.tv] Auth succeeded but no session token found. Cookies: {list(cookies_dict.keys())}')
            else:
                _log.info(f'[france.tv] Authenticated! Session token: {session_token[:30]}...')
            
            # Store all cookies + expiry (30 days, matching Expires header)
            cookies_dict['_expires'] = time.time() + (30 * 24 * 3600)
            builtins.FRANCETV_COOKIES = cookies_dict
            
            return cookies_dict
            
        except Exception as e:
            _log.error(f'[france.tv] Authentication failed: {e}')
            # Return empty cookies on failure (extraction will work without auth for non-premium content)
            empty = {'_expires': time.time() + 300}  # Retry in 5 min
            builtins.FRANCETV_COOKIES = empty
            return empty


# DRM manifest cache (module-level, shared) â€” TTL 10 min
_drm_manifest_cache: Dict[str, dict] = {}
_DRM_CACHE_TTL = 600  # 10 minutes


def _extract_manifest_sync(content_url: str) -> dict:
    """Synchronous extraction using widefrog (runs in executor thread).
    
    All widefrog calls happen inside drmproxy/ CWD so that relative
    paths (config, .wvd, service caches) resolve correctly.
    """
    if not _WIDEFROG_AVAILABLE:
        raise RuntimeError('WideFrog utilities are not installed on this server')

    if content_url in _drm_manifest_cache:
        entry = _drm_manifest_cache[content_url]
        if time.time() - entry.get('_cached_at', 0) < _DRM_CACHE_TTL:
            return entry
        del _drm_manifest_cache[content_url]

    # Switch CWD to drmproxy/ for the entire extraction
    _prev_cwd = os.getcwd()
    os.chdir(_DRMPROXY_DIR)
    try:
        return _extract_manifest_sync_inner(content_url)
    finally:
        os.chdir(_prev_cwd)


def _extract_manifest_sync_inner(content_url: str) -> dict:
    """Inner extraction logic (called with CWD = drmproxy/)."""
    _init_widefrog()
    
    # Pre-authenticate for france.tv URLs
    if 'france.tv' in content_url.lower():
        try:
            _francetv_authenticate()
        except Exception as e:
            logging.getLogger(__name__).warning(f'[france.tv] Pre-auth failed: {e}')

    service = get_service(content_url)
    if service is None:
        raise ValueError(f'No service found for URL: {content_url}')

    source_element = BaseElement(url=content_url)
    manifest, pssh, additional = service.get_video_data(source_element)

    if not isinstance(manifest, list):
        manifest = [(manifest, None)]
    if len(manifest) == 0:
        manifest = [(None, None)]
    if not isinstance(pssh, list):
        pssh = [pssh]

    manifest_url = None
    for m_url, _ in manifest:
        if m_url:
            manifest_url = m_url
            break
    if manifest_url is None:
        raise ValueError('No manifest URL could be extracted')

    manifest_type = 'unknown'
    ml = manifest_url.split('?')[0].lower()
    if '.m3u8' in ml or 'm3u8' in manifest_url.lower():
        manifest_type = 'hls'
    elif '.mpd' in ml or 'mpd' in manifest_url.lower():
        manifest_type = 'dash'
    elif '.ism' in ml:
        manifest_type = 'smooth'
    else:
        try:
            resp = sync_requests.get(manifest_url, timeout=10)
            body = resp.text[:500].lower()
            if '#extm3u' in body:
                manifest_type = 'hls'
            elif '<mpd' in body or 'dash' in body:
                manifest_type = 'dash'
        except Exception:
            pass

    is_hls_aes = additional.get('AES', None) is not None if isinstance(additional, dict) else False
    keys = []
    key_errors = []
    if not is_hls_aes:
        for p in pssh:
            if p is None:
                continue
            try:
                cdm, cdm_session_id, challenge = init_cdm(p)
                if cdm is None:
                    key_errors.append(f'init_cdm returned None for PSSH: {str(p)[:60]}')
                    continue
                keys += close_cdm(
                    cdm, cdm_session_id,
                    service.get_keys(challenge, additional.get(p, additional) if isinstance(additional, dict) else additional)
                )
            except Exception as e:
                key_errors.append(f'CDM error: {type(e).__name__}: {e}')
        keys = list(set(keys))

    result = {
        'manifest_url': manifest_url,
        'all_manifests': [(m, n) for m, n in manifest if m],
        'manifest_type': manifest_type,
        'keys': keys,
        'key_errors': key_errors,
        'pssh': [str(p) for p in pssh if p],
        'is_hls_aes': is_hls_aes,
        'aes_info': additional.get('AES', None) if isinstance(additional, dict) else None,
        'additional': additional if isinstance(additional, dict) else {},
        'title': source_element.element or 'video',
    }
    result['_cached_at'] = time.time()
    _drm_manifest_cache[content_url] = result
    return result


# ---------------------------------------------------------------------------
#  DRM proxy URL rewriting helpers
# ---------------------------------------------------------------------------
def _drm_proxy_url(target_url: str, route: str = '/drm/resource') -> str:
    """Build a proxy URL for DRM resources."""
    return f"{route}?url={urllib.parse.quote(target_url, safe='')}"


def _drm_resolve_url(base_url: str, relative: str) -> str:
    if relative.startswith('http://') or relative.startswith('https://'):
        return relative
    return urljoin(base_url, relative)


def _drm_make_base_proxy_url(original_base_url: str) -> str:
    """Encode a base URL into a path-based proxy prefix for DASH."""
    b = base64.urlsafe_b64encode(original_base_url.encode()).decode().rstrip('=')
    return f"/drm/b/{b}/"


def _drm_rewrite_m3u8(content: str, base_url: str) -> str:
    """Rewrite HLS manifest URLs to go through /drm/ proxy."""
    lines = content.split('\n')
    result = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue
        if stripped.startswith('#'):
            def _rw_uri(m):
                uri = m.group(1)
                absolute = _drm_resolve_url(base_url, uri)
                return f'URI="{_drm_proxy_url(absolute)}"'
            rewritten = re.sub(r'URI="([^"]*)"', _rw_uri, stripped, flags=re.IGNORECASE)
            rewritten = re.sub(r"URI='([^']*)'", _rw_uri, rewritten, flags=re.IGNORECASE)
            rewritten = re.sub(
                r"\bURI=([^\"'\s,][^,\s]*)",
                _rw_uri,
                rewritten,
                flags=re.IGNORECASE,
            )
            result.append(rewritten)
        else:
            absolute = _drm_resolve_url(base_url, stripped)
            result.append(_drm_proxy_url(absolute))
    return '\n'.join(result)


def _drm_rewrite_mpd(content: str, base_url: str) -> str:
    """Rewrite DASH MPD manifest URLs to go through /drm/ proxy."""
    has_base_url = bool(re.search(r'<BaseURL[^>]*>', content, re.IGNORECASE))

    if has_base_url:
        def _rw_baseurl(m):
            url = m.group(1).strip()
            if url and (url.startswith('http://') or url.startswith('https://')):
                resolved = url if url.endswith('/') else url + '/'
                return f'<BaseURL>{_drm_make_base_proxy_url(resolved)}</BaseURL>'
            elif url:
                absolute = _drm_resolve_url(base_url, url)
                if not absolute.endswith('/'):
                    absolute += '/'
                return f'<BaseURL>{_drm_make_base_proxy_url(absolute)}</BaseURL>'
            return m.group(0)
        content = re.sub(r'<BaseURL>(.*?)</BaseURL>', _rw_baseurl, content, flags=re.DOTALL)
    else:
        proxy_base = _drm_make_base_proxy_url(base_url)
        content = re.sub(
            r'(<MPD[^>]*>)',
            rf'\1\n  <BaseURL>{proxy_base}</BaseURL>',
            content,
            count=1,
        )

    for attr in ['media', 'initialization']:
        def _rw_attr(m, attr_name=attr):
            url = m.group(1)
            if url.startswith('http://') or url.startswith('https://'):
                return f'{attr_name}="{_drm_proxy_url(url)}"'
            return m.group(0)
        content = re.sub(
            rf'{attr}="(https?://[^"]*)"',
            _rw_attr,
            content,
            flags=re.IGNORECASE,
        )

    return content


# Try to use uvloop for better async performance (Linux/Mac)
try:
    import uvloop
    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    print("[PERF] uvloop enabled for better async performance")
except ImportError:
    pass

# Optimize garbage collection for high-throughput
gc.set_threshold(50000, 500, 100)

# Configuration
PORT = 25569
PROXY_BASE = str(os.environ.get("PROXY_BASE", '') or '').strip()
VIP_CACHE_TTL = 300  # Cache VIP check results for 5 minutes

# MySQL configuration â€” same env vars as Node.js backend (API/.env)
DB_CONFIG = {
    'host': os.environ.get('DB_HOST'),
    'port': _get_env_int('DB_PORT', 3306),
    'user': os.environ.get('DB_USER'),
    'password': os.environ.get('DB_PASSWORD'),
    'db': os.environ.get('DB_NAME'),
    'minsize': 2,
    'maxsize': 20,
    'autocommit': True,
}

# Proxies SOCKS5H configuration
PROXIES = _load_proxy_list_env('PROXIES_SOCKS5_JSON')

SIBNET_PROXY_CONFIG = _load_proxy_dict_env('SIBNET_PROXY_SOCKS5_JSON')

DEEPBRID_API_KEY = os.environ.get('DEEPBRID_API_KEY', '').strip()
REAL_DEBRID_API_KEY = os.environ.get('REAL_DEBRID_API_KEY', '').strip()
REAL_DEBRID_API_BASE = 'https://api.real-debrid.com/rest/1.0'
DEBRIDR_BASE_URL = 'https://debridr.com'
DEBRIDR_ACCOUNT_KEY = os.environ.get('DEBRIDR_ACCOUNT_KEY', '').strip()
DEBRIDR_REQUEST_TIMEOUT = 45
DEBRIDR_MAX_POW_ATTEMPTS = 250_000

DEBRID_PROVIDERS = frozenset({'deepbrid', 'realdebrid', 'debridr'})

SIBNET_PROXY = PROXIES[0] if len(PROXIES) > 0 else None
VIDMOLY_PROXY = PROXIES[1] if len(PROXIES) > 1 else (PROXIES[0] if len(PROXIES) > 0 else None)

# Logging — default WARNING (errors/warns only); set LOG_LEVEL=INFO|DEBUG to reenable.
_LOG_LEVEL = getattr(logging, os.environ.get('LOG_LEVEL', 'INFO').upper(), logging.WARNING)
logging.basicConfig(level=_LOG_LEVEL)
logger = logging.getLogger(__name__)
logging.getLogger('aiohttp.access').setLevel(logging.WARNING)

# Filter to suppress HTTP/2 connection attempts (PRI/Upgrade errors)
class HTTP2NoiseFilter(logging.Filter):
    """Filter out HTTP/2 connection preface errors from bots/scanners"""
    def filter(self, record):
        if record.levelno >= logging.ERROR:
            msg = str(record.getMessage()).lower()
            if 'pri/upgrade' in msg or 'pause on pri' in msg:
                return False
            # Also filter BadHttpMessage for empty/malformed requests
            if hasattr(record, 'exc_info') and record.exc_info:
                exc_type = record.exc_info[0]
                if exc_type and 'BadHttpMessage' in str(exc_type):
                    exc_msg = str(record.exc_info[1]).lower() if record.exc_info[1] else ''
                    if 'pri/upgrade' in exc_msg or 'pause on pri' in exc_msg:
                        return False
        return True

# Apply filter to aiohttp.server logger
aiohttp_server_logger = logging.getLogger('aiohttp.server')
aiohttp_server_logger.addFilter(HTTP2NoiseFilter())

# URL encoding key
URL_ENCODE_KEY = b"ce1f909bbd8b8fa6bdd29035f75ccd1a284fae92a12ff64580008dd0de6e7bc8"

# Known video extensions (immutable tuple for performance)
KNOWN_EXTENSIONS = ('.mp4', '.m3u8', '.ts', '.m4s', '.mpd', '.webm', '.mkv', '.avi', '.mov')

# CORS headers constant - MINIMIZED for bandwidth savings
CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, x-access-key',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
}


def _safe_stream_response(status, headers):
    """Create StreamResponse with Content-Type in headers only.

    aiohttp 3.11 removed the content_type keyword argument.
    Content-Type must be set via the headers dict directly.
    """
    return web.StreamResponse(status=status, headers=headers)


def _safe_response(body=b'', status=200, headers=None):
    """Create Response with Content-Type in headers only.

    aiohttp 3.11 removed the content_type keyword argument.
    Content-Type must be set via the headers dict directly.
    """
    if headers is None:
        headers = {}
    return web.Response(body=body, status=status, headers=headers)


# Problematic SSL domains
PROBLEMATIC_DOMAINS = frozenset([
    'vidzy.org', 'v4.vidzy.org', 'v3.vidzy.org', 'v2.vidzy.org', 'v1.vidzy.org',
    'bandwidth.com', 'edgeon-bandwidth.com', 'familyrestream.com', '6522236688.shop',
    '1396168994.live', 'vuunov.1396168994.live'
])

# Fsvid/Vidzy gate their HLS CDN on Referer + the presence of Sec-Ch-Ua.
# A request missing either one is answered with a 302 to their decoy stream
# (s1.fsvid.lol/troll/master.m3u8) on fsvid, or a bare 403 on vidzy.
FSVID_VIDZY_SEC_CH_UA = '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"'

# AES decryption constants for seekstreaming (embed4me)
SEEKSTREAMING_AES_KEY = b"kiemtienmua911ca"
SEEKSTREAMING_AES_IV = b"1234567890oiuytr"
SEEKSTREAMING_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
)

# Chunk sizes - OPTIMIZED for high-throughput streaming
CHUNK_TS = 32768      # 32KB for TS segments (doubled for speed)
CHUNK_MP4 = 131072    # 128KB for MP4 streaming (doubled)
CHUNK_DEFAULT = 65536 # 64KB default (doubled)
CHUNK_M3U8 = 16384    # 16KB for M3U8 playlists
CHUNK_LARGE = 262144  # 256KB for large files

# High-load optimization constants
MAX_CONCURRENT_REQUESTS = 0  # No limit
KEEPALIVE_TIMEOUT = 300      # 5 min keepalive
DNS_CACHE_TTL = 600          # 10 min DNS cache
SOCKET_READ_BUFFER = 262144  # 256KB socket buffer
CONNECTION_TIMEOUT = 15      # 15s connection timeout

M3U8_CACHE_TTL = 5                # Cache live M3U8 playlists for 5s (reduces re-fetches)
M3U8_VOD_CACHE_TTL = 120          # Cache VOD M3U8 playlists for 2min

# Dispatcharr-style segment buffer constants
SEGMENT_CACHE_TTL = 20            # Keep segments for 20s (â‰ˆ2 manifest cycles)
SEGMENT_CACHE_MAX_ENTRIES = 200   # Max cached segments
SEGMENT_CACHE_MAX_BYTES = 150 * 1024 * 1024  # 150 MB max memory for segment cache
SEGMENT_MAX_SIZE = 15 * 1024 * 1024  # Don't cache segments > 15 MB


class RequestCoalescer:
    """
    Deduplicates identical concurrent upstream requests.
    If 50 clients request the same M3U8 playlist at the same time,
    only ONE upstream fetch is made, and all 50 get the same result.

    For M3U8 requests: stores (status, body_bytes, headers_dict) tuples.
    The first request performs the actual fetch; concurrent duplicates await
    the same future and receive a clone of the response.
    """
    __slots__ = ('_pending',)

    def __init__(self):
        self._pending: Dict[str, asyncio.Future] = {}

    async def get_or_fetch(self, key: str, fetch_coro):
        """Return cached future result or start a new fetch.

        Returns a tuple (is_coalesced: bool, result).
        is_coalesced=True means this caller piggy-backed on another request.
        """
        if key in self._pending:
            result = await self._pending[key]
            return (True, result)

        future = asyncio.get_event_loop().create_future()
        self._pending[key] = future

        try:
            result = await fetch_coro
            future.set_result(result)
            return (False, result)
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            self._pending.pop(key, None)


class TTLCache:
    """Simple TTL cache with O(1) operations"""
    __slots__ = ('_cache', '_maxsize', '_ttl')
    
    def __init__(self, maxsize: int = 1000, ttl: int = 3600):
        self._cache: OrderedDict = OrderedDict()
        self._maxsize = maxsize
        self._ttl = ttl
    
    def get(self, key: str) -> Optional[Any]:
        if key not in self._cache:
            return None
        data, timestamp = self._cache[key]
        if time.time() - timestamp > self._ttl:
            del self._cache[key]
            return None
        # Move to end for LRU
        self._cache.move_to_end(key)
        return data
    
    def set(self, key: str, value: Any) -> None:
        if key in self._cache:
            del self._cache[key]
        elif len(self._cache) >= self._maxsize:
            self._cache.popitem(last=False)
        self._cache[key] = (value, time.time())

    def delete(self, key: str) -> bool:
        return self._cache.pop(key, None) is not None
    
    def clear_expired(self) -> None:
        now = time.time()
        expired = [k for k, (_, ts) in self._cache.items() if now - ts > self._ttl]
        for k in expired:
            del self._cache[k]


class SegmentBuffer:
    """Dispatcharr-style in-memory segment buffer.

    Caches TS/M4S segments so that N clients watching the same live channel
    share a SINGLE upstream fetch per segment. Segments are evicted by:
      - TTL expiration (SEGMENT_CACHE_TTL)
      - Entry count (SEGMENT_CACHE_MAX_ENTRIES)
      - Total memory (SEGMENT_CACHE_MAX_BYTES)

    Thread-safe within a single asyncio event loop (no locks needed).
    """
    __slots__ = ('_cache', '_total_bytes', '_ttl', '_max_entries', '_max_bytes')

    def __init__(self, ttl: int = SEGMENT_CACHE_TTL,
                 max_entries: int = SEGMENT_CACHE_MAX_ENTRIES,
                 max_bytes: int = SEGMENT_CACHE_MAX_BYTES):
        # key -> (data: bytes, timestamp: float, size: int)
        self._cache: OrderedDict = OrderedDict()
        self._total_bytes = 0
        self._ttl = ttl
        self._max_entries = max_entries
        self._max_bytes = max_bytes

    def get(self, key: str) -> Optional[bytes]:
        """Return cached segment data or None."""
        if key not in self._cache:
            return None
        data, ts, size = self._cache[key]
        if time.time() - ts > self._ttl:
            self._cache.pop(key)
            self._total_bytes -= size
            return None
        self._cache.move_to_end(key)
        return data

    def put(self, key: str, data: bytes) -> None:
        """Cache a segment. Evicts oldest entries if limits exceeded."""
        size = len(data)
        if size > SEGMENT_MAX_SIZE:
            return  # Don't cache oversized segments

        # Remove existing entry if present
        if key in self._cache:
            _, _, old_size = self._cache.pop(key)
            self._total_bytes -= old_size

        # Evict expired entries first
        self._evict_expired()

        # Evict oldest until under memory limit
        while self._total_bytes + size > self._max_bytes and self._cache:
            _, (_, _, evicted_size) = self._cache.popitem(last=False)
            self._total_bytes -= evicted_size

        # Evict oldest until under entry count limit
        while len(self._cache) >= self._max_entries and self._cache:
            _, (_, _, evicted_size) = self._cache.popitem(last=False)
            self._total_bytes -= evicted_size

        self._cache[key] = (data, time.time(), size)
        self._total_bytes += size

    def _evict_expired(self) -> None:
        now = time.time()
        while self._cache:
            key, (_, ts, size) = next(iter(self._cache.items()))
            if now - ts > self._ttl:
                self._cache.popitem(last=False)
                self._total_bytes -= size
            else:
                break  # OrderedDict is sorted by insertion, oldest first

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            'entries': len(self._cache),
            'total_bytes': self._total_bytes,
            'total_mb': round(self._total_bytes / (1024 * 1024), 1),
        }


def encode_url(url: str) -> str:
    """Encode URL with XOR + Base64, preserving file extension"""
    if not url:
        return url
    
    parsed = urlparse(url)
    path_lower = parsed.path.lower()
    file_ext = next((ext for ext in KNOWN_EXTENSIONS if ext in path_lower), '')
    
    url_bytes = url.encode('utf-8')
    key_len = len(URL_ENCODE_KEY)
    # Fast XOR using bytearray instead of generator
    buf = bytearray(len(url_bytes))
    for i in range(len(url_bytes)):
        buf[i] = url_bytes[i] ^ URL_ENCODE_KEY[i % key_len]
    encoded = base64.urlsafe_b64encode(buf).decode('utf-8').rstrip('=')
    
    return encoded + file_ext if file_ext else encoded


def decode_url(encoded: str) -> str:
    """Decode XOR + Base64 encoded URL"""
    if not encoded:
        return encoded
    
    try:
        clean_encoded = encoded
        for ext in KNOWN_EXTENSIONS:
            if encoded.lower().endswith(ext):
                clean_encoded = encoded[:-len(ext)]
                break
        
        padding_needed = (4 - len(clean_encoded) % 4) % 4
        decoded_bytes = base64.urlsafe_b64decode(clean_encoded + '=' * padding_needed)
        
        key_len = len(URL_ENCODE_KEY)
        # Fast XOR using bytearray instead of generator
        buf = bytearray(len(decoded_bytes))
        for i in range(len(decoded_bytes)):
            buf[i] = decoded_bytes[i] ^ URL_ENCODE_KEY[i % key_len]
        return buf.decode('utf-8')
    except Exception as e:
        logger.warning(f"Failed to decode URL: {e}")
        return encoded


@dataclass(frozen=True)
class ContentType:
    """Detected content type info"""
    is_m3u8: bool = False
    is_mp4: bool = False
    is_ts: bool = False
    is_mpd: bool = False
    is_m4s: bool = False


def detect_content_type(url: str, accept_header: str = '') -> ContentType:
    """Detect content type from URL and Accept header"""
    url_lower = url.lower()
    accept_lower = accept_header.lower()
    
    # Treat .txt files that look like M3U8 (usually from specialized providers) as M3U8 for proxy purposes
    is_m3u8 = ('.m3u8' in url_lower or 
               'application/vnd.apple.mpegurl' in accept_lower or 
               'application/x-mpegurl' in accept_lower or
               ('.txt' in url_lower and 'application/vnd.apple.mpegurl' in accept_lower) or
               ('.txt' in url_lower and ('index-' in url_lower or 'master' in url_lower)))  # Heuristic for the .txt m3u8 case
               
    return ContentType(
        is_m3u8=is_m3u8,
        is_mp4='.mp4' in url_lower or 'video/mp4' in accept_lower,
        is_ts='.ts' in url_lower or 'video/mp2t' in accept_lower,
        is_mpd='.mpd' in url_lower or 'application/dash+xml' in accept_lower,
        is_m4s='.m4s' in url_lower
    )


# ---------------------------------------------------------------------------
#  curl_cffi (JA3 impersonation) upstream â€” cinep-proxy only.
#  Direct request first; on HTTP 403 retry once through a random SOCKS5
#  proxy from PROXIES (same pool as the other services).
# ---------------------------------------------------------------------------
try:
    from curl_cffi.requests import AsyncSession as _CurlAsyncSession
    from curl_cffi.requests.exceptions import RequestException as _CurlRequestException
    _CURL_CFFI_AVAILABLE = True
except Exception as _curl_import_err:
    logger.warning(f'[curl_cffi] Not available, cinep-proxy will use plain aiohttp: {_curl_import_err}')
    _CurlRequestException = ()  # empty except-tuple: matches nothing
    _CURL_CFFI_AVAILABLE = False


class _CurlContent:
    """Mimics aiohttp's StreamReader chunk iteration over an already-buffered body."""
    __slots__ = ('_body',)

    def __init__(self, body: bytes):
        self._body = body

    async def iter_chunked(self, chunk_size: int):
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i:i + chunk_size]

    async def iter_any(self):
        if self._body:
            yield self._body


class _CurlResponseAdapter:
    """Wraps a curl_cffi Response so it quacks like the aiohttp response _service_proxy expects."""
    __slots__ = ('status', 'headers', 'content')

    def __init__(self, resp):
        self.status = resp.status_code
        self.headers = resp.headers
        self.content = _CurlContent(resp.content)

    async def read(self) -> bytes:
        return self.content._body


class _CurlCffiUpstream:
    """Async context manager: curl_cffi request with JA3 impersonation.
    Retries once through a random SOCKS5 proxy if the direct attempt is a 403."""
    __slots__ = ('_session', '_url', '_headers', '_timeout_s', '_service_name')

    def __init__(self, session, url: str, headers: Dict, timeout_s: float, service_name: str):
        self._session = session
        self._url = url
        self._headers = headers
        self._timeout_s = timeout_s
        self._service_name = service_name

    async def __aenter__(self):
        resp = await self._session.get(
            self._url, headers=self._headers, timeout=self._timeout_s,
            impersonate='chrome', allow_redirects=False,
        )
        if resp.status_code == 403 and PROXIES:
            proxy_url = _build_socks5_proxy_url(random.choice(PROXIES))
            if proxy_url:
                logger.warning(f'[{self._service_name.upper()}-PROXY] 403 direct â€” retrying via {_redact_proxy_url(proxy_url)}')
                try:
                    resp = await self._session.get(
                        self._url, headers=self._headers, timeout=self._timeout_s,
                        impersonate='chrome', allow_redirects=False,
                        proxies={'http': proxy_url, 'https': proxy_url},
                    )
                except Exception:
                    logger.exception(f'[{self._service_name.upper()}-PROXY] Proxy retry failed, keeping 403')
                else:
                    logger.warning(f'[{self._service_name.upper()}-PROXY] Proxy retry result: {resp.status_code} for {self._url}')
        return _CurlResponseAdapter(resp)

    async def __aexit__(self, *exc_info):
        return False


class ProxyServer:
    # Compiled regex patterns (class-level for sharing)
    RE_BANDWIDTH = re.compile(r'bandwidth\.com|edgeon-bandwidth\.com', re.IGNORECASE)
    # Vidzy now serves its embeds and its HLS CDN from vidzy.cc (u\d+.vidzy.cc).
    RE_VIDZY = re.compile(r'vidzy\.(?:org|cc)', re.IGNORECASE)
    RE_FSVID = re.compile(r'fsvid\.lol', re.IGNORECASE)
    RE_SIBNET = re.compile(r'sibnet\.ru|dv\d+\.sibnet\.ru', re.IGNORECASE)
    RE_VMWESA = re.compile(r'vmwesa\.online|vidmoly|getromes\.space', re.IGNORECASE)
    RE_FAMILYRESTREAM = re.compile(r'familyrestream\.com', re.IGNORECASE)
    RE_SOSPLAY = re.compile(r'srvagu|6522236688\.shop|vuunov|1396168994\.live', re.IGNORECASE)
    RE_WITV = re.compile(r'lansdrud\.space', re.IGNORECASE)
    RE_UQLOAD_EMBED = re.compile(r'uqload\.(is|cx|com|net|bz|org|to|io|co)/(embed-)?[^/]+\.html', re.IGNORECASE)
    RE_UQLOAD = re.compile(r'uqload\.(is|cx|com|bz|net|org|to|io|co)', re.IGNORECASE)
    RE_DROPCDN = re.compile(r'dropcdn', re.IGNORECASE)
    RE_SERVERSICURO = re.compile(r'serversicuro', re.IGNORECASE)
    RE_MERI = re.compile(r'merichunidya\.com', re.IGNORECASE)
    # Streaming CDN patterns: numeric domains, epic*, quest*, hero*, etc.
    RE_NUMERIC_CDN = re.compile(r'([a-z0-9]+\.\d+\.net|epicquest|questher|hero.*\.com|trainer\.net|dishtrainer)', re.IGNORECASE)
    RE_DOODSTREAM = re.compile(r'd0000d\.com|doodstream\.com|dood\.(cx|la|pm|sh|so|to|watch|wf|yt|re)|cloudatacdn\.com|dsvplay\.com|doply\.net', re.IGNORECASE)
    RE_DOODSTREAM_PASS = re.compile(r'/pass_md5/[\w-]+/(?P<token>[\w-]+)')
    RE_RANGE = re.compile(r'bytes=(\d+)-(\d*)')
    RE_M3U8_URI_DQ = re.compile(r'URI="([^"]+)"', re.IGNORECASE)
    RE_M3U8_URI_SQ = re.compile(r"URI='([^']+)'", re.IGNORECASE)
    RE_M3U8_URI_UQ = re.compile(r"\bURI=([^\"'\s,][^,\s]*)", re.IGNORECASE)
    RE_M3U8_HTTP = re.compile(r'^https?://', re.IGNORECASE)
    
    def __init__(self):
        # High-performance application configuration
        self.app = web.Application(
            client_max_size=0,  # No request size limit
            handler_args={
                'tcp_keepalive': True,
            }
        )
        
        # TTL Caches - Sized based on observed usage patterns
        self.voe_cache = TTLCache(maxsize=1000, ttl=7200)
        self.fsvid_cache = TTLCache(maxsize=500, ttl=60)
        self.vidzy_cache = TTLCache(maxsize=1500, ttl=7200)   # Was saturating at 554/500
        self.vidmoly_cache = TTLCache(maxsize=500, ttl=600)
        self.sibnet_cache = TTLCache(maxsize=500, ttl=7200)
        self.uqload_cache = TTLCache(maxsize=2500, ttl=7200)  # Was saturating at 1003/500
        self.uqload_mp4_cache = TTLCache(maxsize=2500, ttl=7200)
        self.doodstream_cache = TTLCache(maxsize=500, ttl=3600)    # 1h - doodstream links expire
        self.seekstreaming_cache = TTLCache(maxsize=500, ttl=300)
        self.vip_cache = TTLCache(maxsize=5000, ttl=VIP_CACHE_TTL)  # VIP access key verification cache
        self.m3u8_response_cache = TTLCache(maxsize=2000, ttl=M3U8_CACHE_TTL)  # Short-lived M3U8 response cache
        self.m3u8_vod_cache = TTLCache(maxsize=1000, ttl=M3U8_VOD_CACHE_TTL)   # Longer-lived VOD M3U8 cache
        self.debridr_status_cache = TTLCache(maxsize=1, ttl=300)
        self.cache_duration = 300  # 5 minutes
        
        # Request coalescer - deduplicates identical concurrent requests
        self.coalescer = RequestCoalescer()

        # Dispatcharr-style segment buffer - caches TS/M4S segments in memory
        # so N clients watching the same channel share ONE upstream fetch
        self.segment_buffer = SegmentBuffer()
        
        # SSL context for problematic domains
        self.ssl_context = ssl.create_default_context()
        self.ssl_context.check_hostname = False
        self.ssl_context.verify_mode = ssl.CERT_NONE
        
        self.setup_routes()
        self.setup_cors()
        
        # Sessions container
        self.sessions = {}

        # MySQL pool (initialized async in start_server)
        self.mysql_pool = None
        
        # Performance metrics
        self._request_count = 0
        self._active_streams = 0
        self._bandwidth_saved = 0  # Track bytes saved by compression/caching
        self._cache_hits = 0
        self._coalesced_requests = 0
        self._coalesced_segments = 0
        self._segment_cache_hits = 0

    async def _init_mysql(self):
        """Initialize the MySQL connection pool for direct VIP verification"""
        try:
            self.mysql_pool = await aiomysql.create_pool(
                host=DB_CONFIG['host'],
                port=DB_CONFIG['port'],
                user=DB_CONFIG['user'],
                password=DB_CONFIG['password'],
                db=DB_CONFIG['db'],
                minsize=DB_CONFIG['minsize'],
                maxsize=DB_CONFIG['maxsize'],
                autocommit=DB_CONFIG['autocommit'],
                charset='utf8mb4',
            )
            # Test connection
            async with self.mysql_pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute('SELECT 1')
            logger.info('âœ… MySQL connection pool created (VIP verification)')
        except Exception as e:
            logger.error(f'âŒ MySQL connection error: {e}')
            self.mysql_pool = None

    async def _init_sessions(self):
        """Initialize persistent sessions - OPTIMIZED FOR HIGH LOAD"""
        
        # Shared connector settings for maximum performance
        base_connector_args = {
            'limit': 0,  # NO CONNECTION LIMIT
            'limit_per_host': 0,  # NO PER-HOST LIMIT
            'keepalive_timeout': KEEPALIVE_TIMEOUT,
            'enable_cleanup_closed': True,
            'ttl_dns_cache': DNS_CACHE_TTL,
            'force_close': False,  # Reuse connections aggressively
            'use_dns_cache': True,
        }
        
        # Normal Session - Maximum performance
        self.sessions['normal'] = aiohttp.ClientSession(
            connector=TCPConnector(
                ssl=True,
                **base_connector_args
            ),
            timeout=ClientTimeout(total=None),  # No global timeout
            read_bufsize=SOCKET_READ_BUFFER,
        )

        # SeekStreaming URLs are user-controlled. This connector validates the
        # exact DNS answers that it subsequently connects to, avoiding a
        # separate check/connect lookup that would be vulnerable to rebinding.
        self.sessions['seekstreaming'] = aiohttp.ClientSession(
            connector=TCPConnector(
                ssl=True,
                resolver=PublicOnlyResolver(),
                **base_connector_args,
            ),
            timeout=ClientTimeout(total=None),
            read_bufsize=SOCKET_READ_BUFFER,
        )
        
        # No SSL Session - For problematic domains
        self.sessions['no_ssl'] = aiohttp.ClientSession(
            connector=TCPConnector(
                ssl=self.ssl_context,
                **base_connector_args
            ),
            timeout=ClientTimeout(total=None),
            read_bufsize=SOCKET_READ_BUFFER,
        )
        
        # Proxy Sessions - Optimized for SOCKS5
        for i, proxy in enumerate(PROXIES):
            if proxy and _build_socks5_proxy_url(proxy):
                connector = self._create_socks5_connector(proxy)
                self.sessions[f'proxy_{i}'] = aiohttp.ClientSession(
                    connector=connector,
                    timeout=ClientTimeout(total=None),
                    read_bufsize=SOCKET_READ_BUFFER,
                )

        # Sibnet Specific Session
        if SIBNET_PROXY_CONFIG and _build_socks5_proxy_url(SIBNET_PROXY_CONFIG):
            sibnet_connector = self._create_socks5_connector(SIBNET_PROXY_CONFIG)
            self.sessions['sibnet'] = aiohttp.ClientSession(
                connector=sibnet_connector,
                timeout=ClientTimeout(total=None),
                read_bufsize=SOCKET_READ_BUFFER,
            )
        else:
            self.sessions['sibnet'] = self.sessions['normal']

        # curl_cffi session (JA3 impersonation) â€” cinep-proxy only
        self.curl_session = _CurlAsyncSession() if _CURL_CFFI_AVAILABLE else None
            
    @staticmethod
    def _is_francetv_url(url: str) -> bool:
        """Detect URLs that require a French IP (france.tv CDN domains)."""
        try:
            host = urllib.parse.urlparse(url).hostname or ''
            return host.endswith('.ftven.fr') or host.endswith('.francetv.fr') or host.endswith('.france.tv')
        except Exception:
            return False

    def _get_session(self, service: str, url: str, use_proxy: Optional[int] = None) -> aiohttp.ClientSession:
        """Get appropriate session for request.
        
        Args:
            use_proxy: If set, force use of proxy_{N} session (0=first SOCKS5, 1=second, etc.)
        """
        # Explicit proxy override from use_proxy parameter
        if use_proxy is not None:
            key = f'proxy_{use_proxy}'
            if key in self.sessions:
                return self.sessions[key]
            # Fallback: try proxy_0 if requested index doesn't exist
            logger.warning(f'Requested proxy_{use_proxy} not available, falling back')
            return self.sessions.get('proxy_0', self.sessions['normal'])
        
        if service == 'bandwidth':
            return self.sessions.get('proxy_0', self.sessions['normal'])
        elif service == 'vmwesa':
            return self.sessions.get('proxy_1', self.sessions.get('proxy_0', self.sessions['normal']))
        elif service == 'sibnet':
            return self.sessions.get('sibnet', self.sessions['normal'])
        
        # France.tv CDN needs French proxy
        if self._is_francetv_url(url):
            return self.sessions.get('proxy_0', self.sessions['normal'])
        
        # Check SSL
        if self._should_disable_ssl(url):
            return self.sessions['no_ssl']
            
        return self.sessions['normal']
    
    def _make_cors_response(self, body: bytes = b'', status: int = 200, 
                            headers: Optional[Dict] = None, content_type: str = None) -> Response:
        """Create response with CORS headers"""
        resp_headers = dict(CORS_HEADERS)
        if headers:
            resp_headers.update(headers)
        if content_type:
            resp_headers['Content-Type'] = content_type
        return _safe_response(body, status, resp_headers)

    def _prepare_stream_headers(self, upstream_headers: Dict, content_type: str = None,
                                include_range: bool = False, range_info: Dict = None) -> Dict:
        """Prepare headers for streaming response"""
        excluded = frozenset(['transfer-encoding', 'connection', 'content-encoding'])
        # Drop any upstream CORS headers too â€” we set our own below, and a
        # case-mismatched upstream 'access-control-allow-origin' would survive
        # the dict.update() and emit a duplicate '*, *' the browser rejects.
        headers = {k: v for k, v in upstream_headers.items()
                   if k.lower() not in excluded and not k.lower().startswith('access-control-')}
        headers.update(CORS_HEADERS)

        # Some segment CDNs (e.g. fctv streamas*) mislabel raw MPEG-TS segments as
        # 'application/zip'. Relabel to video/mp2t so strict HLS/MSE players accept them.
        for _k in list(headers.keys()):
            if _k.lower() == 'content-type' and str(headers[_k]).lower().startswith('application/zip'):
                headers[_k] = 'video/mp2t'

        if content_type:
            headers['Content-Type'] = content_type
        
        if include_range and range_info:
            if 'content_range' in range_info:
                headers['Content-Range'] = range_info['content_range']
            if 'content_length' in range_info:
                headers['Content-Length'] = range_info['content_length']
            headers['Accept-Ranges'] = 'bytes'
        
        return headers
    
    async def _stream_response(self, request: Request, upstream_response, 
                               headers: Dict, chunk_size: int = CHUNK_DEFAULT) -> Response:
        """
        ULTRA-OPTIMIZED streaming response handler for high load
        Features:
        - Adaptive chunk sizing based on transfer speed
        - Minimal overhead with direct buffer writes
        - Graceful connection handling
        - Zero-copy when possible
        """
        resp = _safe_stream_response(upstream_response.status, headers)
        
        # Track active streams for metrics
        self._active_streams += 1
        
        try:
            await resp.prepare(request)
        except (ConnectionResetError, ConnectionAbortedError):
            self._active_streams -= 1
            return resp
        
        try:
            async for chunk in upstream_response.content.iter_chunked(chunk_size):
                try:
                    await resp.write(chunk)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
                    # Client disconnected - normal for video seeking
                    break
            
            # Finalize response
            try:
                await resp.write_eof()
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, RuntimeError, OSError):
                pass
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            err_str = str(e).lower()
            if 'closing transport' not in err_str and 'connection reset' not in err_str:
                logger.debug(f'Stream ended: {type(e).__name__}')
        finally:
            self._active_streams -= 1
            
        return resp
    
    async def _stream_response_fast(self, request: Request, upstream_response, 
                                    headers: Dict, chunk_size: int = CHUNK_LARGE) -> Response:
        """
        FASTEST streaming for large files (MP4, large TS files)
        Uses maximum chunk size and minimal processing
        """
        resp = _safe_stream_response(upstream_response.status, headers)
        self._active_streams += 1
        
        try:
            await resp.prepare(request)
        except (ConnectionResetError, ConnectionAbortedError):
            self._active_streams -= 1
            return resp
        
        try:
            # Stream with maximum chunk size for throughput
            async for chunk in upstream_response.content.iter_any():
                try:
                    await resp.write(chunk)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
                    break
            
            try:
                await resp.write_eof()
            except:
                pass
                
        except asyncio.CancelledError:
            pass
        except:
            pass
        finally:
            self._active_streams -= 1
            
        return resp

    async def _stream_response_with_prefix(self, request: Request, upstream_response,
                                           headers: Dict, prefix: bytes,
                                           chunk_size: int = CHUNK_DEFAULT) -> Response:
        """Stream response after consuming a small probe prefix from upstream."""
        resp = _safe_stream_response(upstream_response.status, headers)
        self._active_streams += 1

        try:
            await resp.prepare(request)
        except (ConnectionResetError, ConnectionAbortedError):
            self._active_streams -= 1
            return resp

        try:
            if prefix:
                await resp.write(prefix)

            async for chunk in upstream_response.content.iter_chunked(chunk_size):
                try:
                    await resp.write(chunk)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
                    break

            try:
                await resp.write_eof()
            except:
                pass

        except asyncio.CancelledError:
            pass
        except:
            pass
        finally:
            self._active_streams -= 1

        return resp
    
    async def _handle_m3u8_response(self, response, target_url: str, headers: Dict,
                                    is_bandwidth: bool = False, is_sosplay: bool = False,
                                    is_witv: bool = False, custom_headers: Optional[Dict] = None,
                                    request: Request = None, use_proxy: Optional[int] = None,
                                    raw_body: Optional[bytes] = None) -> Optional[Response]:
        """Handle M3U8 content rewriting with compression, caching, and ETag support"""
        content = raw_body if raw_body is not None else await response.read()
        try:
            text_content = content.decode('utf-8')
            if self._is_valid_m3u8(text_content):
                modified_content = await self._rewrite_m3u8_urls(
                    text_content, target_url, is_bandwidth, is_sosplay, is_witv, custom_headers,
                    use_proxy=use_proxy
                )
                response_body = modified_content.encode('utf-8')
                original_size = len(response_body)
                
                headers['Content-Type'] = 'application/vnd.apple.mpegurl'
                headers.pop('Content-Length', None)
                headers.pop('content-length', None)
                
                # Determine if VOD (has ENDLIST) for cache duration
                is_vod = '#EXT-X-ENDLIST' in text_content
                if is_vod:
                    headers['Cache-Control'] = f'public, max-age={M3U8_VOD_CACHE_TTL}'
                else:
                    headers['Cache-Control'] = 'no-cache'  # Live playlists must not be stale
                
                # ETag support - allows 304 Not Modified responses
                etag = hashlib.md5(response_body).hexdigest()
                headers['ETag'] = f'"{etag}"'
                
                if request:
                    if_none_match = request.headers.get('If-None-Match', '')
                    if if_none_match == f'"{etag}"':
                        self._cache_hits += 1
                        self._bandwidth_saved += original_size
                        return _safe_response(b'', 304, headers)
                
                headers['Content-Length'] = str(original_size)
                return _safe_response(response_body, response.status, headers)
        except UnicodeDecodeError:
            pass
        
        # Content is NOT valid M3U8 (HTML error page, empty body, binary, etc.)
        # Return a clear error so the player fails fast instead of retrying forever.
        body_text = content.decode('utf-8', errors='replace') if content else '(empty)'
        logger.warning(f"[PROXY] M3U8 URL returned non-M3U8 content (status={response.status}, len={len(content)}): {target_url} â€” body preview: {body_text[:200]}")
        error_headers = dict(CORS_HEADERS)
        error_headers['Cache-Control'] = 'no-cache'
        return web.json_response(
            {
                'error': 'Invalid stream: upstream did not return valid M3U8 content',
                'upstream_status': response.status,
                'upstream_url': target_url,
                'upstream_body': body_text[:2000]
            },
            status=502,
            headers=error_headers
        )
    
    def setup_cors(self):
        """Configure CORS middleware"""
        @web.middleware
        async def cors_handler(request: Request, handler):
            if request.method == 'OPTIONS':
                return web.Response(headers=CORS_HEADERS)
            response = await handler(request)
            for k, v in CORS_HEADERS.items():
                response.headers[k] = v
            
            return response
        
        self.app.middlewares.append(cors_handler)

    def _should_disable_ssl(self, url: str) -> bool:
        """Check if SSL verification should be disabled"""
        try:
            domain = urlparse(url).netloc.lower()
            if domain in PROBLEMATIC_DOMAINS:
                return True
            return any(kw in domain for kw in ('edgeon-bandwidth', 'vidzy'))
        except:
            return False
    
    def _get_random_proxy(self) -> Dict:
        valid_proxies = [proxy for proxy in PROXIES if _build_socks5_proxy_url(proxy)]
        return random.choice(valid_proxies) if valid_proxies else {}
    
    def _create_socks5_connector(self, proxy: Dict) -> ProxyConnector:
        """Create SOCKS5 connector with connection pooling.

        Force IPv4 (rdns=False + AF_INET): several stream CDNs are dual-stack
        (has A + AAAA) but only their v4 nodes accept our SOCKS egress IPs. With
        remote DNS the proxy picks the v6 node and can't route it -> 'Connection
        refused by destination host'. Resolving locally to v4 and handing the
        proxy a v4 address makes the segment CDN reachable."""
        proxy_url = _build_aiohttp_socks_proxy_url(proxy, default_type='socks5')
        if not proxy_url:
            raise ValueError('Proxy SOCKS5 invalide')
        return ProxyConnector.from_url(proxy_url, rdns=False, family=socket.AF_INET, limit=0)
    
    def setup_routes(self):
        """Configure server routes"""
        # Global proxy (fallback)
        self.app.router.add_get('/proxy', self.proxy_handler)
        self.app.router.add_get('/proxy/{path:.*}', self.proxy_handler)
        
        # Extraction endpoints
        self.app.router.add_get('/api/voe/m3u8', self.voe_m3u8_handler)
        self.app.router.add_get('/api/extract-fsvid', self.fsvid_extract_handler)
        self.app.router.add_get('/api/extract-vidzy', self.vidzy_extract_handler)
        self.app.router.add_get('/api/extract-vidmoly', self.vidmoly_extract_handler)
        self.app.router.add_get('/api/extract-sibnet', self.sibnet_extract_handler)
        self.app.router.add_get('/api/extract-uqload', self.uqload_extract_handler)
        self.app.router.add_get('/api/extract-doodstream', self.doodstream_extract_handler)
        self.app.router.add_get('/api/extract-seekstreaming', self.seekstreaming_extract_handler)
        
        # Service-specific proxy routes (dedicated headers, no regex detection needed)
        self.app.router.add_get('/voe-proxy', self.voe_proxy_handler)
        self.app.router.add_get('/fsvid-proxy', self.fsvid_proxy_handler)
        self.app.router.add_get('/vidzy-proxy', self.vidzy_proxy_handler)
        self.app.router.add_get('/vidmoly-proxy', self.vidmoly_proxy_handler)
        self.app.router.add_get('/sibnet-proxy', self.sibnet_proxy_handler)
        self.app.router.add_get('/uqload-proxy', self.uqload_proxy_handler)
        self.app.router.add_get('/doodstream-proxy', self.doodstream_proxy_handler)
        self.app.router.add_get('/seekstreaming-proxy', self.seekstreaming_proxy_handler)
        self.app.router.add_get('/cinep-proxy', self.cinep_proxy_handler)
        self.app.router.add_get('/kisskh-proxy', self.kisskh_proxy_handler)
        self.app.router.add_route('OPTIONS', '/kisskh-proxy', self.kisskh_proxy_handler)
        # DRM Proxy routes (widefrog integration, API-only)
        self.app.router.add_get('/drm/extract', self.drm_extract_handler)
        self.app.router.add_post('/drm/extract', self.drm_extract_handler)
        self.app.router.add_get('/drm/manifest', self.drm_manifest_handler)
        self.app.router.add_get('/drm/resource', self.drm_resource_handler)
        self.app.router.add_get('/drm/b/{base_b64}/{subpath:.*}', self.drm_base_resource_handler)
        
        # Debrid routes
        self.app.router.add_post('/api/debrid/unlock', self.debrid_unlock_handler)

        # System
        self.app.router.add_get('/health', self.health_handler)
        self.app.router.add_get('/stats', self.stats_handler)
    
    def _extract_debrid_error_message(self, payload: Dict[str, Any], fallback: str) -> str:
        """Normalize provider-specific error payloads."""
        error = payload.get('error')
        if isinstance(error, dict):
            message = error.get('message')
            if isinstance(message, str) and message.strip():
                return message
        elif isinstance(error, str) and error.strip():
            return error

        details = payload.get('error_details')
        if isinstance(details, str) and details.strip():
            return details

        message = payload.get('message')
        if isinstance(message, str) and message.strip():
            return message

        return fallback

    def _parse_debrid_filesize(self, size_value: Any) -> int:
        """Convert provider file sizes to bytes."""
        if isinstance(size_value, (int, float)) and not isinstance(size_value, bool):
            return max(int(size_value), 0)

        size_text = str(size_value or '').strip().upper()
        size_match = re.search(r'(\d+(?:[.,]\d+)?)\s*([KMGTPE]?I?B)', size_text)
        if size_match:
            amount = float(size_match.group(1).replace(',', '.'))
            unit = size_match.group(2)
            multipliers = {
                'B': 1,
                'KB': 1024,
                'MB': 1024 ** 2,
                'GB': 1024 ** 3,
                'TB': 1024 ** 4,
                'PB': 1024 ** 5,
                'EB': 1024 ** 6,
                'KIB': 1024,
                'MIB': 1024 ** 2,
                'GIB': 1024 ** 3,
                'TIB': 1024 ** 4,
                'PIB': 1024 ** 5,
                'EIB': 1024 ** 6,
            }
            return max(int(amount * multipliers.get(unit, 0)), 0)

        try:
            if 'GB' in size_text:
                return int(float(size_text.replace(' GB', '').replace('GB', '')) * 1073741824)
            if 'MB' in size_text:
                return int(float(size_text.replace(' MB', '').replace('MB', '')) * 1048576)
            if 'KB' in size_text:
                return int(float(size_text.replace(' KB', '').replace('KB', '')) * 1024)
            if size_text.isdigit():
                return int(size_text)
        except (ValueError, TypeError):
            return 0
        return 0

    def _extract_debrid_link(self, payload: Dict[str, Any]) -> str:
        for key in ('download', 'link'):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ''

    def _guess_filename_from_url(self, value: str) -> str:
        try:
            parsed = urlparse(value)
            path = urllib.parse.unquote(parsed.path or '')
            return path.rsplit('/', 1)[-1].strip()
        except Exception:
            return ''

    def _get_realdebrid_proxy_urls(self) -> Tuple[Optional[str], Optional[str]]:
        proxy = self._get_random_proxy()
        proxy_url = _build_socks5_proxy_url(proxy, default_type='socks5h')
        connector_proxy_url = _build_aiohttp_socks_proxy_url(proxy, default_type='socks5h')
        return proxy_url, connector_proxy_url

    def _build_realdebrid_headers(self) -> Dict[str, str]:
        return {
            'Authorization': f'Bearer {REAL_DEBRID_API_KEY}',
            'Accept': 'application/json',
            'User-Agent': 'movix-proxiesembed/1.0',
        }

    async def _unlock_with_deepbrid(self, link: str, password: str) -> Response:
        """Unlock a link via Deepbrid."""
        if not DEEPBRID_API_KEY:
            return web.json_response({'status': 'error', 'error': 'Service de debridage non configure'}, status=503)

        headers = {
            'Authorization': f'Bearer {DEEPBRID_API_KEY}',
        }
        form_data = aiohttp.FormData()
        form_data.add_field('link', link)
        if password:
            form_data.add_field('pass', password)

        async with aiohttp.ClientSession() as session:
            async with session.post(
                'https://www.deepbrid.com/api/v1/generate/link',
                headers=headers,
                data=form_data,
                timeout=ClientTimeout(total=30)
            ) as resp:
                result = await resp.json(content_type=None)

        if result.get('error') == 0 and result.get('link'):
            return web.json_response({
                'status': 'success',
                'data': {
                    'link': result.get('link', ''),
                    'filename': result.get('filename', ''),
                    'filesize': self._parse_debrid_filesize(result.get('size', '')),
                    'host': result.get('hoster', ''),
                }
            })

        error_msg = self._extract_debrid_error_message(result, 'Erreur lors du debridage')
        return web.json_response({'status': 'error', 'error': error_msg}, status=400)

    async def _unlock_with_realdebrid(self, link: str, password: str) -> Response:
        """Unlock a link via Real-Debrid."""
        if not REAL_DEBRID_API_KEY:
            return web.json_response({'status': 'error', 'error': 'Service de debridage non configure'}, status=503)

        proxy_url, connector_proxy_url = self._get_realdebrid_proxy_urls()
        if not proxy_url or not connector_proxy_url:
            return web.json_response({'status': 'error', 'error': 'Proxy SOCKS5 Real-Debrid non configure'}, status=503)

        headers = self._build_realdebrid_headers()
        form_data = {
            'link': link,
            'password': password or '',
        }

        logger.info(f"[DEBRID][REALDEBRID] Using SOCKS5 proxy: {_redact_proxy_url(proxy_url)}")
        connector = ProxyConnector.from_url(connector_proxy_url, rdns=True, limit=1)

        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.post(
                f'{REAL_DEBRID_API_BASE}/unrestrict/link',
                headers=headers,
                data=form_data,
                timeout=ClientTimeout(total=30)
            ) as resp:
                try:
                    result = await resp.json(content_type=None)
                except Exception:
                    raw_text = (await resp.text()).strip()
                    result = {'error': raw_text or 'Reponse invalide du provider'}
                status_code = resp.status

        if isinstance(result, dict):
            direct_link = self._extract_debrid_link(result)
            if 200 <= status_code < 300 and direct_link:
                filename = str(result.get('filename', '') or '').strip()
                host = str(result.get('host', '') or '').strip()

                if not filename:
                    filename = self._guess_filename_from_url(direct_link) or self._guess_filename_from_url(link)

                if not host:
                    host = urlparse(link).netloc.replace('www.', '') or urlparse(direct_link).netloc.replace('www.', '')

                return web.json_response({
                    'status': 'success',
                    'data': {
                        'link': direct_link,
                        'filename': filename,
                        'filesize': self._parse_debrid_filesize(result.get('filesize')),
                        'host': host,
                    }
                })

            error_msg = self._extract_debrid_error_message(result, 'Erreur lors du debridage')
        else:
            error_msg = 'Erreur lors du debridage'

        error_status = 400 if 400 <= status_code < 500 else 502
        return web.json_response({'status': 'error', 'error': error_msg}, status=error_status)

    def _extract_debridr_pow(self, page_html: str) -> Tuple[str, int, str]:
        """Read the public form fields required by DebridR's current page."""
        soup = BeautifulSoup(page_html, 'html.parser')
        form = soup.select_one('form.console[action]')
        seed_input = soup.select_one('input[name="pow_seed"]')
        seed = str(seed_input.get('value', '') if seed_input else '').strip()
        action = str(form.get('action', '') if form else '').strip()

        bits_match = re.search(r'\bbits\s*=\s*(\d+)', page_html)
        bits = int(bits_match.group(1)) if bits_match else 0

        if not seed or not action or bits < 1 or bits > 8:
            return '', 0, ''

        return seed, bits, action

    def _solve_debridr_pow(self, seed: str, bits: int) -> Optional[int]:
        """Run the small proof-of-work published in DebridR's form JavaScript."""
        target = '0' * bits
        for nonce in range(DEBRIDR_MAX_POW_ATTEMPTS):
            digest = hashlib.sha256(f'{seed}{nonce}'.encode('utf-8')).hexdigest()
            if digest.startswith(target):
                return nonce
        return None

    def _extract_debridr_page_error(self, page_html: str) -> str:
        """Prefer a displayed provider error over a generic HTTP failure."""
        soup = BeautifulSoup(page_html, 'html.parser')
        for selector in ('.error', '.err', '.alert', '[role="alert"]', '.panel.error'):
            element = soup.select_one(selector)
            if element:
                message = element.get_text(' ', strip=True)
                if message:
                    return message[:300]

        page_text = soup.get_text(' ', strip=True)
        patterns = (
            r'[^.]{0,80}(?:rate limit|daily limit|quota|unsupported|invalid link|link not found|try again)[^.]{0,160}',
            r'[^.]{0,80}(?:could not|cannot|failed to)[^.]{0,160}',
        )
        for pattern in patterns:
            match = re.search(pattern, page_text, re.IGNORECASE)
            if match:
                return match.group(0).strip()[:300]
        return ''

    async def _get_debridr_host_status(self, host: str) -> str:
        """Return an actionable DebridR host status, cached to avoid extra load."""
        normalized_host = host.lower().removeprefix('www.')
        if not normalized_host:
            return ''

        statuses = self.debridr_status_cache.get('hosts')
        if statuses is None:
            try:
                headers = {
                    'Accept': 'text/html,application/xhtml+xml',
                    'User-Agent': 'Movix/1.0 (+https://movix.online)',
                }
                timeout = ClientTimeout(total=15)
                async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
                    async with session.get(f'{DEBRIDR_BASE_URL}/status') as response:
                        if response.status != 200:
                            return ''
                        status_html = await response.text()

                soup = BeautifulSoup(status_html, 'html.parser')
                statuses = {}
                for row in soup.select('.srow'):
                    host_element = row.select_one('.shost')
                    badge_element = row.select_one('.sbadge')
                    if not host_element or not badge_element:
                        continue
                    status_host = host_element.get_text(' ', strip=True).lower().removeprefix('www.')
                    status_badge = badge_element.get_text(' ', strip=True)
                    if status_host and status_badge:
                        statuses[status_host] = status_badge
                self.debridr_status_cache.set('hosts', statuses)
            except (aiohttp.ClientError, asyncio.TimeoutError):
                return ''

        status = statuses.get(normalized_host, '') if isinstance(statuses, dict) else ''
        normalized_status = status.lower()
        if status and any(marker in normalized_status for marker in ('down', 'issues')):
            return f'DebridR indique que {normalized_host} est actuellement « {status} ».'
        return ''

    async def _debridr_error_response(self, status_code: int, page_html: str, host: str) -> Response:
        """Normalize a DebridR failure and enrich it with its live host status."""
        provider_message = self._extract_debridr_page_error(page_html)
        lower_message = provider_message.lower()

        if status_code == 429 or any(marker in lower_message for marker in ('rate limit', 'daily limit', 'quota')):
            message = 'Limite DebridR atteinte. Attendez avant de réessayer.'
            response_status = 429
        elif status_code in (401, 403) or 'proof-of-work' in lower_message:
            message = 'DebridR a refusé la demande. Réessayez plus tard depuis le site DebridR.'
            response_status = 403
        elif 500 <= status_code:
            message = 'DebridR est temporairement indisponible.'
            response_status = 502
        else:
            message = provider_message or 'DebridR n’a pas pu générer de lien téléchargeable pour cette URL.'
            response_status = 400

        host_status = await self._get_debridr_host_status(host)
        if host_status:
            message = f'{message} {host_status}'

        return web.json_response({'status': 'error', 'error': message}, status=response_status)

    async def _authenticate_with_debridr(self, session: aiohttp.ClientSession) -> Tuple[bool, int, str]:
        """Attach the optional premium account to the current DebridR session."""
        if not DEBRIDR_ACCOUNT_KEY:
            return True, 0, ''

        async with session.post(
            f'{DEBRIDR_BASE_URL}/account/login',
            data={'key': DEBRIDR_ACCOUNT_KEY},
        ) as response:
            status_code = response.status
            response_html = await response.text()

        page_text = BeautifulSoup(response_html, 'html.parser').get_text(' ', strip=True).lower()
        rejected = any(marker in page_text for marker in ('invalid key', 'enter your key', 'login failed'))
        return 200 <= status_code < 300 and not rejected, status_code, response_html

    async def _resolve_debridr_direct_download(
        self,
        session: aiohttp.ClientSession,
        result_url: str,
        go_url: str,
    ) -> Tuple[str, int, str]:
        """Resolve DebridR's result page to its final CDN URL without downloading it."""
        async with session.get(go_url, headers={'Referer': result_url}) as go_response:
            go_status = go_response.status
            go_html = await go_response.text()
            go_page_url = str(go_response.url)

        if not 200 <= go_status < 300:
            return '', go_status, go_html

        go_soup = BeautifulSoup(go_html, 'html.parser')
        download_button = go_soup.select_one('a.dl[href]')
        if not download_button:
            return '', go_status, go_html

        current_url = urljoin(go_page_url, str(download_button.get('href', '')).strip())
        referer = go_page_url
        for _ in range(3):
            parsed_url = urlparse(current_url)
            if parsed_url.scheme not in ('http', 'https') or not parsed_url.netloc:
                return '', 502, ''

            async with session.get(
                current_url,
                headers={'Referer': referer},
                allow_redirects=False,
            ) as download_response:
                status_code = download_response.status
                location = str(download_response.headers.get('Location', '')).strip()

                if status_code in (301, 302, 303, 307, 308) and location:
                    next_url = urljoin(current_url, location)
                    next_host = (urlparse(next_url).hostname or '').lower().removeprefix('www.')
                    if next_host and next_host != 'debridr.com' and not next_host.endswith('.debridr.com'):
                        return next_url, status_code, ''
                    referer = current_url
                    current_url = next_url
                    continue

                if 200 <= status_code < 300:
                    # A provider may serve the file from /dl directly instead of redirecting.
                    content_type = str(download_response.headers.get('Content-Type', '')).lower()
                    if 'text/html' not in content_type:
                        return current_url, status_code, ''
                    response_html = await download_response.text()
                    return '', status_code, response_html

                response_html = await download_response.text()
                return '', status_code, response_html

        return '', 502, ''

    async def _unlock_with_debridr(self, link: str) -> Response:
        """Submit DebridR's public form and extract its generated download URL."""
        parsed_link = None
        try:
            parsed_link = urlparse(link)
            source_host = (parsed_link.hostname or '').lower().removeprefix('www.')
        except (TypeError, ValueError):
            source_host = ''

        if not parsed_link or parsed_link.scheme not in ('http', 'https') or not source_host:
            return web.json_response({
                'status': 'error',
                'error': 'Lien invalide. Utilisez une URL HTTP ou HTTPS complète.'
            }, status=400)

        if source_host == 'debridr.com' or source_host.endswith('.debridr.com'):
            return web.json_response({
                'status': 'error',
                'error': 'Un lien DebridR ne peut pas être débridé à nouveau.'
            }, status=400)

        headers = {
            'Accept': 'text/html,application/xhtml+xml',
            'User-Agent': 'Movix/1.0 (+https://movix.online)',
        }
        timeout = ClientTimeout(total=DEBRIDR_REQUEST_TIMEOUT)

        try:
            async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
                authenticated, auth_status, auth_html = await self._authenticate_with_debridr(session)
                if not authenticated:
                    logger.warning('[DEBRID][DEBRIDR] Premium account authentication was rejected')
                    return web.json_response({
                        'status': 'error',
                        'error': self._extract_debridr_page_error(auth_html) or 'La clé de compte DebridR a été refusée.'
                    }, status=401 if auth_status in (401, 403) else 502)

                async with session.get(f'{DEBRIDR_BASE_URL}/') as form_response:
                    form_status = form_response.status
                    form_html = await form_response.text()
                    form_url = str(form_response.url)

                if form_status != 200:
                    return await self._debridr_error_response(form_status, form_html, source_host)

                seed, bits, action = self._extract_debridr_pow(form_html)
                if not seed:
                    logger.warning('[DEBRID][DEBRIDR] Form layout changed or proof-of-work fields are missing')
                    return web.json_response({
                        'status': 'error',
                        'error': 'La page DebridR a changé. Le connecteur doit être mis à jour.'
                    }, status=502)

                nonce = await asyncio.to_thread(self._solve_debridr_pow, seed, bits)
                if nonce is None:
                    logger.warning('[DEBRID][DEBRIDR] Proof-of-work could not be completed within the configured limit')
                    return web.json_response({
                        'status': 'error',
                        'error': 'DebridR demande une vérification qui n’a pas pu être finalisée. Réessayez plus tard.'
                    }, status=503)

                payload = {'url': link, 'pow_seed': seed, 'pow_nonce': str(nonce)}
                async with session.post(
                    urljoin(form_url, action),
                    data=payload,
                    headers={'Referer': form_url},
                ) as result_response:
                    result_status = result_response.status
                    result_html = await result_response.text()
                    result_url = str(result_response.url)

                direct_link = ''
                direct_status = 502
                direct_html = ''
                filename = ''
                filesize = 0
                if 200 <= result_status < 300:
                    result_soup = BeautifulSoup(result_html, 'html.parser')
                    download_element = result_soup.select_one('a.dl[href]')
                    if download_element:
                        go_link = urljoin(result_url, str(download_element.get('href', '')).strip())
                        direct_link, direct_status, direct_html = await self._resolve_debridr_direct_download(
                            session,
                            result_url,
                            go_link,
                        )
                        filename_element = result_soup.select_one('.fname')
                        size_element = result_soup.select_one('.fsize')
                        filename = filename_element.get_text(' ', strip=True) if filename_element else ''
                        filesize = self._parse_debrid_filesize(
                            size_element.get_text(' ', strip=True) if size_element else ''
                        )
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return web.json_response({
                'status': 'error',
                'error': 'Impossible de joindre DebridR. Réessayez dans quelques instants.'
            }, status=502)

        if not 200 <= result_status < 300:
            return await self._debridr_error_response(result_status, result_html, source_host)

        if not direct_link:
            return await self._debridr_error_response(direct_status, direct_html or result_html, source_host)

        parsed_download_link = urlparse(direct_link)
        if parsed_download_link.scheme not in ('http', 'https') or not parsed_download_link.netloc:
            logger.warning('[DEBRID][DEBRIDR] Result page returned an invalid download URL')
            return web.json_response({
                'status': 'error',
                'error': 'DebridR a renvoyé un lien de téléchargement invalide.'
            }, status=502)

        return web.json_response({
            'status': 'success',
            'data': {
                'link': direct_link,
                'filename': filename or self._guess_filename_from_url(link) or 'download.bin',
                'filesize': filesize,
                'host': source_host,
            }
        })

    async def debrid_unlock_handler(self, request: Request) -> Response:
        """Unlock a link via the selected debrid provider."""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            data = await request.json()
            if not isinstance(data, dict):
                return web.json_response({'status': 'error', 'error': 'Requête invalide'}, status=400)

            raw_link = data.get('link', '')
            raw_password = data.get('password', '')
            link = raw_link.strip() if isinstance(raw_link, str) else ''
            password = raw_password.strip() if isinstance(raw_password, str) else ''
            provider = (str(data.get('provider', 'deepbrid')).strip().lower() or 'deepbrid').replace('-', '')

            if not link:
                return web.json_response({'status': 'error', 'error': 'Lien manquant'}, status=400)

            if provider not in DEBRID_PROVIDERS:
                return web.json_response({'status': 'error', 'error': 'Provider de debridage invalide'}, status=400)

            if provider == 'realdebrid':
                return await self._unlock_with_realdebrid(link, password)

            if provider == 'debridr':
                return await self._unlock_with_debridr(link)

            return await self._unlock_with_deepbrid(link, password)


        except asyncio.TimeoutError:
            return web.json_response({'status': 'error', 'error': 'Timeout lors du dÃ©bridage'}, status=504)
        except Exception as e:
            logger.error(f'[DEBRID] Error unlocking link: {e}')
            return web.json_response({'status': 'error', 'error': 'Erreur interne du serveur'}, status=500)

    async def health_handler(self, request: Request) -> Response:
        """Quick health check endpoint"""
        return web.json_response({
            "status": "ok", 
            "message": "Ultra High Performance Proxy Server",
            "active_streams": self._active_streams
        })
    
    async def stats_handler(self, request: Request) -> Response:
        """Detailed performance statistics endpoint"""
        import gc
        
        # Collect cache stats
        cache_stats = {
            'voe_cache': f"{len(self.voe_cache._cache)}/{self.voe_cache._maxsize}",
            'fsvid_cache': f"{len(self.fsvid_cache._cache)}/{self.fsvid_cache._maxsize}",
            'vidzy_cache': f"{len(self.vidzy_cache._cache)}/{self.vidzy_cache._maxsize}",
            'vidmoly_cache': f"{len(self.vidmoly_cache._cache)}/{self.vidmoly_cache._maxsize}",
            'sibnet_cache': f"{len(self.sibnet_cache._cache)}/{self.sibnet_cache._maxsize}",
            'uqload_cache': f"{len(self.uqload_cache._cache)}/{self.uqload_cache._maxsize}",
            'uqload_mp4_cache': f"{len(self.uqload_mp4_cache._cache)}/{self.uqload_mp4_cache._maxsize}",
            'doodstream_cache': f"{len(self.doodstream_cache._cache)}/{self.doodstream_cache._maxsize}",
            'seekstreaming_cache': f"{len(self.seekstreaming_cache._cache)}/{self.seekstreaming_cache._maxsize}",
            'vip_cache': f"{len(self.vip_cache._cache)}/{self.vip_cache._maxsize}",
            'm3u8_response_cache': f"{len(self.m3u8_response_cache._cache)}/{self.m3u8_response_cache._maxsize}",
            'm3u8_vod_cache': f"{len(self.m3u8_vod_cache._cache)}/{self.m3u8_vod_cache._maxsize}",
        }
        
        # Session stats
        session_stats = {}
        for name, session in self.sessions.items():
            if hasattr(session, 'connector') and session.connector:
                connector = session.connector
                session_stats[name] = {
                    'limit': connector.limit,
                    'limit_per_host': connector.limit_per_host,
                }
        
        return web.json_response({
            "status": "ok",
            "performance": {
                "total_requests": self._request_count,
                "active_streams": self._active_streams,
                "bandwidth_saved_bytes": self._bandwidth_saved,
                "bandwidth_saved_mb": round(self._bandwidth_saved / (1024 * 1024), 2),
                "cache_hits": self._cache_hits,
                "coalesced_requests": self._coalesced_requests,
                "coalesced_segments": self._coalesced_segments,
                "segment_cache_hits": self._segment_cache_hits,
                "segment_buffer": self.segment_buffer.stats,
                "gc_threshold": gc.get_threshold(),
                "gc_count": gc.get_count(),
            },
            "caches": cache_stats,
            "sessions": session_stats,
            "config": {
                "chunk_ts": CHUNK_TS,
                "chunk_mp4": CHUNK_MP4,
                "chunk_default": CHUNK_DEFAULT,
                "chunk_large": CHUNK_LARGE,
                "keepalive_timeout": KEEPALIVE_TIMEOUT,
                "dns_cache_ttl": DNS_CACHE_TTL,
                "socket_read_buffer": SOCKET_READ_BUFFER,
            }
        })
    
    def _detect_service(self, url: str) -> str:
        """Detect which service the URL belongs to"""
        if self.RE_BANDWIDTH.search(url):
            return 'bandwidth'
        if self.RE_VIDZY.search(url):
            return 'vidzy'
        if self.RE_FSVID.search(url):
            return 'fsvid'
        if self.RE_SIBNET.search(url):
            return 'sibnet'
        if self.RE_VMWESA.search(url):
            return 'vmwesa'
        if self.RE_FAMILYRESTREAM.search(url):
            return 'familyrestream'
        if self.RE_SOSPLAY.search(url):
            return 'sosplay'
        if self.RE_WITV.search(url):
            return 'witv'
        if self.RE_UQLOAD_EMBED.search(url):
            return 'uqload_embed'
        if self.RE_DOODSTREAM.search(url):
            return 'doodstream'
        try:
            parse_seekstreaming_embed_url(url)
        except ValueError:
            pass
        else:
            return 'seekstreaming'
        return 'generic'
    
    async def proxy_handler(self, request: Request) -> Response:
        """Main proxy handler - optimized"""
        try:
            if request.method == 'OPTIONS':
                return web.Response(headers=CORS_HEADERS)
            
            # Extract target URL
            path = request.match_info.get('path', '')
            if path:
                decoded_path = decode_url(path)
                target_url = decoded_path if decoded_path.startswith(('http://', 'https://')) else urllib.parse.unquote(path)
            else:
                target_url = request.query.get('url', '')
                if not target_url:
                    return web.json_response({'error': 'No URL provided'}, status=400)

            # SeekStreaming must use its dedicated route, which enforces strict
            # URL validation and a public-only DNS connector. Reject it before
            # processing caller headers, logging, or dispatching upstream.
            try:
                parse_seekstreaming_embed_url(target_url)
            except ValueError:
                pass
            else:
                return web.json_response(
                    {"error": "Unsupported proxy target"},
                    status=400,
                    headers=CORS_HEADERS,
                )
            
            # Parse use_proxy parameter (0=first SOCKS5, 1=second, etc.)
            use_proxy_param = request.query.get('use_proxy')
            use_proxy = int(use_proxy_param) if use_proxy_param is not None and use_proxy_param.isdigit() else None

            # ponytail: use_proxy_key (deterministic SOCKS-pool spread for fctv) removed —
            # fctv no longer routed through SOCKS5. Param still stripped below so a stray
            # ?use_proxy_key never leaks upstream. Explicit ?use_proxy=N still works.

            # Reconstruct split query parameters (handles unencoded URLs)
            query_params = []
            for k, v in request.query.items():
                if k not in ('url', 'headers', 'referer', 'origin', 'user_agent', 'user-agent', 'sosplay', 'use_proxy', 'use_proxy_key'):
                    query_params.append((k, v))
            
            if query_params:
                target_url += ('&' if '?' in target_url else '?') + urllib.parse.urlencode(query_params)
            
            # Parse and clean URL
            parsed_target = urlparse(target_url)
            
            # Check for sosplay mode (forces streaming CDN headers)
            sosplay_mode = request.query.get('sosplay', '').lower() == 'true'
            
            # Extract custom headers
            custom_headers = {}
            headers_param = request.query.get('headers')
            if not headers_param and parsed_target.query:
                url_params = urllib.parse.parse_qs(parsed_target.query)
                headers_param = url_params.get('headers', [None])[0]
            
            if headers_param:
                try:
                    custom_headers = json.loads(headers_param)
                except Exception as e:
                    logger.error(f"Failed to parse custom headers: {e}, param: {headers_param}")
                    pass

            shortcut_headers = {}
            shortcut_header_map = {
                'referer': 'Referer',
                'origin': 'Origin',
                'user_agent': 'User-Agent',
                'user-agent': 'User-Agent',
            }
            for query_key, header_key in shortcut_header_map.items():
                shortcut_value = request.query.get(query_key)
                if shortcut_value:
                    shortcut_headers[header_key] = shortcut_value

            if shortcut_headers:
                custom_headers = {**custom_headers, **shortcut_headers}
            
            # Clean proxy-specific params from target URL
            proxy_params = {'headers', 'referer', 'origin', 'user_agent', 'user-agent', 'url', 'sosplay', 'use_proxy', 'use_proxy_key'}
            if parsed_target.query:
                existing_params = urllib.parse.parse_qs(parsed_target.query, keep_blank_values=True)
                for p in proxy_params:
                    existing_params.pop(p, None)
                
                if existing_params:
                    query_parts = [f'{k}={v[0] if isinstance(v, list) and len(v) == 1 else v}' 
                                   for k, vals in existing_params.items() 
                                   for v in (vals if isinstance(vals, list) else [vals])]
                    target_url = f"{parsed_target.scheme}://{parsed_target.netloc}{parsed_target.path}"
                    if query_parts:
                        target_url += '?' + '&'.join(query_parts)
            
            # Fix recursive proxy
            target_url = re.sub(r'localhost(:\d+)?/proxy/', '', target_url, flags=re.IGNORECASE)
            
            if not target_url.startswith(('http://', 'https://')):
                target_url = 'https://' + target_url
            
            # Fix malformed URLs with multiple slashes (e.g., https:////domain.com -> https://domain.com)
            target_url = re.sub(r'^(https?:)/{2,}', r'\1//', target_url)
            
            # Validate URL before making request
            try:
                validated_parsed = urlparse(target_url)
                if not validated_parsed.netloc:
                    return web.json_response({'error': 'Invalid URL: missing domain'}, status=400, headers=CORS_HEADERS)
                
                # Check domain label length (DNS limit is 63 chars per label)
                domain_labels = validated_parsed.netloc.split('.')
                for label in domain_labels:
                    # Remove port if present
                    label_clean = label.split(':')[0] if ':' in label else label
                    if len(label_clean) > 63:
                        return web.json_response({'error': f'Invalid URL: domain label too long ({len(label_clean)} > 63 chars)'}, status=400, headers=CORS_HEADERS)
                
                # Test IDNA encoding to catch issues early
                validated_parsed.netloc.encode('idna')
            except UnicodeError as e:
                logger.warning(f'Invalid URL encoding rejected: {e}')
                return web.json_response({'error': f'Invalid URL encoding: {str(e)}'}, status=400, headers=CORS_HEADERS)
            except Exception as e:
                logger.warning(f'URL validation failed: {e}')
                return web.json_response({'error': f'Invalid URL: {str(e)}'}, status=400, headers=CORS_HEADERS)
            
            # Detect content type
            content = detect_content_type(target_url, request.headers.get('accept', ''))
            is_bandwidth = 'edgeon-bandwidth.com' in target_url.lower()
            
            # Prepare headers
            headers = self._prepare_headers(target_url, request)
            if custom_headers:
                headers.update(self._normalize_custom_headers(custom_headers))
            headers = self._ensure_origin_matches_referer(headers)
            
            # Range header
            range_header = request.headers.get('range') or request.headers.get('Range')
            if range_header and content.is_mp4:
                headers['Range'] = range_header
            
            # Configure timeout based on content type and service
            service = self._detect_service(target_url)

            # Debug logs (use DEBUG level to avoid I/O overhead on every request)
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(f"Target URL: {target_url}")
                logger.debug(f"Custom Headers: {custom_headers}")
                logger.debug(f"Final Headers: {headers}")
            
            # Override service detection if sosplay mode is enabled
            if sosplay_mode:
                service = 'sosplay_cdn'
            
            if content.is_m3u8:
                # M3U8 playlists ALWAYS get a total timeout â€” they are small files.
                # Without this, sosplay/witv M3U8 requests could hang forever.
                timeout = ClientTimeout(total=30, connect=10, sock_read=20)
            elif content.is_mp4 and range_header:
                timeout = ClientTimeout(total=None, connect=10, sock_read=30)
            elif content.is_mp4:
                timeout = ClientTimeout(total=60, connect=10, sock_read=30)
            elif content.is_ts or content.is_m4s:
                # TS/M4S segments need longer timeouts for slow servers
                timeout = ClientTimeout(total=None, connect=10, sock_read=60)
            elif service in ('familyrestream', 'fsvid', 'sosplay', 'witv'):
                # Streaming services need longer timeouts for non-playlist content
                timeout = ClientTimeout(total=None, connect=15, sock_read=60)
            else:
                # Unknown content: use no total timeout so live IPTV streams
                # (extensionless URLs) are not killed after 15s.
                # sock_read guards against truly dead connections.
                timeout = ClientTimeout(total=None, connect=10, sock_read=30)
            
            # Route to service handler
            
            return await self._handle_service_request(
                request, target_url, headers, timeout, content,
                service, range_header, is_bandwidth, sosplay_mode, custom_headers,
                use_proxy=use_proxy
            )
            
        except Exception as error:
            logger.exception('Proxy error')
            return web.json_response(
                {
                    'error': 'Proxy error',
                    'exception': type(error).__name__,
                    'message': str(error) or None,
                    'details': repr(error),
                },
                status=500,
                headers=CORS_HEADERS,
            )
    
    async def _fetch_m3u8_upstream(self, target_url: str, headers: Dict,
                                    timeout: ClientTimeout, content: ContentType,
                                    service: str, is_bandwidth: bool,
                                    sosplay_mode: bool, custom_headers: Optional[Dict],
                                    request: Request, use_proxy: Optional[int],
                                    session) -> Tuple[int, bytes, Dict[str, str], Optional[str]]:
        """Fetch an M3U8 playlist upstream and return serialisable result.

        Returns (status, body, headers_dict, redirect_location_or_None).
        This method is designed to be wrapped by RequestCoalescer so that
        concurrent identical requests only perform ONE upstream fetch.
        """
        async with session.request('GET', target_url, headers=headers,
                                    timeout=timeout,
                                    allow_redirects=False) as response:
            resp_headers = self._prepare_stream_headers(response.headers)

            # Redirects
            if 300 <= response.status < 400:
                location = response.headers.get('location') or response.headers.get('Location')
                if location:
                    abs_location = location
                    if not abs_location.startswith(('http://', 'https://')):
                        abs_location = urljoin(target_url, abs_location)
                    encoded_location = encode_url(abs_location)
                    query_parts = []
                    if custom_headers:
                        query_parts.append('headers=' + urllib.parse.quote(json.dumps(custom_headers)))
                    if use_proxy is not None:
                        query_parts.append(f'use_proxy={use_proxy}')
                    suffix = ('?' + '&'.join(query_parts)) if query_parts else ''
                    proxied_location = f"/proxy/{encoded_location}{suffix}"
                    return (response.status, b'', {**CORS_HEADERS, 'Cache-Control': 'no-cache'}, proxied_location)

            # Upstream HTTP errors
            if response.status >= 400:
                err_body = await response.read()
                err_text = err_body.decode('utf-8', errors='replace') if err_body else '(empty)'
                logger.warning(f"[PROXY] Upstream HTTP {response.status} for {target_url} â€” headers_sent: {headers} â€” body: {err_text[:200]}")
                body = json.dumps({
                    'error': f'Upstream HTTP error: {response.status}',
                    'upstream_status': response.status,
                    'upstream_url': target_url,
                    'upstream_body': err_text[:2000]
                }).encode()
                return (response.status, body, {**CORS_HEADERS, 'Content-Type': 'application/json'}, None)

            # Read M3U8 body (small file, safe to buffer fully)
            m3u8_probe = await response.content.read(2048)
            if m3u8_probe and self._is_valid_m3u8(m3u8_probe.decode('utf-8', errors='ignore')):
                rest = await response.content.read(10 * 1024 * 1024)
                raw_body = m3u8_probe + rest
                m3u8_resp = await self._handle_m3u8_response(
                    response, target_url, resp_headers, is_bandwidth,
                    is_sosplay=(service in ('sosplay', 'sosplay_cdn') or sosplay_mode),
                    is_witv=(service == 'witv'),
                    custom_headers=custom_headers,
                    request=request,
                    use_proxy=use_proxy,
                    raw_body=raw_body
                )
                if m3u8_resp is not None:
                    return (m3u8_resp.status, m3u8_resp.body, dict(m3u8_resp.headers), None)
                return (502, json.dumps({
                    'error': 'Failed to process M3U8 stream',
                    'upstream_url': target_url
                }).encode(), {**CORS_HEADERS, 'Content-Type': 'application/json'}, None)

            # Not a valid M3U8 despite URL/content-type â€” return probe bytes
            # so caller can fall back to streaming
            return (-1, m3u8_probe or b'', dict(resp_headers), None)

    async def _fetch_segment_upstream(self, target_url: str, headers: Dict,
                                       timeout: ClientTimeout, session,
                                       custom_headers: Optional[Dict],
                                       use_proxy: Optional[int]) -> Tuple[int, bytes, Dict[str, str], Optional[str]]:
        """Fetch a TS/M4S segment upstream and return buffered result.

        Returns (status, body_bytes, headers_dict, redirect_location_or_None).
        Designed to be wrapped by RequestCoalescer so N concurrent requests
        for the same segment only perform ONE upstream fetch (Dispatcharr-style).
        """
        async with session.request('GET', target_url, headers=headers,
                                    timeout=timeout,
                                    allow_redirects=False) as response:
            resp_headers = self._prepare_stream_headers(response.headers)

            # Redirects â€” rewrite location through proxy
            if 300 <= response.status < 400:
                location = response.headers.get('location') or response.headers.get('Location')
                if location:
                    abs_location = location
                    if not abs_location.startswith(('http://', 'https://')):
                        abs_location = urljoin(target_url, abs_location)
                    encoded_location = encode_url(abs_location)
                    query_parts = []
                    if custom_headers:
                        query_parts.append('headers=' + urllib.parse.quote(json.dumps(custom_headers)))
                    if use_proxy is not None:
                        query_parts.append(f'use_proxy={use_proxy}')
                    suffix = ('?' + '&'.join(query_parts)) if query_parts else ''
                    proxied_location = f"/proxy/{encoded_location}{suffix}"
                    return (response.status, b'', {**CORS_HEADERS, 'Cache-Control': 'no-cache'}, proxied_location)

            # Upstream errors
            if response.status >= 400:
                err_body = await response.read()
                err_text = err_body.decode('utf-8', errors='replace') if err_body else '(empty)'
                logger.warning(f"[PROXY] Upstream HTTP {response.status} for segment {target_url} â€” headers_sent: {headers} â€” body: {err_text[:200]}")
                body = json.dumps({
                    'error': f'Upstream HTTP error: {response.status}',
                    'upstream_status': response.status,
                    'upstream_url': target_url,
                    'upstream_body': err_text[:2000],
                }).encode()
                return (response.status, body, {**CORS_HEADERS, 'Content-Type': 'application/json'}, None)

            # Buffer the full segment (live TS segments are typically 1-8 MB)
            body = await response.read()
            return (response.status, body, dict(resp_headers), None)

    async def _handle_service_request(self, request: Request, target_url: str,
                                       headers: Dict, timeout: ClientTimeout,
                                       content: ContentType, service: str,
                                       range_header: Optional[str], is_bandwidth: bool,
                                       sosplay_mode: bool = False,
                                       custom_headers: Optional[Dict] = None,
                                       use_proxy: Optional[int] = None) -> Response:
        """
        ULTRA-OPTIMIZED service request handler for high load
        Features:
        - Uses fast streaming for large files
        - Minimal logging overhead
        - Request counting for metrics
        - Optimized error handling
        - M3U8 request coalescing (identical concurrent requests â†’ single upstream fetch)
        """

        self._request_count += 1

        # Get session - already optimized for pooling
        session = self._get_session(service, target_url, use_proxy=use_proxy)

        # Handle UQLOAD embed specially
        if service == 'uqload_embed':
            return await self._handle_uqload_embed(request, target_url, headers, timeout, range_header, session)
        
        # Service-specific headers (minimal overhead)
        # Note: If custom_headers is provided (from embed extraction), they are already merged in proxy_handler
        # so we don't need sosplay_cdn special handling anymore
        
        if service == 'familyrestream':
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
                'Accept': '*/*, application/vnd.apple.mpegurl',
                'Connection': 'keep-alive'
            }
            if range_header:
                headers['Range'] = range_header
        
        elif service == 'sosplay':
            headers = {
                'User-Agent': headers.get('User-Agent', 'Mozilla/5.0 Chrome/120.0.0.0'),
                'Accept': '*/*',
                'Referer': 'https://notoriousleash.net/',
                'Origin': 'https://notoriousleash.net',
                'Connection': 'keep-alive'
            }
        
        elif service == 'witv':
            headers = {
                'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0',
                'Accept': '*/*',
                'Accept-Language': 'fr-FR,fr;q=0.9',
                'Accept-Encoding': 'identity',
                'Origin': 'https://witv.website',
                'Referer': 'https://witv.website/',
                'Sec-Fetch-Mode': 'cors',
                'Connection': 'keep-alive'
            }

        if custom_headers:
            headers.update(self._normalize_custom_headers(custom_headers))

        headers = self._ensure_origin_matches_referer(headers)
        
        try:
            # â”€â”€ M3U8 cache + coalescing path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            # 1. Check server-side M3U8 cache (VOD=120s, live=5s)
            # 2. If miss, coalesce concurrent fetches (1 upstream for N clients)
            # 3. Store result in appropriate cache
            if content.is_m3u8:
                cache_key = target_url

                # 1. Check caches (VOD first â€” longer TTL, more likely hit)
                cached = self.m3u8_vod_cache.get(cache_key) or self.m3u8_response_cache.get(cache_key)
                if cached is not None:
                    self._cache_hits += 1
                    status, body, resp_hdrs, redirect_loc = cached
                    if redirect_loc:
                        return web.Response(
                            status=status,
                            headers={**resp_hdrs, 'Location': redirect_loc},
                        )
                    return web.Response(body=body, status=status, headers=resp_hdrs)

                # 2. Coalesce concurrent requests (1 fetch for N clients)
                coalesce_key = target_url
                is_coalesced, result = await self.coalescer.get_or_fetch(
                    coalesce_key,
                    self._fetch_m3u8_upstream(
                        target_url, headers, timeout, content, service,
                        is_bandwidth, sosplay_mode, custom_headers, request,
                        use_proxy, session
                    )
                )
                status, body, resp_hdrs, redirect_loc = result

                if is_coalesced:
                    self._coalesced_requests += 1
                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug(f"[COALESCE] M3U8 piggy-backed for {target_url}")

                # 3. Store in cache (skip errors and non-M3U8 probes)
                if status == 200 and body:
                    if b'#EXT-X-ENDLIST' in body:
                        self.m3u8_vod_cache.set(cache_key, result)
                    else:
                        self.m3u8_response_cache.set(cache_key, result)

                # status == -1 means probe showed it's not a real M3U8
                # (binary IPTV stream with wrong Content-Type).
                # Fall through to generic path which opens its own request.
                if status != -1:
                    if redirect_loc:
                        return web.Response(
                            status=status,
                            headers={**resp_hdrs, 'Location': redirect_loc},
                        )
                    return web.Response(body=body, status=status, headers=resp_hdrs)

            # â”€â”€ TS/M4S segment coalescing + cache (Dispatcharr-style) â”€â”€â”€â”€â”€
            # N clients watching the same live channel request the same segments.
            # 1. Check in-memory SegmentBuffer (instant, no upstream fetch)
            # 2. If miss, coalesce concurrent requests (1 fetch for N clients)
            # 3. Store result in SegmentBuffer for next clients
            if content.is_ts or content.is_m4s:
                is_ts = content.is_ts
                ct = 'video/mp2t' if is_ts else 'video/iso.segment'
                seg_headers = {
                    **CORS_HEADERS,
                    'Content-Type': ct,
                    'Cache-Control': 'public, max-age=86400, immutable',
                    'Accept-Ranges': 'bytes',
                }

                # 1. Check segment buffer cache
                cached_data = self.segment_buffer.get(target_url)
                if cached_data is not None:
                    self._segment_cache_hits += 1
                    self._cache_hits += 1
                    seg_headers['Content-Length'] = str(len(cached_data))
                    seg_headers['X-Segment-Cache'] = 'HIT'
                    return web.Response(body=cached_data, status=200, headers=seg_headers)

                # 2. Coalesce concurrent requests
                coalesce_key = f"seg:{target_url}"
                is_coalesced, result = await self.coalescer.get_or_fetch(
                    coalesce_key,
                    self._fetch_segment_upstream(
                        target_url, headers, timeout, session,
                        custom_headers, use_proxy
                    )
                )
                status, body, resp_hdrs, redirect_loc = result

                if is_coalesced:
                    self._coalesced_segments += 1

                # Handle redirect
                if redirect_loc:
                    return web.Response(
                        status=status,
                        headers={**resp_hdrs, 'Location': redirect_loc},
                    )

                # Handle error
                if status >= 400:
                    return web.Response(body=body, status=status, headers=resp_hdrs)

                # 3. Store in segment buffer for next clients
                if status == 200 and body:
                    self.segment_buffer.put(target_url, body)

                seg_headers.update(resp_hdrs)
                seg_headers['Content-Type'] = ct
                seg_headers['Content-Length'] = str(len(body))
                seg_headers['X-Segment-Cache'] = 'COALESCED' if is_coalesced else 'MISS'
                return web.Response(body=body, status=status, headers=seg_headers)

            # â”€â”€ Generic (non-M3U8, non-segment) path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            # We must not auto-follow redirects here.
            # If upstream returns 302/301, we forward that status + Location back to the client.
            allow_redirects = False

            async with session.request('GET', target_url, headers=headers,
                                        timeout=timeout,
                                        allow_redirects=allow_redirects) as response:

                resp_headers = self._prepare_stream_headers(response.headers)
                response_content_type = (response.headers.get('Content-Type') or '').lower()
                is_m3u8_response = (
                    'mpegurl' in response_content_type
                    or str(response.url).lower().split('?', 1)[0].endswith('.m3u8')
                )

                # Pass through redirects (302/301/307/308, etc.) while keeping the client inside the proxy.
                # This is important for some providers that redirect to a different CDN hostname.
                if 300 <= response.status < 400:
                    location = response.headers.get('location') or response.headers.get('Location')
                    if location:
                        try:
                            abs_location = location
                            if not abs_location.startswith(('http://', 'https://')):
                                abs_location = urljoin(target_url, abs_location)

                            encoded_location = encode_url(abs_location)
                            query_parts = []
                            if custom_headers:
                                query_parts.append('headers=' + urllib.parse.quote(json.dumps(custom_headers)))
                            if use_proxy is not None:
                                query_parts.append(f'use_proxy={use_proxy}')
                            suffix = ('?' + '&'.join(query_parts)) if query_parts else ''
                            proxied_location = f"/proxy/{encoded_location}{suffix}"
                        except Exception as e:
                            logger.warning(f"[PROXY] Failed to rewrite redirect Location: {e}")
                            proxied_location = location

                        return web.Response(
                            status=response.status,
                            headers={
                                **CORS_HEADERS,
                                'Location': proxied_location,
                                'Cache-Control': 'no-cache',
                            },
                        )

                # Fail fast on upstream HTTP errors to avoid hanging streams on player side
                if response.status >= 400:
                    err_body = await response.read()
                    err_text = err_body.decode('utf-8', errors='replace') if err_body else '(empty)'
                    logger.warning(f"[PROXY] Upstream HTTP {response.status} for {target_url} â€” headers_sent: {headers} â€” body: {err_text[:200]}")
                    return web.json_response(
                        {
                            'error': f'Upstream HTTP error: {response.status}',
                            'upstream_status': response.status,
                            'upstream_url': target_url,
                            'upstream_body': err_text[:2000]
                        },
                        status=response.status,
                        headers=CORS_HEADERS
                    )

                # M3U8 detected by content-type (not by URL â€” those went through coalescer above)
                if is_m3u8_response:
                    m3u8_probe = await response.content.read(2048)
                    if m3u8_probe and self._is_valid_m3u8(m3u8_probe.decode('utf-8', errors='ignore')):
                        rest = await response.content.read(10 * 1024 * 1024)
                        raw_body = m3u8_probe + rest
                        m3u8_resp = await self._handle_m3u8_response(
                            response, target_url, resp_headers, is_bandwidth,
                            is_sosplay=(service in ('sosplay', 'sosplay_cdn') or sosplay_mode),
                            is_witv=(service == 'witv'),
                            custom_headers=custom_headers,
                            request=request,
                            use_proxy=use_proxy,
                            raw_body=raw_body
                        )
                        if m3u8_resp is not None:
                            return m3u8_resp
                        body_text = raw_body.decode('utf-8', errors='replace') if raw_body else '(empty)'
                        logger.error(f"[PROXY] BUG: _handle_m3u8_response returned None for {target_url}")
                        return web.json_response(
                            {
                                'error': 'Failed to process M3U8 stream',
                                'upstream_status': response.status,
                                'upstream_url': target_url,
                                'upstream_body': body_text[:2000]
                            },
                            status=502, headers=CORS_HEADERS
                        )

                    # Content-Type says M3U8 but content is binary (live IPTV TS stream
                    # with wrong Content-Type) â€” stream directly instead of buffering
                    if m3u8_probe:
                        return await self._stream_response_with_prefix(request, response, resp_headers, m3u8_probe, CHUNK_DEFAULT)
                    return await self._stream_response(request, response, resp_headers, CHUNK_DEFAULT)
                
                # TS/M4S segments are handled above via coalescer + buffer.
                # They only reach here if content detection missed them (shouldn't happen).

                # MPD handling - small file
                if content.is_mpd:
                    body = await response.read()
                    resp_headers['Content-Type'] = 'application/dash+xml'
                    resp_headers['Cache-Control'] = 'public, max-age=5'
                    resp_headers['Content-Length'] = str(len(body))
                    return _safe_response(body, response.status, resp_headers)
                
                # MP4 handling - use FASTEST streaming for large files
                if content.is_mp4:
                    resp_headers['Accept-Ranges'] = 'bytes'
                    resp_headers['Cache-Control'] = 'public, max-age=7200'
                    resp_headers['Content-Type'] = 'video/mp4'
                    
                    if response.status == 206:
                        if 'content-range' in response.headers:
                            resp_headers['Content-Range'] = response.headers['content-range']
                        if 'content-length' in response.headers:
                            resp_headers['Content-Length'] = response.headers['content-length']
                    
                    # Use fast streaming for maximum throughput
                    return await self._stream_response_fast(request, response, resp_headers, CHUNK_LARGE)
                
                # Extensionless playlists: probe first bytes to detect "#EXTM3U"
                probe = await response.content.read(2048)
                if probe:
                    probe_text = probe.decode('utf-8', errors='ignore')
                    if self._is_valid_m3u8(probe_text):
                        raw_body = probe + await response.content.read(10 * 1024 * 1024)
                        m3u8_resp = await self._handle_m3u8_response(
                            response, target_url, resp_headers, is_bandwidth,
                            is_sosplay=(service == 'sosplay' or service == 'sosplay_cdn' or sosplay_mode),
                            is_witv=(service == 'witv'),
                            custom_headers=custom_headers,
                            request=request,
                            use_proxy=use_proxy,
                            raw_body=raw_body
                        )
                        if m3u8_resp is not None:
                            return m3u8_resp
                        body_text = raw_body.decode('utf-8', errors='replace') if raw_body else '(empty)'
                        logger.error(f"[PROXY] BUG: _handle_m3u8_response returned None for {target_url}")
                        return web.json_response(
                            {
                                'error': 'Failed to process M3U8 stream',
                                'upstream_status': response.status,
                                'upstream_url': target_url,
                                'upstream_body': body_text[:2000]
                            },
                            status=502, headers=CORS_HEADERS
                        )

                    return await self._stream_response_with_prefix(request, response, resp_headers, probe, CHUNK_DEFAULT)

                # Default streaming
                return await self._stream_response(request, response, resp_headers, CHUNK_DEFAULT)
                
        except asyncio.TimeoutError as e:
            return web.json_response(
                {
                    'error': 'Timeout',
                    'exception': type(e).__name__,
                    'message': str(e) or None,
                    'upstream_url': target_url,
                },
                status=504,
                headers=CORS_HEADERS,
            )
        except aiohttp.ClientError as e:
            return web.json_response(
                {
                    'error': 'Upstream request failed',
                    'exception': type(e).__name__,
                    'message': str(e) or None,
                    'details': repr(e),
                    'upstream_url': target_url,
                },
                status=502,
                headers=CORS_HEADERS,
            )
        except Exception as e:
            logger.exception('[PROXY] Unexpected error while streaming')
            return web.json_response(
                {
                    'error': 'Unexpected proxy error',
                    'exception': type(e).__name__,
                    'message': str(e) or None,
                    'details': repr(e),
                    'upstream_url': target_url,
                },
                status=500,
                headers=CORS_HEADERS,
            )
    
    async def _handle_uqload_embed(self, request: Request, target_url: str,
                                    headers: Dict, timeout: ClientTimeout,
                                    range_header: Optional[str], session: aiohttp.ClientSession) -> Response:
        """Handle UQLOAD embed URLs by extracting HLS or streaming MP4."""
        try:
            cache_key = hashlib.md5(target_url.encode()).hexdigest()
            media_url = self.uqload_mp4_cache.get(cache_key)
            
            if not media_url:
                media_url = await self._extract_uqload_media_url(target_url)
                self.uqload_mp4_cache.set(cache_key, media_url)

            if '.m3u8' in urlparse(media_url).path.lower():
                location = f"/uqload-proxy?url={urllib.parse.quote(media_url)}"
                return web.HTTPFound(location=location, headers=CORS_HEADERS)

            uqload_origin = get_uqload_site_origin(media_url)
            
            mp4_headers = self._prepare_headers(media_url, request)
            mp4_headers.update({
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
                'Referer': f'{uqload_origin}/',
                'Origin': uqload_origin,
            })
            
            if not range_header:
                # HEAD request for metadata
                async with session.request('HEAD', media_url, headers=mp4_headers,
                                           timeout=ClientTimeout(total=10)) as resp:
                    resp_headers = self._prepare_stream_headers(resp.headers, 'video/mp4')
                    resp_headers['Accept-Ranges'] = 'bytes'
                    return _safe_response(b'', 200, resp_headers)
            else:
                mp4_headers['Range'] = range_header
                async with session.request('GET', media_url, headers=mp4_headers,
                                           timeout=ClientTimeout(total=None, connect=10, sock_read=30)) as resp:
                    resp_headers = self._prepare_stream_headers(resp.headers, 'video/mp4')
                    resp_headers['Accept-Ranges'] = 'bytes'
                    
                    if resp.status == 206 and 'content-range' in resp.headers:
                        resp_headers['Content-Range'] = resp.headers['content-range']
                    
                    return await self._stream_response(request, resp, resp_headers, CHUNK_MP4)
                    
        except Exception as e:
            logger.error(f'[UQLOAD] Error: {e}')
            return web.json_response({'error': str(e)}, status=500, headers=CORS_HEADERS)
    
    def _normalize_custom_headers(self, custom_headers: Optional[Dict]) -> Dict[str, str]:
        """Normalize custom headers passed through /proxy?headers=..."""
        if not custom_headers:
            return {}

        normalized = {}
        header_aliases = {
            'accept': 'Accept',
            'accept-language': 'Accept-Language',
            'host': 'Host',
            'origin': 'Origin',
            'range': 'Range',
            'referer': 'Referer',
            'user-agent': 'User-Agent',
        }

        for key, value in custom_headers.items():
            if value is None:
                continue

            key_str = str(key).strip()
            if not key_str:
                continue

            canonical_key = header_aliases.get(
                key_str.lower(),
                '-'.join(part[:1].upper() + part[1:] for part in key_str.split('-') if part)
            )
            normalized[canonical_key] = str(value).strip()

        return normalized

    def _ensure_origin_matches_referer(self, headers: Dict[str, str]) -> Dict[str, str]:
        """Keep Origin aligned with Referer for embed-protected CDNs."""
        referer = headers.get('Referer')
        if not referer:
            return headers

        try:
            parsed = urlparse(referer)
            if not parsed.scheme or not parsed.netloc:
                return headers
            referer_origin = f"{parsed.scheme}://{parsed.netloc}"
        except Exception:
            return headers

        current_origin = headers.get('Origin')
        if current_origin != referer_origin:
            if current_origin:
                logger.info(f"[PROXY] Adjusting Origin to match Referer: {current_origin} -> {referer_origin}")
            headers['Origin'] = referer_origin

        return headers

    def _prepare_headers(self, target_url: str, request: Request) -> Dict[str, str]:
        """Prepare headers for proxy request"""
        try:
            parsed = urlparse(target_url)
            referer_origin = f"{parsed.scheme}://{parsed.netloc}"
            target_host = parsed.netloc
        except:
            referer_origin = 'https://vmwesa.online'
            target_host = 'vmwesa.online'
        
        # Service-specific headers
        if self.RE_VMWESA.search(target_url):
            return {
                'Accept': '*/*',
                'Host': target_host,
                'Origin': 'https://vidmoly.net',
                'Referer': 'https://vidmoly.net/',
                'User-Agent': 'Mozilla/5.0 Chrome/143.0.0.0'
            }
        
        if self.RE_DROPCDN.search(target_url):
            return {
                'Accept': '*/*',
                'Host': target_host,
                'Origin': 'https://dropload.tv',
                'Referer': 'https://dropload.tv/',
                'User-Agent': 'Mozilla/5.0 Chrome/139.0.0.0'
            }
        
        if self.RE_SERVERSICURO.search(target_url):
            return {
                'Accept': '*/*',
                'Host': target_host,
                'Origin': 'https://supervideo.cc',
                'Referer': 'https://supervideo.cc/',
                'User-Agent': 'Mozilla/5.0 Chrome/139.0.0.0'
            }
        
        if self.RE_FSVID.search(target_url):
            return {
                'Accept': 'application/vnd.apple.mpegurl,*/*',
                'Host': target_host,
                'Origin': 'https://fsvid.lol',
                'Referer': 'https://fsvid.lol/',
                'Sec-Ch-Ua': FSVID_VIDZY_SEC_CH_UA,
                'User-Agent': 'Mozilla/5.0 Chrome/139.0.0.0'
            }

        if self.RE_SIBNET.search(target_url):
            return {'Accept': '*/*'}
        
        if self.RE_UQLOAD.search(target_url):
            try:
                uqload_origin = get_uqload_site_origin(target_url)
            except ValueError:
                uqload_origin = 'https://uqload.bz'
            return {
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
                'Host': target_host,
                'Origin': uqload_origin,
                'Referer': f'{uqload_origin}/',
                'User-Agent': 'Mozilla/5.0 Chrome/142.0.0.0'
            }
        
        if self.RE_VIDZY.search(target_url):
            return {
                'Accept': 'application/vnd.apple.mpegurl,*/*',
                'Host': target_host,
                'Origin': 'https://vidzy.org',
                'Referer': 'https://vidzy.org/',
                'Sec-Ch-Ua': FSVID_VIDZY_SEC_CH_UA,
                'User-Agent': 'Mozilla/5.0 Chrome/141.0.0.0'
            }

        if self.RE_BANDWIDTH.search(target_url):
            return {
                'Accept': '*/*',
                'Host': target_host,
                'Origin': 'https://voe.sx',
                'Referer': 'https://voe.sx/',
                'User-Agent': 'Mozilla/5.0 Chrome/143.0.0.0'
            }
        
        if self.RE_MERI.search(target_url):
            return {
                'Accept': '*/*',
                'Host': target_host,
                'Referer': 'https://hoca6.com',
                'Origin': 'https://hoca6.com',
                'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0'
            }
        
        if self.RE_DOODSTREAM.search(target_url):
            return {
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
                'Host': target_host,
                'Referer': 'https://d0000d.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Connection': 'keep-alive'
            }
        
        # Numeric CDN domains (e.g., 8nwwqrar.12703830.net) - used by various streaming services
        if self.RE_NUMERIC_CDN.search(target_url):
            return {
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Host': target_host,
                'Origin': 'https://dishtrainer.net',
                'Referer': 'https://dishtrainer.net/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        
        # Default headers
        user_agent = request.headers.get('user-agent', 'Mozilla/5.0 Chrome/120.0.0.0')
        url_lower = target_url.lower()
        
        if 'ios' in url_lower or 'iphone' in url_lower:
            user_agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/604.1'
        elif 'android' in url_lower:
            user_agent = 'Mozilla/5.0 (Linux; Android 10) Chrome/120.0.0.0 Mobile'
        
        headers = {
            'Accept': '*/*',
            'Connection': 'keep-alive',
            # 'Host': target_host,  # Let aiohttp handle Host automatically to avoid conflicts
            'User-Agent': user_agent,
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site',
            # Allow upstream compression for text content (M3U8/MPD) to save proxy<->upstream bandwidth
            # Binary streams (.ts, .mp4, .m4s) are already compressed so 'identity' is fine
            'Accept-Encoding': 'gzip, deflate' if any(ext in url_lower for ext in ('.m3u8', '.mpd', '.html')) else 'identity',
        }
        
        if 'range' in request.headers:
            headers['Range'] = request.headers['range']
        
        return headers
    
    def _is_valid_m3u8(self, content: str) -> bool:
        """Check if content is valid M3U8"""
        content_lower = content.lower()
        return ('#extm3u' in content_lower or '#ext-x-version' in content_lower) and not content.strip().startswith('<')
    
    async def _rewrite_m3u8_urls(self, content: str, base_url: str, 
                                  is_bandwidth: bool = False, is_sosplay: bool = False,
                                  is_witv: bool = False, custom_headers: Optional[Dict] = None,
                                  use_proxy: Optional[int] = None) -> str:
        """Rewrite URLs in M3U8 content to use proxy"""
        base_url_dir = base_url.rsplit('/', 1)[0] + '/'
        
        # Extract query params from base URL (for auth tokens like s= and e=)
        parsed_base = urlparse(base_url)
        base_query = parsed_base.query  # e.g., "s=xxx&e=yyy"
        
        # Pre-encode headers for segment URLs if provided
        encoded_headers = None
        if custom_headers:
            encoded_headers = urllib.parse.quote(json.dumps(custom_headers))
        
        # Build use_proxy query suffix for segment URLs
        use_proxy_suffix = f'use_proxy={use_proxy}' if use_proxy is not None else None
        
        def to_absolute(url: str) -> str:
            if not url or url.startswith(('http://', 'https://')):
                return url
            return urljoin(base_url_dir, url)
        
        def proxify_url(url: str) -> str:
            abs_url = to_absolute(url)
            if not abs_url or '/proxy/' in abs_url:
                return url if not abs_url else abs_url
            
            # If segment URL has no query params but base URL does, inherit them
            # This handles auth tokens for HLS segments
            if base_query and '?' not in abs_url:
                # Check if it's a segment file (ts, m4s, etc.)
                url_lower = abs_url.lower()
                if any(ext in url_lower for ext in ('.ts', '.m4s', '.aac', '.mp4', '.fmp4')):
                    abs_url = f"{abs_url}?{base_query}"
            
            # Build proxy URL with headers if available
            encoded_url = encode_url(abs_url)
            
            # Build query parts for segment proxy URL
            query_parts = []
            if encoded_headers:
                query_parts.append(f'headers={encoded_headers}')
            if use_proxy_suffix:
                query_parts.append(use_proxy_suffix)
            
            # Pass custom headers (embed referer/origin) and proxy choice to segment URLs
            if query_parts:
                return f"/proxy/{encoded_url}?{'&'.join(query_parts)}"
            
            return f"/proxy/{encoded_url}"
        
        # Use pre-compiled patterns for speed
        re_uri_dq = self.RE_M3U8_URI_DQ
        re_uri_sq = self.RE_M3U8_URI_SQ
        re_uri_uq = self.RE_M3U8_URI_UQ
        re_http = self.RE_M3U8_HTTP
        
        def rewrite_line(line: str) -> str:
            trimmed = line.strip()
            if not trimmed:
                return line
            
            # Tag lines with URI attributes (pre-compiled regex)
            if trimmed.startswith('#'):
                line = re_uri_dq.sub(lambda m: f'URI="{proxify_url(m.group(1).strip())}"', line)
                line = re_uri_sq.sub(lambda m: f'URI="{proxify_url(m.group(1).strip())}"', line)
                line = re_uri_uq.sub(lambda m: f'URI="{proxify_url(m.group(1).strip())}"', line)
                return line
            
            # URL lines (pre-compiled regex)
            if re_http.match(trimmed):
                return proxify_url(trimmed)
            
            return proxify_url(to_absolute(trimmed))
        
        return '\n'.join(rewrite_line(line) for line in content.split('\n'))
    
    # ===== VIP Verification =====
    
    async def _check_vip(self, request: Request) -> bool:
        """Verify VIP access key directly against MySQL access_keys table.
        Returns True if VIP, False otherwise. Results are cached for VIP_CACHE_TTL seconds."""
        raw_key = request.headers.get('x-access-key', '')
        
        if not raw_key or not raw_key.strip():
            return False
        
        access_key = raw_key.strip()

        # Normalize key encoding to match how Mainapi (checkVip.js) looks it up.
        # aiohttp hands header bytes back as Latin-1 (or surrogate-escaped). Recover the
        # raw wire bytes, then: valid UTF-8 -> decode it; otherwise the bytes are Latin-1
        # (e.g. 'é' = U+00E9 sent as a single 0xE9 byte). This mirrors checkVip.js
        # (latin1 bytes -> utf8, keep original when invalid) so the key_value lookup
        # matches the stored value and VIP users aren't falsely denied.
        try:
            raw = access_key.encode('latin-1', 'surrogateescape')
            try:
                access_key = raw.decode('utf-8')
            except UnicodeDecodeError:
                access_key = raw.decode('latin-1')
        except UnicodeEncodeError:
            pass
        
        # Check cache first
        cached = self.vip_cache.get(access_key)
        if cached is not None:
            return cached
        
        # Query MySQL directly
        try:
            if not self.mysql_pool:
                return False
            
            async with self.mysql_pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        'SELECT key_value, active, expires_at FROM access_keys WHERE key_value = %s LIMIT 1',
                        (access_key,)
                    )
                    row = await cur.fetchone()
            
            
            if not row:
                self.vip_cache.set(access_key, False)
                return False
            
            key_value, active, expires_at = row
            
            # Key must be active
            if not active:
                self.vip_cache.set(access_key, False)
                return False
            
            # Check expiration. access_keys.expires_at is epoch MILLISECONDS (BIGINT),
            # matching Mainapi (parseAccessKeyExpiresAt -> getTime()). Compare as ms,
            # same as checkVip.js: new Date() > new Date(expires_at).
            if expires_at is not None:
                try:
                    if int(expires_at) < int(time.time() * 1000):
                        self.vip_cache.set(access_key, False)
                        return False
                except (ValueError, TypeError):
                    pass
            
            # Key is valid
            self.vip_cache.set(access_key, True)
            return True
            
        except Exception as e:
            logger.warning(f'[VIP] MySQL verification error: {e}')
            # DB error â€” deny by default for security
            return False
    
    def _vip_denied_response(self) -> Response:
        """Return 403 response for non-VIP users"""
        return web.json_response(
            {'error': 'VIP access required', 'code': 'VIP_REQUIRED'},
            status=403,
            headers=CORS_HEADERS
        )
    
    # ===== Extraction Handlers =====
    
    async def voe_m3u8_handler(self, request: Request) -> Response:
        """VOE M3U8 extraction with caching"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            encoded_url = request.query.get('url')
            if not encoded_url:
                return web.json_response({'error': 'URL required'}, status=400)
            
            try:
                url = base64.b64decode(encoded_url).decode('utf-8')
            except:
                return web.json_response({'error': 'Invalid URL'}, status=400)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.voe_cache.get(cache_key)
            if cached:
                resp = web.json_response(cached)
                resp.headers['X-Cache'] = 'HIT'
                return resp
            
            headers = {
                'User-Agent': 'Mozilla/5.0 Chrome/139.0.0.0',
                'Referer': 'https://voe.sx/',
            }
            
            html, _ = await self._fetch_with_redirects(url, headers, timeout_seconds=5)
            json_content = self._extract_json_from_html(html)
            
            if not json_content or not isinstance(json_content, list):
                return web.json_response({'error': 'Content not found'}, status=404)
            
            decrypted = self._decrypt_voe_data(json_content[0])
            if not decrypted:
                return web.json_response({'error': 'Decryption failed'}, status=500)
            
            source_url = decrypted.get('source', '')
            if '.m3u8' in source_url:
                result = {'source': f"{PROXY_BASE}/voe-proxy?url={urllib.parse.quote(source_url)}"}
            else:
                result = {'decrypted': decrypted}
            
            self.voe_cache.set(cache_key, result)
            resp = web.json_response(result)
            resp.headers['X-Cache'] = 'MISS'
            return resp
            
        except asyncio.TimeoutError:
            return web.json_response({'error': 'Timeout'}, status=504)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)
    
    async def _fetch_with_redirects(self, url: str, headers: Dict, max_redirects: int = 3,
                                     use_proxy: bool = True, specific_proxy: Dict = None,
                                     timeout_seconds: int = 10) -> Tuple[str, str]:
        """Follow redirects and return final HTML content"""
        # Determine session based on proxy args (legacy support for dict args)
        session = self.sessions['normal']
        if use_proxy:
            if specific_proxy and specific_proxy == SIBNET_PROXY:
                session = self.sessions.get('proxy_0', self.sessions['normal'])
            elif specific_proxy and specific_proxy == VIDMOLY_PROXY:
                session = self.sessions.get('proxy_1', self.sessions.get('proxy_0', self.sessions['normal']))
            else:
                session = self.sessions.get('proxy_0', self.sessions['normal']) # Default proxy
                
        timeout = ClientTimeout(total=timeout_seconds)
        
        current_url = url
        async with session.request('GET', current_url, headers=headers, 
                                    timeout=timeout) as response:
            html = await response.text()
        
        for _ in range(max_redirects):
            if re.search(r'type=["\']\s*application/json\s*["\']', html) and '<script' in html:
                break
            
            target = None
            for pattern in [
                r'window\.location\.href\s*=\s*[\'"]([^\'"]+)[\'"]',
                r'http-equiv=["\']refresh["\'][^>]*content=["\'][^;]+;\s*url=([^"\']+)',
                r'https?://[a-z0-9.-]+/e/[a-z0-9]+'
            ]:
                match = re.search(pattern, html, re.IGNORECASE)
                if match:
                    target = match.group(1) if match.lastindex else match.group(0)
                    break
            
            if not target:
                break
            
            try:
                abs_url = target if target.startswith('http') else urljoin(current_url, target)
                async with session.request('GET', abs_url, headers={**headers, 'Referer': current_url},
                                            timeout=timeout) as resp:
                    html = await resp.text()
                    current_url = abs_url
            except:
                break
        
        return html, current_url
    
    def _extract_json_from_html(self, html: str) -> Optional[list]:
        """Extract obfuscated JSON from HTML"""
        match = re.search(r'<script[^>]*type=["\']?\s*application/json\s*["\']?[^>]*>\s*([\s\S]*?)\s*</script>', html, re.IGNORECASE)
        if match:
            try:
                parsed = json.loads(match.group(1).strip())
                if isinstance(parsed, list) and parsed and isinstance(parsed[0], str):
                    return parsed
            except:
                pass
        
        match = re.search(r'\[\s*"(?:[^"\\]|\\.){100,}"\s*\]', html)
        if match:
            try:
                return json.loads(match.group(0))
            except:
                pass
        return None
    
    def _decrypt_voe_data(self, encrypted: str) -> Optional[Dict]:
        """Decrypt VOE.SX data"""
        try:
            step1 = codecs.encode(encrypted, 'rot13')
            for sym in ['@$', '^^', '~@', '%?', '*~', '!!', '#&']:
                step1 = step1.replace(sym, '')
            
            padding = (4 - len(step1) % 4) % 4
            step2 = base64.b64decode(step1 + '=' * padding).decode('utf-8')
            step3 = ''.join(chr(ord(c) - 3) for c in step2)[::-1]
            
            padding = (4 - len(step3) % 4) % 4
            step4 = base64.b64decode(step3 + '=' * padding).decode('utf-8')
            
            return json.loads(step4)
        except Exception as e:
            logger.error(f'VOE decryption error: {e}')
            return None
    
    async def fsvid_extract_handler(self, request: Request) -> Response:
        """FSVID M3U8 extraction"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            url = request.query.get('url')
            if not url or not self._is_fsvid_vidzy_embed_url(url, 'fsvid'):
                return web.json_response({'error': 'Invalid URL'}, status=400)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.fsvid_cache.get(cache_key)
            if cached:
                if self._is_fsvid_vidzy_cached_result(cached, 'fsvid'):
                    resp = web.json_response(cached)
                    resp.headers['X-Cache'] = 'HIT'
                    return resp
                self.fsvid_cache.delete(cache_key)
            
            headers = {
                'accept': 'text/html,*/*',
                'referer': 'https://fsmirror46.lol/',
                'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0'
            }
            
            
            async with self.sessions['normal'].request('GET', url, headers=headers,
                                        timeout=ClientTimeout(total=8)) as response:
                if response.status != 200:
                    return web.json_response({'error': 'Fetch failed'}, status=500)
                
                html = await response.text(encoding='utf-8')

                m3u8_url = await self._resolve_fsvid_vidzy_m3u8(html, url, 'fsvid')
                if not m3u8_url:
                    return web.json_response({'error': 'M3U8 not found'}, status=404)
                
                result = {
                    'm3u8Url': f"{PROXY_BASE}/fsvid-proxy?url={urllib.parse.quote(m3u8_url)}",
                    'source': 'fsvid'
                }
                
                self.fsvid_cache.set(cache_key, result)
                resp = web.json_response(result)
                resp.headers['X-Cache'] = 'MISS'
                return resp
                
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)
    
    def _deobfuscate_fsvid_script(self, script: str) -> str:
        """Deobfuscate packed JavaScript"""
        marker = re.search(
            r'eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,'
            r'\s*k\s*,\s*e\s*,\s*d\s*\)',
            script,
        )
        if not marker:
            raise ValueError('Pattern not found')

        split = re.search(
            r'\.split\(\s*(["\'])\|\1\s*\)',
            script[marker.start():],
        )
        if not split:
            raise ValueError('Pattern not found')

        section_end = marker.start() + split.end()
        section = script[marker.start():section_end]
        single_quote_pattern = re.compile(
            r"\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)"
            r"\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split",
            re.DOTALL,
        )
        double_quote_pattern = re.compile(
            r'\}\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,\s*(\d+)'
            r'\s*,\s*"((?:[^"\\]|\\.)*)"\s*\.split',
            re.DOTALL,
        )
        match = single_quote_pattern.search(section) or double_quote_pattern.search(section)
        if not match:
            raise ValueError('Pattern not found')
        
        p, a, c, k_str = match.group(1), int(match.group(2)), int(match.group(3)), match.group(4)
        p = p.replace(r"\'", "'").replace(r'\"', '"')
        k = k_str.split('|')
        if a < 2 or a > 62 or c < 0 or c > 10000 or c > len(k):
            raise ValueError('Invalid packer parameters')
        
        def to_base(num: int, base: int) -> str:
            chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
            if num == 0:
                return chars[0]
            result = ""
            while num > 0:
                result = chars[num % base] + result
                num //= base
            return result
        
        result = p
        while c > 0:
            c -= 1
            if c < len(k) and k[c]:
                result = re.sub(r'\b' + re.escape(to_base(c, a)) + r'\b', k[c], result)
        
        return result

    def _extract_m3u8_url(self, script: str, embed_url: str) -> Optional[str]:
        """Extract a plain or Base64/XOR-obfuscated M3U8 URL."""
        script = script.replace(r"\'", "'").replace(r'\"', '"')

        def normalize(candidate: str) -> Optional[str]:
            candidate = candidate.replace(r'\/', '/').replace('&amp;', '&').strip().rstrip('\\')
            candidate_lower = candidate.lower()
            if '.m3u8' not in candidate_lower or 'troll' in candidate_lower:
                return None

            parsed = urlparse(candidate)
            if parsed.scheme in ('http', 'https') and parsed.netloc:
                return candidate

            if candidate.startswith(('/', './', '../')):
                return urljoin(embed_url, candidate)

            return None

        # Current Fsvid/Vidzy pages derive the XOR key for each byte from an
        # affine expression that also mixes in the sum of location.hostname's
        # char codes, and reverse the decoded byte sequence either before or
        # after the loop. Capture the page's variable names and parameters
        # instead of evaluating remote JavaScript or hard-coding today's values.
        rolling_xor_pattern = re.compile(
            r'(?:var\s+)?(?P<bytes>[A-Za-z_$][\w$]*)\s*=\s*atob\('
            r'\s*[A-Za-z_$][\w$]*\s*\)'
            r'(?:\s*,\s*(?P<pre_reverse>[A-Za-z_$][\w$]*)\s*=\s*(?P=bytes)'
            r'\.split\(\s*["\']["\']\s*\)\s*\.reverse\(\s*\)\s*'
            r'\.join\(\s*["\']["\']\s*\))?'
            r'.{0,512}?for\s*\(\s*var\s+(?P<index>[A-Za-z_$][\w$]*)'
            r'\s*=\s*0\s*;\s*(?P=index)\s*<\s*[A-Za-z_$][\w$]*\.length\s*;'
            r'\s*(?P=index)\+\+\s*\)\s*\{'
            r'.{0,512}?(?:var\s+)?(?P<key>[A-Za-z_$][\w$]*)\s*=\s*\('
            r'\s*(?P<key_expr>.{1,128}?)\s*\)\s*&\s*'
            r'(?P<mask>0[xX][0-9a-fA-F]+|\d+)\s*;'
            r'.{0,512}?(?P<output>[A-Za-z_$][\w$]*)\s*\+=\s*'
            r'String\.fromCharCode\(\s*[A-Za-z_$][\w$]*\.charCodeAt\('
            r'\s*(?P=index)\s*\)\s*\^\s*(?P=key)\s*\)'
            r'.{0,256}?\}\s*(?P<tail>return\b.{1,512}?)\)\s*\(\s*["\']'
            r'(?P<payload>[A-Za-z0-9+/_=-]{1,32768})["\']\s*\)',
            re.DOTALL,
        )
        numeric_literal = re.compile(r'^(?:0[xX][0-9a-fA-F]+|\d+)$')
        identifier = re.compile(r'^[A-Za-z_$][\w$]*$')

        def hostname_char_sum(mask: int) -> int:
            """Replay the page's `for (c of location.hostname) H = (H + c) & mask`."""
            hostname = (urlparse(embed_url).hostname or '').lower()
            total = 0
            for character in hostname:
                total = (total + ord(character)) & mask
            return total

        def parse_rolling_parameters(
            expression: str,
            index_name: str,
            mask: int,
        ) -> Optional[Tuple[int, int]]:
            """Split `0x3d+i*89+H` style key expressions into (seed, step)."""
            normalized = re.sub(r'[\s()]', '', expression)
            if not normalized:
                return None
            if normalized[0] not in '+-':
                normalized = '+' + normalized

            terms = re.findall(r'[-+][^+-]+', normalized)
            if not terms or ''.join(terms) != normalized:
                return None

            seed = 0
            step = 0
            host_sum = None
            for term in terms:
                sign = -1 if term[0] == '-' else 1
                body = term[1:]
                if not body:
                    return None
                factors = body.split('*')
                if index_name in factors:
                    others = [factor for factor in factors if factor != index_name]
                    if not others:
                        step += sign
                        continue
                    if len(others) != 1 or not numeric_literal.match(others[0]):
                        return None
                    step += sign * int(others[0], 0)
                elif numeric_literal.match(body):
                    seed += sign * int(body, 0)
                elif identifier.match(body):
                    # The only non-numeric term these players use is the
                    # hostname checksum computed just above the loop.
                    if host_sum is None:
                        host_sum = hostname_char_sum(mask)
                    seed += sign * host_sum
                else:
                    return None
            return seed, step

        for match in rolling_xor_pattern.finditer(script):
            try:
                mask = int(match.group('mask'), 0)
                if not 0 <= mask <= 0xFF:
                    continue
                parameters = parse_rolling_parameters(
                    match.group('key_expr'),
                    match.group('index'),
                    mask,
                )
                if parameters is None:
                    continue
                seed, step = parameters
                if not (-0xFFFFFFFF <= seed <= 0xFFFFFFFF and -0xFFFFFFFF <= step <= 0xFFFFFFFF):
                    continue

                payload = match.group('payload')
                payload += '=' * (-len(payload) % 4)
                encrypted = base64.b64decode(payload, altchars=b'-_', validate=True)
                if match.group('pre_reverse'):
                    encrypted = encrypted[::-1]
                decoded_bytes = bytes(
                    value ^ ((seed + index * step) & mask)
                    for index, value in enumerate(encrypted)
                )
                if not match.group('pre_reverse') and re.search(
                    r'\.reverse\(\s*\)\s*\.join',
                    match.group('tail'),
                ):
                    decoded_bytes = decoded_bytes[::-1]
                candidate = normalize(decoded_bytes.decode('utf-8'))
                if candidate:
                    return candidate
            except (ValueError, UnicodeDecodeError, binascii.Error):
                continue

        # New fsvid/vidzy player format:
        # (function(s){var k=[...],b=atob(s),r=""; ... XOR ...})("...")
        xor_pattern = re.compile(
            r'var\s+[A-Za-z_$][\w$]*\s*=\s*\[(?P<key>[0-9,\s]+)\]\s*,'
            r'\s*[A-Za-z_$][\w$]*\s*=\s*atob\(\s*[A-Za-z_$][\w$]*\s*\)'
            r'.{0,2000}?\}\)\s*\(\s*["\'](?P<payload>[A-Za-z0-9+/_=-]+)["\']\s*\)',
            re.DOTALL
        )
        for match in xor_pattern.finditer(script):
            try:
                key_values = [int(value.strip()) for value in match.group('key').split(',')]
                if not key_values or len(key_values) > 64 or any(value < 0 or value > 255 for value in key_values):
                    continue

                payload = match.group('payload')
                payload += '=' * (-len(payload) % 4)
                encrypted = base64.b64decode(payload, altchars=b'-_', validate=True)
                decoded = bytes(
                    value ^ key_values[index % len(key_values)]
                    for index, value in enumerate(encrypted)
                ).decode('utf-8')

                candidate = normalize(decoded)
                if candidate:
                    return candidate
            except (ValueError, UnicodeDecodeError, binascii.Error):
                continue

        # Legacy formats with a directly embedded URL.
        for pattern in [
            r'src:\s*["\']([^"\']+\.m3u8[^"\']*)["\']',
            r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']',
            r'sources:\s*\[\s*\{[^}]*?["\']([^"\']+\.m3u8[^"\']*)["\']',
            r'["\']([^"\']*\.m3u8[^"\']*)["\']',
        ]:
            match = re.search(pattern, script)
            if match:
                candidate = normalize(match.group(1))
                if candidate:
                    return candidate

        return None

    def _extract_fsvid_vidzy_m3u8_from_html(
        self,
        html: str,
        embed_url: str,
    ) -> Optional[str]:
        """Extract a safe direct source, then fall back to tolerant unpacking."""
        direct = self._extract_m3u8_url(html, embed_url)
        if direct:
            return direct

        try:
            decoded = self._deobfuscate_fsvid_script(html)
        except ValueError:
            return None
        return self._extract_m3u8_url(decoded, embed_url)

    @staticmethod
    def _is_fsvid_vidzy_embed_url(url: str, provider: str) -> bool:
        try:
            parsed = urlparse(url)
            if parsed.scheme != 'https' or not parsed.hostname:
                return False
            if parsed.username or parsed.password or parsed.port not in (None, 443):
                return False
            hostname = parsed.hostname.lower().rstrip('.')
            allowed_suffixes = (
                ('fsvid.lol',)
                if provider == 'fsvid'
                else ('vidzy.org', 'vidzy.cc')
            )
            return any(
                hostname == suffix or hostname.endswith(f'.{suffix}')
                for suffix in allowed_suffixes
            )
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _is_fsvid_vidzy_media_candidate(candidate: str, provider: str) -> bool:
        try:
            if not candidate or len(candidate) > 16384:
                return False
            if '.m3u8' not in candidate.lower() or 'troll' in candidate.lower():
                return False
            parsed = urlparse(candidate)
            if parsed.scheme != 'https' or not parsed.hostname:
                return False
            if parsed.username or parsed.password or parsed.port not in (None, 443):
                return False
            hostname = parsed.hostname.lower().rstrip('.')
            allowed_suffixes = ('fsvid.lol',) if provider == 'fsvid' else ('vidzy.cc',)
            return any(
                hostname == suffix or hostname.endswith(f'.{suffix}')
                for suffix in allowed_suffixes
            )
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _is_fsvid_vidzy_cached_result(cached: object, provider: str) -> bool:
        if not isinstance(cached, dict):
            return False
        cached_url = cached.get('m3u8Url')
        if not isinstance(cached_url, str):
            return False

        try:
            parsed = urlparse(cached_url)
            if parsed.path.rstrip('/') != f'/{provider}-proxy':
                return False
            targets = urllib.parse.parse_qs(
                parsed.query,
                keep_blank_values=True,
            ).get('url', [])
            if len(targets) != 1:
                return False
            return ProxyServer._is_fsvid_vidzy_media_candidate(
                targets[0],
                provider,
            )
        except (TypeError, ValueError):
            return False

    async def _resolve_fsvid_vidzy_m3u8(
        self,
        html: str,
        embed_url: str,
        provider: str,
    ) -> Optional[str]:
        direct = self._extract_m3u8_url(html, embed_url)
        if direct and self._is_fsvid_vidzy_media_candidate(direct, provider):
            return direct

        sandbox_result = await execute_player_scripts(html, embed_url, provider)
        for candidate in sandbox_result.candidates:
            normalized = candidate.replace(r'\/', '/').replace('&amp;', '&').strip()
            if self._is_fsvid_vidzy_media_candidate(normalized, provider):
                return normalized

        if sandbox_result.error:
            logger.info('[%s] JavaScript sandbox: %s', provider, sandbox_result.error)

        fallback = self._extract_fsvid_vidzy_m3u8_from_html(html, embed_url)
        if fallback and self._is_fsvid_vidzy_media_candidate(fallback, provider):
            return fallback
        return None
    
    async def vidzy_extract_handler(self, request: Request) -> Response:
        """VIDZY M3U8 extraction"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            url = request.query.get('url')
            if not url or not self._is_fsvid_vidzy_embed_url(url, 'vidzy'):
                return web.json_response({'error': 'Invalid URL'}, status=400)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.vidzy_cache.get(cache_key)
            if cached:
                if self._is_fsvid_vidzy_cached_result(cached, 'vidzy'):
                    resp = web.json_response(cached)
                    resp.headers['X-Cache'] = 'HIT'
                    return resp
                self.vidzy_cache.delete(cache_key)
            
            headers = {
                'accept': 'text/html,*/*',
                'referer': 'https://vidzy.org/',
                'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0'
            }
            
            
            async with self.sessions['no_ssl'].request('GET', url, headers=headers,
                                        timeout=ClientTimeout(total=8)) as response:
                if response.status != 200:
                    return web.json_response({'error': 'Fetch failed'}, status=500)
                
                html = await response.text()
                m3u8_url = await self._resolve_fsvid_vidzy_m3u8(html, url, 'vidzy')
                if not m3u8_url:
                    return web.json_response({'error': 'M3U8 not found'}, status=404)
                
                result = {
                    'm3u8Url': f"{PROXY_BASE}/vidzy-proxy?url={urllib.parse.quote(m3u8_url)}",
                    'source': 'vidzy'
                }
                
                self.vidzy_cache.set(cache_key, result)
                resp = web.json_response(result)
                resp.headers['X-Cache'] = 'MISS'
                return resp
                
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)
    
    async def vidmoly_extract_handler(self, request: Request) -> Response:
        """VIDMOLY M3U8 extraction"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            url = request.query.get('url')
            if not url or 'vidmoly' not in url.lower():
                return web.json_response({'error': 'Invalid URL'}, status=400)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.vidmoly_cache.get(cache_key)
            if cached:
                resp = web.json_response(cached)
                resp.headers['X-Cache'] = 'HIT'
                return resp
            
            headers = {
                'accept': 'text/html,*/*',
                'referer': 'https://voirdrama.to/',
                'user-agent': 'Mozilla/5.0 Chrome/143.0.0.0'
            }
            
            html, _ = await self._fetch_with_redirects(url, headers, use_proxy=True, 
                                                        specific_proxy=VIDMOLY_PROXY)
            
            # Try multiple patterns
            source_url = None
            for pattern in [
                r'sources:\s*\[\s*{\s*file:\s*["\']([^"\']+)["\']',
                r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']',
                r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*'
            ]:
                match = re.search(pattern, html, re.IGNORECASE)
                if match:
                    source_url = match.group(1) if match.lastindex else match.group(0)
                    break
            
            if not source_url:
                return web.json_response({'error': 'M3U8 not found'}, status=404)
            
            result = {
                'sourceUrl': f"{PROXY_BASE}/vidmoly-proxy?url={urllib.parse.quote(source_url)}",
                'source': 'vidmoly'
            }
            
            self.vidmoly_cache.set(cache_key, result)
            resp = web.json_response(result)
            resp.headers['X-Cache'] = 'MISS'
            return resp
            
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)
    
    async def sibnet_extract_handler(self, request: Request) -> Response:
        """SIBNET extraction"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            url = request.query.get('url')
            if not url or 'sibnet.ru' not in url.lower():
                return web.json_response({'error': 'Invalid URL'}, status=400)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.sibnet_cache.get(cache_key)
            if cached:
                resp = web.json_response(cached)
                resp.headers['X-Cache'] = 'HIT'
                return resp
            
            headers = {
                'accept': 'text/html,*/*',
                'referer': 'https://video.sibnet.ru/',
                'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0'
            }
            
            # Use SIBNET proxy
            session = self.sessions.get('sibnet', self.sessions['normal'])
            timeout = ClientTimeout(total=15)
            
            async with session.get(url, headers=headers, timeout=timeout) as response:
                    if response.status != 200:
                        return web.json_response({'error': 'Fetch failed'}, status=500)
                    html = await response.text()
            
            soup = BeautifulSoup(html, 'html.parser')
            body_scripts = soup.find('body').find_all('script') if soup.find('body') else []
            
            if len(body_scripts) < 22:
                return web.json_response({'error': 'Script not found'}, status=404)
            
            script_content = body_scripts[21].string or ''
            mp4_match = re.search(r'player\.src\(\[\{\s*src:\s*["\']([^"\']+\.mp4[^"\']*)["\']', script_content)
            
            if not mp4_match:
                mp4_match = re.search(r'player\.src\(\[\{\s*src:\s*["\']([^"\']+\.mp4[^"\']*)["\']', html)
            
            if not mp4_match:
                return web.json_response({'error': 'MP4 not found'}, status=404)
            
            mp4_url = f"https://video.sibnet.ru{mp4_match.group(1)}"
            
            # Follow redirect to get final URL
            mp4_headers = {
                'accept': '*/*',
                'referer': 'https://video.sibnet.ru/',
                'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0'
            }
            
            # Continue using same session
            async with session.get(mp4_url, headers=mp4_headers, 
                                   allow_redirects=False, timeout=timeout) as resp:
                    if resp.status in [301, 302, 303, 307, 308]:
                        location = resp.headers.get('Location', '')
                        if location.startswith('//'):
                            location = 'https:' + location
                        elif not location.startswith('http'):
                            location = 'https://' + location
                        
                        result = {
                            'sourceUrl': f"{PROXY_BASE}/sibnet-proxy?url={urllib.parse.quote(location)}",
                            'source': 'sibnet'
                        }
                        
                        self.sibnet_cache.set(cache_key, result)
                        resp = web.json_response(result)
                        resp.headers['X-Cache'] = 'MISS'
                        return resp
            
            return web.json_response({'error': 'Expected redirect'}, status=500)
            
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)
    
    def _validate_uqload_url(self, url: str) -> str:
        """Validate and format UQLOAD URL"""
        return normalize_uqload_embed_url(url)
    
    async def _extract_uqload_media_url(self, embed_url: str) -> str:
        """Extract an HLS or MP4 URL from a UQLOAD embed without executing it."""
        validated = self._validate_uqload_url(embed_url)
        site_origin = get_uqload_site_origin(validated)
        urls = [validated, validated.replace('/embed-', '/')]
        
        headers = {
            'User-Agent': 'Mozilla/5.0 Chrome/91.0.0.0',
            'Accept': 'text/html,*/*',
            'Referer': f'{site_origin}/',
            'Origin': site_origin,
        }
        
        html = None
        for url in urls:
            try:
                # UQLOAD generic fetch -> normal session
                async with self.sessions['normal'].request('GET', url, headers=headers,
                                           timeout=ClientTimeout(total=5)) as resp:
                    if resp.status == 200:
                        html = await resp.text()
                        break
            except (aiohttp.ClientError, asyncio.TimeoutError):
                continue
        
        if not html:
            raise ValueError('No content from UQLOAD')
        
        if 'File was deleted' in html:
            raise ValueError('Video deleted')
        
        media_url = extract_uqload_media_url(html)
        if not media_url:
            raise ValueError('Uqload media URL not found')
        
        return media_url
    
    async def uqload_extract_handler(self, request: Request) -> Response:
        """UQLOAD extraction"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            url = request.query.get('url')
            if not url or 'uqload' not in url.lower():
                return web.json_response({'error': 'Invalid URL'}, status=400)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.uqload_cache.get(cache_key)
            if cached:
                resp = web.json_response(cached)
                resp.headers['X-Cache'] = 'HIT'
                return resp
            
            validated = self._validate_uqload_url(url)
            media_url = await self._extract_uqload_media_url(validated)
            
            if not media_url:
                return web.json_response({'error': 'Extraction failed'}, status=404)
            
            result = {
                'url': f"{PROXY_BASE}/uqload-proxy?url={urllib.parse.quote(media_url)}",
                'source': 'uqload'
            }
            
            self.uqload_cache.set(cache_key, result)
            resp = web.json_response(result)
            resp.headers['X-Cache'] = 'MISS'
            return resp
            
        except ValueError as e:
            return web.json_response({'error': str(e)}, status=400)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)
    
    # ===== DoodStream Extraction =====
    
    def _extract_doodstream_video_url(self, html_content: str, original_url: str) -> Optional[str]:
        """Extract video URL from DoodStream HTML page"""
        parsed_url = urlparse(original_url)
        domain = f"{parsed_url.scheme}://{parsed_url.netloc}"
        
        pattern_match = self.RE_DOODSTREAM_PASS.search(html_content)
        if not pattern_match:
            return None
        
        pass_md5_url = pattern_match.group(0)
        token = pattern_match.group("token")
        
        return domain, pass_md5_url, token
    
    async def doodstream_extract_handler(self, request: Request) -> Response:
        """DoodStream extraction handler"""
        if not await self._check_vip(request):
            return self._vip_denied_response()
        try:
            url = request.query.get('url')
            if not url:
                return web.json_response({'error': 'Missing url parameter'}, status=400, headers=CORS_HEADERS)
            
            cache_key = hashlib.md5(url.encode()).hexdigest()
            cached = self.doodstream_cache.get(cache_key)
            if cached:
                self._cache_hits += 1
                resp = web.json_response(cached)
                resp.headers['X-Cache'] = 'HIT'
                return resp
            
            # Step 1: Fetch the embed page
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://d0000d.com/',
            }
            
            # Use proxy_1 (SOCKS5 2) instead of no_ssl
            session = self.sessions.get('proxy_1', self.sessions.get('proxy_0', self.sessions['normal']))
            timeout = ClientTimeout(total=10)
            
            async with session.get(url, headers=headers, timeout=timeout) as response:
                if response.status != 200:
                    return web.json_response({'error': f'Failed to fetch page: {response.status}'}, status=502, headers=CORS_HEADERS)
                html_content = await response.text()
            
            # Step 2: Extract pass_md5 URL and token
            extracted = self._extract_doodstream_video_url(html_content, url)
            if not extracted:
                return web.json_response(
                    {
                        'error': 'DoodStream: File was deleted',
                        'reason': 'deleted',
                    },
                    status=410,
                    headers=CORS_HEADERS,
                )
            
            domain, pass_md5_url, token = extracted
            
            # Step 3: Call pass_md5 endpoint to get base URL
            pass_headers = {
                'Referer': domain,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            }
            
            async with session.get(f"{domain}{pass_md5_url}", headers=pass_headers, timeout=timeout) as response:
                base_url = await response.text()
            
            # Step 4: Build final video URL
            random_str = ''.join(random.choices(ascii_letters + digits, k=10))
            expiry = int(time.time() * 1000)
            video_url = f"{base_url}{random_str}?token={token}&expiry={expiry}"
            
            result = {
                'url': f"{PROXY_BASE}/doodstream-proxy?url={urllib.parse.quote(video_url)}",
                'source': 'doodstream'
            }
            
            self.doodstream_cache.set(cache_key, result)
            resp = web.json_response(result)
            resp.headers['X-Cache'] = 'MISS'
            return resp
            
        except asyncio.TimeoutError:
            return web.json_response({'error': 'Timeout'}, status=504, headers=CORS_HEADERS)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500, headers=CORS_HEADERS)
    
    # ===== SeekStreaming (Embed4me) Extraction =====
    
    async def seekstreaming_extract_handler(self, request: Request) -> Response:
        """SeekStreaming (embed4me) extraction handler - accepts full URL"""
        if not await self._check_vip(request):
            return self._vip_denied_response()

        try:
            embed = parse_seekstreaming_embed_url(request.query.get("url", ""))
        except ValueError:
            return web.json_response(
                {"error": "Invalid SeekStreaming extraction request"},
                status=400,
                headers=CORS_HEADERS,
            )

        cache_key = build_seekstreaming_cache_key(embed.host, embed.video_id)
        cached = self.seekstreaming_cache.get(cache_key)
        if cached:
            self._cache_hits += 1
            response = web.json_response(cached, headers=CORS_HEADERS)
            response.headers["X-Cache"] = "HIT"
            return response

        api_url = f"{embed.origin}/api/v1/video?" + urllib.parse.urlencode({
            "id": embed.video_id,
            "w": "1920",
            "h": "1080",
            "r": "",
        })
        headers = {
            "User-Agent": SEEKSTREAMING_USER_AGENT,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": embed.referer,
            "Origin": embed.origin,
        }
        timeout = ClientTimeout(
            total=10,
            connect=5,
            sock_connect=5,
            sock_read=8,
        )

        try:
            session = self.sessions.get("seekstreaming")
            if session is None or getattr(session, "closed", False):
                return web.json_response(
                    {"error": "SeekStreaming upstream unavailable"},
                    status=503,
                    headers=CORS_HEADERS,
                )
            async with session.get(
                api_url,
                headers=headers,
                timeout=timeout,
                allow_redirects=False,
            ) as upstream:
                if upstream.status != 200:
                    return web.json_response(
                        {
                            "error": (
                                "SeekStreaming upstream HTTP "
                                f"{upstream.status}"
                            )
                        },
                        status=502,
                        headers=CORS_HEADERS,
                    )
                encrypted_text = await upstream.text()
        except asyncio.TimeoutError:
            logger.warning(
                "[SEEKSTREAMING] Upstream timeout for %s",
                redact_url_for_log(api_url),
            )
            return web.json_response(
                {"error": "SeekStreaming upstream timeout"},
                status=504,
                headers=CORS_HEADERS,
            )
        except aiohttp.ClientError:
            logger.warning(
                "[SEEKSTREAMING] Upstream request failed for %s",
                redact_url_for_log(api_url),
            )
            return web.json_response(
                {"error": "SeekStreaming upstream request failed"},
                status=502,
                headers=CORS_HEADERS,
            )

        try:
            payload = decrypt_seekstreaming_payload(
                encrypted_text,
                SEEKSTREAMING_AES_KEY,
                SEEKSTREAMING_AES_IV,
            )
            candidates = extract_seekstreaming_candidates(payload)
            result = build_seekstreaming_result(
                candidates,
                proxy_base=PROXY_BASE,
                embed_origin=embed.origin,
                cache_key=cache_key,
            )
        except (ValueError, UnicodeError, json.JSONDecodeError):
            logger.warning(
                "[SEEKSTREAMING] Invalid upstream payload from %s",
                redact_url_for_log(api_url),
            )
            return web.json_response(
                {"error": "Invalid SeekStreaming upstream payload"},
                status=502,
                headers=CORS_HEADERS,
            )

        self.seekstreaming_cache.set(cache_key, result)
        response = web.json_response(result, headers=CORS_HEADERS)
        response.headers["X-Cache"] = "MISS"
        return response
    
    # ===== Service-Specific Proxy Routes =====
    
    def _rewrite_m3u8_for_service(self, content: str, base_url: str, proxy_route: str, extra_query: str = '') -> str:
        """Rewrite M3U8 URLs to go through a service-specific proxy route"""
        base_url_dir = base_url.rsplit('/', 1)[0] + '/'
        
        parsed_base = urlparse(base_url)
        base_query = parsed_base.query
        
        def to_absolute(url: str) -> str:
            if not url or url.startswith(('http://', 'https://')):
                return url
            return urljoin(base_url_dir, url)
        
        def proxify(url: str) -> str:
            abs_url = to_absolute(url)
            if not abs_url:
                return url
            # Inherit auth query params from base URL for segments
            if base_query and '?' not in abs_url:
                url_lower = abs_url.lower()
                if any(ext in url_lower for ext in ('.ts', '.m4s', '.aac', '.mp4', '.fmp4', '.key')):
                    abs_url = f"{abs_url}?{base_query}"

            # Append extra query params (referer, origin, etc.)
            suffix = f"&{extra_query}" if extra_query else ""
            return f"{proxy_route}?url={urllib.parse.quote(abs_url)}{suffix}"

        def proxify_sub(url: str) -> str:
            # SUBTITLES URIs must resolve to an m3u8 playlist. When a source
            # points directly at a subtitle file, tag it so the proxy returns a
            # synthetic wrapper playlist instead of the raw .vtt (which hls.js
            # would reject with "Missing #EXTM3U"). Real subtitle playlists
            # (.m3u8) are proxied normally.
            abs_url = to_absolute(url)
            if not abs_url:
                return url
            low = abs_url.split('?', 1)[0].lower()
            if not (low.endswith('.vtt') or low.endswith('.srt')):
                return proxify(url)
            suffix = f"&{extra_query}" if extra_query else ""
            return f"{proxy_route}?url={urllib.parse.quote(abs_url)}&vttwrap=1{suffix}"

        re_uri_dq = self.RE_M3U8_URI_DQ
        re_uri_sq = self.RE_M3U8_URI_SQ
        re_uri_uq = self.RE_M3U8_URI_UQ
        re_http = self.RE_M3U8_HTTP

        def rewrite_line(line: str) -> str:
            trimmed = line.strip()
            if not trimmed:
                return line
            if trimmed.startswith('#'):
                fn = proxify_sub if ('TYPE=SUBTITLES' in trimmed.upper()) else proxify
                line = re_uri_dq.sub(lambda m: f'URI="{fn(m.group(1).strip())}"', line)
                line = re_uri_sq.sub(lambda m: f'URI="{fn(m.group(1).strip())}"', line)
                line = re_uri_uq.sub(lambda m: f'URI="{fn(m.group(1).strip())}"', line)
                return line
            if re_http.match(trimmed):
                return proxify(trimmed)
            return proxify(to_absolute(trimmed))
        
        return '\n'.join(rewrite_line(l) for l in content.split('\n'))
    
    @staticmethod
    def _with_browser_fetch_metadata(headers: Dict) -> Dict:
        return {
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            **headers,
        }

    async def _service_proxy(self, request: Request, service_name: str,
                              default_headers: Dict, session_key: str = 'normal',
                              proxy_route: str = None,
                              trusted_proxy_params: Optional[Dict[str, str]] = None) -> Response:
        """
        Generic service-specific proxy handler.
        Each service route calls this with its own headers and session.
        No regex detection needed - the route itself identifies the service.
        """
        if request.method == 'OPTIONS':
            return web.Response(headers=CORS_HEADERS)
        
        target_url = request.query.get('url')
        if not target_url:
            return web.json_response({'error': 'Missing url parameter'}, status=400, headers=CORS_HEADERS)

        if service_name == "seekstreaming":
            try:
                target_url = validate_seekstreaming_media_url(target_url)
                seek_origin = normalize_seekstreaming_origin(
                    default_headers.get("Origin")
                    or default_headers.get("Referer")
                    or "https://embedseek.com/"
                )
            except ValueError:
                return web.json_response(
                    {"error": "Invalid SeekStreaming proxy request"},
                    status=400,
                    headers=CORS_HEADERS,
                )
            default_headers = {
                **default_headers,
                "Origin": seek_origin,
                "Referer": f"{seek_origin}/",
            }
        
        # Same guard as on the redirect below: never relay the Fsvid/Vidzy decoy
        # stream, even when it reaches us through a stale cache or a crafted url.
        if service_name in ('fsvid', 'vidzy') and 'troll' in target_url.lower():
            logger.warning(
                "[%s-PROXY] Decoy target refused for %s",
                service_name.upper(),
                redact_url_for_log(target_url),
            )
            return web.json_response(
                {"error": "Upstream returned a decoy stream"},
                status=502,
                headers=CORS_HEADERS,
            )

        self._request_count += 1

        headers = self._with_browser_fetch_metadata(default_headers)
        
        # Detect content type
        content = detect_content_type(target_url, request.headers.get('accept', ''))

        # Range support â€” never forward to manifests: we need the full text to
        # parse/rewrite, and upstreams that honor Range return a truncated 206
        # that fails M3U8 validation (client then retries forever).
        range_header = request.headers.get('range') or request.headers.get('Range')
        if range_header and not content.is_m3u8:
            headers['Range'] = range_header

        # Capture only caller-approved query params for rewritten resources.
        if trusted_proxy_params is not None:
            forwarded_proxy_params = {}
            if service_name == "seekstreaming":
                for name in ("origin", "referer"):
                    value = trusted_proxy_params.get(name)
                    if value:
                        forwarded_proxy_params[name] = value
                cache_key = trusted_proxy_params.get("cache_key", "")
                if re.fullmatch(r"[a-f0-9]{64}", cache_key):
                    forwarded_proxy_params["cache_key"] = cache_key
                if trusted_proxy_params.get("vttwrap") == "1":
                    forwarded_proxy_params["vttwrap"] = "1"
            else:
                forwarded_proxy_params = dict(trusted_proxy_params)
        else:
            forwarded_proxy_params = {
                k: v for k, v in request.query.items() if k != "url"
            }
        extra_query = urllib.parse.urlencode(forwarded_proxy_params)

        # Timeouts based on content
        if content.is_mp4 and range_header:
            timeout = ClientTimeout(total=None, connect=10, sock_read=30)
        elif content.is_mp4:
            timeout = ClientTimeout(total=60, connect=10, sock_read=30)
        elif content.is_ts or content.is_m4s:
            timeout = ClientTimeout(total=None, connect=10, sock_read=60)
        elif content.is_m3u8:
            timeout = ClientTimeout(total=30, connect=10, sock_read=20)
        else:
            timeout = ClientTimeout(total=30, connect=10, sock_read=20)
        
        if service_name == "seekstreaming":
            session = self.sessions.get("seekstreaming")
            if session is None or getattr(session, "closed", False):
                return web.json_response(
                    {"error": "SeekStreaming proxy unavailable"},
                    status=503,
                    headers=CORS_HEADERS,
                )
            actual_session_key = "seekstreaming"
        elif session_key in self.sessions:
            session = self.sessions[session_key]
            actual_session_key = session_key
        else:
            session = self.sessions['normal']
            actual_session_key = 'normal'
            logger.warning(f'[{service_name.upper()}-PROXY] âš  Session "{session_key}" introuvable, fallback sur "normal" (sans proxy) ! VÃ©rifier PROXIES_SOCKS5_JSON')
        route = proxy_route or f'/{service_name}-proxy'

        # Subtitle wrapper: some sources (e.g. topstream) declare
        # #EXT-X-MEDIA:TYPE=SUBTITLES with a URI pointing straight at a .vtt file.
        # hls.js expects that URI to be an m3u8 playlist, so synthesize a
        # one-segment playlist that references the real VTT (fetched normally
        # on the follow-up request without the marker).
        if forwarded_proxy_params.get("vttwrap") == "1":
            inner_params = {
                k: v
                for k, v in forwarded_proxy_params.items()
                if k != "vttwrap"
            }
            inner_query = urllib.parse.urlencode(inner_params)
            inner_suffix = f"&{inner_query}" if inner_query else ""
            inner_url = f"{route}?url={urllib.parse.quote(target_url)}{inner_suffix}"
            playlist = (
                "#EXTM3U\n"
                "#EXT-X-VERSION:3\n"
                "#EXT-X-TARGETDURATION:999999\n"
                "#EXT-X-MEDIA-SEQUENCE:0\n"
                "#EXTINF:999999.0,\n"
                f"{inner_url}\n"
                "#EXT-X-ENDLIST\n"
            )
            return web.Response(text=playlist, headers={
                **CORS_HEADERS,
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache',
            })

        logger.info(
            "[%s-PROXY] session=%s url=%s",
            service_name.upper(),
            actual_session_key,
            redact_url_for_log(target_url),
        )

        try:
            # â”€â”€ Segment cache check (before upstream request) â”€â”€
            if (content.is_ts or content.is_m4s) and not range_header:
                cached_data = self.segment_buffer.get(target_url)
                if cached_data is not None:
                    self._segment_cache_hits += 1
                    self._cache_hits += 1
                    ct = 'video/mp2t' if content.is_ts else 'video/iso.segment'
                    return web.Response(body=cached_data, status=200, headers={
                        **CORS_HEADERS,
                        'Content-Type': ct,
                        'Cache-Control': 'public, max-age=86400, immutable',
                        'Accept-Ranges': 'bytes',
                        'Content-Length': str(len(cached_data)),
                        'X-Segment-Cache': 'HIT',
                    })

            if service_name == 'cinep' and self.curl_session is not None:
                timeout_s = timeout.total or timeout.sock_read or 30
                upstream_cm = _CurlCffiUpstream(self.curl_session, target_url, headers, timeout_s, service_name)
            else:
                upstream_cm = session.get(
                    target_url,
                    headers=headers,
                    timeout=timeout,
                    allow_redirects=False,
                )

            async with upstream_cm as response:
                response_url = str(getattr(response, "url", "") or target_url)
                resp_headers = self._prepare_stream_headers(response.headers)

                # Pass through redirects while keeping the client inside this service proxy route
                if 300 <= response.status < 400:
                    location = response.headers.get('location') or response.headers.get('Location')
                    if not location:
                        return web.json_response(
                            {"error": "Invalid upstream redirect"},
                            status=502,
                            headers=CORS_HEADERS,
                        )
                    redirected = urljoin(response_url, location)
                    if service_name == "seekstreaming":
                        try:
                            redirected = validate_seekstreaming_media_url(
                                redirected
                            )
                        except ValueError:
                            return web.json_response(
                                {"error": "Invalid upstream redirect"},
                                status=502,
                                headers=CORS_HEADERS,
                            )
                    # Fsvid/Vidzy answer a request they judge illegitimate with a
                    # 302 towards their decoy stream. Following it would play the
                    # troll video, so surface the rejection instead.
                    if (
                        service_name in ('fsvid', 'vidzy')
                        and 'troll' in redirected.lower()
                    ):
                        logger.warning(
                            "[%s-PROXY] Decoy redirect refused for %s",
                            service_name.upper(),
                            redact_url_for_log(target_url),
                        )
                        return web.json_response(
                            {"error": "Upstream returned a decoy stream"},
                            status=502,
                            headers=CORS_HEADERS,
                        )
                    proxied_location = f"{route}?" + urllib.parse.urlencode({
                        "url": redirected,
                        **forwarded_proxy_params,
                    })
                    return web.Response(
                        status=response.status,
                        headers={
                            **CORS_HEADERS,
                            "Location": proxied_location,
                            "Cache-Control": "no-cache",
                        },
                    )
                
                # Convert upstream HTTP failures to error for consistent client handling
                if response.status >= 400:
                    if (
                        service_name == "seekstreaming"
                        and response.status in (401, 403, 404)
                    ):
                        cache_key = forwarded_proxy_params.get("cache_key")
                        if cache_key:
                            self.seekstreaming_cache.delete(cache_key)
                    logger.warning(
                        "[%s-PROXY] Upstream HTTP %s for %s",
                        service_name.upper(),
                        response.status,
                        redact_url_for_log(response_url),
                    )
                    return web.json_response(
                        {
                            'error': f'Upstream HTTP error: {response.status}',
                            'upstream_status': response.status,
                        },
                        status=response.status,
                        headers=CORS_HEADERS
                    )
                
                known_hls = is_hls_response(
                    target_url,
                    response_url,
                    response.headers.get("Content-Type", ""),
                )
                if known_hls:
                    body = await response.read()
                    try:
                        if not has_hls_manifest_signature(body):
                            raise ValueError("Invalid HLS response")
                        text = body.decode("utf-8")
                    except (UnicodeDecodeError, ValueError):
                        logger.warning(
                            "[%s-PROXY] Invalid HLS response from %s",
                            service_name.upper(),
                            redact_url_for_log(response_url),
                        )
                        return web.json_response(
                            {"error": "Invalid HLS response"},
                            status=502,
                            headers=CORS_HEADERS,
                        )
                    rewritten = self._rewrite_m3u8_for_service(
                        text,
                        response_url,
                        route,
                        extra_query,
                    )
                    payload = rewritten.encode("utf-8")
                    return _safe_response(payload, response.status, {
                        **resp_headers,
                        "Content-Type": "application/vnd.apple.mpegurl",
                        "Content-Length": str(len(payload)),
                        "Cache-Control": (
                            "public, max-age=300"
                            if "#EXT-X-ENDLIST" in text
                            else "no-cache"
                        ),
                    })

                if not (
                    content.is_ts
                    or content.is_m4s
                    or content.is_mp4
                    or content.is_mpd
                ):
                    if not hasattr(response.content, "read"):
                        return await self._stream_response(
                            request,
                            response,
                            resp_headers,
                            CHUNK_DEFAULT,
                        )
                    prefix = await response.content.read(32)
                    if has_hls_manifest_signature(prefix):
                        body = prefix + await response.read()
                        try:
                            text = body.decode("utf-8")
                        except UnicodeDecodeError:
                            return web.json_response(
                                {"error": "Invalid HLS response"},
                                status=502,
                                headers=CORS_HEADERS,
                            )
                        rewritten = self._rewrite_m3u8_for_service(
                            text,
                            response_url,
                            route,
                            extra_query,
                        )
                        payload = rewritten.encode("utf-8")
                        return _safe_response(payload, response.status, {
                            **resp_headers,
                            "Content-Type": "application/vnd.apple.mpegurl",
                            "Content-Length": str(len(payload)),
                            "Cache-Control": "no-cache",
                        })
                    return await self._stream_response_with_prefix(
                        request,
                        response,
                        resp_headers,
                        prefix,
                        CHUNK_DEFAULT,
                    )
                
                # Les playlists KissKH utilisent des centaines de BYTERANGE sur
                # des .ts. Une requête Range doit commencer à répondre dès le
                # premier chunk, comme le chemin MP4, au lieu d'attendre que la
                # plage complète soit chargée en mémoire.
                if range_header and (content.is_ts or content.is_m4s):
                    resp_headers['Content-Type'] = (
                        'video/mp2t' if content.is_ts else 'video/iso.segment'
                    )
                    resp_headers['Accept-Ranges'] = 'bytes'
                    resp_headers['Cache-Control'] = 'public, max-age=7200'
                    if response.status == 206 and 'content-range' in response.headers:
                        resp_headers['Content-Range'] = response.headers['content-range']
                    if 'content-length' in response.headers:
                        resp_headers['Content-Length'] = response.headers['content-length']
                    return await self._stream_response_fast(
                        request,
                        response,
                        resp_headers,
                        CHUNK_LARGE,
                    )

                # TS segments â€” buffer + cache (shared with main proxy segment buffer)
                if content.is_ts:
                    body = await response.read()
                    if response.status == 200 and body:
                        self.segment_buffer.put(target_url, body)
                    resp_headers['Content-Type'] = 'video/mp2t'
                    resp_headers['Cache-Control'] = 'public, max-age=86400, immutable'
                    resp_headers['Accept-Ranges'] = 'bytes'
                    resp_headers['Content-Length'] = str(len(body))
                    resp_headers['X-Segment-Cache'] = 'MISS'
                    return web.Response(body=body, status=response.status, headers=resp_headers)

                # M4S segments â€” buffer + cache (shared with main proxy segment buffer)
                if content.is_m4s:
                    body = await response.read()
                    if response.status == 200 and body:
                        self.segment_buffer.put(target_url, body)
                    resp_headers['Content-Type'] = 'video/iso.segment'
                    resp_headers['Cache-Control'] = 'public, max-age=86400, immutable'
                    resp_headers['Content-Length'] = str(len(body))
                    resp_headers['X-Segment-Cache'] = 'MISS'
                    return web.Response(body=body, status=response.status, headers=resp_headers)
                
                # MP4
                if content.is_mp4:
                    resp_headers['Accept-Ranges'] = 'bytes'
                    resp_headers['Content-Type'] = 'video/mp4'
                    resp_headers['Cache-Control'] = 'public, max-age=7200'
                    if response.status == 206 and 'content-range' in response.headers:
                        resp_headers['Content-Range'] = response.headers['content-range']
                    if 'content-length' in response.headers:
                        resp_headers['Content-Length'] = response.headers['content-length']
                    return await self._stream_response_fast(request, response, resp_headers, CHUNK_LARGE)
                
                # MPD
                if content.is_mpd:
                    body = await response.read()
                    resp_headers['Content-Type'] = 'application/dash+xml'
                    resp_headers['Content-Length'] = str(len(body))
                    return _safe_response(body, response.status, resp_headers)

                # Default streaming
                return await self._stream_response(request, response, resp_headers, CHUNK_DEFAULT)

        except asyncio.TimeoutError:
            logger.warning(
                "[%s-PROXY] Upstream timeout for %s",
                service_name.upper(),
                redact_url_for_log(target_url),
            )
            return web.json_response(
                {'error': 'Upstream timeout'},
                status=504,
                headers=CORS_HEADERS,
            )
        except (aiohttp.ClientError, _CurlRequestException):
            logger.warning(
                "[%s-PROXY] Upstream request failed for %s",
                service_name.upper(),
                redact_url_for_log(target_url),
            )
            return web.json_response(
                {'error': 'Upstream request failed'},
                status=502,
                headers=CORS_HEADERS,
            )
        except Exception as e:
            logger.error(
                "[%s-PROXY] Unexpected %s for %s",
                service_name.upper(),
                type(e).__name__,
                redact_url_for_log(target_url),
            )
            return web.json_response(
                {'error': 'Unexpected proxy error'},
                status=500,
                headers=CORS_HEADERS,
            )

    def _random_socks5_session_key(self) -> Optional[str]:
        proxy_session_keys = sorted(
            key
            for key, session in self.sessions.items()
            if re.fullmatch(r'proxy_\d+', key)
            and not getattr(session, 'closed', False)
        )
        return random.choice(proxy_session_keys) if proxy_session_keys else None

    async def _service_proxy_via_random_socks(
        self,
        request: Request,
        service_name: str,
        default_headers: Dict,
    ) -> Response:
        session_key = self._random_socks5_session_key()
        if session_key is None:
            logger.warning(
                '[%s-PROXY] No SOCKS5 session available',
                service_name.upper(),
            )
            return web.json_response(
                {'error': 'SOCKS5 proxy unavailable'},
                status=503,
                headers=CORS_HEADERS,
            )
        return await self._service_proxy(
            request,
            service_name,
            default_headers,
            session_key=session_key,
        )
    
    # --- Service proxy thin wrappers ---
    
    async def voe_proxy_handler(self, request: Request) -> Response:
        """VOE / bandwidth CDN proxy"""
        return await self._service_proxy(request, 'voe', {
            'Accept': '*/*',
            'Origin': 'https://voe.sx',
            'Referer': 'https://voe.sx/',
            'User-Agent': 'Mozilla/5.0 Chrome/143.0.0.0'
        }, session_key='proxy_0')
    
    async def fsvid_proxy_handler(self, request: Request) -> Response:
        """FSVID proxy"""
        return await self._service_proxy_via_random_socks(request, 'fsvid', {
            'Accept': 'application/vnd.apple.mpegurl,*/*',
            'Origin': 'https://fsvid.lol',
            'Referer': 'https://fsvid.lol/',
            'Sec-Ch-Ua': FSVID_VIDZY_SEC_CH_UA,
            'User-Agent': 'Mozilla/5.0 Chrome/139.0.0.0'
        })

    async def kisskh_proxy_handler(self, request: Request) -> Response:
        """KissKH HLS relay: direct egress, then one deterministic SOCKS retry on 403."""
        if request.method == 'OPTIONS':
            return web.Response(headers=CORS_HEADERS)

        target_url = request.query.get('url')
        try:
            parsed_target = urlparse(target_url or '')
        except ValueError:
            parsed_target = None
        if (
            parsed_target is None
            or parsed_target.scheme.lower() not in {'http', 'https'}
            or not parsed_target.netloc
        ):
            return web.json_response(
                {'error': 'Invalid url parameter'},
                status=400,
                headers=CORS_HEADERS,
            )

        headers = {
            'Accept': 'application/vnd.apple.mpegurl,*/*',
            'Origin': 'https://kisskh.nl',
            'Referer': 'https://kisskh.nl/',
            'User-Agent': 'Mozilla/5.0 Chrome/139.0.0.0',
        }
        started_at = time.monotonic()
        response = await self._service_proxy(
            request,
            'kisskh',
            headers,
            session_key='normal',
        )
        direct_ms = (time.monotonic() - started_at) * 1000
        logger.info(
            "[KISSKH-PROXY] egress=direct status=%s elapsed_ms=%.1f url=%s",
            response.status,
            direct_ms,
            redact_url_for_log(target_url),
        )
        if response.status != 403:
            return response

        logger.warning(
            "[KISSKH-PROXY] direct_403 retry=proxy_0 url=%s",
            redact_url_for_log(target_url),
        )
        proxy_session = self.sessions.get('proxy_0')
        if proxy_session is None or getattr(proxy_session, 'closed', False):
            return web.json_response(
                {'error': 'SOCKS5 proxy unavailable'},
                status=503,
                headers=CORS_HEADERS,
            )
        retry_started_at = time.monotonic()
        response = await self._service_proxy(
            request,
            'kisskh',
            headers,
            session_key='proxy_0',
        )
        logger.info(
            "[KISSKH-PROXY] egress=proxy_0 status=%s elapsed_ms=%.1f total_ms=%.1f url=%s",
            response.status,
            (time.monotonic() - retry_started_at) * 1000,
            (time.monotonic() - started_at) * 1000,
            redact_url_for_log(target_url),
        )
        return response

    async def vidzy_proxy_handler(self, request: Request) -> Response:
        """Vidzy proxy"""
        return await self._service_proxy_via_random_socks(request, 'vidzy', {
            'Accept': 'application/vnd.apple.mpegurl,*/*',
            'Origin': 'https://vidzy.org',
            'Referer': 'https://vidzy.org/',
            'Sec-Ch-Ua': FSVID_VIDZY_SEC_CH_UA,
            'User-Agent': 'Mozilla/5.0 Chrome/141.0.0.0'
        })
    
    async def vidmoly_proxy_handler(self, request: Request) -> Response:
        """Vidmoly proxy"""
        return await self._service_proxy(request, 'vidmoly', {
            'Accept': '*/*',
            'Origin': 'https://vidmoly.net',
            'Referer': 'https://vidmoly.net/',
            'User-Agent': 'Mozilla/5.0 Chrome/143.0.0.0'
        }, session_key='proxy_1')
    
    async def sibnet_proxy_handler(self, request: Request) -> Response:
        """Sibnet proxy"""
        return await self._service_proxy(request, 'sibnet', {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 Chrome/140.0.0.0'
        }, session_key='sibnet')
    
    async def uqload_proxy_handler(self, request: Request) -> Response:
        """Uqload proxy"""
        target_url = request.query.get('url')
        try:
            parse_allowed_uqload_url(target_url)
            uqload_origin = get_uqload_site_origin(target_url)
        except ValueError as exc:
            return web.json_response(
                {'error': str(exc)},
                status=400,
                headers=CORS_HEADERS,
            )

        return await self._service_proxy(request, 'uqload', {
            'Accept': '*/*',
            'Accept-Encoding': 'identity;q=1, *;q=0',
            'Origin': uqload_origin,
            'Referer': f'{uqload_origin}/',
            'User-Agent': 'Mozilla/5.0 Chrome/142.0.0.0'
        })
    
    async def doodstream_proxy_handler(self, request: Request) -> Response:
        """DoodStream proxy â€” robust streaming with SOCKS5 retry on connection drop.
        Unlike the generic _service_proxy, this handler automatically resumes
        the upstream download via Range headers when the SOCKS5 tunnel drops,
        so the client receives the full file without interruption.
        """
        if request.method == 'OPTIONS':
            return web.Response(headers=CORS_HEADERS)

        target_url = request.query.get('url')
        if not target_url:
            return web.json_response({'error': 'Missing url parameter'}, status=400, headers=CORS_HEADERS)

        self._request_count += 1

        # -- Build upstream headers ------------------------------------------------
        up_headers = {
            'Accept': '*/*',
            'Accept-Encoding': 'identity;q=1, *;q=0',
            'Referer': 'https://d0000d.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Connection': 'keep-alive',
        }
        try:
            up_headers['Host'] = urlparse(target_url).netloc
        except Exception:
            pass

        # Forward client Range header
        client_range = request.headers.get('range') or request.headers.get('Range')
        if client_range:
            up_headers['Range'] = client_range

        # No sock_read timeout â€” SOCKS5 tunnels can stall briefly during large transfers
        timeout = ClientTimeout(total=None, connect=15, sock_read=None)
        session = self.sessions.get('proxy_1', self.sessions['normal'])

        MAX_RETRIES = 5

        try:
            # -- First upstream request --------------------------------------------
            async with session.get(target_url, headers=up_headers, timeout=timeout) as first_resp:
                # Prepare response headers for the client
                resp_headers = self._prepare_stream_headers(first_resp.headers)
                resp_headers['Accept-Ranges'] = 'bytes'
                resp_headers['Content-Type'] = 'video/mp4'
                resp_headers['Cache-Control'] = 'public, max-age=7200'

                if first_resp.status == 206 and 'content-range' in first_resp.headers:
                    resp_headers['Content-Range'] = first_resp.headers['content-range']
                if 'content-length' in first_resp.headers:
                    resp_headers['Content-Length'] = first_resp.headers['content-length']

                # Determine total file size (needed for retry Range headers)
                total_size = None
                cr = first_resp.headers.get('content-range', '')
                if '/' in cr:
                    try:
                        total_size = int(cr.split('/')[-1])
                    except (ValueError, IndexError):
                        pass
                if total_size is None and 'content-length' in first_resp.headers:
                    try:
                        total_size = int(first_resp.headers['content-length'])
                    except (ValueError, IndexError):
                        pass

                # Figure out the absolute start byte so retries can resume correctly
                range_start = 0
                if client_range:
                    try:
                        range_start = int(client_range.split('=')[1].split('-')[0])
                    except Exception:
                        pass

                # -- Begin streaming to client -------------------------------------
                resp = _safe_stream_response(first_resp.status, resp_headers)
                self._active_streams += 1
                try:
                    await resp.prepare(request)
                except (ConnectionResetError, ConnectionAbortedError):
                    self._active_streams -= 1
                    return resp

                bytes_sent = 0
                upstream_ok = True
                try:
                    async for chunk in first_resp.content.iter_any():
                        try:
                            await resp.write(chunk)
                            bytes_sent += len(chunk)
                        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
                            # Client disconnected â€” nothing to retry
                            self._active_streams -= 1
                            return resp
                except (aiohttp.ClientError, aiohttp.ClientPayloadError, asyncio.TimeoutError, OSError) as exc:
                    logger.warning(f'[DOODSTREAM-PROXY] Upstream dropped at {bytes_sent} bytes: {exc}')
                    upstream_ok = False
                except Exception as exc:
                    logger.warning(f'[DOODSTREAM-PROXY] Upstream error at {bytes_sent} bytes: {exc}')
                    upstream_ok = False

            # -- Retry loop (runs only when upstream dropped) ----------------------
            if not upstream_ok:
                current_pos = range_start + bytes_sent
                for attempt in range(1, MAX_RETRIES + 1):
                    if total_size is not None and current_pos >= total_size:
                        break  # We actually got everything

                    retry_headers = dict(up_headers)
                    if total_size:
                        retry_headers['Range'] = f'bytes={current_pos}-{total_size - 1}'
                    else:
                        retry_headers['Range'] = f'bytes={current_pos}-'

                    await asyncio.sleep(min(1.0 * attempt, 3.0))  # back-off

                    try:
                        async with session.get(target_url, headers=retry_headers, timeout=timeout) as retry_resp:
                            if retry_resp.status not in (200, 206):
                                logger.warning(f'[DOODSTREAM-PROXY] Retry {attempt} status {retry_resp.status}')
                                continue
                            try:
                                async for chunk in retry_resp.content.iter_any():
                                    try:
                                        await resp.write(chunk)
                                        bytes_sent += len(chunk)
                                        current_pos += len(chunk)
                                    except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
                                        self._active_streams -= 1
                                        return resp
                            except (aiohttp.ClientError, aiohttp.ClientPayloadError, asyncio.TimeoutError, OSError) as exc:
                                logger.warning(f'[DOODSTREAM-PROXY] Retry {attempt} dropped at +{bytes_sent} bytes: {exc}')
                                continue
                            except Exception as exc:
                                logger.warning(f'[DOODSTREAM-PROXY] Retry {attempt} error: {exc}')
                                continue

                            # If we reached here the retry stream finished normally
                            if total_size is None or current_pos >= total_size:
                                break
                    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                        logger.warning(f'[DOODSTREAM-PROXY] Retry {attempt} connect failed: {exc}')
                        continue

            # -- Finalise ----------------------------------------------------------
            try:
                await resp.write_eof()
            except Exception:
                pass
            self._active_streams -= 1
            return resp

        except asyncio.TimeoutError:
            return web.json_response({'error': 'Timeout'}, status=504, headers=CORS_HEADERS)
        except aiohttp.ClientError as exc:
            return web.json_response({'error': str(exc)}, status=502, headers=CORS_HEADERS)
        except Exception as exc:
            logger.error(f'[DOODSTREAM-PROXY] Fatal: {exc}')
            return web.json_response({'error': str(exc)}, status=500, headers=CORS_HEADERS)

    async def seekstreaming_proxy_handler(self, request: Request) -> Response:
        """SeekStreaming / embed4me proxy"""
        try:
            validate_seekstreaming_media_url(request.query.get("url"))
            origin = normalize_seekstreaming_origin(
                request.query.get("origin")
                or request.query.get("referer")
                or "https://embedseek.com/"
            )
        except ValueError:
            return web.json_response(
                {"error": "Invalid SeekStreaming proxy request"},
                status=400,
                headers=CORS_HEADERS,
            )

        cache_key = request.query.get("cache_key", "")
        if cache_key and not re.fullmatch(r"[a-f0-9]{64}", cache_key):
            return web.json_response(
                {"error": "Invalid SeekStreaming proxy request"},
                status=400,
                headers=CORS_HEADERS,
            )
        trusted_proxy_params = {
            "origin": origin,
            "referer": f"{origin}/",
        }
        if cache_key:
            trusted_proxy_params["cache_key"] = cache_key
        if request.query.get("vttwrap") == "1":
            trusted_proxy_params["vttwrap"] = "1"

        return await self._service_proxy(
            request,
            "seekstreaming",
            {
                "Accept": "*/*",
                "Origin": origin,
                "Referer": f"{origin}/",
                "User-Agent": SEEKSTREAMING_USER_AGENT,
            },
            session_key="seekstreaming",
            trusted_proxy_params=trusted_proxy_params,
        )

    async def cinep_proxy_handler(self, request: Request) -> Response:
        """CinePulse proxy"""
        return await self._service_proxy(request, 'cinep', {
            'Accept': 'application/vnd.apple.mpegurl,*/*',
            'Origin': 'https://purstream.mx',
            'Referer': 'https://purstream.mx/',
            'User-Agent': 'Mozilla/5.0 Chrome/143.0.0.0'
        })

    # ===== DRM Proxy Handlers (WideFrog integration) =====
    
    async def drm_extract_handler(self, request: Request) -> Response:
        """Extract manifest info from a content URL (JSON API, GET or POST)"""
        # VIP check â€” DRM extraction is a premium feature
        if not await self._check_vip(request):
            return self._vip_denied_response()
        
        # Support both GET ?url= and POST {"url": ...} like proxy_server.py
        if request.method == 'POST':
            try:
                body = await request.json()
                content_url = body.get('url', '').strip()
            except Exception:
                content_url = ''
        else:
            content_url = request.query.get('url', '').strip()
        
        if not content_url:
            return web.json_response({'error': "Missing 'url' parameter"}, status=400, headers=CORS_HEADERS)
        
        try:
            loop = asyncio.get_event_loop()
            info = await loop.run_in_executor(_DRM_EXECUTOR, _extract_manifest_sync, content_url)
            return web.json_response({
                'manifest_url': info['manifest_url'],
                'all_manifests': info['all_manifests'],
                'proxied_manifest_url': _drm_proxy_url(info['manifest_url'], '/drm/manifest'),
                'manifest_type': info['manifest_type'],
                'keys': info['keys'],
                'key_errors': info.get('key_errors', []),
                'pssh': info.get('pssh', []),
                'is_hls_aes': info['is_hls_aes'],
                'title': info['title'],
            }, headers=CORS_HEADERS)
        except Exception as e:
            traceback.print_exc()
            return web.json_response({'error': str(e)}, status=500, headers=CORS_HEADERS)
    
    async def drm_manifest_handler(self, request: Request) -> Response:
        """Fetch a manifest, rewrite its URLs, and return it through the DRM proxy"""
        target_url = request.query.get('url', '')
        if not target_url:
            return web.Response(text='Missing url parameter', status=400)
        
        target_url = urllib.parse.unquote(target_url)
        
        # Build headers
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        if _WIDEFROG_AVAILABLE and hasattr(builtins, 'CONFIG'):
            headers['User-Agent'] = builtins.CONFIG.get('USER_AGENT', headers['User-Agent'])
        
        # Use proxy for France.tv CDN domains (need French IP)
        if self._is_francetv_url(target_url):
            session = self.sessions.get('proxy_0', self.sessions['normal'])
            headers['Accept-Language'] = 'fr-FR,fr;q=0.9,en;q=0.6'
            headers['Origin'] = 'https://www.france.tv'
            headers['Referer'] = 'https://www.france.tv/'
            logger.info(f'[drm/manifest] Using proxy for france.tv URL: {target_url[:120]}')
        else:
            session = self.sessions['normal']
        try:
            async with session.get(target_url, headers=headers,
                                   timeout=ClientTimeout(total=30)) as response:
                body = await response.text()
                resp_content_type = response.headers.get('Content-Type', '').lower()
                if response.status == 403:
                    logger.warning(f'[drm/manifest] 403 on {target_url[:150]}')
                    return web.json_response({'msg': 'Access denied', 'code': 1400}, status=403, headers=CORS_HEADERS)
        except Exception as e:
            return web.Response(text=f'Failed to fetch manifest: {e}', status=502)
        
        content_type = 'application/octet-stream'
        base_url = target_url.rsplit('/', 1)[0] + '/'
        
        # Detect type from content, URL, and Content-Type header (like proxy_server.py)
        if '#EXTM3U' in body or 'm3u8' in target_url.lower() or 'mpegurl' in resp_content_type:
            body = _drm_rewrite_m3u8(body, base_url)
            content_type = 'application/vnd.apple.mpegurl'
        elif '<MPD' in body or 'mpd' in target_url.lower() or 'dash' in resp_content_type:
            body = _drm_rewrite_mpd(body, base_url)
            content_type = 'application/dash+xml'
        
        resp_headers = dict(CORS_HEADERS)
        resp_headers['Cache-Control'] = 'no-cache'
        resp_headers['Content-Type'] = content_type
        return web.Response(text=body, headers=resp_headers)
    
    async def drm_resource_handler(self, request: Request) -> Response:
        """Generic proxy for DRM segments, keys, init data, sub-playlists"""
        target_url = request.query.get('url', '')
        if not target_url:
            return web.Response(text='Missing url parameter', status=400)
        
        target_url = urllib.parse.unquote(target_url)
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        if _WIDEFROG_AVAILABLE and hasattr(builtins, 'CONFIG'):
            headers['User-Agent'] = builtins.CONFIG.get('USER_AGENT', headers['User-Agent'])
        
        # Forward range headers
        range_header = request.headers.get('Range') or request.headers.get('range')
        if range_header:
            headers['Range'] = range_header
        
        # Determine content type for streaming optimization
        content = detect_content_type(target_url, request.headers.get('accept', ''))
        
        if content.is_ts or content.is_m4s:
            timeout = ClientTimeout(total=None, connect=10, sock_read=60)
        elif content.is_mp4:
            timeout = ClientTimeout(total=None, connect=10, sock_read=30)
        else:
            timeout = ClientTimeout(total=60, connect=10)
        
        # Use proxy for France.tv CDN domains
        if self._is_francetv_url(target_url):
            session = self.sessions.get('proxy_0', self.sessions['normal'])
            headers['Accept-Language'] = 'fr-FR,fr;q=0.9,en;q=0.6'
            headers['Origin'] = 'https://www.france.tv'
            headers['Referer'] = 'https://www.france.tv/'
        else:
            session = self.sessions['normal']
        try:
            async with session.get(target_url, headers=headers, timeout=timeout) as response:
                resp_headers = self._prepare_stream_headers(response.headers)
                body_bytes = await response.read()
                content_type_header = response.headers.get('Content-Type', 'application/octet-stream')
                
                # If sub-playlist (m3u8), rewrite URLs
                is_m3u8 = 'mpegurl' in content_type_header.lower() or target_url.lower().split('?')[0].endswith('.m3u8')
                try:
                    if is_m3u8 or body_bytes[:7] == b'#EXTM3U':
                        text = body_bytes.decode('utf-8', errors='replace')
                        base_url = target_url.rsplit('/', 1)[0] + '/'
                        text = _drm_rewrite_m3u8(text, base_url)
                        body_bytes = text.encode('utf-8')
                        content_type_header = 'application/vnd.apple.mpegurl'
                except Exception:
                    pass
                
                # If DASH sub-manifest
                is_mpd = 'dash' in content_type_header.lower() or target_url.lower().split('?')[0].endswith('.mpd')
                try:
                    if is_mpd and b'<MPD' in body_bytes[:500]:
                        text = body_bytes.decode('utf-8', errors='replace')
                        base_url = target_url.rsplit('/', 1)[0] + '/'
                        text = _drm_rewrite_mpd(text, base_url)
                        body_bytes = text.encode('utf-8')
                        content_type_header = 'application/dash+xml'
                except Exception:
                    pass
                
                if 'Content-Range' in response.headers:
                    resp_headers['Content-Range'] = response.headers['Content-Range']

                return _safe_response(body_bytes, response.status, {**resp_headers, 'Content-Type': content_type_header})
        except asyncio.TimeoutError:
            return web.json_response({'error': 'Timeout'}, status=504, headers=CORS_HEADERS)
        except aiohttp.ClientError as e:
            return web.json_response({'error': str(e)}, status=502, headers=CORS_HEADERS)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500, headers=CORS_HEADERS)
    
    async def drm_base_resource_handler(self, request: Request) -> Response:
        """Path-based proxy for DASH: resolves subpath relative to decoded base URL.
        Used when <BaseURL> is set to /drm/b/<base64>/ in rewritten MPD manifests."""
        base_b64 = request.match_info['base_b64']
        subpath = request.match_info['subpath']
        
        # Decode base URL
        padding = 4 - len(base_b64) % 4
        if padding != 4:
            base_b64 += '=' * padding
        try:
            decoded_base = base64.urlsafe_b64decode(base_b64).decode()
        except Exception:
            return web.Response(text='Invalid base encoding', status=400)
        
        target_url = decoded_base + subpath
        
        # Preserve query string
        if request.query_string:
            target_url += '?' + request.query_string
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        if _WIDEFROG_AVAILABLE and hasattr(builtins, 'CONFIG'):
            headers['User-Agent'] = builtins.CONFIG.get('USER_AGENT', headers['User-Agent'])
        
        range_header = request.headers.get('Range') or request.headers.get('range')
        if range_header:
            headers['Range'] = range_header
        
        content = detect_content_type(target_url, request.headers.get('accept', ''))
        
        if content.is_ts or content.is_m4s:
            timeout = ClientTimeout(total=None, connect=10, sock_read=60)
        elif content.is_mp4:
            timeout = ClientTimeout(total=None, connect=10, sock_read=30)
        else:
            timeout = ClientTimeout(total=60, connect=10)
        
        # Use proxy for France.tv CDN domains
        if self._is_francetv_url(target_url):
            session = self.sessions.get('proxy_0', self.sessions['normal'])
            headers['Accept-Language'] = 'fr-FR,fr;q=0.9,en;q=0.6'
            headers['Origin'] = 'https://www.france.tv'
            headers['Referer'] = 'https://www.france.tv/'
        else:
            session = self.sessions['normal']
        try:
            async with session.get(target_url, headers=headers, timeout=timeout) as response:
                resp_headers = self._prepare_stream_headers(response.headers)
                body_bytes = await response.read()
                content_type_header = response.headers.get('Content-Type', 'application/octet-stream')
                
                # Rewrite sub-manifests
                try:
                    if b'#EXTM3U' in body_bytes[:20]:
                        text = body_bytes.decode('utf-8', errors='replace')
                        text_base = target_url.rsplit('/', 1)[0] + '/'
                        text = _drm_rewrite_m3u8(text, text_base)
                        body_bytes = text.encode('utf-8')
                        content_type_header = 'application/vnd.apple.mpegurl'
                    elif b'<MPD' in body_bytes[:500]:
                        text = body_bytes.decode('utf-8', errors='replace')
                        text_base = target_url.rsplit('/', 1)[0] + '/'
                        text = _drm_rewrite_mpd(text, text_base)
                        body_bytes = text.encode('utf-8')
                        content_type_header = 'application/dash+xml'
                except Exception:
                    pass
                
                if 'Content-Range' in response.headers:
                    resp_headers['Content-Range'] = response.headers['Content-Range']

                # Use streaming for large segments
                if content.is_ts or content.is_m4s:
                    resp_headers['Cache-Control'] = 'public, max-age=86400, immutable'

                return _safe_response(body_bytes, response.status, {**resp_headers, 'Content-Type': content_type_header})
        except asyncio.TimeoutError:
            return web.json_response({'error': 'Timeout'}, status=504, headers=CORS_HEADERS)
        except aiohttp.ClientError as e:
            return web.json_response({'error': str(e)}, status=502, headers=CORS_HEADERS)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500, headers=CORS_HEADERS)
    
    async def _periodic_cache_cleanup(self):
        """Periodically clean expired cache entries to free memory"""
        while True:
            await asyncio.sleep(600)  # Every 10 minutes
            try:
                self.voe_cache.clear_expired()
                self.fsvid_cache.clear_expired()
                self.vidzy_cache.clear_expired()
                self.vidmoly_cache.clear_expired()
                self.sibnet_cache.clear_expired()
                self.uqload_cache.clear_expired()
                self.uqload_mp4_cache.clear_expired()
                self.doodstream_cache.clear_expired()
                self.seekstreaming_cache.clear_expired()
                self.m3u8_response_cache.clear_expired()
                self.m3u8_vod_cache.clear_expired()
                self.segment_buffer._evict_expired()

                # Force garbage collection periodically (every ~10 cleanup cycles = ~100 min)
                if self._request_count % 100000 < 1000:  # Triggers roughly every 100K requests
                    gc.collect(1)  # Only gen0+gen1, not full collection
                    
            except Exception as e:
                logger.warning(f'Cache cleanup error: {e}')
    
    async def start_server(self):
        """Start the server with HIGH PERFORMANCE configuration"""
        logger.info("=" * 60)
        logger.info("ULTRA HIGH PERFORMANCE PROXY SERVER STARTING")
        logger.info("=" * 60)
        logger.info(f"Configuration:")
        logger.info(f"  - Port: {PORT}")
        logger.info(f"  - Chunk Size TS: {CHUNK_TS} bytes")
        logger.info(f"  - Chunk Size MP4: {CHUNK_MP4} bytes")
        logger.info(f"  - Chunk Size Large: {CHUNK_LARGE} bytes")
        logger.info(f"  - Keepalive Timeout: {KEEPALIVE_TIMEOUT}s")
        logger.info(f"  - DNS Cache TTL: {DNS_CACHE_TTL}s")
        logger.info(f"  - Socket Buffer: {SOCKET_READ_BUFFER} bytes")
        logger.info(f"  - Connection Limits: UNLIMITED")
        logger.info("=" * 60)
        
        # Optimized AppRunner - disable access log for production performance
        runner = web.AppRunner(
            self.app,
            handle_signals=True,
            access_log=None,  # Disabled for production - saves significant I/O
        )
        await runner.setup()
        await self._init_mysql()
        await self._init_sessions()
        
        # Pre-init widefrog config for DRM proxy (runs in thread to avoid blocking)
        if _WIDEFROG_AVAILABLE:
            try:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(_DRM_EXECUTOR, _init_widefrog)
                logger.info('[DRM] WideFrog config initialized')
            except Exception as e:
                logger.warning(f'[DRM] WideFrog init failed: {e}')
        
        # Start with optimized TCP settings
        site = web.TCPSite(
            runner, 
            '0.0.0.0', 
            PORT,
            reuse_address=True,
            reuse_port=(sys.platform != 'win32'),  # reuse_port only supported on Linux
        )
        await site.start()
        
        # Start background cache cleanup
        asyncio.create_task(self._periodic_cache_cleanup())
        
        logger.info(f"Server running on port {PORT} - Ready for HIGH LOAD!")
        logger.info("Endpoints: /proxy, /health, /stats, /drm/*")
        if _WIDEFROG_AVAILABLE:
            logger.info("[DRM] WideFrog DRM API available at /drm/extract")
        else:
            logger.warning("[DRM] WideFrog not available â€” /drm/extract will fail")


async def main():
    server = ProxyServer()
    await server.start_server()
    
    # Create shutdown event
    shutdown_event = asyncio.Event()
    
    def signal_handler():
        logger.info("Shutdown signal received...")
        shutdown_event.set()
    
    # Setup signal handlers
    if sys.platform != 'win32':
        import signal
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, signal_handler)
    
    try:
        # On Windows, loop with sleep to allow signal handling
        while not shutdown_event.is_set():
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        # Cleanup sessions
        logger.info("Closing sessions...")
        cleanup_tasks = []
        for name, session in server.sessions.items():
            if not session.closed:
                cleanup_tasks.append(session.close())
        if server.curl_session is not None:
            cleanup_tasks.append(server.curl_session.close())
        if cleanup_tasks:
            await asyncio.gather(*cleanup_tasks, return_exceptions=True)
            
        # Give a moment for underlying transports to close
        await asyncio.sleep(0.1)
        logger.info("Server stopped.")
        # Force exit to ensure process terminates
        sys.exit(0)


if __name__ == '__main__':
    # Performance optimizations for Windows
    if sys.platform == 'win32':
        # Use SelectorEventLoop for better Windows performance
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
