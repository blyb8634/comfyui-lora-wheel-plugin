import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import ANY, AsyncMock, patch

import civitai


class TestCivitai(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        civitai.RATE_LIMIT_UNTIL = 0
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.model = self.root / "model.safetensors"
        self.cache = self.root / "cache"
        self.model.write_bytes(b"model contents")

    def tearDown(self):
        self.temp_dir.cleanup()

    async def lookup(self, fetch_json, **kwargs):
        with patch.object(civitai, "fetch_json", new=AsyncMock(side_effect=fetch_json)) as mocked:
            result = await civitai.lookup(self.model, self.cache, **kwargs)
        return result, mocked

    async def test_hash_matches_hashlib(self):
        expected = hashlib.sha256(self.model.read_bytes()).hexdigest()
        result, mocked = await self.lookup([None])
        self.assertEqual(result["sha256"], expected)
        mocked.assert_awaited_once_with(ANY, "model-versions/by-hash/" + expected)

    async def test_cache_hit_does_not_fetch_again(self):
        with patch.object(civitai, "fetch_json", new=AsyncMock(return_value=None)) as fetch:
            first = await civitai.lookup(self.model, self.cache)
            second = await civitai.lookup(self.model, self.cache)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        fetch.assert_awaited_once()

    async def test_refresh_bypasses_result_cache(self):
        with patch.object(civitai, "fetch_json", new=AsyncMock(return_value=None)) as fetch:
            await civitai.lookup(self.model, self.cache)
            refreshed = await civitai.lookup(self.model, self.cache, refresh=True)
        self.assertFalse(refreshed["cached"])
        self.assertEqual(fetch.await_count, 2)

    async def test_file_change_invalidates_cache(self):
        with patch.object(civitai, "fetch_json", new=AsyncMock(return_value=None)) as fetch:
            first = await civitai.lookup(self.model, self.cache)
            self.model.write_bytes(b"changed model contents")
            second = await civitai.lookup(self.model, self.cache)
        self.assertNotEqual(first["sha256"], second["sha256"])
        self.assertEqual(fetch.await_count, 2)

    async def test_html_and_plaintext_are_safely_converted(self):
        version = {
            "id": 7,
            "modelId": 42,
            "name": "<b>Version</b>",
            "baseModel": "SDXL",
            "description": "<p>Hello <b>world</b></p><script>bad()</script>",
            "trainedWords": ["<i>trigger</i>"],
            "publishedAt": "2024-01-01",
            "images": [
                {"url": "https://image.civitai.com/safe.png", "type": "image", "meta": {"prompt": "<lora:style:0.8>, vivid", "negativePrompt": "blur"}},
                {"url": "https://image.civitai.com.evil.test/file.png"},
                {"url": "javascript:alert(1)"},
                {"url": "https://image.civitai.com/video.mp4", "type": "video"},
            ],
        }
        model = {"id": 42, "name": "<h1>Model</h1>", "description": "<div>Desc</div>", "creator": {"username": "Example"}}
        result, mocked = await self.lookup([version, model])
        self.assertEqual(result["model_name"], "Model")
        self.assertEqual(result["description"], "Desc")
        self.assertEqual(result["versions"][0]["description"], "Hello world")
        self.assertEqual(result["versions"][0]["trigger_words"], ["trigger"])
        self.assertEqual(result["creator"], "Example")
        self.assertEqual(result["versions"][0]["images"], [{"url": "https://image.civitai.com/safe.png", "prompt": "<lora:style:0.8>, vivid", "negative_prompt": "blur"}])
        self.assertEqual(mocked.await_count, 2)

    async def test_notfound_result_is_cached(self):
        with patch.object(civitai, "fetch_json", new=AsyncMock(return_value=None)) as fetch:
            first = await civitai.lookup(self.model, self.cache)
            second = await civitai.lookup(self.model, self.cache)
        self.assertFalse(first["found"])
        self.assertEqual(first["message"], "未找到对应模型")
        self.assertTrue(second["cached"])
        fetch.assert_awaited_once()

    async def test_model_details_failure_returns_partial_result(self):
        version = {"id": 7, "modelId": 42, "name": "Version", "trainedWords": []}
        failure = civitai.LookupError("details unavailable", 502, "network_error")
        result, mocked = await self.lookup([version, failure])
        self.assertTrue(result["found"])
        self.assertEqual(result["model_id"], 42)
        self.assertEqual(result["matched_version_id"], 7)
        self.assertIn("details unavailable", result["warning"])
        self.assertEqual(mocked.await_count, 2)

    async def test_corrupt_cache_is_ignored(self):
        cache_path = self.cache / (hashlib.sha256(str(self.model.resolve()).encode()).hexdigest() + ".json")
        cache_path.parent.mkdir()
        cache_path.write_text("not json", encoding="utf-8")
        with patch.object(civitai, "fetch_json", new=AsyncMock(return_value=None)) as fetch:
            result = await civitai.lookup(self.model, self.cache)
        self.assertFalse(result["cached"])
        fetch.assert_awaited_once()

    async def test_concurrent_same_lookup_shares_refresh(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow(*args):
            entered.set()
            await release.wait()
            return None

        with patch.object(civitai, "fetch_json", new=AsyncMock(side_effect=slow)) as fetch:
            first = asyncio.create_task(civitai.lookup(self.model, self.cache, refresh=True))
            await asyncio.wait_for(entered.wait(), 1)
            second = asyncio.create_task(civitai.lookup(self.model, self.cache, refresh=True))
            await asyncio.sleep(0)
            release.set()
            one, two = await asyncio.gather(first, second)
        self.assertEqual(one, two)
        self.assertFalse(one["cached"])
        fetch.assert_awaited_once()

    async def test_distinct_lookups_run_at_most_two_at_once(self):
        paths = [self.model, self.root / "second.safetensors", self.root / "third.safetensors"]
        for path in paths[1:]:
            path.write_bytes(path.name.encode())
        two_started, release = asyncio.Event(), asyncio.Event()
        active = peak = 0

        async def slow(*args):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            if active == 2:
                two_started.set()
            await release.wait()
            active -= 1
            return None

        with patch.object(civitai, "fetch_json", new=AsyncMock(side_effect=slow)) as fetch:
            tasks = [asyncio.create_task(civitai.lookup(path, self.cache)) for path in paths]
            await asyncio.wait_for(two_started.wait(), 1)
            await asyncio.sleep(0.05)
            self.assertEqual(fetch.await_count, 2)
            release.set()
            await asyncio.gather(*tasks)
        self.assertEqual(fetch.await_count, 3)
        self.assertEqual(peak, 2)

    async def test_cancelled_waiter_does_not_cancel_shared_lookup(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow(*args):
            entered.set()
            await release.wait()
            return None

        with patch.object(civitai, "fetch_json", new=AsyncMock(side_effect=slow)) as fetch:
            first = asyncio.create_task(civitai.lookup(self.model, self.cache))
            await asyncio.wait_for(entered.wait(), 1)
            second = asyncio.create_task(civitai.lookup(self.model, self.cache))
            await asyncio.sleep(0)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            result = await second
        self.assertFalse(result["cached"])
        fetch.assert_awaited_once()

    async def test_expired_cache_survives_network_failure(self):
        first, _ = await self.lookup([None])
        cache_path = self.cache / (hashlib.sha256(str(self.model.resolve()).encode()).hexdigest() + ".json")
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        cached["fetched_at"] -= 7200
        cache_path.write_text(json.dumps(cached), encoding="utf-8")
        failure = civitai.LookupError("offline", 502, "network_error")
        fallback, fetch = await self.lookup([failure])
        self.assertEqual(fallback, {**first, "cached": True, "fetched_at": cached["fetched_at"]})
        fetch.assert_awaited_once()

    async def test_rate_limit_uses_cache_and_starts_cooldown(self):
        first, _ = await self.lookup([None])
        limited = civitai.LookupError("limited", 429, "rate_limited")
        with patch.object(civitai, "fetch_json", new=AsyncMock(side_effect=limited)) as fetch:
            fallback = await civitai.lookup(self.model, self.cache, refresh=True)
            again = await civitai.lookup(self.model, self.cache, refresh=True)
            other = self.root / "other.safetensors"
            other.write_bytes(b"other")
            with self.assertRaises(civitai.LookupError) as raised:
                await civitai.lookup(other, self.cache)
        self.assertEqual(fallback["sha256"], first["sha256"])
        self.assertTrue(fallback["cached"])
        self.assertEqual(again, fallback)
        self.assertEqual(raised.exception.code, "rate_limited")
        fetch.assert_awaited_once()

    async def test_cached_full_details_survive_details_outage(self):
        version = {"id": 7, "modelId": 42, "name": "Version"}
        model = {"id": 42, "name": "Full model", "description": "Description"}
        first, _ = await self.lookup([version, model])
        offline = civitai.LookupError("offline", 502, "network_error")
        fallback, fetch = await self.lookup([version, offline], refresh=True)
        self.assertEqual(fallback, {**first, "cached": True})
        self.assertEqual(fetch.await_count, 2)


class TestFetchJson(unittest.IsolatedAsyncioTestCase):
    class Response:
        def __init__(self, status):
            self.status = status

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    class Session:
        def __init__(self, response=None, error=None):
            self.response = response
            self.error = error

        def get(self, *args, **kwargs):
            if self.error:
                return self.error
            return self.response

    async def assert_error(self, session, status, code):
        with self.assertRaises(civitai.LookupError) as raised:
            await civitai.fetch_json(session, "route")
        self.assertEqual(raised.exception.status, status)
        self.assertEqual(raised.exception.code, code)

    async def test_429_and_403(self):
        await self.assert_error(self.Session(self.Response(429)), 429, "rate_limited")
        await self.assert_error(self.Session(self.Response(403)), 403, "access_denied")

    async def test_timeout(self):
        class TimeoutContext:
            async def __aenter__(self):
                raise asyncio.TimeoutError()

            async def __aexit__(self, *args):
                return False

        await self.assert_error(self.Session(error=TimeoutContext()), 504, "timeout")


if __name__ == "__main__":
    unittest.main()
