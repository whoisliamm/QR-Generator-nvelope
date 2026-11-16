// Menghubungkan bot Telegram ke Worker yang sudah di-deploy.
//
// Pemakaian:  npm run setup -- https://envelope-qr-bot.<akun>.workers.dev --admin 123456789
//
// Yang dilakukan:
//   1. Membaca BOT_TOKEN dari ../.env (atau variabel lingkungan BOT_TOKEN)
//   2. Membuat WEBHOOK_SECRET acak
//   3. Menyimpan keduanya (dan ADMIN_USER_IDS bila --admin diisi) sebagai secret Worker
//   4. setWebhook, setMyCommands, dan tombol menu "QR Generator" (Mini App)
//
// --admin  ID Telegram admin, pisahkan dengan koma bila lebih dari satu.
//          Belum tahu ID-nya? Jalankan setup tanpa --admin, kirim /start ke bot
//          (bot membalas dengan ID Anda), lalu jalankan setup lagi dengan --admin.
//
// Token tidak pernah dicetak ke layar.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let adminArg = "";
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--admin") adminArg = args[++i] ?? "";
  else if (args[i].startsWith("--admin=")) adminArg = args[i].slice("--admin=".length);
  else positional.push(args[i]);
}

const workerUrl = (positional[0] || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(workerUrl)) {
  console.error(
    "❌ Berikan URL Worker, contoh:\n   npm run setup -- https://envelope-qr-bot.namaakun.workers.dev --admin 123456789",
  );
  process.exit(1);
}

const adminIds = adminArg.split(/[\s,]+/).filter(Boolean);
if (adminIds.some((id) => !/^\d{1,15}$/.test(id))) {
  console.error("❌ --admin harus berisi ID Telegram berupa angka, dipisah koma.");
  process.exit(1);
}

function readToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim();
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("BOT_TOKEN="));
  return (line ?? "").split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
}

const token = readToken();
if (!token) {
  console.error("❌ BOT_TOKEN tidak ditemukan di ../.env atau variabel lingkungan.");
  process.exit(1);
}

function putSecret(name, value) {
  // Satu string perintah (nama secret selalu tetap) supaya npx juga jalan di Windows tanpa peringatan Node
  const result = spawnSync(`npx wrangler secret put ${name}`, {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`❌ Gagal menyimpan secret ${name}.`);
    process.exit(1);
  }
}

async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const me = await telegram("getMe", {});
console.log(`🤖 Bot: @${me.username}`);

const webhookSecret = randomBytes(32).toString("hex");
console.log("🔐 Menyimpan secret BOT_TOKEN & WEBHOOK_SECRET ke Worker…");
putSecret("BOT_TOKEN", token);
putSecret("WEBHOOK_SECRET", webhookSecret);
if (adminIds.length) {
  putSecret("ADMIN_USER_IDS", adminIds.join(","));
  console.log(`👤 Admin: ${adminIds.join(", ")}`);
}

// Beri waktu Worker memuat secret baru sebelum Telegram mulai mengirim update
await new Promise((resolve) => setTimeout(resolve, 3000));

await telegram("setWebhook", {
  url: `${workerUrl}/telegram`,
  secret_token: webhookSecret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
console.log(`🔗 Webhook: ${workerUrl}/telegram`);

const userCommands = [
  { command: "start", description: "Buka QR Generator" },
  { command: "riwayat", description: "10 QR terakhir, bisa dibuat lagi" },
  { command: "help", description: "Bantuan" },
];
await telegram("setMyCommands", { commands: userCommands });

// Menu "/" khusus admin: perintah biasa + perintah pengelolaan akses, hanya terlihat di chat admin
const adminCommands = [
  ...userCommands,
  { command: "izinkan", description: "Beri akses: /izinkan ID Nama" },
  { command: "cabut", description: "Cabut akses: /cabut ID" },
  { command: "akses", description: "Daftar admin & anggota tim" },
];
for (const id of adminIds) {
  await telegram("setMyCommands", { commands: adminCommands, scope: { type: "chat", chat_id: Number(id) } });
}

await telegram("setChatMenuButton", {
  menu_button: { type: "web_app", text: "QR Generator", web_app: { url: `${workerUrl}/` } },
});
console.log("📋 Command & tombol menu Mini App diset.");

const info = await telegram("getWebhookInfo", {});
console.log(info.last_error_message ? `⚠️ Webhook error terakhir: ${info.last_error_message}` : "✅ Selesai! Coba kirim /start ke bot.");
if (!adminIds.length) {
  console.log(
    "\n⚠️ Belum ada admin, jadi bot menolak semua orang.\n" +
      "   Kirim /start ke bot untuk melihat ID Telegram Anda, lalu jalankan:\n" +
      `   npm run setup -- ${workerUrl} --admin <ID Anda>`,
  );
}
