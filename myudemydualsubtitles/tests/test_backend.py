"""Regression tests for translation jobs and the local HTTP trust boundary."""

import json
from pathlib import Path
import tempfile
import threading
import unittest
import subprocess
from unittest.mock import patch

from backend.app import create_app
from backend.codex_translate import translate_batch, validate_result
from backend.jobs import TranslationJobs


EXTENSION_ID = "a" * 32
POLICY = {"model": "test", "prompt_version": 1}


def payload(text="Hello"):
    """Build one bounded, timestamped cue."""
    return {
        "source_language": "en",
        "cues": [
            {"start": 1.005, "end": 3.09, "text": text},
        ],
    }


class BackendTests(unittest.TestCase):
    """Exercise actual API and worker behavior without consuming model
    quota.
    """

    def setUp(self):
        """Keep each test's cache isolated."""
        self.temporary = tempfile.TemporaryDirectory()
        self.calls = []

        def translator(batch, context, language, policy):
            """Return deterministic translations and count model requests."""
            self.calls.append(batch)
            return ["你好" for item in batch]

        self.jobs = TranslationJobs(self.temporary.name, POLICY, translator)
        self.client = create_app(EXTENSION_ID, self.jobs).test_client()
        self.headers = {
            "X-MyUdemy-Extension": EXTENSION_ID,
            "Origin": f"chrome-extension://{EXTENSION_ID}",
        }

    def tearDown(self):
        """Wait for worker writes before removing test-owned temporary
        files.
        """
        self.jobs.pending.join()
        self.temporary.cleanup()

    def post(self, path, data):
        """Use the same loopback host and headers as the extension worker."""
        return self.client.post(
            path,
            json=data,
            base_url="http://127.0.0.1:8765",
            headers=self.headers,
        )

    def test_cache_and_completed_result(self):
        """Repeated source content and restart both reuse completed
        translations.
        """
        first = self.post("/translations", payload()).get_json()
        self.jobs.pending.join()
        second = self.post("/translations", payload())
        self.assertEqual(second.status_code, 200)
        result = second.get_json()
        self.assertEqual(result["state"], "completed")
        self.assertEqual(
            result["cues"][0],
            {
                "start": 1.005,
                "end": 3.09,
                "text": "Hello\n你好",
            },
        )
        self.assertEqual(result["id"], first["id"])
        self.assertEqual(len(self.calls), 1)
        restarted = TranslationJobs(
            self.temporary.name, POLICY, self.jobs.translator
        )
        self.assertEqual(restarted.submit(payload())["state"], "completed")
        self.assertEqual(len(self.calls), 1)

    def test_duplicate_inflight_does_not_start_another_model_call(self):
        """Two submitters attach to the same queued/running task."""
        entered, release = threading.Event(), threading.Event()

        def translator(*args):
            """Hold the only worker while submitting a duplicate."""
            entered.set()
            release.wait(2)
            return ["你好"]

        self.jobs.translator = translator
        first = self.jobs.submit(payload())
        entered.wait(2)
        second = self.jobs.submit(payload())
        release.set()
        self.jobs.pending.join()
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.jobs.jobs), 1)

    def test_failed_batch_retries_only_remaining_cues(self):
        """Checkpointed prefix survives a later model error and explicit
        retry.
        """
        calls = []

        def translator(batch, *args):
            """Fail the second batch once."""
            calls.append([item["id"] for item in batch])
            if len(calls) == 2:
                raise RuntimeError("fixture failure")
            return ["翻译" for item in batch]

        self.jobs.translator = translator
        data = payload("x" * 4000)
        data["cues"].append({"start": 4, "end": 5, "text": "y" * 4000})
        first = self.jobs.submit(data)
        self.jobs.pending.join()
        self.assertEqual(self.jobs.status(first["id"])["done"], 1)
        self.assertEqual(self.jobs.status(first["id"])["state"], "failed")
        self.jobs.submit(data)
        self.assertEqual(len(calls), 2)
        self.jobs.retry(first["id"])
        self.jobs.pending.join()
        self.assertEqual(calls, [[0], [1], [1]])
        self.assertEqual(self.jobs.status(first["id"])["state"], "completed")

    def test_restart_marks_interrupted_work_failed(self):
        """Restart must not automatically replay a possibly already-billed
        request.
        """
        result = self.jobs.submit(payload())
        self.jobs.pending.join()
        path = Path(self.temporary.name) / f'{result["id"]}.json'
        data = json.loads(path.read_text())
        data["state"] = "running"
        path.write_text(json.dumps(data))
        restarted = TranslationJobs(
            self.temporary.name, POLICY, self.jobs.translator
        )
        self.assertEqual(restarted.status(result["id"])["state"], "failed")
        self.assertEqual(len(self.calls), 1)

    def test_reject_untrusted_or_invalid_requests(self):
        """Website origins and malformed cues never reach a model."""
        for headers, base in [
            ({}, "http://127.0.0.1:8765"),
            (
                {**self.headers, "Origin": "https://evil.test"},
                "http://127.0.0.1:8765",
            ),
            (self.headers, "http://evil.test:8765"),
        ]:
            response = self.client.post(
                "/translations", json=payload(), headers=headers, base_url=base
            )
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.post("/translations", None).status_code, 415)
        for data in [{}, payload(""), payload("x" * 6001)]:
            self.assertEqual(self.post("/translations", data).status_code, 400)
        self.assertEqual(self.calls, [])

    def test_checkpoint_failure_keeps_previous_prefix(self):
        """A failed save cannot mark an uncheckpointed translation
        completed.
        """
        save = self.jobs._save

        def fail_completion(job):
            """Simulate a full disk when committing a completed batch."""
            if job["state"] == "completed":
                raise OSError("disk full")
            save(job)

        with patch.object(self.jobs, "_save", fail_completion):
            result = self.jobs.submit(payload())
            self.jobs.pending.join()
        self.assertEqual(self.jobs.status(result["id"])["done"], 0)
        self.assertEqual(self.jobs.status(result["id"])["state"], "failed")

    def test_model_output_requires_exact_unique_ids(self):
        """Missing, repeated, unknown IDs and blank text cannot be cached."""
        for items in [
            [],
            [{"id": 1, "text": "错"}],
            [{"id": 0, "text": ""}],
            [{"id": True, "text": "错"}],
        ]:
            with self.assertRaises(ValueError):
                validate_result({"translations": items}, [0])
        self.assertEqual(
            validate_result(
                {
                    "translations": [
                        {"id": 1, "text": "二"},
                        {"id": 0, "text": "一"},
                    ]
                },
                [0, 1],
            ),
            ["一", "二"],
        )

    def test_policy_change_invalidates_cache(self):
        """Different prompts must not silently reuse old translations."""
        first = self.jobs.submit(payload())
        self.jobs.pending.join()
        self.jobs.policy = {**POLICY, "prompt_version": 2}
        second = self.jobs.submit(payload())
        self.jobs.pending.join()
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(self.calls), 2)

    def test_codex_command_keeps_provider_name_and_validates_output(self):
        """Lock down the provider override syntax verified by the real CLI."""
        commands = []

        def process(command, **kwargs):
            """Create the output file exactly where the CLI would write it."""
            commands.append(command)
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text(json.dumps({
                "translations": [{"id": 0, "text": "你好"}],
            }))
            from unittest.mock import Mock
            child = Mock(returncode=0)
            child.communicate.return_value = (None, "")
            return child

        policy = {"model": "gpt-6-luna", "effort": "low",
                  "provider": "example_provider", "provider_config": {
                      "name": "example", "requires_openai_auth": True,
                  }}
        with patch(
            "backend.codex_translate.shutil.which", return_value="codex",
        ):
            with patch("backend.codex_translate.subprocess.Popen", process):
                result = translate_batch(
                    [{"id": 0, "text": "Hello"}], [], "en", policy,
                )
        self.assertEqual(result, ["你好"])
        self.assertIn('model_providers.example_provider.name="example"',
                      commands[0])
        self.assertIn("--ignore-user-config", commands[0])
        self.assertIn("read-only", commands[0])

    def test_codex_timeout_terminates_process_group(self):
        """A timed-out batch must not leave a billing child process running."""
        from unittest.mock import Mock
        child = Mock(pid=1234, returncode=None)
        child.poll.return_value = None
        child.communicate.side_effect = [
            subprocess.TimeoutExpired("codex", 180), (None, ""),
        ]
        policy = {"model": "gpt-6-luna", "effort": "low",
                  "provider": "openai", "provider_config": {}}
        with patch(
            "backend.codex_translate.shutil.which", return_value="codex",
        ):
            with patch("backend.codex_translate.subprocess.Popen",
                       return_value=child):
                with patch("backend.codex_translate.os.killpg") as kill:
                    with self.assertRaisesRegex(RuntimeError, "180"):
                        translate_batch(
                            [{"id": 0, "text": "Hello"}], [], "en", policy,
                        )
                    kill.assert_called_once()

    def test_batch_schema_requires_every_requested_subtitle(self):
        """Constrain model output for a real-sized, nonzero-offset batch."""
        from unittest.mock import Mock
        captured = []
        batch = [{"id": index, "text": "fragment"}
                 for index in range(70, 104)]

        def process(command, **kwargs):
            """Capture the actual schema passed to the CLI."""
            schema = Path(command[command.index("--output-schema") + 1])
            captured.append(json.loads(schema.read_text()))
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text(json.dumps({"translations": [
                {"id": item["id"], "text": "片段"} for item in batch
            ]}))
            child = Mock(returncode=0)
            child.communicate.return_value = (None, "")
            return child

        policy = {"model": "gpt-6-luna", "effort": "low",
                  "provider": "openai", "provider_config": {}}
        with patch(
            "backend.codex_translate.shutil.which", return_value="codex",
        ):
            with patch("backend.codex_translate.subprocess.Popen", process):
                translated = translate_batch(batch, [], "en", policy)
        self.assertEqual(len(translated), 34)
        items = captured[0]["properties"]["translations"]
        self.assertEqual(items.get("minItems"), 34)
        self.assertEqual(items.get("maxItems"), 34)
        self.assertEqual(items["items"]["properties"]["id"].get("enum"),
                         list(range(70, 104)))

    def test_incomplete_result_reports_counts_without_subtitle_text(self):
        """Expose enough evidence for a leak-free diagnosis of dropped cues."""
        result = {"translations": [
            {"id": index, "text": "PRIVATE_SUBTITLE"} for index in range(33)
        ]}
        with self.assertLogs(
            "backend.codex_translate", level="WARNING",
        ) as logs:
            with self.assertRaisesRegex(ValueError, "预期 34 条.*实际 33 条"):
                validate_result(result, list(range(34)))
        logged = "\n".join(logs.output)
        self.assertIn("expected=34", logged)
        self.assertIn("actual=33", logged)
        self.assertIn("missing_ids=[33]", logged)
        self.assertNotIn("PRIVATE_SUBTITLE", logged)

    def test_worker_logs_correlate_model_validation_with_task(self):
        """Correlate task and validation logs without exposing content."""
        def incomplete(batch, *args):
            """Represent a model that omitted the only subtitle."""
            return validate_result({"translations": []}, [0])

        self.jobs.translator = incomplete
        with self.assertLogs("backend", level="INFO") as logs:
            job = self.jobs.submit(payload("PRIVATE_SOURCE"))
            self.jobs.pending.join()
        output = "\n".join(logs.output)
        self.assertIn(f'translation_result_invalid job={job["id"][:12]}',
                      output)
        self.assertIn("expected=1 actual=0", output)
        self.assertIn("translation_failed", output)
        self.assertNotIn("PRIVATE_SOURCE", output)


if __name__ == "__main__":
    unittest.main()
