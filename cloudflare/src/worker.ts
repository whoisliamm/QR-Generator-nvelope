// Bot Telegram QR Generator énvelope: Cloudflare Worker
//
// QR hanya dibuat lewat Mini App (public/), di perangkat pengguna, supaya ukuran 4000 px
// dan batch tetap muat di batas CPU paket gratis Cloudflare. Worker ini membuka Mini App dari
// chat (URL yang ditempel di chat membuka form yang sudah terisi), menyimpan job & riwayat,
// mengatur akses tim, dan meneruskan file hasil ke chat.

import {
  FORMAT_LABEL,
  MAX_BATCH,
  SEPARATOR_HINT,
  autoFilename,
  batchZipName,
  dedupeUrls,
  duplicateSummary,
  isQrFormat,
  isQrSize,
  isValidUrl,
  parseUrls,
  withExtension,
  type QrFormat,
} from "./shared/qr";
import { Telegram, escapeHtml, verifyInitData, type InlineKeyboard } from "./telegram";

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  // ID Telegram admin, dipisah koma. Admin selalu boleh memakai bot dan mengelola izin.
  ADMIN_USER_IDS?: string;
}

// Batas upload file bot Telegram adalah 50 MB
const MAX_UPLOAD_BYTES = 49 * 1024 * 1024;

type TgUser = { id: number };
type TgChat = { id: number; type: string };
type TgMessage = { message_id: number; from?: TgUser; chat: TgChat; text?: string };
type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };

// ==========================================
// HTTP ROUTER
// ==========================================

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleWebhook(request, env, url.origin);
    }
    if (url.pathname === "/api/access" && request.method === "GET") {
      return handleAccess(request, env);
    }
    if (url.pathname === "/api/job" && request.method === "GET") {
      return handleGetJob(request, env, url);
    }
    if (url.pathname === "/api/job" && request.method === "POST") {
      return handleCreateJob(request, env);
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      return handleHistory(request, env);
    }
    if (url.pathname === "/api/deliver" && request.method === "POST") {
      return handleDeliver(request, env, url);
    }
    return new Response("Not found", { status: 404 });
  },

  // Bersihkan data lama setiap hari
  async scheduled(_controller, env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      // Job disimpan 30 hari supaya bisa dipakai lagi dari riwayat
      env.DB.prepare("DELETE FROM jobs WHERE COALESCE(used_at, created_at) < ?").bind(now - 30 * 86400_000),
      env.DB.prepare("DELETE FROM sessions WHERE updated_at < ?").bind(now - 30 * 86400_000),
    ]);
  },
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// ==========================================
// DATABASE
// ==========================================

async function createJob(
  env: Env,
  userId: number,
  kind: "single" | "batch",
  urls: string[],
  filename: string | null,
): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    "INSERT INTO jobs (id, user_id, kind, urls, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, kind, JSON.stringify(urls), filename, Date.now())
    .run();
  return id;
}

// ==========================================
// ACCESS CONTROL
// ==========================================

function adminIds(env: Env): Set<number> {
  return new Set(
    (env.ADMIN_USER_IDS ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isSafeInteger),
  );
}

function isAdmin(env: Env, userId: number): boolean {
  return adminIds(env).has(userId);
}

async function isAllowed(env: Env, userId: number): Promise<boolean> {
  if (isAdmin(env, userId)) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM allowed_users WHERE user_id = ?")
    .bind(userId)
    .first();
  return row !== null;
}

function deniedText(userId: number): string {
  return (
    "🔒 <b>Bot ini khusus tim énvelope.</b>\n\n" +
    `ID Telegram Anda: <code>${userId}</code>\n\n` +
    "Kirim ID ini ke admin énvelope untuk minta akses."
  );
}

const ADMIN_HELP_TEXT =
  "\n\n<b>Khusus admin:</b>\n" +
  "<code>/izinkan ID Nama</code> - Beri akses\n" +
  "<code>/cabut ID</code> - Cabut akses\n" +
  "<code>/akses</code> - Daftar yang punya akses";

