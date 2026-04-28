"""Provider-agnostic LLM client.

Swap providers via the LLM_PROVIDER env var:
  "ollama"    – local Ollama (Qwen, Llama, etc.)
  "nvidia"    – NVIDIA NIM cloud API (free tier, OpenAI-compatible)
  "anthropic" – Anthropic Claude
  "openai"    – OpenAI-compatible gateway
  "echo"      – offline stub (no key needed)

All providers share the `complete_json(system, messages)` contract and
must return a dict parsed from the model's JSON output.
"""
from __future__ import annotations

import json
import os
import re
from abc import ABC, abstractmethod
from typing import Any

import httpx


Message = dict[str, str]  # {"role": "user"|"assistant", "content": "..."}


class LLMError(RuntimeError):
    pass


def _extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a model response.

    Models sometimes wrap JSON in ```json fences or prose; be lenient.
    """
    if not text:
        raise LLMError("Empty LLM response")

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else None

    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise LLMError(f"No JSON object found in response: {text[:200]}")
        candidate = text[start : end + 1]

    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise LLMError(f"Invalid JSON from LLM: {exc}. Raw: {candidate[:300]}") from exc


class LLMClient(ABC):
    @abstractmethod
    def complete_json(
        self,
        system: str,
        messages: list[Message],
        temperature: float = 0.6,
        max_tokens: int = 800,
    ) -> dict[str, Any]: ...


class OllamaClient(LLMClient):
    def __init__(self, base_url: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.keep_alive = str(os.getenv("OLLAMA_KEEP_ALIVE", "20m") or "").strip() or None
        self.num_ctx = max(512, int(os.getenv("OLLAMA_NUM_CTX", "4096") or "4096"))
        self.num_thread = max(0, int(os.getenv("OLLAMA_NUM_THREAD", "0") or "0"))
        self._client = httpx.Client(
            timeout=float(os.getenv("OLLAMA_TIMEOUT_SEC", "90") or "90"),
            limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
        )

    @staticmethod
    def _trim_text(value: str, max_chars: int) -> str:
        text = str(value or "")
        if len(text) <= max_chars:
            return text
        return text[:max_chars]

    def _build_options(self, temperature: float, max_tokens: int) -> dict[str, Any]:
        options: dict[str, Any] = {
            "temperature": float(temperature),
            "num_predict": int(max_tokens),
            "num_ctx": self.num_ctx,
        }
        if self.num_thread > 0:
            options["num_thread"] = self.num_thread
        return options

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        safe_system = self._trim_text(system, 5000)
        safe_messages = [
            {
                "role": str(m.get("role", "user")),
                "content": self._trim_text(str(m.get("content", "")), 9000),
            }
            for m in messages
        ]

        attempts = [
            {
                "model": self.model,
                "stream": False,
                "format": "json",
                "options": self._build_options(temperature, max_tokens),
                "keep_alive": self.keep_alive,
                "messages": [{"role": "system", "content": safe_system}, *safe_messages],
            },
            {
                "model": self.model,
                "stream": False,
                "options": self._build_options(
                    min(float(temperature), 0.15),
                    min(int(max_tokens), 240),
                ),
                "keep_alive": self.keep_alive,
                "messages": [{"role": "system", "content": safe_system}, *safe_messages],
            },
        ]

        body: dict[str, Any] | None = None
        last_error: str | None = None

        for idx, payload in enumerate(attempts):
            try:
                resp = self._client.post(f"{self.base_url}/api/chat", json=payload)
                resp.raise_for_status()
                body = resp.json()
                break
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else "unknown"
                resp_text = ""
                if exc.response is not None:
                    resp_text = (exc.response.text or "")[:300]
                last_error = f"status={status}, body={resp_text or '<empty>'}"
                # Retry once on server-side failures with a lighter payload.
                if status and int(status) >= 500 and idx < len(attempts) - 1:
                    continue
                raise LLMError(f"Ollama request failed: {exc}. Details: {last_error}") from exc
            except httpx.HTTPError as exc:
                last_error = str(exc)
                if idx < len(attempts) - 1:
                    continue
                raise LLMError(f"Ollama request failed: {exc}") from exc

        if body is None:
            raise LLMError(f"Ollama request failed with no response body. Last error: {last_error or 'unknown'}")

        content = body.get("message", {}).get("content", "")
        return _extract_json(content)


class AnthropicClient(LLMClient):
    def __init__(self, api_key: str, model: str) -> None:
        try:
            import anthropic
        except ImportError as exc:
            raise LLMError("anthropic package not installed") from exc
        self._client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        reinforced = (
            system
            + "\n\nRespond with ONLY a single JSON object. No prose, no markdown fences."
        )
        try:
            resp = self._client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=reinforced,
                messages=messages,
            )
        except Exception as exc:  # anthropic raises many subclasses
            raise LLMError(f"Anthropic request failed: {exc}") from exc

        text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
        return _extract_json(text)


class OpenAICompatClient(LLMClient):
    """OpenAI-compatible chat completion client via HTTP.

    Works with OpenAI and compatible gateways (OpenRouter, Azure-compatible
    proxies exposing /chat/completions, etc.) when using the same schema.
    """

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        use_json_response_format: bool = True,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.use_json_response_format = use_json_response_format

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        payload: dict[str, Any] = {
            "model": self.model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": system}, *messages],
        }
        if self.use_json_response_format:
            payload["response_format"] = {"type": "json_object"}

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            with httpx.Client(timeout=120.0) as client:
                resp = client.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                )
                resp.raise_for_status()
                body = resp.json()
        except httpx.HTTPError as exc:
            raise LLMError(f"OpenAI-compatible request failed: {exc}") from exc

        content = (
            body.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        return _extract_json(content)


class NvidiaClient(LLMClient):
    """NVIDIA NIM cloud API – free tier, OpenAI-compatible.

    Sign up at https://build.nvidia.com and grab an ``nvapi-...`` key.
    Default model: ``meta/llama-3.3-70b-instruct`` (strong, free, great for
    structured interview tasks).  Override with NVIDIA_MODEL env var.

    The NIM endpoint does NOT support ``response_format: json_object`` on all
    models, so we rely on the shared ``_extract_json`` parser instead.
    """

    _BASE_URL = "https://integrate.api.nvidia.com/v1"

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        # Reinforce JSON-only output inside the system prompt because we
        # cannot rely on response_format across all NIM models.
        enforced_system = (
            system
            + "\n\nIMPORTANT: Respond with ONLY a single valid JSON object."
            "  No markdown fences, no explanatory prose."
        )
        payload: dict[str, Any] = {
            "model": self.model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": enforced_system},
                *messages,
            ],
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        # NIM free tier occasionally returns 502/503/504 or drops the connection
        # under load. Retry up to 3 times with a small backoff on transient
        # failures so a single hiccup doesn't kill the candidate's turn.
        # Auth/4xx errors are NOT retried — they will not become valid by retrying.
        import time as _time
        retryable_statuses = {502, 503, 504}
        last_exc: Exception | None = None
        body: dict[str, Any] | None = None

        # 60s per-attempt timeout × 2 attempts + 0.6s backoff = ~120.6s worst
        # case, which fits under the Node-side 150s timeout. NIM free tier
        # tail latency can spike to 30-50s under queue pressure, so 30s was
        # too tight and surfaced spurious "read timed out" errors. Two
        # attempts is the right tradeoff: a real outage won't recover by a
        # 3rd retry, but a single hiccup will.
        max_attempts = 2
        for attempt in range(max_attempts):
            try:
                with httpx.Client(timeout=60.0) as client:
                    resp = client.post(
                        f"{self._BASE_URL}/chat/completions",
                        headers=headers,
                        json=payload,
                    )
                    resp.raise_for_status()
                    body = resp.json()
                    break
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else 0
                last_exc = exc
                if status in retryable_statuses and attempt < max_attempts - 1:
                    _time.sleep(0.6 * (attempt + 1))
                    continue
                detail = (exc.response.text or "")[:300] if exc.response is not None else ""
                raise LLMError(
                    f"NVIDIA NIM request failed (HTTP {status}): {detail or exc}"
                ) from exc
            except httpx.HTTPError as exc:
                # Network-level error (timeout, read error, connection reset).
                last_exc = exc
                if attempt < max_attempts - 1:
                    _time.sleep(0.6 * (attempt + 1))
                    continue
                raise LLMError(f"NVIDIA NIM request failed: {exc}") from exc

        if body is None:
            raise LLMError(f"NVIDIA NIM request failed after retries: {last_exc}")

        content = (
            body.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        return _extract_json(content)


class EchoClient(LLMClient):
    """Offline stub so the pipeline runs with no LLM at all.

    Returns deterministic, plausible-looking payloads. Useful for CI and for
    wiring the frontend before you pick a provider.
    """

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        last_user = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
        )
        is_intro = "intro" in system.lower() or "hr phase" in system.lower()
        return {
            "score": 0.6,
            "confidence": 0.5,
            "reasoning": "echo-stub: no real LLM configured",
            "next_question": (
                "Tell me a bit about your background and what drew you to this role."
                if is_intro
                else "Walk me through how you would design a REST API rate limiter."
            ),
            "difficulty": 3,
            "skill_focus": "general",
            "done": False,
            "_echoed_last_user": last_user[:120],
        }


def build_client_from_env() -> LLMClient:
    provider = os.getenv("LLM_PROVIDER", "echo").strip().lower()

    if provider == "ollama":
        return OllamaClient(
            base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
            model=os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct"),
        )
    if provider == "nvidia":
        key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not key:
            raise LLMError(
                "NVIDIA_API_KEY is empty. Get a free key at https://build.nvidia.com"
            )
        return NvidiaClient(
            api_key=key,
            model=os.getenv("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct"),
        )
    if provider == "anthropic":
        key = os.getenv("ANTHROPIC_API_KEY", "").strip()
        if not key:
            raise LLMError("ANTHROPIC_API_KEY is empty")
        return AnthropicClient(
            api_key=key,
            model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        )
    if provider == "openai":
        key = os.getenv("OPENAI_API_KEY", "").strip()
        if not key:
            raise LLMError("OPENAI_API_KEY is empty")
        return OpenAICompatClient(
            api_key=key,
            model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        )
    if provider == "echo":
        return EchoClient()

    raise LLMError(f"Unknown LLM_PROVIDER: {provider!r}")
