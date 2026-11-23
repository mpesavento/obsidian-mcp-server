#!/usr/bin/env node
// Generate the consent-gate TOTP secret and print what an authenticator app needs.
//   node scripts/totp-setup.mjs            → new secret + otpauth URI (+ QR PNG if qrencode is installed)
//   node scripts/totp-setup.mjs --check    → print the current code for CONSENT_TOTP_SECRET in .env
// Put the secret in .env as CONSENT_TOTP_SECRET=... (never commit it).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { generateTotpSecret, otpauthUri, base32Decode, hotp, totpCounter } from "../dist/auth/totp.js";

if (process.argv.includes("--check")) {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith("CONSENT_TOTP_SECRET="));
  if (!line) throw new Error("CONSENT_TOTP_SECRET not found in .env");
  console.log(hotp(base32Decode(line.split("=")[1].trim()), totpCounter()));
  process.exit(0);
}

const secret = generateTotpSecret();
const uri = otpauthUri(secret, "vault-mcp", "ExoBrain");
console.log(`CONSENT_TOTP_SECRET=${secret}`);
console.log(`\notpauth URI (import into your authenticator):\n${uri}`);
const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
if (out) {
  try {
    execFileSync("qrencode", ["-o", out, "-s", "8", uri]);
    console.log(`\nQR code written to ${out}. Delete it after scanning.`);
  } catch {
    console.log("\n(qrencode not installed, so no QR file; brew install qrencode)");
  }
}
