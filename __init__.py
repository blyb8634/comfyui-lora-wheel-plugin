"""Local-only LoRA browser and a stack delegating to ComfyUI's native loader."""
import asyncio
import hashlib
import json
import math
import logging
import os
import struct
import tempfile
import warnings
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from PIL import Image, UnidentifiedImageError
import folder_paths
import nodes
from server import PromptServer
from . import civitai

WEB_DIRECTORY = "./web"
MAX_JSON = 8 * 1024 * 1024
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}
PATH_CONFIG = Path(folder_paths.get_system_user_directory("radial_lora")) / "paths.json"
_owned_paths = []
_extra_paths = []
_path_lock = asyncio.Lock()
_thumbnail_lock = asyncio.Lock()
MAX_COVER_BYTES = 256 * 1024 * 1024
MAX_COVER_PIXELS = 180_000_000


def validate_paths(paths, require_exists=True):
    if not isinstance(paths, list) or len(paths) > 16:
        raise ValueError("最多添加 16 个目录")
    result = []
    for value in paths:
        if not isinstance(value, str) or not value.strip() or len(value) > 4096:
            raise ValueError("目录必须是非空绝对路径")
        path = Path(value.strip()).expanduser()
        if not path.is_absolute() or (require_exists and not path.is_dir()):
            raise ValueError(f"目录不存在或不是绝对路径：{value}")
        path = path.resolve()
        if path not in [Path(existing) for existing in result]:
            result.append(str(path))
    return result


def apply_paths(paths, persist=False):
    global _owned_paths, _extra_paths
    paths = validate_paths(paths, require_exists=persist)
    if persist:
        PATH_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=PATH_CONFIG.parent, suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                json.dump({"extra_paths": paths}, stream, ensure_ascii=False, indent=2)
            os.replace(temporary, PATH_CONFIG)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    registered = folder_paths.folder_names_and_paths["loras"][0]
    # Remove only additions owned by this plugin; preserve all native/other paths.
    registered[:] = [path for path in registered if path not in _owned_paths]
    _owned_paths = []
    for path in paths:
        if Path(path) not in [Path(existing) for existing in registered]:
            folder_paths.add_model_folder_path("loras", path)
            _owned_paths.append(path)
    _extra_paths = paths
    folder_paths.filename_list_cache.pop("loras", None)


def path_state():
    return {"extra_paths": _extra_paths, "effective_paths": folder_paths.get_folder_paths("loras"), "missing_paths": [path for path in _extra_paths if not Path(path).is_dir()]}


if PATH_CONFIG.is_file():
    try:
        apply_paths(json.loads(PATH_CONFIG.read_text(encoding="utf-8"))["extra_paths"])
    except (OSError, ValueError, KeyError) as error:
        logging.warning("[Radial LoRA] Cannot load extra directories: %s", error)


@PromptServer.instance.routes.get("/radial-lora/paths")
async def get_paths(request):
    return web.json_response(path_state())


def require_same_origin(request):
    origin = urlsplit(request.headers.get("Origin", ""))
    if origin.scheme not in ("http", "https") or origin.netloc != request.host:
        raise web.HTTPForbidden(text="仅允许同源请求")


@PromptServer.instance.routes.post("/radial-lora/paths")
async def set_paths(request):
    require_same_origin(request)
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType()
    async with _path_lock:
        try:
            data = await request.json()
            paths = validate_paths(data.get("extra_paths") if isinstance(data, dict) else None)
            if paths != _extra_paths:
                running, pending = PromptServer.instance.prompt_queue.get_current_queue()
                if running or pending:
                    return web.json_response({"error": "请等当前队列完成后再修改模型目录"}, status=409)
                apply_paths(paths, persist=True)
            return web.json_response(path_state())
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)


def lora_path(name):
    # Only names enumerated by ComfyUI are accepted, never arbitrary client paths.
    if not isinstance(name, str) or name not in folder_paths.get_filename_list("loras"):
        raise ValueError("Unknown local LoRA")
    return Path(folder_paths.get_full_path_or_raise("loras", name))


def read_json(path):
    if path.is_file() and path.stat().st_size <= MAX_JSON:
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            return data if isinstance(data, dict) else {}
        except (ValueError, OSError):
            pass
    return {}


def covers(path):
    # Local adjacent artwork only; no remote fetching or writes to the model library.
    candidates = []
    for item in path.parent.iterdir():
        if item.suffix.lower() not in IMAGE_TYPES or not item.is_file():
            continue
        if item.stem == path.stem or item.name.startswith(path.stem + "."):
            if item.resolve().parent == path.parent.resolve():
                candidates.append(item)
    return sorted(candidates, key=lambda p: p.name.casefold())


