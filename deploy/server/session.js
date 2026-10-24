let generation = 0;
let active = false;
const pending = new Set();

export function endSession() {
  active = false;
  generation++;
  for (const controller of pending) controller.abort();
  pending.clear();
}

export function beginSession() {
  endSession();
  active = true;
}

export async function sessionFetch(endpoint, options = {}) {
  if (!active) throw new DOMException("Session ended", "AbortError");
  const current = generation;
  const controller = new AbortController();
  const abort = () => controller.abort();
  pending.add(controller);
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await globalThis.fetch(endpoint, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    const body = await response.arrayBuffer();
    if (response.status === 401 && current === generation) window.dispatchEvent(new Event("console-session-expired"));
    if (current !== generation || controller.signal.aborted) throw new DOMException("Session ended", "AbortError");
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    pending.delete(controller);
    options.signal?.removeEventListener("abort", abort);
  }
}