async function onAdminCommand(name: string, arg: string, env: Env, tg: Telegram, chatId: number, adminId: number) {
  if (name === "akses") {
    const { results } = await env.DB.prepare(
      "SELECT user_id, note FROM allowed_users ORDER BY added_at DESC LIMIT 100",
    ).all<{ user_id: number; note: string | null }>();
    const admins = [...adminIds(env)].map((id) => `• <code>${id}</code>`).join("\n");
    const team = results.length
      ? results
          .map((r) => `• <code>${r.user_id}</code>${r.note ? ` · ${escapeHtml(r.note)}` : ""}`)
          .join("\n")
      : "Belum ada. Tambahkan dengan <code>/izinkan ID Nama</code>.";
    await tg.sendMessage(chatId, `🔑 <b>Admin</b>\n${admins}\n\n👥 <b>Tim (${results.length})</b>\n${team}`);
    return;
  }

  const match = /^(\d{1,15})(?:\s+([\s\S]+))?$/.exec(arg);
  if (!match) {
    await tg.sendMessage(
      chatId,
      name === "izinkan"
        ? "Format: <code>/izinkan 123456789 Nama</code>\n\nID didapat dari balasan bot saat orang itu mengirim /start."
        : "Format: <code>/cabut 123456789</code>",
    );
    return;
  }
  const targetId = Number(match[1]);

  if (name === "izinkan") {
    const note = (match[2] ?? "").trim().slice(0, 60) || null;
    await env.DB.prepare(
      `INSERT INTO allowed_users (user_id, note, added_by, added_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET note = ?2, added_by = ?3, added_at = ?4`,
    )
      .bind(targetId, note, adminId, Date.now())
      .run();
    await tg.sendMessage(
      chatId,
      `✅ <code>${targetId}</code>${note ? ` (${escapeHtml(note)})` : ""} sekarang bisa memakai bot.`,
    );
    return;
  }

  // cabut
  if (isAdmin(env, targetId)) {
    await tg.sendMessage(chatId, "ID ini admin. Admin diatur lewat secret ADMIN_USER_IDS, bukan dari chat.");
    return;
  }
  const result = await env.DB.prepare("DELETE FROM allowed_users WHERE user_id = ?").bind(targetId).run();
  await tg.sendMessage(
    chatId,
    result.meta.changes
      ? `🚫 Akses <code>${targetId}</code> sudah dicabut.`
      : `ID <code>${targetId}</code> memang tidak ada di daftar akses.`,
  );
}

// ==========================================
// KEYBOARDS
// ==========================================

// QR hanya dibuat lewat Mini App. Chat cukup membuka Mini App, kosong atau sudah terisi URL.
function openKeyboard(origin: string, jobId?: string, label = "🔳 Buka QR Generator"): InlineKeyboard {
  return {
    inline_keyboard: [[{ text: label, web_app: { url: jobId ? `${origin}/?job=${jobId}` : `${origin}/` } }]],
  };
}

// /start untuk admin: tombol QR Generator + alat chat yang bisa langsung diketuk
function adminStartKeyboard(origin: string): InlineKeyboard {
  return {
    inline_keyboard: [
      ...openKeyboard(origin).inline_keyboard,
      [
        { text: "🕘 Riwayat", callback_data: "history" },
        { text: "❓ Help", callback_data: "help" },
      ],
      [{ text: "👥 Akses tim", callback_data: "access" }],
    ],
  };
}


// ==========================================
// RIWAYAT
// ==========================================

type HistoryRow = { id: string; kind: string; urls: string; filename: string | null; used_at: number };

async function recentJobs(env: Env, userId: number, limit = 10): Promise<HistoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, urls, filename, used_at FROM jobs
     WHERE user_id = ? AND used_at IS NOT NULL
     ORDER BY used_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<HistoryRow>();
  return results;
}

function historyTitle(row: { kind: string; urls: string[]; filename: string | null }): string {
  if (row.kind === "single") return row.filename || autoFilename(row.urls[0] ?? "");
  return `Batch ${row.urls.length} URL`;
}

function jakartaTime(ms: number): string {
  return new Date(ms).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  });
}

