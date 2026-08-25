"""Bounded subprocess runner for untrusted Fsvid/Vidzy player scripts."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
MAX_HTML_BYTES = 512 * 1024
MAX_SCRIPT_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 128 * 1024
OUTER_TIMEOUT_SECONDS = 1.25
_SANDBOX_CONCURRENCY = asyncio.Semaphore(2)
_WORKER_PATH = Path(__file__).with_name("fsvid_vidzy_js_worker.py")
_PLAYER_SIGNALS = (
    "videojs",
    "sources",
    "atob(",
    "eval(function",
    "eval ( function",
    ".m3u8",
)


@dataclass(frozen=True)
class SandboxResult:
    candidates: tuple[str, ...] = ()
    error: str | None = None


class _InlineScriptCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[str] = []
        self._inside_script = False
        self._external_script = False
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        self._inside_script = True
        self._external_script = any(name.lower() == "src" for name, _ in attrs)
        self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._inside_script and not self._external_script:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "script" or not self._inside_script:
            return
        if not self._external_script:
            self.scripts.append("".join(self._chunks))
        self._inside_script = False
        self._external_script = False
        self._chunks = []


def select_player_scripts(html: str) -> tuple[str, ...]:
    if len(html.encode("utf-8", errors="ignore")) > MAX_HTML_BYTES:
        return ()

    collector = _InlineScriptCollector()
    try:
        collector.feed(html)
        collector.close()
    except Exception:
        return ()

    selected: list[str] = []
    total_bytes = 0
    for script in collector.scripts:
        lowered = script.lower()
        if not any(signal in lowered for signal in _PLAYER_SIGNALS):
            continue
        script_bytes = len(script.encode("utf-8", errors="ignore"))
        if script_bytes == 0 or total_bytes + script_bytes > MAX_SCRIPT_BYTES:
            continue
        selected.append(script)
        total_bytes += script_bytes
    return tuple(selected)


def _minimal_worker_environment() -> dict[str, str]:
    environment: dict[str, str] = {}
    for name in (
        "SYSTEMROOT",
        "WINDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOME",
        "PATH",
        "LANG",
        "LC_ALL",
        "LD_LIBRARY_PATH",
        "VIRTUAL_ENV",
    ):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


def _parse_worker_response(stdout: bytes, returncode: int | None) -> SandboxResult:
    if len(stdout) > MAX_RESPONSE_BYTES:
        return SandboxResult(error="sandbox_invalid_response")
    if not stdout:
        return SandboxResult(
            error=(
                "sandbox_runtime_error"
                if returncode not in (None, 0)
                else "sandbox_invalid_response"
            )
        )

    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return SandboxResult(
            error=(
                "sandbox_runtime_error"
                if returncode not in (None, 0)
                else "sandbox_invalid_response"
            )
        )

    if not isinstance(payload, dict):
        return SandboxResult(error="sandbox_invalid_response")
    raw_candidates = payload.get("candidates", [])
    if not isinstance(raw_candidates, list):
        return SandboxResult(error="sandbox_invalid_response")

    candidates = tuple(
        candidate
        for candidate in raw_candidates[:16]
        if isinstance(candidate, str) and len(candidate) <= 16384
    )
    error = payload.get("error")
    if returncode not in (None, 0) and not isinstance(error, str):
        error = "sandbox_runtime_error"
    return SandboxResult(
        candidates=candidates,
        error=error if isinstance(error, str) else None,
    )


async def execute_player_scripts(
    html: str,
    embed_url: str,
    provider: str,
) -> SandboxResult:
    scripts = select_player_scripts(html)
    if not scripts:
        return SandboxResult(error="no_player_script")

    request_bytes = json.dumps(
        {
            "embedUrl": embed_url,
            "provider": provider,
            "scripts": scripts,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    async with _SANDBOX_CONCURRENCY:
        command = [sys.executable, "-E"]
        if sys.version_info >= (3, 11):
            command.append("-P")
        command.append(str(_WORKER_PATH))
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=_minimal_worker_environment(),
            )
        except (OSError, NotImplementedError):
            # NotImplementedError : la boucle asyncio ne sait pas lancer de
            # sous-processus (cas de WindowsSelectorEventLoop). Elle remonte
            # sans message, ce qui donnait un 500 `{"error": ""}` indéchiffrable
            # à l'appelant. Ici on dégrade comme pour une OSError : l'extraction
            # retombe sur le repli HTML au lieu de faire échouer la requête.
            return SandboxResult(error="sandbox_unavailable")
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(request_bytes),
                timeout=OUTER_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return SandboxResult(error="sandbox_timeout")

    return _parse_worker_response(stdout, process.returncode)
