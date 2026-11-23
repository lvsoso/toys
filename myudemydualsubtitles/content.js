"use strict";

(() => {
  const {parse_subtitles, to_srt, lesson_context} = SubtitleTools;
  let current_key = null;
  let imported_cues = [];
  let imported_name = "";
  let cache_error = "";
  let visible = true;
  let active_video = null;
  let active_track = null;
  let overlay = null;
  let captions = [];
  let active_job = null;
  let translation_status = null;
  let polling = false;
  let action_version = 0;
  let storage_writes = Promise.resolve();
  let loaded = Promise.resolve();
  const tracks = new WeakMap();
  const default_style = {font_size: 24, position: 85};
  let subtitle_style = {...default_style};
  let style_revision = 0;

  /** Validate persisted preferences and popup messages before changing cue layout. */
  function validate_style(value) {
    if (!value || !Number.isInteger(value.font_size) || value.font_size < 18 || value.font_size > 48
        || !Number.isInteger(value.position) || value.position < 10 || value.position > 100) {
      throw new Error("字号须为 18–48px，位置须为 10–100% 的整数。");
    }
    return {font_size: value.font_size, position: value.position};
  }

  /** Apply presentation changes in place, retaining timings, text and visibility. */
  function apply_style() {
    if (!active_video) return;
    active_video.style.setProperty("--myuds-font-size", `${subtitle_style.font_size}px`);
    if (!active_track) return;
    const mode = active_track.mode;
    active_track.mode = "hidden";
    for (const cue of Array.from(active_track.cues || [])) {
      cue.snapToLines = false;
      cue.line = subtitle_style.position;
      cue.lineAlign = "end";
      cue.position = 50;
      cue.positionAlign = "center";
      cue.align = "center";
    }
    active_track.mode = mode;
    render_overlay();
  }

  /** Join layout-only wraps within each language, preserving uncertain boundaries. */
  function flatten_subtitle_lines(text) {
    const lines = [];
    let previous_language = null;
    for (const raw_line of text.split("\n")) {
      const line = raw_line.trim();
      const letters = line.match(/\p{L}/gu) || [];
      const language = !letters.length ? null
        : letters.every((letter) => /\p{Script=Han}/u.test(letter)) ? "zh"
        : letters.every((letter) => /\p{Script=Latin}/u.test(letter)) ? "en" : null;
      if (language && language === previous_language) {
        lines[lines.length - 1] += (language === "en" ? " " : "") + line;
      } else {
        lines.push(line);
      }
      previous_language = language;
    }
    return lines.join("\n");
  }

  /** Render plain text in one box; native cues still own pause/seek/rate timing. */
  function render_overlay() {
    if (!active_video || !active_track || !visible || !imported_cues.length
        || current_key !== lesson_context(location.href)?.key) {
      if (overlay) overlay.hidden = true;
      return;
    }
    // A video-only fullscreen/PiP surface cannot contain a DOM overlay.
    const native_surface = document.fullscreenElement === active_video
      || document.pictureInPictureElement === active_video;
    const mode = native_surface ? "showing" : "hidden";
    if (active_track.mode !== mode) active_track.mode = mode;
    if (native_surface) {
      if (overlay) overlay.hidden = true;
      return;
    }
    const host = document.fullscreenElement || document.body;
    if (!host) return;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "myuds-subtitle-overlay";
    }
    if (overlay.parentNode !== host) host.appendChild(overlay);
    const text = Array.from(active_track.activeCues || [])
      .map((cue) => flatten_subtitle_lines(cue.getCueAsHTML().textContent)).join("\n");
    if (overlay.textContent !== text) overlay.textContent = text;
    const rect = active_video.getBoundingClientRect();
    overlay.hidden = !text || rect.width <= 0 || rect.height <= 0;
    if (overlay.hidden) return;
    overlay.style.fontSize = `${subtitle_style.font_size}px`;
    overlay.style.maxWidth = `${rect.width * 0.92}px`;
    overlay.style.left = `${rect.left + rect.width / 2}px`;
    overlay.style.maxHeight = `${rect.height}px`;
    // Keep the entire box inside the video even near the top edge.
    overlay.style.top = `${rect.top + Math.max(0,
      rect.height * subtitle_style.position / 100 - overlay.offsetHeight)}px`;
  }

  const style_loaded = chrome.storage.local.get("subtitle_style").then((stored) => {
    if (style_revision) return;
    subtitle_style = stored.subtitle_style ? validate_style(stored.subtitle_style) : {...default_style};
    apply_style();
  }).catch(() => {
    cache_error = "字幕显示设置读取失败，已使用默认值。";
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.subtitle_style) return;
    try {
      const value = changes.subtitle_style.newValue;
      subtitle_style = value === undefined ? {...default_style} : validate_style(value);
      style_revision += 1;
      apply_style();
    } catch (error) {
      cache_error = error.message;
    }
  });

  /** Refuse stale popup actions after Udemy navigates to another lesson. */
  function require_lesson(key) {
    const context = lesson_context(location.href);
    if (!context) throw new Error("请打开 Udemy 正式课程中的视频课时。");
    if (key && context.key !== key) throw new Error("课时已切换，请关闭并重新打开插件。");
    return context;
  }

  /** Keep a hidden native track for timing and native-only fullscreen surfaces. */
  function render_track() {
    if (!active_video) return;
    active_track = tracks.get(active_video);
    if (!active_track && imported_cues.length) {
      active_track = active_video.addTextTrack("subtitles", "本地导入字幕", "");
      active_track.addEventListener("cuechange", render_overlay);
      tracks.set(active_video, active_track);
    }
    if (!active_track) return;
    active_track.mode = "hidden";
    for (const cue of Array.from(active_track.cues || [])) active_track.removeCue(cue);
    for (const item of imported_cues) {
      // Encode markup so imported text is displayed literally by the WebVTT renderer.
      const text = item.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const cue = new VTTCue(item.start, item.end, `<c.myuds-local-cue>${text}</c>`);
      active_track.addCue(cue);
    }
    active_track.mode = visible && imported_cues.length ? "hidden" : "disabled";
    apply_style();
  }

  /** Reset immediately on navigation; discard late cache reads for previous lessons. */
  function sync_context() {
    const context = lesson_context(location.href);
    const next_key = context?.key || null;
    if (next_key !== current_key) {
      current_key = next_key;
      imported_cues = [];
      imported_name = "";
      cache_error = "";
      captions = [];
      active_job = null;
      translation_status = null;
      action_version += 1;
      render_track();
      loaded = next_key ? chrome.storage.local.get([next_key, `translation:${next_key}`]).then((stored) => {
        if (current_key !== next_key || lesson_context(location.href)?.key !== next_key) return;
        if (stored[next_key]) {
          imported_cues = parse_subtitles(stored[next_key].text);
          imported_name = stored[next_key].name;
          render_track();
        }
          active_job = stored[`translation:${next_key}`] || null;
          if (active_job?.saved) translation_status = {state: "completed", done: imported_cues.length, total: imported_cues.length};
      }).catch(() => {
        if (current_key === next_key) cache_error = "本地字幕读取失败，请重新导入。";
      }) : Promise.resolve();
    }
    const video = context ? document.querySelector("video") : null;
    if (video !== active_video) {
      if (active_track) active_track.mode = "disabled";
      if (active_video) {
        for (const event of ["timeupdate", "seeked", "enterpictureinpicture", "leavepictureinpicture"])
          active_video.removeEventListener(event, render_overlay);
      }
      active_video = video;
      if (active_video) {
        for (const event of ["timeupdate", "seeked", "enterpictureinpicture", "leavepictureinpicture"])
          active_video.addEventListener(event, render_overlay);
      }
      active_track = null;
      render_track();
    }
    render_overlay();
  }

  /** Read the page bridge's cached metadata with a bounded wait and origin validation. */
  function graphql_captions(lecture_id) {
    return new Promise((resolve) => {
      const request_id = crypto.randomUUID();
      /** Remove listeners for both successful responses and timeouts. */
      function finish(result) {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        resolve(result);
      }
      /** Accept only the response matching this request. */
      function receive(event) {
        if (event.source === window && event.origin === location.origin
            && event.data?.type === "myuds:captions:response"
            && event.data.request_id === request_id) {
          finish(Array.isArray(event.data.captions) ? event.data.captions : []);
        }
      }
      const timer = setTimeout(() => finish([]), 700);
      window.addEventListener("message", receive);
      window.postMessage({type: "myuds:captions:request", request_id, lecture_id}, location.origin);
    });
  }

  /** Fetch current lecture metadata using the classic player's course ID. */
  async function rest_captions(context) {
    const loader = document.querySelector("div.ud-main-content div.ud-app-loader");
    const args = loader?.getAttribute("data-module-args");
    if (!args) return [];
    const course_id = JSON.parse(args).courseId;
    if (!/^\d+$/.test(String(course_id))) return [];
    const response = await fetch(`${location.origin}/api-2.0/users/me/subscribed-courses/`
      + `${course_id}/lectures/${context.lecture_id}/?fields[asset]=captions`,
    {credentials: "same-origin", signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`课时字幕接口返回 HTTP ${response.status}，请检查登录和课程访问权限。`);
    return (await response.json()).asset?.captions || [];
  }

  /** Normalize known Udemy caption metadata without exposing URLs in UI or logs. */
  function normalize_captions(items) {
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      try {
        const url = new URL(item.url);
        if (url.protocol !== "https:" || url.username || url.password
            || !/(^|\.)(udemy|udemycdn)\.com$/.test(url.hostname)) return [];
        return [{url: url.href, language: String(item.language || item.locale_id || "und"),
          label: String(item.label || item.videoLabel || item.video_label
            || item.language || item.locale_id || "字幕")}];
      } catch {
        return [];
      }
    });
  }

  /** List captions independently from importing, so no-caption lessons still allow imports. */
  async function list_captions(context) {
    let result = normalize_captions(await graphql_captions(context.lecture_id));
    if (!result.length) result = normalize_captions(await rest_captions(context));
    require_lesson(context.key);
    captions = result;
    return result.map(({label, language}, index) => ({index, label, language}));
  }

  /** Share the existing official subtitle download path with translation submissions. */
  async function fetch_captions(context, index) {
    const caption = captions[index];
    if (!Number.isInteger(index) || !caption) throw new Error("请重新读取并选择字幕语言。");
    const response = await fetch(caption.url, {credentials: "omit", signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`字幕下载失败（HTTP ${response.status}），请刷新课程后重试。`);
    const cues = parse_subtitles(await response.text());
    require_lesson(context.key);
    return {cues, language: caption.language};
  }

  /** Let the extension service worker own cross-origin access to the fixed loopback API. */
  async function backend(operation, payload = {}) {
    const response = await chrome.runtime.sendMessage({source: "myuds:backend", operation, ...payload});
    if (!response?.ok) throw new Error(response?.error || "本地翻译服务未响应。");
    return response.data;
  }

  /** Serialize writes so a late translation cannot overwrite a newer manual import. */
  function save_local(values, valid) {
    const write = storage_writes.then(async () => {
      if (!valid()) return false;
      await chrome.storage.local.set(values);
      return true;
    });
    storage_writes = write.catch(() => {});
    return write;
  }

  /** Update partial display and persist only fully completed translations. */
  async function poll_translation() {
    sync_context();
    await loaded;
    if (polling || !active_job || !current_key) return;
    if (["completed", "failed"].includes(translation_status?.state) && !translation_status?.connection_error) return;
    const key = current_key;
    const job = active_job;
    const version = action_version;
    polling = true;
    try {
      const status = await backend("status", {job_id: job.id});
      if (key !== lesson_context(location.href)?.key || active_job !== job || version !== action_version) return;
      const progress_changed = status.done !== translation_status?.done;
      const needs_save = status.state === "completed" && !job.saved;
      if (status.done > 0 && (progress_changed || needs_save)) {
        const text = to_srt(status.cues);
        const cues = parse_subtitles(text);
        if (needs_save) {
          const saved_job = {...job, saved: true};
          await save_local({[key]: {name: "Codex 双语字幕.srt", text},
            [`translation:${key}`]: saved_job}, () => active_job === job && version === action_version);
          if (key !== lesson_context(location.href)?.key || active_job !== job || version !== action_version) return;
          active_job = saved_job;
        }
        imported_cues = cues;
        imported_name = status.state === "completed" ? "Codex 双语字幕.srt" : "Codex 双语字幕（翻译中）";
        render_track();
      }
      translation_status = {...status, cues: undefined};
    } catch (error) {
      if (active_job === job && version === action_version) {
        translation_status = {...translation_status, connection_error: error.message};
      }
    } finally {
      polling = false;
    }
  }

  /** Handle extension-only requests and validate the lesson before every mutation/result. */
  async function handle_message(message) {
    sync_context();
    const context = require_lesson(message.key);
    await loaded;
    await style_loaded;
    require_lesson(context.key);
    switch (message.action) {
      case "status":
        return {context, imported_name, cue_count: imported_cues.length, visible,
          video_found: Boolean(active_video), cache_error, translation_status, subtitle_style,
          translation_pending: Boolean(active_job)};
      case "subtitle_style": {
        const style = message.reset === true ? {...default_style} : validate_style(message.style);
        await save_local({subtitle_style: style}, () => true);
        subtitle_style = style;
        style_revision += 1;
        apply_style();
        return {subtitle_style};
      }
      case "list":
        return {captions: await list_captions(context)};
      case "download": {
        const {cues, language} = await fetch_captions(context, message.index);
        return {text: to_srt(cues), filename: `${context.course}-${context.lecture_id}-${language}.srt`};
      }
      case "translate": {
        if (active_job && !["completed", "failed"].includes(translation_status?.state)) {
          throw new Error("本课已有翻译任务，请等待完成或查询状态。");
        }
        const version = ++action_version;
        const {cues, language} = await fetch_captions(context, message.index);
        if (version !== action_version) return {};
        const status = await backend("submit", {payload: {source_language: language, cues}});
        require_lesson(context.key);
        if (version !== action_version) return {};
        await save_local({[`translation:${context.key}`]: {id: status.id, saved: false}}, () => version === action_version);
        require_lesson(context.key);
        if (version !== action_version) return {};
        active_job = {id: status.id, saved: false};
        translation_status = null;
        visible = true;
        void poll_translation();
        return {state: status.state};
      }
      case "translation_retry": {
        if (!active_job) throw new Error("没有可重试的任务。");
        const job = active_job;
        await backend("retry", {job_id: job.id});
        require_lesson(context.key);
        if (active_job === job) translation_status = null;
        void poll_translation();
        return {};
      }
      case "translation_poll":
        await poll_translation();
        require_lesson(context.key);
        return {translation_status};
      case "import": {
        const cues = parse_subtitles(message.text);
        const name = typeof message.name === "string" ? message.name.slice(0, 200) : "导入字幕";
        // Persist first: a quota/write failure leaves the previous subtitle intact.
        const version = ++action_version;
        await save_local({[context.key]: {name, text: message.text},
          [`translation:${context.key}`]: null}, () => version === action_version);
        require_lesson(context.key);
        if (version !== action_version) return {};
        imported_cues = cues;
        imported_name = name;
        active_job = null;
        translation_status = null;
        cache_error = "";
        visible = true;
        render_track();
        return {cue_count: cues.length};
      }
      case "visibility":
        visible = Boolean(message.visible);
        if (active_track) active_track.mode = visible && imported_cues.length ? "hidden" : "disabled";
        render_overlay();
        return {};
      default:
        throw new Error("不支持的操作。");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.source !== "myuds:popup") return false;
    handle_message(message).then((data) => respond({ok: true, ...data}))
      .catch((error) => respond({ok: false, error: error.message || "操作失败，请刷新课程后重试。"}));
    return true;
  });
  document.addEventListener("fullscreenchange", render_overlay);
  document.addEventListener("scroll", render_overlay, true);
  window.addEventListener("resize", render_overlay);
  // Udemy's SPA may replace the video without changing the URL or firing a load event.
  setInterval(sync_context, 300);
  setInterval(poll_translation, 2000);
  sync_context();
})();
