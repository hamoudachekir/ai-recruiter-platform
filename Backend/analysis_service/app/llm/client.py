"""Provider-agnostic LLM client.

NOTE: this is a copy of Backend/voice_engine/interview_agent/llm_client.py.
Keep the `complete_json(system, messages)` contract in sync; if either copy
gains a feature the other should too. When a third service needs the same
client, promote to a shared package instead of forking again.

Swap providers via the LLM_PROVIDER env var:
  "ollama"    – local Ollama (Qwen, Llama, etc.)
  "nvidia"    – NVIDIA NIM cloud API (free tier, OpenAI-compatible)
  "anthropic" – Anthropic Claude
  "openai"    – OpenAI-compatible gateway
  "echo"      – offline stub (no key needed)
"""
from __future__ import annotations

import json
import os
import re
from abc import ABC, abstractmethod
from typing import Any

import httpx


Message = dict[str, str]


class LLMError(RuntimeError):
    pass


def _extract_json(text: str) -> dict[str, Any]:
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
        except Exception as exc:
            raise LLMError(f"Anthropic request failed: {exc}") from exc

        text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
        return _extract_json(text)


class OpenAICompatClient(LLMClient):
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
    _BASE_URL = "https://integrate.api.nvidia.com/v1"

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
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

        import time as _time
        retryable_statuses = {502, 503, 504}
        last_exc: Exception | None = None
        body: dict[str, Any] | None = None

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


class GeminiClient(LLMClient):
    """Google Gemini via REST — free tier, no local model required."""

    _BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def complete_json(
        self,
        system: str,
        messages: list[Message],
        temperature: float = 0.6,
        max_tokens: int = 800,
    ) -> dict[str, Any]:
        user_text = next(
            (m["content"] for m in reversed(messages) if m.get("role") == "user"), ""
        )

        payload: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "generationConfig": {
                "temperature": float(temperature),
                "maxOutputTokens": int(max_tokens),
                "responseMimeType": "application/json",
            },
        }

        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }

        url = f"{self._BASE_URL}/{self.model}:generateContent"

        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                body = resp.json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code if exc.response is not None else "unknown"
            detail = (exc.response.text or "")[:300] if exc.response is not None else ""
            raise LLMError(f"Gemini request failed (HTTP {status}): {detail or exc}") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"Gemini request failed: {exc}") from exc

        try:
            text = body["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"Unexpected Gemini response shape: {str(body)[:300]}") from exc

        return _extract_json(text)


class EchoClient(LLMClient):
    """Offline stub. Returns a polish-shaped JSON for report tasks."""

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        sys_lower = (system or "").lower()
        if "polish" in sys_lower or "rewrite" in sys_lower:
            return {
                "transcriptSummary": "Candidate provided structured responses across the interview.",
                "finalRecommendation": "Recruiter review of the captured transcript and integrity flags is recommended before progressing.",
                "technicalEvaluation": {
                    "strengths": [
                        "Verbal responses captured with intelligible structure.",
                        "Interview content available for in-depth recruiter review.",
                    ],
                    "weaknesses": [
                        "Automated analysis cannot substitute for technical human review.",
                        "Some answers may benefit from manual follow-up questions.",
                    ],
                },
            }
        last_user = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
        )
        return {
            "score": 0.6,
            "confidence": 0.5,
            "reasoning": "echo-stub: no real LLM configured",
            "next_question": "Walk me through how you would design a REST API rate limiter.",
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
    if provider == "gemini":
        key = os.getenv("GEMINI_API_KEY", "").strip()
        if not key:
            raise LLMError(
                "GEMINI_API_KEY is empty. Get a free key at https://aistudio.google.com"
            )
        return GeminiClient(
            api_key=key,
            model=os.getenv("GEMINI_MODEL", os.getenv("REPORT_POLISH_MODEL", "gemini-2.5-flash-lite")),
        )
    if provider == "echo":
        return EchoClient()

    raise LLMError(f"Unknown LLM_PROVIDER: {provider!r}")