async function sendHistory(env: Env, tg: Telegram, chatId: number, userId: number, origin: string) {
  const rows = await recentJobs(env, userId);
  if (!rows.length) {
    await tg.sendMessage(chatId, "🕘 Belum ada riwayat. QR yang sudah dibuat akan muncul di sini selama 30 hari.");
    return;
  }
  const keyboard: InlineKeyboard = {
    inline_keyboard: rows.map((row) => {
      const title = historyTitle({ ...row, urls: JSON.parse(row.urls) });
      return [{ text: `${title} · ${jakartaTime(row.used_at)}`, web_app: { url: `${origin}/?job=${row.id}` } }];
    }),
  };
  await tg.sendMessage(
    chatId,
    `🕘 <b>Riwayat ${rows.length} QR terakhir</b>\n\nKetuk salah satu untuk membuka form yang sudah terisi, lalu pilih ukuran atau format.`,
    keyboard,
  );
}

// ==========================================
// TEXTS
// ==========================================

const WELCOME_TEXT =
  "👋 <b>QR Generator énvelope</b>\n\n" +
  "Buat QR berlogo énvelope lewat tombol di bawah, atau tombol menu <b>QR Generator</b> di samping kolom ketik.\n\n" +
  "Bisa juga tempel URL di chat ini, nanti formnya langsung terisi.";

const HELP_TEXT =
  "📖 <b>QR Generator énvelope</b>\n\n" +
  "<b>Cara pakai:</b>\n" +
  "1. Buka QR Generator (tombol di bawah atau tombol menu).\n" +
  `2. Tempel satu atau banyak URL. ${SEPARATOR_HINT}\n` +
  "3. Atur format, ukuran, dan nama file di bagian Lanjutan bila perlu.\n" +
  "4. Setiap QR dicek bisa dipindai, lalu file dikirim ke chat ini.\n\n" +
  "<b>Tempel URL di chat:</b> bot membalas dengan tombol yang membuka form sudah terisi.\n\n" +
  "<b>Format:</b> PNG 1000 sampai 4000 px untuk layar, SVG atau PDF vektor untuk percetakan. " +
  `Maksimal ${MAX_BATCH} URL sekali buat.\n\n` +
  "<b>Command:</b>\n" +
  "<code>/start</code> - Menu utama\n" +
  "<code>/riwayat</code> - 10 QR terakhir, bisa dibuat lagi\n" +
  "<code>/help</code> - Bantuan";

const NO_URL_TEXT =
  "QR dibuat lewat <b>QR Generator</b>. Buka tombol di bawah, lalu tempel URL-nya di sana.\n\n" +
  "Atau tempel URL yang diawali <code>https://</code> di chat ini, nanti formnya langsung terisi.";

// ==========================================
// WEBHOOK
// ==========================================

async function handleWebhook(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = (await request.json()) as TgUpdate;
  const tg = new Telegram(env.BOT_TOKEN);

  try {
    if (update.message) await onMessage(update.message, env, tg, origin);
    else if (update.callback_query) await onCallback(update.callback_query, env, tg, origin);
  } catch (error) {
    // Selalu balas 200 supaya Telegram tidak mengirim ulang update yang sama terus-menerus
    console.error("Webhook error:", error);
  }
  return new Response("ok");
}

async function onMessage(msg: TgMessage, env: Env, tg: Telegram, origin: string) {
  const text = msg.text?.trim();
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!text || !userId) return;

  // Tombol Mini App hanya bisa dipakai di chat pribadi dengan bot
  if (msg.chat.type !== "private") {
    if (text.startsWith("/")) {
      await tg.sendMessage(chatId, "ℹ️ Silakan gunakan bot ini lewat chat pribadi.");
    }
    return;
  }

  // Hanya tim énvelope yang boleh memakai bot
  if (!(await isAllowed(env, userId))) {
    await tg.sendMessage(chatId, deniedText(userId));
    return;
  }

  const command = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (command) {
    const name = command[1].toLowerCase();
    const arg = (command[2] ?? "").trim();

    if (name === "start") {
      await tg.sendMessage(
        chatId,
        WELCOME_TEXT,
        isAdmin(env, userId) ? adminStartKeyboard(origin) : openKeyboard(origin),
      );
    } else if (name === "help") {
      await tg.sendMessage(chatId, HELP_TEXT + (isAdmin(env, userId) ? ADMIN_HELP_TEXT : ""), openKeyboard(origin));
    } else if (name === "riwayat") {
      await sendHistory(env, tg, chatId, userId, origin);
    } else if (name === "izinkan" || name === "cabut" || name === "akses") {
      if (isAdmin(env, userId)) await onAdminCommand(name, arg, env, tg, chatId, userId);
      else await tg.sendMessage(chatId, "Perintah ini khusus admin.");
    } else if (name === "qr" || name === "batch") {
      // Perintah lama: tetap dilayani, tapi diarahkan ke Mini App (terisi bila ada URL)
      await offerForm(arg, env, tg, chatId, userId, origin);
    }
    // Command lain diabaikan
    return;
  }

  await offerForm(text, env, tg, chatId, userId, origin);
}

