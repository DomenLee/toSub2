import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { testUI } from "./accounts.ui.test.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-build-")));
try {
  for (const name of ["test.mjs", "identity.test.mjs", "repair.test.mjs", "accounts.test.mjs"]) execFileSync(process.execPath, [path.join(root, "deploy/server", name)], { cwd: root, stdio: "inherit" });
  for (const name of ["src", "web", "package.json"]) await fs.cp(path.join(root, name), path.join(temporary, name), { recursive: true });
  await fs.symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "junction");
  execFileSync(process.execPath, [path.join(root, "deploy/server/patch.mjs"), temporary], { stdio: "inherit" });
  for (const [source, target] of [["security.mjs", "src/server-security.mjs"], ["sync.mjs", "src/server-sync.mjs"], ["repair.mjs", "src/server-repair.mjs"], ["identity.mjs", "src/identity.mjs"], ["accounts.mjs", "src/server-accounts.mjs"], ["SyncPanel.jsx", "web/src/SyncPanel.jsx"], ["SyncPanel.css", "web/src/SyncPanel.css"], ["Accounts.jsx", "web/src/Accounts.jsx"]]) await fs.copyFile(path.join(root, "deploy/server", source), path.join(temporary, target));
  for (const file of ["console-server.mjs", "server-accounts.mjs", "server-sync.mjs", "server-repair.mjs", "protocol-login.mjs"]) execFileSync(process.execPath, ["--check", path.join(temporary, "src", file)], { stdio: "inherit" });
  await build({ root: path.join(temporary, "web"), configFile: false, plugins: [react()] });
  await testUI(temporary);
  console.log("PASS: exact production patches, runtime syntax and frontend build");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
