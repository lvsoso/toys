"use strict";

(() => {
  const lecture_captions = new Map();
  const original_fetch = window.fetch;

  /** Capture only captions actually attached to a lecture, never credentials or response bodies. */
  function remember_lecture(lecture, fallback_id) {
    const id = lecture?.id ?? fallback_id;
    if (!id || !Array.isArray(lecture?.asset?.captions)) return;
    lecture_captions.set(String(id), lecture.asset.captions.map((caption) => ({
      language: caption.language, label: caption.videoLabel, url: caption.url,
    })));
    if (lecture_captions.size > 300) lecture_captions.delete(lecture_captions.keys().next().value);
  }

  /** Observe a cloned GraphQL response without delaying or consuming Udemy's response. */
  async function capture_response(response, input, init) {
    try {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.origin !== location.origin || !url.pathname.includes("/graphql")) return;
      const response_copy = response.clone();
      let request_body = init?.body;
      if (!request_body && input instanceof Request) request_body = await input.clone().text();
      const request = typeof request_body === "string" ? JSON.parse(request_body) : request_body;
      const body = await response_copy.json();
      for (const lecture of body.data?.lectures || []) remember_lecture(lecture);
      if (body.data?.lecture) remember_lecture(body.data.lecture, request?.variables?.id);
    } catch {
      // Observing metadata must never break Udemy playback or its own network requests.
    }
  }

  /** Preserve the original fetch result and rejection behavior. */
  window.fetch = async function (...args) {
    let observed_input = args[0];
    if (observed_input instanceof Request && observed_input.url.includes("/graphql") && !args[1]?.body) {
      observed_input = observed_input.clone();
    }
    const response = await original_fetch.apply(this, args);
    void capture_response(response, observed_input, args[1]);
    return response;
  };

  /** Reply with metadata only; this bridge cannot fetch arbitrary URLs or write storage. */
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin
        || event.data?.type !== "myuds:captions:request") return;
    const {request_id, lecture_id} = event.data;
    if (typeof request_id !== "string" || !/^\d+$/.test(lecture_id)) return;
    window.postMessage({type: "myuds:captions:response", request_id,
      captions: lecture_captions.get(lecture_id) || []}, location.origin);
  });
})();
