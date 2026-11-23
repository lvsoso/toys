"use strict";

const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), (element) => [element.id, element]));
let tab_id;
let lesson_key;
let poll_busy = false;
let style_sequence = 0;

/** Reflect the saved global style in the controls and their visible values. */
function show_style(style) {
  elements.font_size.value = style.font_size;
  elements.subtitle_position.value = style.position;
  elements.font_size_value.textContent = `${style.font_size}px`;
  elements.subtitle_position_value.textContent = `${style.position}%`;
}

/** Save each slider change without disabling the slider during a drag. */
async function update_style(reset = false) {
  const sequence = ++style_sequence;
  const style = {font_size: Number(elements.font_size.value), position: Number(elements.subtitle_position.value)};
  show_style(style);
  elements.style_status.textContent = "正在保存…";
  elements.style_status.dataset.error = "false";
  try {
    const result = await request("subtitle_style", {style, reset});
    if (sequence !== style_sequence) return;
    show_style(result.subtitle_style);
    elements.style_status.textContent = reset ? "已恢复默认并保存。" : "已保存，其他课时也会使用此设置。";
  } catch (error) {
    if (sequence !== style_sequence) return;
    elements.style_status.textContent = error.message;
    elements.style_status.dataset.error = "true";
  }
}

elements.font_size.addEventListener("input", () => update_style());
elements.subtitle_position.addEventListener("input", () => update_style());
elements.reset_style.addEventListener("click", () => update_style(true));

/** Show concise progress or failure messages without exposing subtitle URLs. */
function show_status(text, error = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = String(error);
}

/** Send requests only to the tab and lesson captured when this popup opened. */
async function request(action, payload = {}) {
  const response = await chrome.tabs.sendMessage(tab_id, {source: "myuds:popup", action, key: lesson_key, ...payload});
  if (!response?.ok) throw new Error(response?.error || "插件未响应，请刷新课程页面。");
  return response;
}

/** Keep a single operation active to avoid overlapping imports or stale selections. */
async function run_action(action) {
  elements.controls.disabled = true;
  try {
    await action();
  } catch (error) {
    show_status(error.message, true);
  } finally {
    elements.controls.disabled = !lesson_key;
  }
}

/** Refresh available captions without blocking local imports when none exist. */
async function refresh_captions() {
  elements.download.disabled = true;
  elements.language.replaceChildren(new Option("正在读取…", ""));
  const result = await request("list");
  elements.language.replaceChildren(...result.captions.map((caption) => new Option(caption.label, String(caption.index))));
  elements.download.disabled = !result.captions.length;
  elements.translate.disabled = !result.captions.length;
  elements.caption_note.textContent = result.captions.length
    ? "下载后自行翻译，保留序号和起止时间。"
    : "未获取到字幕。请开启 Udemy 原字幕后重新读取；安装后首次使用请刷新课程。仍可导入本地文件。";
  if (!result.captions.length) elements.language.append(new Option("无可用字幕", ""));
}

elements.refresh.addEventListener("click", () => run_action(async () => {
  show_status("正在读取字幕…");
  await refresh_captions();
  show_status("字幕列表已更新。");
}));

/** Keep task progress separate from one-off download/import messages. */
function show_translation(result) {
  const task = result.translation_status;
  elements.retry_translation.hidden = task?.state !== "failed";
  elements.check_translation.hidden = !result.translation_pending;
  const busy = result.translation_pending && !["completed", "failed"].includes(task?.state);
  elements.translate.disabled = busy || elements.download.disabled;
  if (task?.connection_error) elements.translation_progress.textContent = task.connection_error;
  else if (!task) elements.translation_progress.textContent = result.translation_pending ? "正在查询已提交任务…" : "尚未提交翻译任务。";
  else {
    const labels = {queued: "等待翻译", running: "翻译中", failed: "翻译失败", completed: "翻译完成，已加载双语字幕"};
    elements.translation_progress.textContent = `${labels[task.state]} · ${task.done}/${task.total} 条`
      + (task.error ? `：${task.error}` : "");
  }
  if (result.imported_name) elements.saved.textContent = `${result.imported_name} · ${result.cue_count} 条字幕`;
}

