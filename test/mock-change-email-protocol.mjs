#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
};

const email = valueAfter("--email");
if (args.includes("--change-email")) {
  const nextEmail = String(process.env.CHATGPT_NEW_EMAIL || "");
  const mailUrl = String(process.env.CHATGPT_NEW_MAIL_API_URL || "");
  if (!nextEmail || !mailUrl) process.exit(2);
  if (nextEmail.startsWith("fail@")) {
    console.log("[email-change-failed] status=email_already_linked");
    process.exit(1);
  }
  await fs.writeFile(valueAfter("--email-change-result"), `${JSON.stringify({
    version: 1,
    old_email: email,
    new_email: nextEmail,
    changed_at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  console.log("[email-change] eligibility");
  console.log("[email-change] waiting-otp");
  console.log("[email-change-changed]");
  process.exit(0);
}

const output = valueAfter("--sub2api-out");
if (output) {
  await fs.mkdir(output.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await fs.writeFile(output, `${JSON.stringify({
    type: "sub2api-data",
    accounts: [{
      name: email,
      platform: "openai",
      type: "oauth",
      credentials: { email, access_token: "token", refresh_token: "refresh" },
    }],
  })}\n`);
  console.log(`[ok] Saved sub2api import: ${output}`);
}
