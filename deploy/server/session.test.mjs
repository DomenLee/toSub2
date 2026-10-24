import assert from "node:assert/strict";
import { beginSession, endSession, sessionFetch } from "./session.js";

globalThis.window = new EventTarget();
const originalFetch = globalThis.fetch;
let request;
let deliver;
try {
  globalThis.fetch = async (endpoint, options) => {
    request = options;
    return new Promise(resolve => { deliver = resolve; });
  };
  beginSession();
  const canceled = new AbortController();
  const first = sessionFetch("/api/jobs/query", { signal: canceled.signal });
  canceled.abort();
  assert.equal(request.signal.aborted, true);
  deliver(new Response("{}"));
  await assert.rejects(first, { name: "AbortError" });
  const download = sessionFetch("/api/jobs/example/download");
  endSession();
  assert.equal(request.signal.aborted, true);
  beginSession();
  deliver(new Response("OLD_SENSITIVE_CONTENT"));
  await assert.rejects(download, { name: "AbortError" }, "old responses must not reach the new session");
  window.addEventListener("console-session-expired", endSession, { once: true });
  const expired = sessionFetch("/api/jobs");
  deliver(new Response("{}", { status: 401 }));
  await assert.rejects(expired, { name: "AbortError" });
  await assert.rejects(sessionFetch("/api/jobs/delete-batch", { method: "POST" }), { name: "AbortError" });
  console.log("PASS: session request cancellation, caller cancellation, stale download rejection, expired-session event and no request replay");
} finally { endSession(); globalThis.fetch = originalFetch; delete globalThis.window; }