// URL yang ditempel di chat disimpan sebagai job, lalu bot membalas tombol yang membuka form sudah terisi.
// URL yang salah ikut dimasukkan supaya ditandai di form dan bisa diperbaiki di sana.
async function offerForm(text: string, env: Env, tg: Telegram, chatId: number, userId: number, origin: string) {
  const { unique, duplicates } = dedupeUrls(parseUrls(text));
  const valid = unique.filter(isValidUrl);
  if (!valid.length) {
    await tg.sendMessage(chatId, NO_URL_TEXT, openKeyboard(origin));
    return;
  }

  const urls = unique.slice(0, MAX_BATCH);
  const invalidCount = urls.length - urls.filter(isValidUrl).length;
  const jobId = await createJob(env, userId, urls.length === 1 ? "single" : "batch", urls, null);

  const notes: string[] = [];
  if (invalidCount) notes.push(`⚠️ ${invalidCount} bagian belum diawali https://, perbaiki di form.`);
  if (duplicates.length) notes.push(`ℹ️ ${escapeHtml(duplicateSummary(duplicates))}`);
  if (unique.length > MAX_BATCH) notes.push(`⚠️ Hanya ${MAX_BATCH} URL pertama yang dimasukkan.`);

  await tg.sendMessage(
    chatId,
    `🔗 <b>${urls.length} URL siap.</b>` +
      (notes.length ? `\n\n${notes.join("\n")}` : "") +
      "\n\nBuka form untuk memilih format dan ukuran, lalu buat QR-nya.",
    openKeyboard(origin, jobId, "🔳 Buka form yang sudah terisi"),
  );
}

async function onCallback(query: TgCallbackQuery, env: Env, tg: Telegram, origin: string) {
  const userId = query.from.id;
  const chatId = query.message?.chat.id ?? userId;
  const allowed = await isAllowed(env, userId);

  // Menghentikan animasi loading di tombol. Kalau gagal (mis. tombol sudah lama), aksi tetap dijalankan.
  await tg
    .answerCallbackQuery(query.id, allowed ? undefined : "Bot ini khusus tim énvelope.")
    .catch((error) => console.warn("answerCallbackQuery:", error));
  if (!allowed) {
    await tg.sendMessage(chatId, deniedText(userId));
    return;
  }

  if (query.data === "help") {
    await tg.sendMessage(chatId, HELP_TEXT + (isAdmin(env, userId) ? ADMIN_HELP_TEXT : ""), openKeyboard(origin));
  } else if (query.data === "history") {
    await sendHistory(env, tg, chatId, userId, origin);
  } else if (query.data === "access") {
    if (isAdmin(env, userId)) await onAdminCommand("akses", "", env, tg, chatId, userId);
    else await tg.sendMessage(chatId, "Perintah ini khusus admin.");
  } else {
    // Tombol dari pesan versi lama (alur buat QR di chat) diarahkan ke Mini App
    await tg.sendMessage(chatId, "QR sekarang dibuat lewat QR Generator.", openKeyboard(origin));
  }
}


// ==========================================
// MINI APP API
// ==========================================

async function authUser(request: Request, env: Env) {
  return verifyInitData(request.headers.get("X-Telegram-Init-Data") ?? "", env.BOT_TOKEN);
}

function forbidden(userId: number): Response {
  return json(
    {
      ok: false,
      code: "forbidden",
      userId,
      error: `Bot ini khusus tim énvelope. ID Telegram Anda: ${userId}. Kirim ID ini ke admin untuk minta akses.`,
    },
    403,
  );
}