/** Reopening the popup reads the same job; polling never starts new model requests. */
async function refresh_translation() {
  if (!lesson_key || poll_busy) return;
  poll_busy = true;
  try {
    show_translation(await request("status"));
  } catch (error) {
    elements.translation_progress.textContent = error.message;
  } finally {
    poll_busy = false;
  }
}

elements.translate.addEventListener("click", () => run_action(async () => {
  show_status("正在提交翻译任务…");
  await request("translate", {index: Number(elements.language.value)});
  show_status("任务已受理，可以关闭弹窗；后端会继续翻译。");
  await refresh_translation();
}));

elements.retry_translation.addEventListener("click", () => run_action(async () => {
  await request("translation_retry");
  show_status("已请求续办，已完成批次直接复用。");
  await refresh_translation();
}));

elements.check_translation.addEventListener("click", () => run_action(async () => {
  await request("translation_poll");
  await refresh_translation();
}));

elements.download.addEventListener("click", () => run_action(async () => {
  show_status("正在下载并转换字幕，请保持窗口打开…");
  const result = await request("download", {index: Number(elements.language.value)});
  const url = URL.createObjectURL(new Blob([result.text], {type: "application/x-subrip;charset=utf-8"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename.replace(/[\\/:*?"<>|]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  show_status("已发起 SRT 下载，请查看浏览器下载列表。");
}));

elements.subtitle_file.addEventListener("change", () => run_action(async () => {
  const file = elements.subtitle_file.files[0];
  if (!file) return;
  try {
    if (!/\.(srt|vtt)$/i.test(file.name) || file.size > SubtitleTools.max_bytes) {
      throw new Error("请选择不超过 2 MiB 的 SRT / VTT 文件。");
    }
    show_status("正在读取并保存字幕…");
    const text = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
    const result = await request("import", {text, name: file.name});
    elements.saved.textContent = `${file.name} · ${result.cue_count} 条字幕`;
    elements.visible.checked = true;
    await refresh_translation();
    show_status("已导入并保存，下次打开本课会自动加载。");
  } finally {
    elements.subtitle_file.value = "";
  }
}));

elements.visible.addEventListener("change", () => run_action(async () => {
  try {
    await request("visibility", {visible: elements.visible.checked});
    show_status(elements.visible.checked ? "本地字幕已显示。" : "本地字幕已隐藏，缓存仍保留。");
  } catch (error) {
    elements.visible.checked = !elements.visible.checked;
    throw error;
  }
}));

/** Initialize status first, so failed remote metadata never prevents a local import. */
async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    tab_id = tab.id;
    let result;
    try {
      result = await request("status");
    } catch {
      throw new Error("请打开 Udemy 视频课时；首次加载插件后，请刷新课程页面。");
    }
    lesson_key = result.context.key;
    elements.backend_command.textContent = `python -m backend.app --extension-id ${chrome.runtime.id}`;
    elements.lesson.textContent = `${result.context.course} / 课时 ${result.context.lecture_id}`;
    elements.visible.checked = result.visible;
    show_style(result.subtitle_style);
    elements.saved.textContent = result.imported_name
      ? `${result.imported_name} · ${result.cue_count} 条字幕` : "本课尚未导入字幕。";
    if (result.cache_error) show_status(result.cache_error, true);
    else if (!result.video_found) show_status("尚未发现视频；可先导入，播放器出现后自动加载。");
    await run_action(refresh_captions);
    await refresh_translation();
    setInterval(refresh_translation, 2000);
  } catch (error) {
    elements.lesson.textContent = "尚未连接课程";
    show_status(error.message, true);
  }
}

void initialize();
