"""On-demand Civitai metadata lookup for local LoRAs."""
import asyncio
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit
from weakref import WeakKeyDictionary

import aiohttp

API = "https://civitai.com/api/v1/"
MAX_RESPONSE = 4 * 1024 * 1024
LOOKUP_STATES = WeakKeyDictionary()
RATE_LIMIT_UNTIL = 0.0
RATE_LIMIT_SECONDS = 30


class LookupError(Exception):
    def __init__(self, message, status=502, code="upstream_error"):
        super().__init__(message)
        self.status, self.code = status, code


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1
        elif not self.hidden and tag in {"p", "br", "li", "div", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def text(value, limit=12000):
    parser = PlainText()
    parser.feed(value[:100000] if isinstance(value, str) else "")
    return "\n".join(line.strip() for line in "".join(parser.parts).splitlines() if line.strip())[:limit]


def signature(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def fingerprint(path):
    before = signature(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if signature(path) != before:
        raise LookupError("模型文件正在变化，请等文件写入完成后重试", 409, "file_changed")
    return before, digest.hexdigest()


def read_cache(path):
    try:
        if path.stat().st_size > MAX_RESPONSE:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) and data.get("schema") == 2 else {}
    except (OSError, ValueError):
        return {}


def write_cache(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            json.dump(value, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


async def fetch_json(session, route):
    try:
        async with session.get(API + route, allow_redirects=False) as response:
            if response.status == 404:
                return None
            if response.status in (401, 403):
                raise LookupError("Civitai 拒绝访问：资源可能需要权限，或网络请求被拦截", 403, "access_denied")
            if response.status == 429:
                raise LookupError("Civitai 请求过于频繁，请稍后重试", 429, "rate_limited")
            if response.status != 200:
                raise LookupError(f"Civitai 暂时不可用（HTTP {response.status}）")
            payload = bytearray()
            async for block in response.content.iter_chunked(65536):
                payload.extend(block)
                if len(payload) > MAX_RESPONSE:
                    raise LookupError("Civitai 返回的数据过大")
            data = json.loads(payload)
            if not isinstance(data, dict):
                raise ValueError("Expected object")
            return data
    except asyncio.TimeoutError as error:
        raise LookupError("连接 Civitai 超时，请检查网络后重试", 504, "timeout") from error
    except (aiohttp.ClientError, ValueError) as error:
        raise LookupError("无法读取 Civitai 数据，请检查网络或代理设置", 502, "network_error") from error


def positive_id(value):
    if type(value) is not int or value <= 0:
        raise LookupError("Civitai 返回的模型标识无效")
    return value


def version_info(data, model_id):
    version_id = positive_id(data.get("id"))
    words = data.get("trainedWords")
    images = []
    candidates = data.get("images")
    for item in candidates[:20] if isinstance(candidates, list) else []:
        if not isinstance(item, dict) or item.get("type", "image") != "image":
            continue
        url = item.get("url")
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            if not parsed or len(url) > 2048 or parsed.scheme != "https" or parsed.hostname != "image.civitai.com" or parsed.username or parsed.password or parsed.port not in (None, 443):
                continue
        except ValueError:
            continue
        meta = item.get("meta")
        meta = meta if isinstance(meta, dict) else {}
        # Prompt syntax is plain text, not HTML: preserve LoRA tags and weights.
        prompt, negative = meta.get("prompt"), meta.get("negativePrompt")
        images.append({"url": url, "prompt": prompt[:12000] if isinstance(prompt, str) else "",
                       "negative_prompt": negative[:12000] if isinstance(negative, str) else ""})
    return {
        "id": version_id, "name": text(data.get("name"), 200),
        "base_model": text(data.get("baseModel"), 200),
        "description": text(data.get("description")),
        "trigger_words": [text(word, 500) for word in words[:64] if isinstance(word, str)] if isinstance(words, list) else [],
        "published_at": text(data.get("publishedAt"), 40),
        "images": images,
        "url": f"https://civitai.com/models/{model_id}?modelVersionId={version_id}",
    }


async def _lookup(path, cache_path, refresh, limit):
    async with limit:
        stamp = signature(path)
        cached = await asyncio.to_thread(read_cache, cache_path)
        digest = cached.get("sha256", "")
        same_file = cached.get("signature") == stamp and isinstance(digest, str) and len(digest) == 64 and all(char in "0123456789abcdef" for char in digest)
        result = cached.get("result")
        ttl = 86400 if isinstance(result, dict) and result.get("found") else 3600
        fetched = cached.get("fetched_at")
        stale = {**result, "cached": True, "fetched_at": fetched} if same_file and isinstance(result, dict) and isinstance(fetched, (int, float)) else None
        if same_file and not refresh and isinstance(result, dict) and isinstance(fetched, (int, float)) and 0 <= time.time() - fetched < ttl:
            return stale
        if time.monotonic() < RATE_LIMIT_UNTIL:
            if stale is not None:
                return stale
            raise LookupError("Civitai 请求过于频繁，请稍后重试", 429, "rate_limited")
        if not same_file:
            stamp, digest = await asyncio.to_thread(fingerprint, path)
        timeout = aiohttp.ClientTimeout(total=25, connect=10)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True, headers={"Accept": "application/json", "User-Agent": "ComfyUI-Radial-LoRA/0.1"}) as session:
            async def get(route):
                global RATE_LIMIT_UNTIL
                try:
                    return await fetch_json(session, route)
                except LookupError as error:
                    if error.status == 429:
                        RATE_LIMIT_UNTIL = time.monotonic() + RATE_LIMIT_SECONDS
                    raise

            try:
                version = await get("model-versions/by-hash/" + digest)
            except LookupError as error:
                if stale is not None and error.status in (429, 502, 504) and signature(path) == stamp:
                    return stale
                raise
            if version is None:
                result = {"found": False, "sha256": digest, "message": "未找到对应模型"}
            else:
                model_id = positive_id(version.get("modelId"))
                matched = version_info(version, model_id)
                warning = ""
                try:
                    model = await get(f"models/{model_id}")
                    if model is None:
                        warning = "版本已匹配，但模型详情当前不可用。"
                    elif model.get("id") != model_id:
                        raise LookupError("Civitai 模型详情标识不匹配")
                except LookupError as error:
                    if stale is not None and error.status in (429, 502, 504) and signature(path) == stamp:
                        return stale
                    model = None
                    warning = f"版本已匹配，完整介绍和其他版本暂未获取：{error}"
                model = model or {}
                versions = [matched]
                candidates = model.get("modelVersions", [])
                if isinstance(candidates, list):
                    seen = {matched["id"]}
                    for item in candidates[:100]:
                        if isinstance(item, dict) and type(item.get("id")) is int and item["id"] > 0 and item["id"] not in seen:
                            versions.append(version_info(item, model_id))
                            seen.add(item["id"])
                summary = version.get("model")
                result = {
                    "found": True, "sha256": digest, "model_id": model_id,
                    "model_name": text(model.get("name") or (summary.get("name") if isinstance(summary, dict) else ""), 200),
                    "description": text(model.get("description")),
                    "creator": text((model.get("creator") or {}).get("username"), 200) if isinstance(model.get("creator"), dict) else "",
                    "matched_version_id": matched["id"], "versions": versions,
                    "url": matched["url"], "warning": warning,
                }
        if signature(path) != stamp:
            raise LookupError("查询期间模型文件发生变化，请重试", 409, "file_changed")
        fetched = time.time()
        try:
            await asyncio.to_thread(write_cache, cache_path, {"schema": 2, "signature": stamp, "sha256": digest, "fetched_at": fetched, "result": result})
        except OSError:
            result = {**result, "cache_warning": "查询成功，但本地缓存无法写入。"}
        return {**result, "cached": False, "fetched_at": fetched}


async def lookup(path, cache_dir, refresh=False):
    path = Path(path).resolve()
    cache_path = Path(cache_dir).resolve() / (hashlib.sha256(str(path).encode()).hexdigest() + ".json")
    loop = asyncio.get_running_loop()
    limit, pending = LOOKUP_STATES.setdefault(loop, (asyncio.Semaphore(2), {}))
    key = (path, cache_path, refresh)
    task = pending.get(key)
    if task is not None and task.done():
        pending.pop(key, None)
        task = None
    if task is None:
        task = asyncio.create_task(_lookup(path, cache_path, refresh, limit))
        pending[key] = task

        def complete(done):
            if pending.get(key) is done:
                pending.pop(key)
            if not done.cancelled():
                done.exception()

        task.add_done_callback(complete)
    return await asyncio.shield(task)