// Mini App menanyakan apakah pengguna ini boleh memakai bot
async function handleAccess(request: Request, env: Env): Promise<Response> {
  const user = await authUser(request, env);
  if (!user) return json({ ok: false, error: "Sesi Telegram tidak valid. Buka ulang dari chat." }, 401);
  if (!(await isAllowed(env, user.id))) return forbidden(user.id);
  return json({ ok: true, userId: user.id });
}

// Mini App mengambil data job (URL & nama file) yang dibuat dari chat
async function handleGetJob(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await authUser(request, env);
  if (!user) return json({ ok: false, error: "Sesi Telegram tidak valid. Buka ulang dari chat." }, 401);
  if (!(await isAllowed(env, user.id))) return forbidden(user.id);

  const id = url.searchParams.get("id") ?? "";
  const row = await env.DB.prepare(
    "SELECT kind, urls, filename FROM jobs WHERE id = ? AND user_id = ?",
  )
    .bind(id, user.id)
    .first<{ kind: string; urls: string; filename: string | null }>();

  if (!row) {
    return json({ ok: false, error: "Data QR tidak ditemukan atau sudah kedaluwarsa. Kirim URL-nya lagi di chat." }, 404);
  }
  return json({ ok: true, kind: row.kind, urls: JSON.parse(row.urls), filename: row.filename });
}

// Mini App menyimpan job dari form, supaya muncul di riwayat dan bisa dipakai lagi
async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const user = await authUser(request, env);
  if (!user) return json({ ok: false, error: "Sesi Telegram tidak valid. Buka ulang dari chat." }, 401);
  if (!(await isAllowed(env, user.id))) return forbidden(user.id);

  const body = (await request.json().catch(() => null)) as {
    kind?: string;
    urls?: unknown;
    filename?: unknown;
  } | null;
  const urls = Array.isArray(body?.urls) ? body.urls.filter((u): u is string => typeof u === "string") : [];
  const kind = body?.kind;
  if (
    (kind !== "single" && kind !== "batch") ||
    urls.length === 0 ||
    urls.length > MAX_BATCH ||
    (kind === "single" && urls.length !== 1) ||
    urls.some((u) => u.length > 2000 || !isValidUrl(u))
  ) {
    return json({ ok: false, error: "Data job tidak valid." }, 400);
  }
  const filename =
    kind === "single" && typeof body?.filename === "string" && body.filename.trim()
      ? body.filename.trim().slice(0, 150)
      : null;
  const id = await createJob(env, user.id, kind, urls, filename);
  return json({ ok: true, id });
}

// 10 QR terakhir yang benar-benar dibuat
async function handleHistory(request: Request, env: Env): Promise<Response> {
  const user = await authUser(request, env);
  if (!user) return json({ ok: false, error: "Sesi Telegram tidak valid. Buka ulang dari chat." }, 401);
  if (!(await isAllowed(env, user.id))) return forbidden(user.id);

  const rows = await recentJobs(env, user.id);
  return json({
    ok: true,
    items: rows.map((row) => {
      const urls = JSON.parse(row.urls) as string[];
      return {
        id: row.id,
        kind: row.kind,
        count: urls.length,
        title: historyTitle({ kind: row.kind, urls, filename: row.filename }),
        usedAt: row.used_at,
      };
    }),
  });
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, i) => bytes[i] === value);
}

