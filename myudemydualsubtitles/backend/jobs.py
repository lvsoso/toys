"""Single-worker translation jobs with atomic checkpoints and explicit
retries.
"""

import copy
import hashlib
import json
import logging
import math
from pathlib import Path
import queue
import re
import threading
import time

from .codex_translate import BATCH_CHARS, LOG_JOB, translate_batch


LOGGER = logging.getLogger(__name__)
SENTENCE_END = re.compile(r"[.!?…。！？][\"'”’)\]]*\s*$")


def validate_payload(payload):
    """Validate the browser boundary before caching or invoking a model."""
    if not isinstance(payload, dict):
        raise ValueError("请求必须是 JSON 对象。")
    language = payload.get("source_language")
    cues = payload.get("cues")
    if not isinstance(language, str) or not 1 <= len(language) <= 40:
        raise ValueError("原字幕语言无效。")
    if not isinstance(cues, list) or not 1 <= len(cues) <= 10000:
        raise ValueError("字幕条数必须在 1–10000 之间。")
    normalized = []
    for cue in cues:
        if not isinstance(cue, dict):
            raise ValueError("字幕条目格式无效。")
        start, end, text = cue.get("start"), cue.get("end"), cue.get("text")
        if (
            any(
                type(value) not in (int, float) or not math.isfinite(value)
                for value in (start, end)
            )
            or not 0 <= start < end <= 360000
        ):
            raise ValueError("字幕时间轴无效。")
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > BATCH_CHARS
        ):
            raise ValueError("字幕文本为空或单条过长。")
        normalized.append({"start": start, "end": end, "text": text})
    if (
        len(json.dumps(normalized, ensure_ascii=False).encode())
        > 2 * 1024 * 1024
    ):
        raise ValueError("字幕数据超过 2 MiB。")
    return {
        "source_language": language,
        "target_language": "zh-CN",
        "cues": normalized,
    }


