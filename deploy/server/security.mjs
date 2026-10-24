import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createAuth } from "./auth.mjs";

export const authorize = await createAuth();
const key = Buffer.from((await fs.readFile(process.env.CREDENTIAL_KEY_FILE || "/run/secrets/credential-key", "utf8")).trim(), "hex");
if (key.length !== 32) throw new Error("Credential encryption key must contain 32 bytes");
const credentialRoot = process.env.CREDENTIAL_ROOT || "/data/credentials";

export async function serveStatic(req, res, pathname) {
  const relative = ["/", "/login"].includes(pathname) ? "index.html" : pathname.slice(1);
  const allowedAsset = relative === "favicon.svg" || /^assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2?)$/.test(relative);
  if (!["GET", "HEAD"].includes(req.method) || (relative !== "index.html" && !allowedAsset)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const data = await fs.readFile(path.join(process.env.WEB_DIST || "/opt/tosub2/web/dist", relative));
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2" };
    res.writeHead(200, { "Content-Type": types[path.extname(relative)], "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    res.writeHead(404);
    res.end("Not found");
  }
}

export function createCredentialStore() {
  const filename = email => path.join(credentialRoot, crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex") + ".json");
  return {
    async save(email, credentials) {
      await fs.mkdir(credentialRoot, { recursive: true, mode: 0o700 });
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(email.trim().toLowerCase()));
      const data = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
      const target = filename(email);
      const temporary = target + "." + crypto.randomUUID();
      await fs.writeFile(temporary, JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("base64") }), { mode: 0o600 });
      await fs.rename(temporary, target);
    },
    async load(email) {
      let saved;
      try { saved = JSON.parse(await fs.readFile(filename(email), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return { password: "", totpSecret: "", proxyUrl: "" }; throw error; }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(saved.iv, "hex"));
      decipher.setAAD(Buffer.from(email.trim().toLowerCase()));
      decipher.setAuthTag(Buffer.from(saved.tag, "hex"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, "base64")), decipher.final()]).toString("utf8"));
    },
    async delete(email) { await fs.rm(filename(email), { force: true }); },
  };
}