def cover_thumbnail(source):
    """Cache a browser-sized copy outside the model library, leaving the source untouched."""
    stat = source.stat()
    if stat.st_size > MAX_COVER_BYTES:
        raise ValueError("封面文件过大，无法生成预览（上限 256 MB）")
    identity = f"{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}"
    target = PATH_CONFIG.parent / "covers" / (hashlib.sha256(identity.encode()).hexdigest() + ".webp")
    if target.is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        # Pillow warns above its default pixel threshold; our explicit limit handles it.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.width * image.height > MAX_COVER_PIXELS:
                    raise ValueError("封面分辨率过高，无法生成预览（上限 1.8 亿像素）")
                image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
                with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".webp", delete=False) as stream:
                    temporary = Path(stream.name)
                image.save(temporary, "WEBP", quality=82)
        os.replace(temporary, target)
        temporary = None
        return target
    except (UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ValueError("封面图片损坏或分辨率过高") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def metadata(path):
    meta = {}
    if path.suffix.lower() == ".safetensors":
        try:
            with path.open("rb") as stream:
                length = struct.unpack("<Q", stream.read(8))[0]
                if length <= MAX_JSON:
                    meta = json.loads(stream.read(length)).get("__metadata__", {})
                    if not isinstance(meta, dict):
                        meta = {}
        except (OSError, ValueError, struct.error):
            pass
    sidecar = read_json(path.with_suffix(".json"))
    civitai = read_json(path.with_suffix(".civitai.info"))
    rgthree = read_json(Path(str(path) + ".rgthree-info.json"))
    version = sidecar.get("version", {})
    version = version if isinstance(version, dict) else {}
    model_info = sidecar.get("model", {})
    model_info = model_info if isinstance(model_info, dict) else {}
    words = sidecar.get("trainedWords") or version.get("trainedWords") or civitai.get("trainedWords") or rgthree.get("trainedWords", [])
    if isinstance(words, str):
        words = [words]
    if not isinstance(words, list):
        words = []
    words = [word.get("word", "") if isinstance(word, dict) else word for word in words]
    if not words:
        trigger = meta.get("ss_trigger_words") or meta.get("trigger_words") or meta.get("activation text")
        if trigger:
            words = [str(trigger)]
    return {
        "base_model": str(sidecar.get("baseModel") or version.get("baseModel") or model_info.get("baseModel") or civitai.get("baseModel") or rgthree.get("baseModel") or meta.get("ss_base_model_version") or meta.get("modelspec.architecture") or "未知"),
        "trigger_words": [str(word)[:500] for word in words[:32]],
        "metadata": {str(k): str(v)[:2000] for k, v in meta.items() if k in {
            "ss_output_name", "ss_network_module", "ss_network_dim", "ss_network_alpha",
            "ss_base_model_version", "modelspec.title", "modelspec.description", "modelspec.architecture"
        }},
    }


def catalogue():
    result = []
    images_by_dir = {}
    for name in folder_paths.get_filename_list("loras"):
        try:
            path = Path(folder_paths.get_full_path_or_raise("loras", name))
            parent = path.parent
            if parent not in images_by_dir:
                root = parent.resolve()
                images_by_dir[parent] = [item for item in parent.iterdir() if item.suffix.lower() in IMAGE_TYPES and item.is_file() and item.resolve().parent == root]
            count = sum(item.stem == path.stem or item.name.startswith(path.stem + ".") for item in images_by_dir[parent])
            result.append({"name": name, "title": path.stem, "cover_count": count, "size_bytes": path.stat().st_size})
        except (OSError, ValueError):
            continue
    return result


@PromptServer.instance.routes.get("/radial-lora/catalog")
async def get_catalog(request):
    return web.json_response(await asyncio.to_thread(catalogue))


@PromptServer.instance.routes.post("/radial-lora/civitai")
async def identify_civitai(request):
    require_same_origin(request)
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType()
    try:
        data = await request.json()
        if not isinstance(data, dict) or type(data.get("refresh", False)) is not bool:
            raise ValueError("查询参数无效")
        path = lora_path(data.get("name"))
        async with asyncio.timeout(90):
            result = await civitai.lookup(path, PATH_CONFIG.parent / "civitai", data.get("refresh", False))
        return web.json_response(result)
    except civitai.LookupError as error:
        return web.json_response({"error": str(error), "code": error.code}, status=error.status)
    except asyncio.TimeoutError:
        return web.json_response({"error": "查询耗时过长，请稍后重试", "code": "timeout"}, status=504)
    except (ValueError, OSError):
        return web.json_response({"error": "本地 LoRA 不存在、不可读或请求参数无效", "code": "invalid_local_file"}, status=400)


@PromptServer.instance.routes.post("/radial-lora/translate")
async def translate_description(request):
    require_same_origin(request)
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType()
    try:
        data = await request.json()
        source = data.get("text") if isinstance(data, dict) else None
        if not isinstance(source, str) or not source.strip() or len(source) > 12000:
            raise ValueError()
    except (ValueError, web.HTTPBadRequest):
        return web.json_response({"error": "介绍文字无效（最多 12000 字）"}, status=400)
    endpoint = os.environ.get("RADIAL_LORA_TRANSLATE_URL", "").strip().rstrip("/")
    if not endpoint:
        return web.json_response({"error": "未配置服务端翻译"}, status=503)
    if not endpoint.endswith("/translate"):
        endpoint += "/translate"
    try:
        parsed = urlsplit(endpoint)
        valid = parsed.hostname and not (parsed.username or parsed.password or parsed.query or parsed.fragment) and (
            parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"})
        )
    except ValueError:
        valid = False
    if not valid:
        return web.json_response({"error": "翻译服务须使用 HTTPS 或本机 HTTP"}, status=503)
    payload = {"q": source, "source": "auto", "target": "zh"}
    key = os.environ.get("RADIAL_LORA_TRANSLATE_KEY")
    if key:
        payload["api_key"] = key
    try:
        timeout = aiohttp.ClientTimeout(total=30, connect=10)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.post(endpoint, json=payload, allow_redirects=False) as response:
                if response.status != 200:
                    return web.json_response({"error": f"翻译服务不可用（HTTP {response.status}）"}, status=429 if response.status == 429 else 502)
                raw = bytearray()
                async for chunk in response.content.iter_chunked(8192):
                    raw.extend(chunk)
                    if len(raw) > 65536:
                        raise ValueError("翻译结果过大")
                result = json.loads(raw)
                translated = result.get("translatedText") if isinstance(result, dict) else None
                if not isinstance(translated, str) or not translated:
                    raise ValueError("翻译结果无效")
                return web.json_response({"text": translated[:24000]})
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
        logging.warning("[Radial LoRA] Translation failed: %s", error)
        return web.json_response({"error": "翻译服务暂不可用"}, status=502)


@PromptServer.instance.routes.get("/radial-lora/info")
async def get_info(request):
    try:
        path = lora_path(request.query.get("name"))
        return web.json_response(await asyncio.to_thread(metadata, path))
    except (ValueError, OSError):
        raise web.HTTPNotFound()


@PromptServer.instance.routes.get("/radial-lora/thumbnail")
async def get_thumbnail(request):
    try:
        path = lora_path(request.query.get("name"))
        index = int(request.query.get("index", "0"))
        images = await asyncio.to_thread(covers, path)
        if index < 0 or index >= len(images):
            raise web.HTTPNotFound()
        source = images[index]
    except (ValueError, OSError):
        raise web.HTTPNotFound()
    try:
        async with _thumbnail_lock:
            preview = await asyncio.to_thread(cover_thumbnail, source)
        return web.FileResponse(preview, headers={"X-Content-Type-Options": "nosniff", "Content-Type": "image/webp"})
    except (ValueError, OSError) as error:
        return web.json_response({"error": str(error) or "封面不可用"}, status=422)


def parse_selection(value):
    if not isinstance(value, str) or len(value) > 65536:
        raise ValueError("LoRA selection must be JSON text (max 64KB)")
    selected = json.loads(value)
    if not isinstance(selected, list) or len(selected) > 32:
        raise ValueError("Select at most 32 LoRAs")
    seen = set()
    for item in selected:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("Each selection needs a LoRA name")
        lora_path(item["name"])
        if item["name"] in seen:
            raise ValueError("Duplicate LoRA selection")
        seen.add(item["name"])
        for key in ("strength_model", "strength_clip"):
            strength = item.get(key, 1.0)
            if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(strength) or not -100 <= strength <= 100:
                raise ValueError("LoRA strengths must be finite numbers between -100 and 100")
            item[key] = float(strength)
    return selected


class RadialLoraStack:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "selection": ("RADIAL_LORA_SELECTION", {"default": "[]"})}, "optional": {"clip": ("CLIP",)}}

    RETURN_TYPES = ("MODEL", "CLIP")
    FUNCTION = "apply"
    CATEGORY = "loaders/LoRA"
    DESCRIPTION = "Open the radial wheel to equip LoRAs. Applied in selection order using the native loader. Empty selection passes through. CLIP is optional for model-only workflows."

    @classmethod
    def VALIDATE_INPUTS(cls, selection):
        try:
            parse_selection(selection)
            return True
        except (ValueError, OSError) as exc:
            return str(exc)

    @classmethod
    def IS_CHANGED(cls, selection, **kwargs):
        return [(item["name"], lora_path(item["name"]).stat().st_mtime_ns) for item in parse_selection(selection)]

    def apply(self, model, selection, clip=None):
        for item in parse_selection(selection):
            model, clip = nodes.LoraLoader().load_lora(model, clip, item["name"], item["strength_model"], item["strength_clip"] if clip is not None else 0)
        return model, clip


NODE_CLASS_MAPPINGS = {"RadialLoraStack": RadialLoraStack}
NODE_DISPLAY_NAME_MAPPINGS = {"RadialLoraStack": "LoRA 轮盘 · LoRA Wheel"}
