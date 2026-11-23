"use strict";

/** Proxy only the three local translation endpoints, never arbitrary URLs or headers. */
async function backend_request(message) {
  let path = "/translations";
  let method = "POST";
  if (message.operation !== "submit") {
    if (!/^[a-f0-9]{64}$/.test(message.job_id || "")) throw new Error("无效任务 ID。");
    path += `/${message.job_id}`;
    if (message.operation === "status") method = "GET";
    else if (message.operation === "retry") path += "/retry";
    else throw new Error("不支持的后端操作。");
  }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:8765${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: {"Content-Type": "application/json", "X-MyUdemy-Extension": chrome.runtime.id},
      body: method === "POST" ? JSON.stringify(message.operation === "submit" ? message.payload : {}) : undefined,
    });
  } catch {
    throw new Error("无法连接本地翻译后端，请先启动服务。任务状态未知时重新查询，不会自动重提。");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `后端返回 HTTP ${response.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.source !== "myuds:backend") return false;
  backend_request(message).then((data) => respond({ok: true, data}))
    .catch((error) => respond({ok: false, error: error.message}));
  return true;
});