class TranslationJobs:
    """Keep transitions serialized, while a single daemon worker calls
    Codex.
    """

    def __init__(self, directory, policy, translator=translate_batch):
        """Recover interrupted jobs as failed; never auto-replay paid work."""
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.policy = policy
        self.translator = translator
        self.lock = threading.RLock()
        self.pending = queue.Queue()
        self.jobs = {}
        for path in self.directory.glob("*.json"):
            job = json.loads(path.read_text(encoding="utf-8"))
            if job["state"] in ("queued", "running"):
                job.update(
                    state="failed",
                    error="后端已重启；已完成批次保留，请手动重试。",
                )
                self._save(job)
                LOGGER.warning(
                    "task_interrupted job=%s done=%d total=%d",
                    job["id"][:12], len(job["translations"]),
                    len(job["cues"]),
                )
            self.jobs[job["id"]] = job
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()

    def _save(self, job):
        """Atomically replace a checkpoint; do not expose half-written
        cache files.
        """
        path = self.directory / f'{job["id"]}.json'
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(job, ensure_ascii=False), encoding="utf-8"
        )
        temporary.replace(path)

    def submit(self, payload):
        """Deduplicate running and completed jobs by content and
        translation policy.
        """
        normalized = validate_payload(payload)
        identity = {**normalized, "policy": self.policy}
        job_id = hashlib.sha256(
            json.dumps(
                identity,
                sort_keys=True,
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        with self.lock:
            if job_id not in self.jobs:
                if (
                    sum(
                        job["state"] in ("queued", "running")
                        for job in self.jobs.values()
                    )
                    >= 8
                ):
                    raise ValueError("等待任务已满，请完成现有任务后再提交。")
                job = {
                    **identity,
                    "id": job_id,
                    "state": "queued",
                    "translations": [],
                    "error": "",
                    "elapsed_seconds": 0,
                }
                self._save(job)
                self.jobs[job_id] = job
                self.pending.put(job_id)
                LOGGER.info(
                    "task_created job=%s total=%d model=%s",
                    job_id[:12], len(job["cues"]), self.policy["model"],
                )
            else:
                job = self.jobs[job_id]
                LOGGER.info(
                    "%s job=%s state=%s done=%d total=%d",
                    "cache_hit" if job["state"] == "completed"
                    else "task_reused", job_id[:12], job["state"],
                    len(job["translations"]), len(job["cues"]),
                )
            return self.status(job_id)

    def status(self, job_id):
        """Return progress plus validated bilingual cues for completed
        batches only.
        """
        with self.lock:
            job = self.jobs[job_id]
            translated = job["translations"]
            return {
                "id": job_id,
                "state": job["state"],
                "error": job["error"],
                "done": len(translated),
                "total": len(job["cues"]),
                "elapsed_seconds": job["elapsed_seconds"],
                "cues": [
                    {
                        "start": cue["start"],
                        "end": cue["end"],
                        "text": cue["text"] + "\n" + text,
                    }
                    for cue, text in zip(job["cues"], translated)
                ],
            }

    def retry(self, job_id):
        """Resume only failed jobs and retain all validated prefix batches."""
        with self.lock:
            job = self.jobs[job_id]
            if job["state"] == "failed":
                previous = copy.deepcopy(job)
                job.update(state="queued", error="")
                try:
                    self._save(job)
                except OSError:
                    self.jobs[job_id] = previous
                    raise
                self.pending.put(job_id)
                LOGGER.info(
                    "task_retry job=%s done=%d remaining=%d",
                    job_id[:12], len(job["translations"]),
                    len(job["cues"]) - len(job["translations"]),
                )
            return self.status(job_id)

    def _work(self):
        """Consume jobs sequentially; failures terminate a job until
        explicit retry.
        """
        while True:
            job_id = self.pending.get()
            log_token = LOG_JOB.set(job_id[:12])
            try:
                self._translate(job_id)
            except Exception as error:
                with self.lock:
                    job = self.jobs[job_id]
                    message = (
                        str(error)
                        if isinstance(error, (ValueError, RuntimeError))
                        else "任务执行或存储失败，请检查本地服务。"
                    )
                    job.update(state="failed", error=message)
                    try:
                        self._save(job)
                    except OSError:
                        LOGGER.error("checkpoint_failed job=%s", job_id[:12])
                LOGGER.warning(
                    "translation_failed job=%s type=%s done=%d total=%d "
                    "reason=%s",
                    job_id[:12],
                    type(error).__name__,
                    len(job["translations"]), len(job["cues"]), message,
                )
            finally:
                LOG_JOB.reset(log_token)
                self.pending.task_done()

    def _translate(self, job_id):
        """Translate bounded batches, then atomically checkpoint each
        complete result.
        """
        with self.lock:
            job = self.jobs[job_id]
            job.update(state="running", error="")
            self._save(job)
        while len(job["translations"]) < len(job["cues"]):
            start = len(job["translations"])
            end = start
            size = 0
            while (
                end < len(job["cues"])
                and size + len(job["cues"][end]["text"]) <= BATCH_CHARS
            ):
                size += len(job["cues"][end]["text"])
                end += 1
            if end < len(job["cues"]):
                for cut in range(end, start, -1):
                    if SENTENCE_END.search(job["cues"][cut - 1]["text"]):
                        end = cut
                        break
            size = sum(len(job["cues"][i]["text"]) for i in range(start, end))
            batch = [
                {"id": index, "text": job["cues"][index]["text"]}
                for index in range(start, end)
            ]
            context = [
                cue["text"] for cue in job["cues"][max(0, start - 2):start]
            ]
            began = time.monotonic()
            LOGGER.info(
                "batch_started job=%s first_id=%d last_id=%d expected=%d "
                "source_chars=%d context_cues=%d model=%s",
                job_id[:12], start, end - 1, len(batch), size, len(context),
                job["policy"]["model"],
            )
            translations = self.translator(
                batch, context, job["source_language"], job["policy"]
            )
            if len(translations) != len(batch) or any(
                not isinstance(text, str) or not text.strip()
                for text in translations
            ):
                raise ValueError("译文不完整，已完成批次保留。")
            with self.lock:
                checkpoint = {
                    **job,
                    "translations": job["translations"] + translations,
                    "elapsed_seconds": round(
                        job["elapsed_seconds"] + time.monotonic() - began, 2
                    ),
                }
                if end == len(job["cues"]):
                    checkpoint["state"] = "completed"
                self._save(checkpoint)
                job = checkpoint
                self.jobs[job_id] = job
            LOGGER.info(
                "batch_saved job=%s done=%d total=%d "
                "actual=%d elapsed_seconds=%.2f",
                job_id[:12],
                end,
                len(job["cues"]),
                len(translations), time.monotonic() - began,
            )
        with self.lock:
            if job["state"] != "completed":
                job["state"] = "completed"
                self._save(job)
            LOGGER.info(
                "translation_completed job=%s total=%d "
                "successful_batch_seconds=%.2f",
                job_id[:12], len(job["cues"]), job["elapsed_seconds"],
            )
