"""OCR + structure-extraction HTTP service (design §3/§4, Phase 2).

The TypeScript stack calls this service to turn an image/PDF into text
(PaddleOCR) and then into structured metadata (Anthropic). Both steps are
optional and degrade gracefully: if PaddleOCR is missing, /ocr errors clearly;
if no ANTHROPIC_API_KEY is set, /extract returns minimal metadata so ingestion
still stores the raw text.

Run:  uvicorn ingest_service:app --host 127.0.0.1 --port 8011
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

PROMPTS_DIR = Path(os.environ.get("PK_PROMPTS_DIR", Path(__file__).resolve().parent.parent / "prompts"))
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
NO_EXPIRY = "9999-12-31"
# Cap upload size to avoid memory-exhaustion DoS (default 25 MiB).
MAX_UPLOAD_BYTES = int(os.environ.get("PK_MAX_UPLOAD_BYTES", 25 * 1024 * 1024))
# Cap /extract text length to bound worker time and Anthropic API cost.
MAX_EXTRACT_CHARS = int(os.environ.get("PK_MAX_EXTRACT_CHARS", 20000))

# Mirror of the TypeScript DocTypeRegistry default vocabulary (design §9.5).
DEFAULT_DOC_TYPES = [
    "保証書", "自治体通知", "学校手紙", "イベント案内", "連絡先",
    "料金プラン", "確定申告メモ", "固定資産税", "支出記録", "日記", "メモ",
]

app = FastAPI(title="personal-knowledge ingest service")

# Serializes access to the (thread-unsafe) PaddleOCR engine.
_OCR_LOCK = Lock()


# --------------------------------------------------------------------------- OCR
@lru_cache(maxsize=1)
def _ocr_engine():
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise HTTPException(503, "PaddleOCR is not installed") from exc
    # Japanese model also recognizes Latin characters.
    return PaddleOCR(use_angle_cls=True, lang="japan", show_log=False)


def _ocr_image_bytes(data: bytes) -> str:
    import numpy as np
    from PIL import Image

    image = Image.open(io.BytesIO(data)).convert("RGB")
    result = _ocr_engine().ocr(np.array(image), cls=True)
    lines: list[str] = []
    for page in result or []:
        for entry in page or []:
            # entry = [box, (text, confidence)]
            if entry and len(entry) >= 2 and entry[1]:
                lines.append(str(entry[1][0]))
    return "\n".join(lines)


def ocr_file(data: bytes, filename: str, content_type: str | None) -> str:
    is_pdf = (content_type or "").endswith("pdf") or filename.lower().endswith(".pdf")
    if is_pdf:
        try:
            from pdf2image import convert_from_bytes
        except ImportError as exc:  # pragma: no cover
            raise HTTPException(503, "pdf2image/poppler not installed") from exc
        pages = convert_from_bytes(data)
        texts = []
        for page in pages:
            buf = io.BytesIO()
            page.save(buf, format="PNG")
            texts.append(_ocr_image_bytes(buf.getvalue()))
        return "\n\n".join(texts)
    return _ocr_image_bytes(data)


# -------------------------------------------------------------------- extraction
def _load_prompt(doc_type_hint: str | None) -> str:
    root = PROMPTS_DIR.resolve()
    if doc_type_hint:
        # Use only the basename and confirm the resolved path stays under root,
        # so a hint like "../../etc/passwd" cannot escape the prompts directory.
        safe_name = Path(f"{doc_type_hint}.md").name
        candidate = (root / safe_name).resolve()
        if candidate.is_file() and candidate.is_relative_to(root):
            return candidate.read_text(encoding="utf-8")
    return (root / "default.md").read_text(encoding="utf-8")


def _parse_json_object(text: str) -> dict[str, Any]:
    # Tolerate code fences or surrounding prose; grab the first {...} block.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("no JSON object in model output")
    return json.loads(match.group(0))


def extract_metadata(full_text: str, doc_type_hint: str | None) -> dict[str, Any]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        # Degrade gracefully: keep the text, no structured metadata.
        return {"doc_type": doc_type_hint, "extracted": {}, "valid_until": NO_EXPIRY, "dedup_key": None}

    from anthropic import Anthropic

    prompt = (
        _load_prompt(doc_type_hint)
        .replace("{{DOC_TYPES}}", "\n".join(f"- {d}" for d in DEFAULT_DOC_TYPES))
        .replace("{{FULL_TEXT}}", full_text)
    )
    client = Anthropic(api_key=api_key)
    message = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = "".join(block.text for block in message.content if getattr(block, "type", None) == "text")
    data = _parse_json_object(raw)
    return {
        "doc_type": data.get("doc_type") or doc_type_hint,
        "extracted": data.get("extracted") or {},
        "valid_until": data.get("valid_until") or NO_EXPIRY,
        "dedup_key": data.get("dedup_key"),
    }


# ------------------------------------------------------------------------ routes
class ExtractRequest(BaseModel):
    full_text: str
    doc_type_hint: str | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": ANTHROPIC_MODEL, "extraction": bool(os.environ.get("ANTHROPIC_API_KEY"))}


async def _read_limited(file: UploadFile) -> bytes:
    # Read up to the limit (+1 byte to detect overflow) without buffering more.
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file exceeds {MAX_UPLOAD_BYTES} bytes")
    return data


def _safe_ocr(data: bytes, filename: str, content_type: str | None) -> str:
    # PaddleOCR/PaddlePaddle are NOT thread-safe; serialize OCR calls so
    # concurrent requests cannot segfault the process.
    with _OCR_LOCK:
        return ocr_file(data, filename, content_type)


@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...)) -> dict[str, str]:
    data = await _read_limited(file)
    loop = asyncio.get_running_loop()
    # OCR is heavy and synchronous; run it off the event loop so health checks
    # and other requests stay responsive.
    full_text = await loop.run_in_executor(None, _safe_ocr, data, file.filename or "upload", file.content_type)
    return {"full_text": full_text}


@app.post("/extract")
async def extract_endpoint(req: ExtractRequest) -> dict[str, Any]:
    if len(req.full_text) > MAX_EXTRACT_CHARS:
        raise HTTPException(413, f"full_text exceeds {MAX_EXTRACT_CHARS} chars")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, extract_metadata, req.full_text, req.doc_type_hint)
    result["full_text"] = req.full_text
    return result


@app.post("/ingest")
async def ingest_endpoint(file: UploadFile = File(...), doc_type_hint: str | None = Form(default=None)) -> dict[str, Any]:
    data = await _read_limited(file)
    loop = asyncio.get_running_loop()
    full_text = await loop.run_in_executor(None, _safe_ocr, data, file.filename or "upload", file.content_type)
    result = await loop.run_in_executor(None, extract_metadata, full_text, doc_type_hint)
    result["full_text"] = full_text
    return result
