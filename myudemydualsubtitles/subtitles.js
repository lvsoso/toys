"use strict";

/** Pure subtitle helpers shared by the popup, content script and tests. */
const SubtitleTools = (() => {
  const max_bytes = 2 * 1024 * 1024;

  /** Parse an SRT/WebVTT timestamp into seconds without losing milliseconds. */
  function parse_time(value) {
    const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
    if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
      throw new Error(`无效字幕时间：${value}`);
    }
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60
      + Number(match[3]) + Number(match[4]) / 1000;
  }

  /** Remove subtitle styling, preserving line breaks and literal text. */
  function plain_text(text) {
    const entities = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "};
    return text.replace(/<[^>\n]*>/g, "").replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity) => {
        if (!entity.startsWith("#")) return entities[entity.toLowerCase()];
        const hex = entity.slice(0, 2).toLowerCase() === "#x";
        const point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point) : whole;
      },
    );
  }

  /** Parse complete subtitle files; reject malformed cues rather than silently dropping them. */
  function parse_subtitles(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > max_bytes) {
      throw new Error("字幕文件必须是 UTF-8 文本，且不超过 2 MiB。");
    }
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
    const blocks = normalized.split(/\n[ \t]*\n+/);
    const is_vtt = /^WEBVTT(?:[ \t]|$)/.test(blocks[0]?.split("\n")[0]);
    if (is_vtt) blocks.shift();
    const cues = [];
    for (const block of blocks) {
      if (is_vtt && /^(NOTE(?:[ \t\n]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block)) continue;
      const lines = block.split("\n");
      const time_index = lines[0]?.includes("-->") ? 0 : 1;
      const match = /^(\S+)\s+-->\s+(\S+)(?:[ \t]+.*)?$/.exec(lines[time_index] || "");
      if (!match) throw new Error(`第 ${cues.length + 1} 条字幕缺少有效时间轴。`);
      const start = parse_time(match[1]);
      const end = parse_time(match[2]);
      if (end <= start) throw new Error(`第 ${cues.length + 1} 条字幕结束时间必须晚于开始时间。`);
      const cue_text = plain_text(lines.slice(time_index + 1).join("\n"));
      if (!cue_text.trim()) continue;
      cues.push({start, end, text: cue_text});
    }
    if (!cues.length) throw new Error("未找到字幕内容。");
    return cues.sort((a, b) => a.start - b.start);
  }

  /** Format seconds as SRT time, including hours over 24 and zero-padded milliseconds. */
  function format_time(seconds) {
    const milliseconds = Math.round(seconds * 1000);
    const pad = (value, width = 2) => String(value).padStart(width, "0");
    return `${pad(Math.floor(milliseconds / 3600000))}:`
      + `${pad(Math.floor(milliseconds / 60000) % 60)}:`
      + `${pad(Math.floor(milliseconds / 1000) % 60)},${pad(milliseconds % 1000, 3)}`;
  }

  /** Export plain cues to a portable SRT file. */
  function to_srt(cues) {
    return cues.map((cue, index) => `${index + 1}\n${format_time(cue.start)} --> `
      + `${format_time(cue.end)}\n${cue.text}\n`).join("\n");
  }

  /** Identify a formal lesson independently of query parameters and URL fragments. */
  function lesson_context(url) {
    const parsed = new URL(url);
    const match = /^\/course\/([^/]+)\/(?:learn\/)?lecture\/(\d+)(?:\/|$)/.exec(parsed.pathname);
    if (parsed.protocol !== "https:" || !/(^|\.)udemy\.com$/.test(parsed.hostname) || !match) return null;
    return {
      course: match[1], lecture_id: match[2],
      key: `subtitle:${parsed.hostname}:${match[1]}:${match[2]}`,
    };
  }

  return {max_bytes, parse_subtitles, to_srt, lesson_context};
})();

if (typeof module !== "undefined") module.exports = SubtitleTools;
