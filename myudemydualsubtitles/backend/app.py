"""Loopback-only Flask API for the Udemy extension's translation jobs."""

import argparse
import fcntl
import logging
from pathlib import Path
import re
import signal

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from .codex_translate import translation_policy
from .jobs import TranslationJobs


def create_app(extension_id, jobs):
    """Build an API restricted to one explicitly configured extension
    origin.
    """
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError(
            "扩展 ID 必须是 chrome://extensions 页面显示的 32 位 ID。"
        )
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024
    origin = f"chrome-extension://{extension_id}"

    @app.before_request
    def check_client():
        """Block web-page requests, cross-origin submissions and DNS
        rebinding.
        """
        if request.host != "127.0.0.1:8765":
            return jsonify(error="无效 Host。"), 403
        supplied_origin = request.headers.get("Origin")
        if supplied_origin and supplied_origin != origin:
            return jsonify(error="不允许的来源。"), 403
        if request.method == "OPTIONS":
            if supplied_origin != origin:
                return jsonify(error="不允许的来源。"), 403
            return "", 204
        if request.headers.get("X-MyUdemy-Extension") != extension_id:
            return jsonify(error="扩展 ID 不匹配，请检查后端启动参数。"), 403
        if request.method == "POST" and not request.is_json:
            return jsonify(error="请求必须使用 application/json。"), 415

    @app.after_request
    def allow_extension(response):
        """Allow only the configured extension to read API responses."""
        if request.headers.get("Origin") == origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = (
                "Content-Type, X-MyUdemy-Extension"
            )
            response.headers["Access-Control-Allow-Methods"] = (
                "GET, POST, OPTIONS"
            )
            response.headers["Vary"] = "Origin"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(ValueError)
    def invalid_request(error):
        """Return bounded validation messages to the extension."""
        return jsonify(error=str(error)), 400

    @app.errorhandler(KeyError)
    def missing_job(error):
        """Do not expose filesystem paths or internals for missing job IDs."""
        return jsonify(error="任务不存在，请重新提交字幕。"), 404

    @app.errorhandler(HTTPException)
    def http_error(error):
        """Keep malformed JSON and oversized request errors machine-
        readable.
        """
        return jsonify(error=f"请求无效（HTTP {error.code}）。"), error.code

    @app.errorhandler(OSError)
    def storage_error(error):
        """Keep storage errors explicit without revealing local paths."""
        return jsonify(error="任务保存失败，请检查磁盘空间及目录权限。"), 500

    @app.post("/translations")
    def submit():
        """Accept a job; 202 means accepted, not completed."""
        status = jobs.submit(request.get_json())
        return jsonify(status), 200 if status["state"] == "completed" else 202

    @app.get("/translations/<job_id>")
    def status(job_id):
        """Read progress without starting or replaying work."""
        return jsonify(jobs.status(job_id))

    @app.post("/translations/<job_id>/retry")
    def retry(job_id):
        """Explicitly resume a failed task from its last successful batch."""
        return jsonify(jobs.retry(job_id))

    return app


def main():
    """Start one local process with one worker and no debug/reloader
    processes.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("扩展 ID 格式不正确。")
    directory = Path(__file__).parent / "data"
    directory.mkdir(exist_ok=True)
    with (directory / "server.lock").open("a") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("已有后端正在使用此数据目录。")
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
        )
        jobs = TranslationJobs(directory, translation_policy())

        def terminate(signum, frame):
            """Use normal interpreter shutdown so the owned Codex child is
            stopped.
            """
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, terminate)
        create_app(args.extension_id, jobs).run(
            host="127.0.0.1",
            port=8765,
            debug=False,
            use_reloader=False,
        )


if __name__ == "__main__":
    main()
