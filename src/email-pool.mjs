import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isMailboxAddress } from "./change-email.mjs";
import { validateMailApiUrl } from "./mail-otp.mjs";

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMPORT_LINES = 2000;
const ASSURIVO_FEED_URL = "https://assurivo.com/console/feed.php";

export function assurivoFeedUrl(email, code) {
  const params = new URLSearchParams();
  params.set("mail", String(email || "").trim().toLowerCase());
  params.set("pwd", String(code || "").trim());
  params.set("limit", "5");
  return `${ASSURIVO_FEED_URL}?${params.toString()}`;
}

export function normalizeEmailPoolProvider(value) {
  const provider = String(value || "url").trim().toLowerCase();
  if (provider === "url" || provider === "assurivo") return provider;
  throw new Error("导入类型只支持取码地址或 assurivo");
}

export function redactMailboxUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!parsed.hostname) return "";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname || "/"}`;
  } catch {
    return "";
  }
}

export function parseEmailPoolText(text, provider = "url") {
  const kind = normalizeEmailPoolProvider(provider);
  const raw = String(text || "");
  if (Buffer.byteLength(raw) > MAX_IMPORT_BYTES) {
    return { entries: [], errors: [{ line: 0, error: "导入内容超过 1 MB" }] };
  }
  const entries = [];
  const errors = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  if (lines.filter((line) => line.trim()).length > MAX_IMPORT_LINES) {
    return { entries: [], errors: [{ line: 0, error: `一次最多导入 ${MAX_IMPORT_LINES} 个邮箱` }] };
  }
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separator = trimmed.indexOf("----");
    if (separator <= 0) {
      errors.push({ line: index + 1, error: kind === "assurivo" ? "应为 邮箱----查询码" : "应为 邮箱----HTTP(S)取码地址，可选第三段为 POST 内容" });
      return;
    }
    const email = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 4);
    if (!isMailboxAddress(email)) {
      errors.push({ line: index + 1, error: "邮箱格式无效" });
      return;
    }
    let mailApiUrl = "";
    let mailRequestBody = "";
    if (kind === "assurivo") {
      const code = rest.trim();
      if (!code) {
        errors.push({ line: index + 1, error: "查询码不能为空" });
        return;
      }
      if (code.length > 512 || /[\r\n]/.test(code)) {
        errors.push({ line: index + 1, error: "查询码无效" });
        return;
      }
      mailApiUrl = assurivoFeedUrl(email, code);
    } else {
      const parts = rest.split("----");
      if (parts.length > 2) {
        errors.push({ line: index + 1, error: "应为 邮箱----HTTP(S)取码地址，可选第三段为 POST 内容" });
        return;
      }
      mailApiUrl = parts[0].trim();
      mailRequestBody = parts[1] || "";
      if (!validateMailApiUrl(mailApiUrl)) {
        errors.push({ line: index + 1, error: "取码地址必须是 HTTP 或 HTTPS" });
        return;
      }
      if (Buffer.byteLength(mailRequestBody) > 64 * 1024) {
        errors.push({ line: index + 1, error: "POST 内容过长" });
        return;
      }
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line: index + 1, error: "导入内容里有重复邮箱" });
      return;
    }
    seen.add(key);
    entries.push({ email, mailApiUrl, mailRequestBody, provider: kind });
  });
  return { entries, errors };
}

function publicItem(item) {
  return {
    email: item.email,
    status: item.status,
    provider: item.provider === "assurivo" ? "assurivo" : "url",
    mailbox: redactMailboxUrl(item.mailApiUrl),
    hasRequestBody: Boolean(item.mailRequestBody),
    reservedFor: item.reservedFor || null,
    usedFor: item.usedFor || null,
    updatedAt: item.updatedAt || item.createdAt || null,
  };
}

function summaryOf(items) {
  const count = (status) => items.filter((item) => item.status === status).length;
  const order = { available: 0, reserved: 1, blocked: 2, used: 3 };
  return {
    available: count("available"),
    reserved: count("reserved"),
    blocked: count("blocked"),
    used: count("used"),
    items: items
      .map(publicItem)
      .sort((left, right) => (order[left.status] ?? 9) - (order[right.status] ?? 9) || left.email.localeCompare(right.email)),
  };
}

export function createEmailPool({ filePath }) {
  let queue = Promise.resolve();
  const run = (operation) => {
    const pending = queue.then(operation, operation);
    queue = pending.then(() => {}, () => {});
    return pending;
  };

  async function load() {
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error("邮箱池文件格式不正确");
      return data;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, items: [] };
      throw error;
    }
  }

  async function save(state) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  }

  function findItem(state, email) {
    const key = String(email || "").trim().toLowerCase();
    return state.items.find((item) => item.email.toLowerCase() === key) || null;
  }

  return {
    summary() {
      return run(async () => summaryOf((await load()).items));
    },
    mailboxFor(email) {
      return run(async () => {
        const item = findItem(await load(), email);
        if (!item || !validateMailApiUrl(item.mailApiUrl)) return null;
        return {
          mailApiUrl: item.mailApiUrl,
          mailRequestBody: item.mailRequestBody || "",
          provider: item.provider === "assurivo" ? "assurivo" : "url",
        };
      });
    },
    importText(text, provider = "url") {
      return run(async () => {
        const parsed = parseEmailPoolText(text, provider);
        if (!parsed.entries.length && parsed.errors.length) {
          const error = new Error(parsed.errors[0].error);
          error.details = parsed.errors.slice(0, 20);
          throw error;
        }
        const state = await load();
        let imported = 0;
        let updated = 0;
        const skipped = [];
        for (const entry of parsed.entries) {
          const existing = findItem(state, entry.email);
          if (existing && existing.status !== "available") {
            skipped.push({ email: entry.email, error: existing.status === "reserved" ? "该邮箱正在换绑，不能覆盖" : "该邮箱已使用或不可用，不能覆盖" });
            continue;
          }
          if (existing) {
            existing.mailApiUrl = entry.mailApiUrl;
            existing.mailRequestBody = entry.mailRequestBody;
            existing.provider = entry.provider;
            existing.updatedAt = new Date().toISOString();
            updated += 1;
          } else {
            state.items.push({
              email: entry.email,
              provider: entry.provider,
              mailApiUrl: entry.mailApiUrl,
              mailRequestBody: entry.mailRequestBody,
              status: "available",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            imported += 1;
          }
        }
        await save(state);
        return {
          imported,
          updated,
          skipped,
          errors: parsed.errors.slice(0, 20),
          ...summaryOf(state.items),
        };
      });
    },
    remove(emails) {
      return run(async () => {
        const keys = new Set((Array.isArray(emails) ? emails : []).map((email) => String(email || "").trim().toLowerCase()).filter(Boolean));
        if (!keys.size) throw new Error("请选择要删除的邮箱");
        const state = await load();
        const blocked = state.items.filter((item) => keys.has(item.email.toLowerCase()) && item.status === "reserved");
        if (blocked.length) throw new Error(`${blocked[0].email} 正在换绑，不能删除`);
        const before = state.items.length;
        state.items = state.items.filter((item) => !keys.has(item.email.toLowerCase()));
        await save(state);
        return { deleted: before - state.items.length, ...summaryOf(state.items) };
      });
    },
    claim({ jobId, currentEmail, blockedEmails = [] }) {
      return run(async () => {
        const state = await load();
        const current = String(currentEmail || "").trim().toLowerCase();
        const blocked = new Set(blockedEmails.map((email) => String(email || "").trim().toLowerCase()));
        const item = state.items.find((entry) => (
          entry.status === "available"
          && entry.email.toLowerCase() !== current
          && !blocked.has(entry.email.toLowerCase())
        ));
        if (!item) return null;
        item.status = "reserved";
        item.reservedBy = jobId;
        item.reservedFor = currentEmail;
        item.updatedAt = new Date().toISOString();
        await save(state);
        return {
          email: item.email,
          mailApiUrl: item.mailApiUrl,
          mailRequestBody: item.mailRequestBody || "",
        };
      });
    },
    release(email, jobId) {
      return run(async () => {
        const state = await load();
        const item = findItem(state, email);
        if (!item || item.status !== "reserved" || item.reservedBy !== jobId) return false;
        item.status = "available";
        item.reservedBy = null;
        item.reservedFor = null;
        item.updatedAt = new Date().toISOString();
        await save(state);
        return true;
      });
    },
    consume(email, jobId, replacedEmail) {
      return run(async () => {
        const state = await load();
        const item = findItem(state, email);
        if (!item || item.status === "used") return false;
        if (item.status === "reserved" && item.reservedBy && item.reservedBy !== jobId) return false;
        item.status = "used";
        item.usedFor = replacedEmail || item.reservedFor || null;
        item.reservedBy = null;
        item.updatedAt = new Date().toISOString();
        await save(state);
        return true;
      });
    },
    block(email, jobId) {
      return run(async () => {
        const state = await load();
        const item = findItem(state, email);
        if (!item || item.status === "used") return false;
        if (item.status === "reserved" && item.reservedBy && item.reservedBy !== jobId) return false;
        item.status = "blocked";
        item.reservedBy = null;
        item.updatedAt = new Date().toISOString();
        await save(state);
        return true;
      });
    },
    releaseUnheld(heldEmails) {
      return run(async () => {
        const held = new Set([...heldEmails].map((email) => String(email || "").toLowerCase()));
        const state = await load();
        let released = 0;
        for (const item of state.items) {
          if (item.status === "reserved" && !held.has(item.email.toLowerCase())) {
            item.status = "available";
            item.reservedBy = null;
            item.reservedFor = null;
            item.updatedAt = new Date().toISOString();
            released += 1;
          }
        }
        if (released) await save(state);
        return released;
      });
    },
  };
}
