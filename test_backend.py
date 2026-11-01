"""No GPU/server required: python test_backend.py."""
import importlib.util
import asyncio
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, AsyncMock, patch
from PIL import Image

folder = types.ModuleType("folder_paths")
folder.get_system_user_directory = lambda _: str(Path(tempfile.gettempdir()) / 'radial-lora-test-no-config')
native = types.ModuleType("nodes")
native.LoraLoader = Mock()
routes = Mock()
routes.get.side_effect = lambda *_: lambda function: function
routes.post.side_effect = lambda *_: lambda function: function
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
sys.modules.update(folder_paths=folder, nodes=native, server=server)
spec = importlib.util.spec_from_file_location("radial", Path(__file__).with_name("__init__.py"))
radial = importlib.util.module_from_spec(spec)
sys.modules["radial"] = radial
spec.loader.exec_module(radial)


class BackendTest(unittest.TestCase):
    def test_thumbnail_keeps_source_and_handles_bad_cover(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / 'test.safetensors'
            model.touch()
            source = model.with_suffix('.png')
            Image.new('RGB', (2400, 1200), '#608a72').save(source)
            original = source.read_bytes()
            request = types.SimpleNamespace(query={'name': model.name, 'index': '0'})
            with patch.object(radial, 'lora_path', return_value=model), patch.object(radial, 'PATH_CONFIG', Path(tmp) / 'user' / 'paths.json'):
                response = asyncio.run(radial.get_thumbnail(request))
                self.assertEqual(response.status, 200)
                preview = response._path
                with Image.open(preview) as image:
                    self.assertEqual(image.format, 'WEBP')
                    self.assertLessEqual(max(image.size), 1024)
                self.assertEqual(source.read_bytes(), original)
                cached_at = preview.stat().st_mtime_ns
                self.assertEqual(asyncio.run(radial.get_thumbnail(request))._path.stat().st_mtime_ns, cached_at)
                source.write_bytes(b'broken image')
                bad = asyncio.run(radial.get_thumbnail(request))
                self.assertEqual(bad.status, 422)
                self.assertIn('封面图片损坏', json.loads(bad.text)['error'])

    def test_display_name_preserves_node_type(self):
        self.assertEqual(radial.NODE_DISPLAY_NAME_MAPPINGS['RadialLoraStack'], 'LoRA 轮盘 · LoRA Wheel')

    def test_translation_route(self):
        request = types.SimpleNamespace(headers={'Origin': 'http://localhost:8188'}, host='localhost:8188', content_type='application/json', json=AsyncMock(return_value={'text': 'Hello'}))
        with patch.dict(os.environ, {'RADIAL_LORA_TRANSLATE_URL': ''}):
            self.assertEqual(asyncio.run(radial.translate_description(request)).status, 503)
        request.json = AsyncMock(return_value={'text': ''})
        self.assertEqual(asyncio.run(radial.translate_description(request)).status, 400)
        request.headers['Origin'] = 'http://other.example'
        with self.assertRaises(radial.web.HTTPForbidden): asyncio.run(radial.translate_description(request))
        request.headers['Origin'] = 'http://localhost:8188'
        request.json = AsyncMock(return_value={'text': 'Hello'})

        class Response:
            status = 200
            content = None

            async def __aenter__(self): return self
            async def __aexit__(self, *args): return False
            async def iter_chunked(self, _): yield b'{"translatedText":"\xe4\xbd\xa0\xe5\xa5\xbd"}'

        response = Response()
        response.content = response

        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return False
            def post(self, url, json, allow_redirects):
                self.url, self.payload, self.redirects = url, json, allow_redirects
                return response

        session = Session()
        with patch.dict(os.environ, {'RADIAL_LORA_TRANSLATE_URL': 'https://translate.example', 'RADIAL_LORA_TRANSLATE_KEY': 'secret'}), patch.object(radial.aiohttp, 'ClientSession', return_value=session):
            result = asyncio.run(radial.translate_description(request))
        self.assertEqual(json.loads(result.text), {'text': '你好'})
        self.assertEqual(session.url, 'https://translate.example/translate')
        self.assertEqual(session.payload['api_key'], 'secret')
        self.assertFalse(session.redirects)

    def test_civitai_route(self):
        request = types.SimpleNamespace(headers={'Origin': 'http://localhost:8188'}, host='localhost:8188', content_type='application/json', json=AsyncMock(return_value={'name': 'a.safetensors'}))
        with patch.object(radial, 'lora_path', return_value=Path('a.safetensors')), patch.object(radial.civitai, 'lookup', new=AsyncMock(return_value={'found': False})) as lookup:
            self.assertEqual(asyncio.run(radial.identify_civitai(request)).status, 200)
            lookup.assert_awaited_once()
            request.json = AsyncMock(return_value={'name': 'a', 'refresh': 'yes'})
            self.assertEqual(asyncio.run(radial.identify_civitai(request)).status, 400)
            request.json = AsyncMock(return_value={'name': 'a'})
            lookup.side_effect = radial.civitai.LookupError('limited', 429, 'rate_limited')
            self.assertEqual(asyncio.run(radial.identify_civitai(request)).status, 429)
            request.headers['Origin'] = 'http://untrusted.example'
            with self.assertRaises(radial.web.HTTPForbidden): asyncio.run(radial.identify_civitai(request))

    def test_download_route_removed(self):
        self.assertNotIn('/radial-lora/download', [call.args[0] for call in routes.post.call_args_list])
        self.assertNotIn('/radial-lora/cover', [call.args[0] for call in routes.get.call_args_list])

    def test_mutating_routes_require_origin(self):
        request = types.SimpleNamespace(headers={}, host='localhost:8188')
        for route in (radial.set_paths, radial.set_site, radial.identify_civitai, radial.translate_description):
            with self.subTest(route=route.__name__), self.assertRaises(radial.web.HTTPForbidden):
                asyncio.run(route(request))

    def test_site_route_roundtrip(self):
        request = types.SimpleNamespace(headers={'Origin': 'http://localhost:8188'}, host='localhost:8188', content_type='application/json', json=AsyncMock(return_value={'site': 'https://civitai.example'}))
        with tempfile.TemporaryDirectory() as tmp, patch.object(radial, 'SITE_CONFIG', Path(tmp) / 'site.json'):
            try:
                self.assertEqual(json.loads(asyncio.run(radial.get_site(types.SimpleNamespace())).text)['site'], radial.civitai.DEFAULT_SITE)
                response = asyncio.run(radial.set_site(request))
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.text)['site'], 'https://civitai.example')
                self.assertEqual(json.loads(radial.SITE_CONFIG.read_text(encoding='utf-8'))['site'], 'https://civitai.example')
                request.json = AsyncMock(return_value={'site': 'http://not-local.example'})
                self.assertEqual(asyncio.run(radial.set_site(request)).status, 400)
                request.json = AsyncMock(return_value={'site': 'http://127.0.0.1:8000'})
                self.assertEqual(asyncio.run(radial.set_site(request)).status, 200)
                request.json = AsyncMock(return_value={})
                self.assertEqual(asyncio.run(radial.set_site(request)).status, 400)
                request.headers['Origin'] = 'http://untrusted.example'
                with self.assertRaises(radial.web.HTTPForbidden): asyncio.run(radial.set_site(request))
            finally:
                radial.civitai.set_site(radial.civitai.DEFAULT_SITE)

    def test_extra_paths_preserve_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'default'; base.mkdir()
            extra = Path(tmp) / 'extra'; extra.mkdir()
            other = Path(tmp) / 'other'; other.mkdir()
            folder.folder_names_and_paths = {'loras': ([str(base), str(other)], {'.safetensors'})}
            folder.filename_list_cache = {'loras': 'stale'}
            folder.add_model_folder_path = lambda _, path: folder.folder_names_and_paths['loras'][0].append(path)
            folder.get_folder_paths = lambda _: folder.folder_names_and_paths['loras'][0][:]
            original_config = radial.PATH_CONFIG
            radial.PATH_CONFIG = Path(tmp) / 'config' / 'paths.json'
            try:
                radial.apply_paths([str(extra), str(extra), str(base)], persist=True)
                self.assertEqual(folder.get_folder_paths('loras'), [str(base), str(other), str(extra)])
                self.assertNotIn('loras', folder.filename_list_cache)
                self.assertEqual(json.loads(radial.PATH_CONFIG.read_text())['extra_paths'], [str(extra), str(base)])
                with self.assertRaises(ValueError): radial.apply_paths([str(Path(tmp) / 'missing')], persist=True)
                self.assertEqual(folder.get_folder_paths('loras')[-1], str(extra))
                radial.apply_paths([], persist=True)
                self.assertEqual(folder.get_folder_paths('loras'), [str(base), str(other)])
                with self.assertRaises(ValueError): radial.validate_paths(['relative/path'])
                server.PromptServer.instance.prompt_queue = Mock()
                server.PromptServer.instance.prompt_queue.get_current_queue.return_value = ([], [])
                request = types.SimpleNamespace(headers={'Origin': 'http://localhost:8188'}, host='localhost:8188', content_type='application/json', json=AsyncMock(return_value={'extra_paths': [str(extra)]}))
                response = asyncio.run(radial.set_paths(request))
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.text)['effective_paths'], [str(base), str(other), str(extra)])
                server.PromptServer.instance.prompt_queue.get_current_queue.return_value = ([1], [])
                request.json = AsyncMock(return_value={'extra_paths': []})
                self.assertEqual(asyncio.run(radial.set_paths(request)).status, 409)
                self.assertEqual(radial._extra_paths, [str(extra)])
                request.headers['Origin'] = 'http://untrusted.example'
                with self.assertRaises(radial.web.HTTPForbidden): asyncio.run(radial.set_paths(request))
                radial.apply_paths([], persist=True)
            finally:
                radial.PATH_CONFIG = original_config

    def test_cache_trim_keeps_newest(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for index in range(5):
                item = directory / f"{index}.webp"
                item.write_bytes(b"x" * 10)
                os.utime(item, (index + 1, index + 1))
            radial.trim_cache(directory, 10 ** 9, 2)
            self.assertEqual([item.name for item in sorted(directory.iterdir())], ["3.webp", "4.webp"])

    def test_selection_and_native_chain(self):
        folder.get_filename_list = lambda _: ["a.safetensors", "b.safetensors"]
        folder.get_full_path_or_raise = lambda _, name: name
        native.LoraLoader.reset_mock()
        native.LoraLoader.return_value.load_lora.side_effect = [("m1", "c1"), ("m2", "c2")]
        stack = radial.RadialLoraStack()
        self.assertEqual(stack.apply("m0", "[]", "c0"), ("m0", "c0"))
        selection = json.dumps([{"name": "a.safetensors", "strength_model": .6}, {"name": "b.safetensors", "strength_clip": .2}])
        self.assertEqual(stack.apply("m0", selection, "c0"), ("m2", "c2"))
        self.assertEqual(native.LoraLoader.return_value.load_lora.call_args_list[1].args, ("m1", "c1", "b.safetensors", 1.0, .2))
        native.LoraLoader.return_value.load_lora.side_effect = [("m1", None)]
        stack.apply("m0", '[{"name":"a.safetensors"}]')
        self.assertEqual(native.LoraLoader.return_value.load_lora.call_args.args[-1], 0)
        for invalid in ['{}', '[{"name":"../secret"}]', '[{"name":"a.safetensors","strength_model":NaN}]', '[{"name":"a.safetensors","strength_clip":true}]', '[{"name":"a.safetensors"},{"name":"a.safetensors"}]']:
            with self.assertRaises(ValueError):
                radial.parse_selection(invalid)

    def test_metadata_and_covers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.safetensors"
            header = json.dumps({"__metadata__": {"ss_network_dim": "16"}}).encode()
            path.write_bytes(struct.pack("<Q", len(header)) + header)
            path.with_suffix(".json").write_text(json.dumps({"version": {"trainedWords": ["style token"], "baseModel": "Anima"}}))
            for name in ["test.png", "test.2.webp", "test.preview.jpg", "test-other.png"]:
                (Path(tmp) / name).touch()
            self.assertEqual(len(radial.covers(path)), 3)
            data = radial.metadata(path)
            self.assertEqual(data["trigger_words"], ["style token"])
            self.assertEqual(data["base_model"], "Anima")
            self.assertEqual(data["metadata"]["ss_network_dim"], "16")


if __name__ == "__main__":
    unittest.main()