function safeName(name: string, extension: string): string {
  let clean = name.replace(/[\/:*?"<>|\r\n\t]/g, "-").trim().slice(0, 150);
  if (!clean.toLowerCase().endsWith(extension)) clean += extension;
  return clean;
}

const FILE_TYPES: Record<QrFormat, { mime: string; looksRight: (b: Uint8Array) => boolean }> = {
  png: { mime: "image/png", looksRight: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  svg: { mime: "image/svg+xml", looksRight: (b) => new TextDecoder().decode(b).startsWith("<svg") },
  pdf: { mime: "application/pdf", looksRight: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
};

// Mini App mengirim file hasil (PNG/SVG/PDF atau ZIP) -> diteruskan ke chat pengguna
async function handleDeliver(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await authUser(request, env);
  if (!user) return json({ ok: false, error: "Sesi Telegram tidak valid. Buka ulang dari chat." }, 401);
  if (!(await isAllowed(env, user.id))) return forbidden(user.id);

  const kind = url.searchParams.get("kind");
  const format = url.searchParams.get("format") ?? "png";
  const size = Number(url.searchParams.get("size"));
  if ((kind !== "single" && kind !== "batch") || !isQrFormat(format) || (format === "png" && !isQrSize(size))) {
    return json({ ok: false, error: "Permintaan tidak valid." }, 400);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "File terlalu besar untuk Telegram (maks 50 MB)." }, 413);
  }

  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "Ukuran file tidak valid." }, 413);
  }

  const tg = new Telegram(env.BOT_TOKEN);
  const dimension = format === "png" ? `${size} × ${size} px` : "vektor, bisa diperbesar tanpa pecah";
  const formatLine = `Format: ${FORMAT_LABEL[format]}`;

  try {
    if (kind === "single") {
      const type = FILE_TYPES[format];
      if (!type.looksRight(bytes)) {
        return json({ ok: false, error: `File bukan ${format.toUpperCase()}.` }, 400);
      }
      const filename = safeName(
        withExtension(url.searchParams.get("filename") || `QR-${format === "png" ? `${size}px` : "Code"}`, format),
        `.${format}`,
      );
      const qrUrl = (url.searchParams.get("url") ?? "").slice(0, 2000);
      const file = new Blob([buffer], { type: type.mime });

      // Pratinjau foto hanya untuk PNG (Telegram tidak bisa menampilkan SVG/PDF sebagai foto)
      if (format === "png") {
        try {
          await tg.sendFile(
            "sendPhoto",
            user.id,
            file,
            filename,
            "✅ <b>QR Code berhasil dibuat!</b>\n\n" +
              `📐 <code>${dimension}</code>\n` +
              `🔗 <code>${escapeHtml(qrUrl)}</code>`,
          );
        } catch (error) {
          console.error("sendPhoto gagal:", error);
        }
      }

      await tg.sendFile(
        "sendDocument",
        user.id,
        file,
        filename,
        (format === "png" ? "📥 <b>QR PNG HD</b>\n\n" : `📥 <b>QR ${format.toUpperCase()} untuk cetak</b>\n\n`) +
          `Nama file: <code>${escapeHtml(filename)}</code>\n` +
          (format === "png" ? "" : `🔗 <code>${escapeHtml(qrUrl)}</code>\n`) +
          `Ukuran: <code>${dimension}</code>\n` +
          `${formatLine}\n` +
          "Error Correction: H\n" +
          "✔️ Sudah dicek bisa dipindai",
        openKeyboard(url.origin, undefined, "🔳 Buat QR lagi"),
      );
    } else {
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
        return json({ ok: false, error: "File bukan ZIP." }, 400);
      }
      const count = Math.max(0, Math.min(MAX_BATCH, Number(url.searchParams.get("count")) || 0));
      await tg.sendFile(
        "sendDocument",
        user.id,
        new Blob([buffer], { type: "application/zip" }),
        batchZipName(format, size),
        "✅ <b>Batch QR selesai!</b>\n\n" +
          `📦 Jumlah QR: <code>${count}</code>\n` +
          `📐 Ukuran: <code>${dimension}</code>\n` +
          `📄 ${formatLine}\n` +
          "✔️ Semua QR sudah dicek bisa dipindai\n" +
          "⬇️ Semua QR ada di dalam ZIP.",
        openKeyboard(url.origin, undefined, "🔳 Buat QR lagi"),
      );
    }
  } catch (error) {
    console.error("Deliver error:", error);
    const message = error instanceof Error ? error.message : String(error);
    const blocked = /blocked|chat not found|initiate/i.test(message);
    return json(
      {
        ok: false,
        error: blocked
          ? "Bot tidak bisa mengirim pesan ke Anda. Buka chat bot lalu tekan Start terlebih dahulu."
          : "Gagal mengirim file ke Telegram. Coba lagi.",
      },
      502,
    );
  }

  // Tandai job sebagai dipakai supaya muncul di riwayat
  const jobId = url.searchParams.get("job");
  if (jobId) {
    await env.DB.prepare("UPDATE jobs SET used_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), jobId, user.id)
      .run();
  }

  return json({ ok: true });
}
