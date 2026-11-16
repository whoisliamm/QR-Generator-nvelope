// Pembungkus kecil untuk Telegram Bot API + validasi initData Mini App.

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export class TelegramError extends Error {
  constructor(
    public method: string,
    public description: string,
  ) {
    super(`${method}: ${description}`);
  }
}

export class Telegram {
  constructor(private token: string) {}

  async call<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new TelegramError(method, data.description ?? `HTTP ${res.status}`);
    return data.result as T;
  }

  sendMessage(chatId: number, html: string, replyMarkup?: InlineKeyboard) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  sendFile(
    method: "sendPhoto" | "sendDocument",
    chatId: number,
    file: Blob,
    filename: string,
    captionHtml: string,
    replyMarkup?: InlineKeyboard,
  ) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(method === "sendPhoto" ? "photo" : "document", file, filename);
    form.append("caption", captionHtml);
    form.append("parse_mode", "HTML");
    if (method === "sendDocument") form.append("disable_content_type_detection", "true");
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
    return this.call(method, form);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ------------------------------------------------------------------
// Validasi initData Mini App
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ------------------------------------------------------------------

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type WebAppUser = { id: number; first_name?: string; username?: string };

// Mengembalikan user jika initData asli dari Telegram dan belum kedaluwarsa, selain itu null.
export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 60 * 60,
): Promise<WebAppUser | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secretKey = await hmac(encoder.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secretKey, dataCheckString));
  if (!timingSafeEqualHex(expected, hash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null") as WebAppUser | null;
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}
