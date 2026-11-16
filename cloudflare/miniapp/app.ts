// Telegram Mini App QR Generator énvelope
//
// Mode:
//  1. ?job=<id>&format=png&size=<px>  -> dari tombol ukuran di chat. Langsung membuat QR,
//     ?job=<id>&format=svg|pdf           mengirim file ke chat, lalu menutup sendiri.
//  2. ?job=<id> saja                   -> dari riwayat: form terisi, pilih ukuran/format sendiri.
//  3. tanpa parameter                  -> formulir.
//  ?preview=<layar>                    -> semua layar tanpa Telegram, untuk mendesain.
//
// Tampilan mengikuti desain "Mini App QR énvelope" (artifact). Di luar Telegram, file diunduh langsung.

import {
  FORMATS,
  FORMAT_LABEL,
  MAX_BATCH,
  SIZES,
  autoFilename,
  batchFilename,
  batchZipName,
  cleanFilename,
  dedupeUrls,
  duplicateSummary,
  findInvalidUrls,
  isQrFormat,
  isQrSize,
  isValidUrl,
  parseUrls,
  withExtension,
  type QrFormat,
} from "../src/shared/qr";
import {
  DEFAULT_STYLE,
  VerifyError,
  loadLogo,
  renderBatchZip,
  renderOne,
  renderPdf,
  renderQr,
  renderSvg,
  scanMatches,
  styleWarning,
  type CustomLogo,
  type DotShape,
  type LogoChoice,
  type LogoSize,
  type QrStyle,
} from "./render";

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { user?: { id: number } };
  colorScheme?: "light" | "dark";
  ready(): void;
  expand(): void;
  close(): void;
  onEvent?(event: string, handler: () => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  HapticFeedback?: { notificationOccurred(type: "success" | "error" | "warning"): void };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
    __qr?: unknown;
  }
}

const tg = window.Telegram?.WebApp;
const initData = tg?.initData ?? "";
const inTelegram = initData.length > 0;

const params = new URLSearchParams(location.search);
const previewState = params.get("preview");
// Saat preview, teks dan tombol tampil versi Telegram
const telegramUi = inTelegram || previewState !== null;

type Job = { id?: string; kind: "single" | "batch"; urls: string[]; filename: string | null };
type Output = { format: QrFormat; size: number };
type Action = { label: string; run: () => void };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: { ...(init.headers ?? {}), "X-Telegram-Init-Data": initData } });
}

function describe(output: Output): string {
  return output.format === "png" ? `${output.size} × ${output.size} px` : `${output.format.toUpperCase()} vektor`;
}

function outputFilename(job: Job, output: Output): string {
  return job.kind === "single"
    ? withExtension(job.filename || autoFilename(job.urls[0]), output.format)
    : batchZipName(output.format, output.size);
}

// ==========================================
// IKON (garis sederhana, hanya di tempat yang punya makna)
// ==========================================

const svg = (size: number, body: string, width = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const QR_PATH =
  '<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><path d="M14 14h3v3h-3zM20 14v1M14 20h1M18 18h3v3"></path>';
const ICON = {
  qr: (size: number) => svg(size, QR_PATH, 1.5),
  alert: (size: number) => svg(size, '<circle cx="12" cy="12" r="9.5"></circle><path d="M12 7.5v5.5M12 16.5h.01"></path>', size < 20 ? 2 : 1.8),
  info: svg(16, '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5M12 7.5h.01"></path>', 2),
  check: svg(22, '<circle cx="12" cy="12" r="9.5"></circle><path d="M7.5 12.5l3 3 6-6.5"></path>', 2.2),
  lock: svg(44, '<rect x="5" y="10.5" width="14" height="10" rx="2"></rect><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5"></path>'),
  scanFail: svg(48, '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M9 9l6 6M15 9l-6 6"></path>'),
  file: svg(28, '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5M11 6h1M11 9h1M11 12h1M10.5 15h2v3h-2z"></path>', 1.6),
};

// ==========================================
// TEMA
// ==========================================

function applyTheme(forced?: string) {
  const root = document.documentElement;
  const scheme = forced && forced !== "auto" ? forced : inTelegram ? tg?.colorScheme : undefined;
  if (scheme === "light" || scheme === "dark") root.dataset.theme = scheme;
  else delete root.dataset.theme;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (inTelegram && bg) {
    tg?.setHeaderColor?.(bg);
    tg?.setBackgroundColor?.(bg);
  }
}

// ==========================================
// LAYAR & TOMBOL BAWAH
// ==========================================

const formView = $("form-view");
const statusView = $("status-view");
const footer = $("footer");
const footerHint = $("footer-hint");
const submitButton = $<HTMLButtonElement>("submit");
const primaryButton = $<HTMLButtonElement>("primary-action");
const secondaryButton = $<HTMLButtonElement>("secondary-action");

function setActions(primary?: Action, secondary?: Action) {
  for (const [button, action] of [
    [primaryButton, primary],
    [secondaryButton, secondary],
  ] as const) {
    button.hidden = !action;
    button.textContent = action?.label ?? "";
    button.onclick = action ? () => action.run() : null;
  }
}

function closeApp() {
  tg?.close();
}

// Tombol "Tutup"/"Kembali ke chat" hanya berguna di dalam Telegram
function closeAction(label = "Tutup"): Action | undefined {
  return telegramUi ? { label, run: closeApp } : undefined;
}

let refreshForm: () => void = () => undefined;

function showFormView() {
  formView.hidden = false;
  statusView.hidden = true;
  footer.hidden = false;
  submitButton.hidden = false;
  setActions();
  refreshForm();
}

type StatusOptions = {
  visual?: "slot" | "count" | "none";
  image?: string; // pratinjau QR hasil
  icon?: string;
  iconClass?: string;
  title: string;
  titleIcon?: string;
  detail?: string;
  count?: { done: number; total: number };
  progress?: number | "indeterminate";
  text?: string;
  box?: { label: string; value: string; kind?: "id" | "file" };
  hint?: string;
  note?: string;
  primary?: Action;
  secondary?: Action;
  alert?: boolean;
};

function showStatus(o: StatusOptions) {
  formView.hidden = true;
  statusView.hidden = false;
  submitButton.hidden = true;
  footerHint.hidden = true;

  statusView.setAttribute("aria-live", o.alert ? "assertive" : "polite");
  statusView.setAttribute("role", o.alert ? "alert" : "status");

  // Visual di atas judul: slot QR, gambar hasil, atau ikon
  const visual = $("st-visual");
  visual.innerHTML = "";
  if (o.image) {
    const tile = document.createElement("div");
    tile.className = "tile large";
    const img = document.createElement("img");
    img.src = o.image;
    img.alt = "QR yang dibuat";
    img.width = 158;
    img.height = 158;
    tile.append(img);
    visual.append(tile);
  } else if (o.visual === "slot") {
    visual.innerHTML = `<div class="tile large slot">${ICON.qr(56)}</div>`;
  } else if (o.icon) {
    visual.innerHTML = `<span class="${o.iconClass ?? "icon-muted"}">${o.icon}</span>`;
  }
  visual.hidden = !visual.innerHTML;

  const title = $("st-title");
  title.innerHTML = o.titleIcon ? `<span class="icon-success" style="display:flex">${o.titleIcon}</span>` : "";
  title.append(document.createTextNode(o.title));

  const setText = (id: string, text?: string) => {
    const el = $(id);
    el.textContent = text ?? "";
    el.hidden = !text;
  };
  setText("st-detail", o.detail);
  setText("st-text", o.text);
  setText("st-hint", o.hint);
  setText("st-note", o.note);

  const count = $("st-count");
  count.hidden = !o.count;
  if (o.count) {
    count.textContent = String(o.count.done);
    const total = document.createElement("span");
    total.textContent = ` / ${o.count.total}`;
    count.append(total);
  }

  const progress = $("st-progress");
  const bar = $("st-bar");
  progress.hidden = o.progress === undefined;
  progress.classList.toggle("indeterminate", o.progress === "indeterminate");
  if (typeof o.progress === "number") {
    bar.style.width = `${Math.round(o.progress * 100)}%`;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(Math.round(o.progress * 100)));
  } else {
    bar.style.width = "";
    progress.removeAttribute("role");
  }

  const box = $("st-box");
  box.hidden = !o.box;
  box.className = `infobox${o.box?.kind === "file" ? " file" : ""}`;
  box.innerHTML = "";
  if (o.box) {
    const label = document.createElement("span");
    label.className = "small muted";
    label.textContent = o.box.label;
    const value = document.createElement("span");
    value.className = `value${o.box.kind === "id" ? " id" : ""}`;
    value.textContent = o.box.value;
    if (o.box.kind === "file") {
      box.innerHTML = `<span class="icon-muted" style="display:flex">${ICON.file}</span>`;
      const text = document.createElement("div");
      text.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0";
      text.append(value, label);
      box.append(text);
    } else {
      box.append(label, value);
    }
  }

  setActions(o.primary, o.secondary);
  footer.hidden = !o.primary && !o.secondary;
}

// ---------- layar-layar status ----------

function showLoading() {
  showStatus({ visual: "slot", title: "Memuat data", progress: "indeterminate" });
}

function showLocked(userId?: number) {
  const id = userId ?? tg?.initDataUnsafe?.user?.id;
  const copy: Action | undefined =
    id !== undefined
      ? {
          label: "Salin ID",
          run: async () => {
            try {
              await navigator.clipboard.writeText(String(id));
              primaryButton.textContent = "ID disalin";
            } catch {
              primaryButton.textContent = "Salin manual dari kotak di atas";
            }
          },
        }
      : undefined;
  showStatus({
    icon: ICON.lock,
    title: "Akses terbatas",
    text: "Bot ini khusus tim énvelope. Kirim ID Telegram Anda ke admin untuk minta akses.",
    box: id !== undefined ? { label: "ID Telegram Anda", value: String(id), kind: "id" } : undefined,
    primary: copy,
    secondary: closeAction(),
    alert: true,
  });
  tg?.HapticFeedback?.notificationOccurred("warning");
}

function showProblem(message: string, retry?: () => void, fromForm = false) {
  showStatus({
    icon: ICON.alert(48),
    iconClass: "icon-danger",
    title: "Ada masalah",
    text: message,
    primary: retry ? { label: "Coba lagi", run: retry } : undefined,
    secondary: fromForm ? { label: "Kembali ke form", run: showFormView } : closeAction(),
    alert: true,
  });
  tg?.HapticFeedback?.notificationOccurred("error");
}

function showVerifyFailed(error: VerifyError, fromForm: boolean) {
  const [first] = error.failures;
  const others = error.failures.length - 1;
  const which = first.position > 0 ? `URL ke-${first.position}` : "URL ini";
  showStatus({
    icon: ICON.scanFail,
    iconClass: "icon-danger",
    title: "QR tidak lolos cek scan",
    text:
      `QR untuk ${which}${others > 0 ? ` dan ${others} URL lainnya` : ""} tidak terbaca saat dicek, ` +
      "jadi belum ada file yang dikirim.",
    box: { label: first.position > 0 ? `URL ke-${first.position}` : "URL", value: first.url },
    hint: "Biasanya karena URL terlalu panjang. Persingkat URL-nya, lalu buat lagi.",
    primary: fromForm
      ? {
          label: "Perbaiki URL",
          run: () => {
            showFormView();
            $("urls").focus();
          },
        }
      : closeAction("Perbaiki di chat"),
    secondary: fromForm ? closeAction() : undefined,
    alert: true,
  });
  tg?.HapticFeedback?.notificationOccurred("error");
}

// ==========================================
// BUAT & KIRIM
// ==========================================

function setBusy(busy: boolean) {
  if (busy) tg?.enableClosingConfirmation?.();
  else tg?.disableClosingConfirmation?.();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function workingNote(autoClose: boolean): string {
  if (!inTelegram && !telegramUi) return "QR dicek bisa dipindai sebelum diunduh.";
  return autoClose
    ? "QR dicek bisa dipindai sebelum dikirim. Biarkan layar ini terbuka, layar menutup sendiri setelah file terkirim."
    : "QR dicek bisa dipindai sebelum dikirim. Biarkan layar ini terbuka.";
}

async function produce(job: Job, output: Output, autoClose: boolean): Promise<Blob> {
  const style = await activeStyle();
  const logo = output.format === "png" && style.logo === "envelope" ? await loadLogo().catch(() => null) : null;
  if (job.kind === "single") {
    showStatus({
      visual: "slot",
      title: "Membuat QR",
      detail: `${outputFilename(job, output)} · ${describe(output)}`,
      progress: "indeterminate",
      note: workingNote(autoClose),
    });
    await nextFrame();
    return renderOne(job.urls[0], output.format, output.size, style, logo);
  }
  const total = job.urls.length;
  const batchStatus = (done: number, current: string) =>
    showStatus({
      visual: "count",
      title: `Membuat ${total} QR`,
      detail: `${describe(output)} · dikirim sebagai ZIP`,
      count: { done, total },
      progress: done / total,
      hint: current ? `Dibuat dan dicek: ${current}` : undefined,
      note: workingNote(autoClose),
    });
  batchStatus(0, "");
  await nextFrame();
  return renderBatchZip(job.urls, output.format, output.size, style, logo, (done, _total, current) =>
    batchStatus(done, current),
  );
}

function downloadLocally(blob: Blob, filename: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

async function deliver(job: Job, output: Output, blob: Blob) {
  const filename = outputFilename(job, output);
  if (!inTelegram) {
    downloadLocally(blob, filename);
    return;
  }

  const query = new URLSearchParams({ kind: job.kind, format: output.format, size: String(output.size) });
  if (job.id) query.set("job", job.id);
  if (job.kind === "single") {
    query.set("filename", filename);
    query.set("url", job.urls[0]);
  } else {
    query.set("count", String(job.urls.length));
  }

  showStatus({
    title: "Mengirim ke chat",
    detail: job.kind === "single" ? "QR selesai dibuat" : `${job.urls.length} QR selesai dibuat`,
    box: { label: `${(blob.size / 1024 / 1024).toFixed(1).replace(".", ",")} MB`, value: filename, kind: "file" },
    progress: "indeterminate",
    note: "Lama pengiriman tergantung koneksi internet Anda.",
  });

  const res = await api(`api/deliver?${query}`, {
    method: "POST",
    headers: { "content-type": blob.type },
    body: blob,
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; userId?: number };
  if (data.code === "forbidden") throw new LockedError(data.userId);
  if (!res.ok || !data.ok) throw new Error(data.error || `Server error (${res.status}).`);
}

class LockedError extends Error {
  constructor(public userId?: number) {
    super("forbidden");
  }
}

let resultImage: string | null = null;

// Gambar kecil untuk layar Berhasil, dengan tampilan yang sama. SVG dipakai untuk semua format karena ringan.
function resultPreview(job: Job, style: QrStyle = styleFrom(loadSettings())): string {
  if (resultImage) URL.revokeObjectURL(resultImage);
  resultImage = URL.createObjectURL(new Blob([renderSvg(job.urls[0], style)], { type: "image/svg+xml" }));
  return resultImage;
}

async function run(job: Job, output: Output, autoClose: boolean) {
  setBusy(true);
  let blob: Blob;
  try {
    blob = await produce(job, output, autoClose);
  } catch (error) {
    setBusy(false);
    if (error instanceof VerifyError) showVerifyFailed(error, !autoClose);
    else showProblem(error instanceof Error ? error.message : String(error), () => run(job, output, autoClose), !autoClose);
    return;
  }
  await send(job, output, blob, autoClose);
}

// Dipisah dari pembuatan QR supaya "Coba kirim lagi" tidak membuat ulang QR
async function send(job: Job, output: Output, blob: Blob, autoClose: boolean) {
  setBusy(true);
  try {
    await deliver(job, output, blob);
  } catch (error) {
    setBusy(false);
    if (error instanceof LockedError) {
      showLocked(error.userId);
      return;
    }
    showStatus({
      icon: ICON.alert(48),
      iconClass: "icon-danger",
      title: "File belum terkirim",
      text: error instanceof Error ? error.message : String(error),
      hint: "QR yang sudah dibuat tidak perlu dibuat ulang.",
      primary: { label: "Coba kirim lagi", run: () => send(job, output, blob, autoClose) },
      secondary: autoClose ? closeAction() : { label: "Kembali ke form", run: showFormView },
      alert: true,
    });
    tg?.HapticFeedback?.notificationOccurred("error");
    return;
  }

  setBusy(false);
  tg?.HapticFeedback?.notificationOccurred("success");
  const filename = outputFilename(job, output);
  const what =
    job.kind === "batch"
      ? "Semua QR sudah dicek bisa dipindai. ZIP sudah ada di chat."
      : output.format === "png"
        ? "Sudah dicek bisa dipindai. Pratinjau dan file PNG HD sudah ada di chat."
        : `Sudah dicek bisa dipindai. File ${output.format.toUpperCase()} sudah ada di chat.`;
  showStatus({
    image: resultPreview(job),
    title: inTelegram ? "Terkirim ke chat" : "File sudah diunduh",
    titleIcon: ICON.check,
    detail: job.kind === "single" ? `${filename} · ${describe(output)}` : `${job.urls.length} QR · ${filename}`,
    text: inTelegram ? what + (autoClose ? " Layar ini menutup sendiri." : "") : "Sudah dicek bisa dipindai.",
    primary: autoClose ? undefined : { label: "Buat QR lagi", run: showFormView },
    secondary: closeAction("Kembali ke chat"),
  });
  if (!autoClose) loadHistory();
  if (autoClose && inTelegram) setTimeout(closeApp, 1200);
}

// ==========================================
// JOB DARI CHAT / RIWAYAT
// ==========================================

async function fetchJob(jobId: string): Promise<Job | null> {
  const res = await api(`api/job?id=${encodeURIComponent(jobId)}`);
  const data = (await res.json()) as Job & { ok: boolean; error?: string; code?: string; userId?: number };
  if (data.code === "forbidden") {
    showLocked(data.userId);
    return null;
  }
  if (!data.ok) throw new Error(data.error || "Data QR tidak ditemukan.");
  return { id: jobId, kind: data.kind, urls: data.urls, filename: data.filename };
}

async function startJobMode(jobId: string, output: Output) {
  if (!inTelegram) {
    showProblem("Halaman ini harus dibuka dari tombol di chat Telegram.");
    return;
  }
  if (output.format === "png" && !isQrSize(output.size)) {
    showProblem("Ukuran QR tidak valid.");
    return;
  }
  showLoading();
  try {
    const job = await fetchJob(jobId);
    if (job) await run(job, output, true);
  } catch (error) {
    showProblem(error instanceof Error ? error.message : String(error), () => startJobMode(jobId, output));
  }
}

// ==========================================
// FORM
// ==========================================

const SETTINGS_KEY = "envelope-qr-settings";
const LOGO_KEY = "envelope-qr-logo";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

type Settings = {
  format: QrFormat;
  size: number;
  open: boolean;
  shape: DotShape;
  fg: string;
  bg: string;
  logo: LogoChoice;
  logoSize: LogoSize;
};

const STYLE_DEFAULTS = {
  shape: DEFAULT_STYLE.shape,
  fg: DEFAULT_STYLE.fg,
  bg: DEFAULT_STYLE.bg,
  logo: DEFAULT_STYLE.logo,
  logoSize: DEFAULT_STYLE.logoSize,
};

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const hexColor = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;

function loadSettings(): Settings {
  const fallback: Settings = { format: "png", size: 2000, open: false, ...STYLE_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    return {
      format: isQrFormat(saved?.format) ? saved.format : fallback.format,
      size: isQrSize(Number(saved?.size)) ? Number(saved?.size) : fallback.size,
      open: saved?.open === true,
      shape: oneOf(saved?.shape, ["square", "rounded", "dots"] as const, fallback.shape),
      fg: hexColor(saved?.fg, fallback.fg),
      bg: hexColor(saved?.bg, fallback.bg),
      logo: oneOf(saved?.logo, ["envelope", "custom", "none"] as const, fallback.logo),
      logoSize: oneOf(saved?.logoSize, ["small", "medium", "large"] as const, fallback.logoSize),
    };
  } catch {
    return fallback;
  }
}

// ---------- logo sendiri (disimpan di perangkat ini) ----------

let customLogo: CustomLogo | null = null;
let customLogoName = "";
let customLogoReady: Promise<void> | null = null;

function imageFrom(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Gambar logo tidak bisa dibaca."));
    img.src = src;
  });
}

function loadCustomLogo(): Promise<void> {
  customLogoReady ??= (async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(LOGO_KEY) ?? "null") as { name?: string; dataUrl?: string } | null;
      if (saved?.dataUrl?.startsWith("data:image/")) {
        customLogo = { image: await imageFrom(saved.dataUrl), dataUrl: saved.dataUrl };
        customLogoName = saved.name || "logo";
      }
    } catch {
      // Logo tersimpan rusak atau penyimpanan tidak tersedia: anggap belum ada logo
    }
  })();
  return customLogoReady;
}

// Logo diperkecil ke maks 512 px (cukup tajam untuk QR 4000 px dengan logo 22%) lalu disimpan sebagai PNG
async function importLogo(file: File): Promise<string | null> {
  if (!["image/png", "image/jpeg"].includes(file.type)) return "Pakai gambar PNG atau JPG.";
  if (file.size > MAX_LOGO_BYTES) return "Ukuran gambar maksimal 2 MB.";
  const source = await imageFrom(URL.createObjectURL(file));
  const scale = Math.min(1, 512 / Math.max(source.naturalWidth, source.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(source.src);
  const dataUrl = canvas.toDataURL("image/png");
  customLogo = { image: await imageFrom(dataUrl), dataUrl };
  customLogoName = file.name;
  try {
    localStorage.setItem(LOGO_KEY, JSON.stringify({ name: file.name, dataUrl }));
  } catch {
    return "Logo dipakai sampai halaman ditutup, tapi tidak bisa disimpan di perangkat ini.";
  }
  return null;
}

function styleFrom(settings: Settings): QrStyle {
  return {
    shape: settings.shape,
    fg: settings.fg,
    bg: settings.bg,
    // Logo sendiri dipilih tapi belum ada gambarnya: pakai logo énvelope
    logo: settings.logo === "custom" && !customLogo ? "envelope" : settings.logo,
    logoSize: settings.logoSize,
    customLogo,
  };
}

async function activeStyle(): Promise<QrStyle> {
  await loadCustomLogo();
  return styleFrom(loadSettings());
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Penyimpanan tidak tersedia (mode privat): pilihan tetap berlaku sampai halaman ditutup
  }
}

let fillForm: (job: Job) => void = () => undefined;

function startFormView() {
  const form = $<HTMLFormElement>("form");
  const urlsInput = $<HTMLTextAreaElement>("urls");
  const filenameInput = $<HTMLInputElement>("filename");
  const toggle = $<HTMLButtonElement>("advanced-toggle");
  const panel = $("advanced-panel");
  const settings = loadSettings();
  let loadedJob: Job | null = null;

  $("max-batch").textContent = String(MAX_BATCH);

  // ---------- pilihan format & ukuran ----------
  const makeOptions = <T extends string | number>(
    containerId: string,
    values: readonly T[],
    label: (v: T) => string,
    isOn: (v: T) => boolean,
    pick: (v: T) => void,
    ariaLabel?: (v: T) => string,
  ) => {
    const container = $(containerId);
    container.innerHTML = "";
    return values.map((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label(value);
      if (ariaLabel) button.setAttribute("aria-label", ariaLabel(value));
      button.onclick = () => {
        pick(value);
        saveSettings(settings);
        update();
      };
      container.append(button);
      return () => button.setAttribute("aria-pressed", String(isOn(value)));
    });
  };
  const formatButtons = makeOptions(
    "formats",
    FORMATS,
    (f) => f.toUpperCase(),
    (f) => f === settings.format,
    (f) => (settings.format = f),
  );
  const sizeButtons = makeOptions(
    "sizes",
    SIZES,
    (s) => String(s),
    (s) => s === settings.size,
    (s) => (settings.size = s),
  );

  // ---------- tampilan QR ----------
  const SHAPE_LABEL = { square: "Kotak", rounded: "Membulat", dots: "Bulat" } as const;
  const LOGO_LABEL = { envelope: "énvelope", custom: "Logo sendiri", none: "Tanpa" } as const;
  const LOGO_SIZE_LABEL = { small: "Kecil", medium: "Sedang", large: "Besar" } as const;
  const styleRefreshers = [
    ...makeOptions("shapes", ["square", "rounded", "dots"] as const, (v) => SHAPE_LABEL[v], (v) => v === settings.shape, (v) => (settings.shape = v)),
    ...makeOptions("logos", ["envelope", "custom", "none"] as const, (v) => LOGO_LABEL[v], (v) => v === settings.logo, (v) => (settings.logo = v)),
    ...makeOptions(
      "logo-sizes",
      ["small", "medium", "large"] as const,
      (v) => LOGO_SIZE_LABEL[v],
      (v) => v === settings.logoSize,
      (v) => (settings.logoSize = v),
    ),
  ];

  // Bulatan warna + tombol "Lainnya" (pemilih warna bawaan perangkat)
  const makeSwatches = (
    containerId: string,
    inputId: string,
    colors: readonly (readonly [string, string])[],
    get: () => string,
    set: (hex: string) => void,
  ) => {
    const container = $(containerId);
    const input = $<HTMLInputElement>(inputId);
    container.innerHTML = "";
    const choose = (hex: string) => {
      set(hex.toUpperCase());
      saveSettings(settings);
      update();
    };
    const buttons = colors.map(([name, hex]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.setAttribute("aria-label", `Warna ${name.toLowerCase()}`);
      const dot = document.createElement("span");
      dot.style.background = hex;
      button.append(dot);
      button.onclick = () => choose(hex);
      container.append(button);
      return [button, hex] as const;
    });
    const more = document.createElement("button");
    more.type = "button";
    more.className = "swatch-more";
    const moreDot = document.createElement("span");
    moreDot.className = "dot";
    more.append(moreDot, document.createTextNode("Lainnya"));
    more.onclick = () => {
      input.value = get().toLowerCase();
      const picker = input as HTMLInputElement & { showPicker?: () => void };
      try {
        if (picker.showPicker) picker.showPicker();
        else input.click();
      } catch {
        input.click();
      }
    };
    input.oninput = () => choose(input.value);
    container.append(more);
    return () => {
      const current = get().toUpperCase();
      let preset = false;
      for (const [button, hex] of buttons) {
        const on = hex.toUpperCase() === current;
        preset ||= on;
        button.setAttribute("aria-pressed", String(on));
      }
      more.setAttribute("aria-pressed", String(!preset));
      more.setAttribute("aria-label", preset ? "Warna lainnya" : `Warna lainnya, sekarang ${current}`);
      moreDot.style.background = preset ? "transparent" : current;
    };
  };
  styleRefreshers.push(
    makeSwatches(
      "fg-swatches",
      "fg-custom",
      [["Hitam", "#000000"], ["Charcoal", "#222222"], ["Biru tua", "#1F3A5F"], ["Biru énvelope", "#2F72A6"]],
      () => settings.fg,
      (hex) => (settings.fg = hex),
    ),
    makeSwatches(
      "bg-swatches",
      "bg-custom",
      [["Putih", "#FFFFFF"], ["Krem", "#FBF7F0"], ["Abu muda", "#F4F5F7"]],
      () => settings.bg,
      (hex) => (settings.bg = hex),
    ),
  );

  // Unggah logo sendiri
  const logoInput = $<HTMLInputElement>("logo-input");
  let logoMessage = "";
  $("logo-pick").onclick = () => logoInput.click();
  logoInput.onchange = async () => {
    const file = logoInput.files?.[0];
    logoInput.value = "";
    if (!file) return;
    try {
      logoMessage = (await importLogo(file)) ?? "";
      if (customLogo) settings.logo = "custom";
    } catch (error) {
      logoMessage = error instanceof Error ? error.message : String(error);
    }
    saveSettings(settings);
    update();
  };
  const refreshLogoFile = () => {
    const custom = settings.logo === "custom";
    $("logo-file").hidden = !custom;
    $("logo-options").hidden = settings.logo === "none";
    const thumb = $("logo-thumb");
    thumb.innerHTML = "";
    if (customLogo) {
      const img = document.createElement("img");
      img.src = customLogo.dataUrl;
      img.alt = "";
      thumb.append(img);
    } else {
      thumb.textContent = "LOGO";
    }
    $("logo-name").textContent = customLogo ? customLogoName : "Belum ada gambar";
    $("logo-hint").textContent = logoMessage || "PNG atau JPG, maks 2 MB";
    $("logo-pick").textContent = customLogo ? "Ganti" : "Pilih";
    $("logo-pick").setAttribute("aria-label", customLogo ? "Ganti gambar logo" : "Pilih gambar logo");
  };

  $("style-reset").onclick = () => {
    Object.assign(settings, STYLE_DEFAULTS);
    logoMessage = "";
    saveSettings(settings);
    update();
  };

  const previewRow = formView.querySelector<HTMLElement>(".preview")!;
  const setOpen = (open: boolean) => {
    settings.open = open;
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    previewRow.classList.toggle("sticky", open);
  };
  toggle.onclick = () => {
    setOpen(!settings.open);
    saveSettings(settings);
  };
  setOpen(settings.open);

  // ---------- pratinjau QR langsung ----------
  const tile = $("preview-tile");
  let previewUrl: string | null = null;
  let previewFor = "";
  let previewTimer = 0;
  const showPreview = (url: string | null, style: QrStyle) => {
    const key = url
      ? [url, style.shape, style.fg, style.bg, style.logo, style.logoSize, style.customLogo ? customLogoName : ""].join("|")
      : "";
    if (key === previewFor && (url || tile.classList.contains("empty"))) return;
    // Jeda hanya saat mengetik; pratinjau pertama (dari kosong) langsung tampil
    const delay = previewFor ? 200 : 0;
    previewFor = key;
    window.clearTimeout(previewTimer);
    if (!url) {
      tile.className = "tile empty";
      tile.innerHTML = ICON.qr(40);
      return;
    }
    previewTimer = window.setTimeout(() => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([renderSvg(url, style)], { type: "image/svg+xml" }));
      tile.className = "tile";
      tile.innerHTML = "";
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = `Pratinjau QR untuk ${url}`;
      img.width = 98;
      img.height = 98;
      tile.append(img);
    }, delay);
  };

  // ---------- tampilan form mengikuti isi ----------
  const notice = (id: string, icon: string, text: string) => {
    const el = $(id);
    el.hidden = !text;
    el.innerHTML = text ? icon : "";
    if (text) {
      const span = document.createElement("span");
      span.textContent = text;
      el.append(span);
    }
  };

  const output = (): Output => ({ format: settings.format, size: settings.size });

  const update = () => {
    const parsed = parseUrls(urlsInput.value);
    const invalid = findInvalidUrls(parsed);
    const { unique, duplicates } = dedupeUrls(parsed);
    const valid = unique.filter(isValidUrl);
    const single = unique.length <= 1;
    const tooMany = unique.length > MAX_BATCH;
    const out = output();
    const vector = out.format !== "png";

    formatButtons.forEach((refresh) => refresh());
    sizeButtons.forEach((refresh) => refresh());
    styleRefreshers.forEach((refresh) => refresh());
    refreshLogoFile();
    const style = styleFrom(settings);
    notice("style-warning", ICON.alert(16), styleWarning(style) ?? "");
    const needsLogo = settings.logo === "custom" && !customLogo;

    // Hitungan & pesan di bawah URL
    const count = $("url-count");
    count.textContent = unique.length > 1 ? `${unique.length} / ${MAX_BATCH}` : "";
    count.classList.toggle("over", tooMany);

    const firstInvalid = invalid[0];
    const errorText = firstInvalid
      ? `URL ke-${firstInvalid.position} (${firstInvalid.url.slice(0, 40)}) belum diawali https://` +
        (invalid.length > 1 ? `, dan ${invalid.length - 1} URL lainnya.` : "")
      : tooMany
        ? `Maksimal ${MAX_BATCH} URL dalam satu batch, sekarang ${unique.length}.`
        : "";
    notice("urls-error", ICON.alert(16), errorText);
    urlsInput.setAttribute("aria-invalid", String(!!errorText));
    notice("dup-note", ICON.info, duplicates.length ? duplicateSummary(duplicates) : "");

    // Lanjutan
    $("filename-field").hidden = !single;
    $("size-field").hidden = vector;
    $("vector-note").hidden = !vector;
    const cm = ((out.size / 300) * 2.54).toFixed(1).replace(".", ",");
    $("print-size").textContent = `Dicetak 300 dpi: ${cm} × ${cm} cm`;
    const nameSummary = !single ? "nama dari tiap URL" : filenameInput.value.trim() ? "nama sendiri" : "nama otomatis";
    const styleParts: string[] = [];
    if (settings.shape !== "square") styleParts.push(settings.shape === "dots" ? "titik bulat" : "titik membulat");
    if (settings.fg !== DEFAULT_STYLE.fg || settings.bg !== DEFAULT_STYLE.bg) styleParts.push("warna kustom");
    if (settings.logo === "custom") styleParts.push("logo sendiri");
    if (settings.logo === "none") styleParts.push("tanpa logo");
    $("advanced-summary").textContent = [
      vector ? `${out.format.toUpperCase()} vektor` : `PNG · ${out.size} px`,
      nameSummary,
      ...styleParts,
    ].join(" · ");

    // Pratinjau
    const title = $("preview-title");
    const line1 = $("preview-line1");
    const line2 = $("preview-line2");
    showPreview(valid[0] ?? null, style);
    if (!valid.length) {
      title.textContent = "Pratinjau QR";
      line1.textContent = "Muncul di sini setelah URL diisi.";
      line2.textContent = "";
    } else if (single) {
      const name = filenameInput.value.trim() ? cleanFilename(filenameInput.value) : autoFilename(valid[0]);
      title.textContent = withExtension(name, out.format);
      line1.textContent = valid[0];
      line2.textContent = vector
        ? `${out.format.toUpperCase()} vektor · 10 × 10 cm, bisa diperbesar`
        : `${out.size} × ${out.size} px · PNG`;
    } else {
      title.textContent = `${unique.length} URL dalam satu ZIP`;
      line1.textContent = batchZipName(out.format, out.size);
      line2.textContent = `Nama tiap file dari akhir URL, misalnya ${withExtension(batchFilename(valid[0], 1), out.format)}`;
    }

    // Tombol bawah
    let hint = "";
    if (!unique.length) hint = "Isi minimal satu URL untuk membuat QR.";
    else if (firstInvalid) hint = invalid.length === 1 ? `Perbaiki URL ke-${firstInvalid.position} dulu, lalu QR bisa dibuat.` : `Perbaiki ${invalid.length} URL dulu, lalu QR bisa dibuat.`;
    else if (tooMany) hint = `Kurangi jadi maksimal ${MAX_BATCH} URL dulu.`;
    else if (needsLogo) hint = "Pilih gambar logo dulu di Lanjutan, atau pakai logo énvelope.";
    footerHint.textContent = hint;
    footerHint.hidden = !hint;
    submitButton.disabled = !!hint;
    const target = telegramUi ? " dan kirim ke chat" : " dan unduh";
    submitButton.textContent = !unique.length ? "Buat QR" : (single ? "Buat QR" : `Buat ${unique.length} QR`) + target;
  };

  // Handler properti (bukan addEventListener) supaya aman bila form disiapkan ulang di mode preview
  refreshForm = update;
  urlsInput.oninput = update;
  filenameInput.oninput = update;

  fillForm = (job: Job) => {
    urlsInput.value = job.urls.join("\n");
    filenameInput.value =
      job.kind === "single" && job.filename ? job.filename.replace(/^QR-|\.(png|svg|pdf)$/g, "").replace(/-/g, " ") : "";
    loadedJob = job;
    showFormView();
    window.scrollTo({ top: 0, behavior: "smooth" });
    urlsInput.focus();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    update();
    if (submitButton.disabled) return;
    const { unique } = dedupeUrls(parseUrls(urlsInput.value));
    const job: Job =
      unique.length === 1
        ? {
            kind: "single",
            urls: unique,
            filename: filenameInput.value.trim() ? cleanFilename(filenameInput.value) : autoFilename(unique[0]),
          }
        : { kind: "batch", urls: unique, filename: null };
    submitButton.disabled = true;
    job.id = await saveJob(job, loadedJob);
    await run(job, output(), false);
  };

  showFormView();
  // Logo sendiri yang tersimpan dimuat belakangan, lalu form diperbarui
  loadCustomLogo().then(() => refreshForm());
}

// Simpan job supaya muncul di riwayat. Isi yang sama dengan job dari riwayat memakai job itu lagi.
async function saveJob(job: Job, loaded: Job | null): Promise<string | undefined> {
  if (!inTelegram) return undefined;
  if (
    loaded?.id &&
    loaded.kind === job.kind &&
    loaded.filename === job.filename &&
    loaded.urls.join("\n") === job.urls.join("\n")
  ) {
    return loaded.id;
  }
  try {
    const res = await api("api/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: job.kind, urls: job.urls, filename: job.filename }),
    });
    const data = (await res.json()) as { ok?: boolean; id?: string };
    return data.ok ? data.id : undefined;
  } catch {
    return undefined; // riwayat hanya bonus, QR tetap dibuat
  }
}

// ==========================================
// RIWAYAT
// ==========================================

type HistoryItem = { id: string; kind: string; count: number; title: string; usedAt: number };

function renderHistory(items: HistoryItem[], onPick: (item: HistoryItem, button: HTMLButtonElement) => void) {
  const section = $("history");
  const list = $("history-list");
  section.hidden = false;
  list.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Belum ada. QR yang sudah dikirim muncul di sini selama 30 hari.";
    list.append(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const text = document.createElement("div");
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "small muted";
    meta.textContent = `${item.count} URL · ${new Date(item.usedAt).toLocaleString("id-ID", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
    text.append(title, meta);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-small";
    button.textContent = "Pakai lagi";
    button.setAttribute("aria-label", `Pakai lagi ${item.title}`);
    button.onclick = () => onPick(item, button);
    li.append(text, button);
    list.append(li);
  }
}

async function loadHistory() {
  if (!inTelegram) return;
  try {
    const res = await api("api/history");
    const data = (await res.json()) as { ok?: boolean; items?: HistoryItem[] };
    if (!data.ok || !data.items) return;
    renderHistory(data.items, async (item, button) => {
      button.disabled = true;
      try {
        const job = await fetchJob(item.id);
        if (job) fillForm(job);
      } catch (error) {
        showProblem(error instanceof Error ? error.message : String(error), undefined, true);
      }
      button.disabled = false;
    });
  } catch {
    // Riwayat gagal dimuat: form tetap bisa dipakai
  }
}

async function checkAccess(): Promise<boolean> {
  if (!inTelegram) return true;
  try {
    const res = await api("api/access");
    const data = (await res.json()) as { code?: string; userId?: number };
    if (data.code === "forbidden") {
      showLocked(data.userId);
      return false;
    }
  } catch {
    // Jaringan bermasalah: form tetap dibuka, server tetap menolak saat mengirim
  }
  return true;
}

// ==========================================
// MODE PREVIEW (untuk desain, tanpa Telegram)
// ==========================================

const SAMPLE_URL = "https://website.com/tamu/andi";
const SAMPLE_BATCH =
  "https://website.com/tamu/andi, https://website.com/tamu/budi\nhttps://website.com/tamu/citra | website.com/tamu/dewi\nhttps://website.com/tamu/eka https://website.com/tamu/andi";

function fillPreviewForm(urls: string, open: boolean, format: QrFormat, name = "", style: Partial<Settings> = {}) {
  saveSettings({ format, size: 2000, open, ...STYLE_DEFAULTS, ...style });
  startFormView();
  $<HTMLTextAreaElement>("urls").value = urls;
  $<HTMLInputElement>("filename").value = name;
  renderHistory(
    [
      { id: "a", kind: "single", count: 1, title: "QR-andi.png", usedAt: Date.now() - 3_600_000 },
      { id: "b", kind: "batch", count: 50, title: "Batch 50 URL", usedAt: Date.now() - 86_400_000 },
    ],
    () => fillForm({ kind: "single", urls: [SAMPLE_URL], filename: "QR-andi.png" }),
  );
  refreshForm();
}

const PREVIEW_STATES: Record<string, { label: string; show: () => void }> = {
  form: { label: "Form kosong", show: () => fillPreviewForm("", false, "png") },
  single: { label: "Form 1 URL", show: () => fillPreviewForm(SAMPLE_URL, false, "png") },
  advanced: { label: "Lanjutan", show: () => fillPreviewForm(SAMPLE_URL, true, "pdf", "Andreas Hada") },
  batchform: { label: "Form batch", show: () => fillPreviewForm(SAMPLE_BATCH, false, "png") },
  style: {
    label: "Tampilan",
    show: () => fillPreviewForm(SAMPLE_URL, true, "png", "", { shape: "dots", fg: "#1F3A5F" }),
  },
  contrast: {
    label: "Kontras",
    show: () => fillPreviewForm(SAMPLE_URL, true, "png", "", { fg: "#B9C2CC" }),
  },
  loading: {
    label: "Membuat",
    show: () =>
      showStatus({
        visual: "slot",
        title: "Membuat QR",
        detail: "QR-andi.png · 4000 × 4000 px",
        progress: "indeterminate",
        note: workingNote(true),
      }),
  },
  batch: {
    label: "Batch",
    show: () =>
      showStatus({
        visual: "count",
        title: "Membuat 50 QR",
        detail: "4000 × 4000 px · dikirim sebagai ZIP",
        count: { done: 23, total: 50 },
        progress: 23 / 50,
        hint: "Dibuat dan dicek: QR-tamu-23.png",
        note: workingNote(true),
      }),
  },
  sending: {
    label: "Mengirim",
    show: () =>
      showStatus({
        title: "Mengirim ke chat",
        detail: "50 QR selesai dibuat",
        box: { label: "14,5 MB", value: "QR-Batch-4000px.zip", kind: "file" },
        progress: "indeterminate",
        note: "Lama pengiriman tergantung koneksi internet Anda.",
      }),
  },
  success: {
    label: "Berhasil",
    show: () =>
      showStatus({
        image: resultPreview({ kind: "single", urls: [SAMPLE_URL], filename: null }),
        title: "Terkirim ke chat",
        titleIcon: ICON.check,
        detail: "QR-andi.png · 4000 × 4000 px",
        text: "Sudah dicek bisa dipindai. Pratinjau dan file PNG HD sudah ada di chat. Layar ini menutup sendiri.",
        secondary: closeAction("Kembali ke chat"),
      }),
  },
  failed: {
    label: "Gagal kirim",
    show: () =>
      showStatus({
        icon: ICON.alert(48),
        iconClass: "icon-danger",
        title: "File belum terkirim",
        text: "Bot tidak bisa mengirim pesan ke Anda. Buka chat bot lalu tekan Start terlebih dahulu.",
        hint: "QR yang sudah dibuat tidak perlu dibuat ulang.",
        primary: { label: "Coba kirim lagi", run: () => undefined },
        secondary: closeAction(),
        alert: true,
      }),
  },
  verify: {
    label: "Cek gagal",
    show: () => showVerifyFailed(new VerifyError([{ position: 7, url: "https://website.com/tamu/nama-yang-sangat-panjang" }]), true),
  },
  locked: { label: "Akses", show: () => showLocked(123456789) },
};

const THEMES: Record<string, string> = { auto: "Otomatis", light: "Terang", dark: "Gelap" };

function startPreviewMode(initial: string) {
  const bar = document.createElement("nav");
  bar.className = "preview-bar";
  bar.setAttribute("aria-label", "Preview layar");
  document.body.prepend(bar);

  let state = initial in PREVIEW_STATES ? initial : "form";
  let theme = params.get("theme") ?? "auto";

  const render = () => {
    applyTheme(theme);
    $("history").hidden = true;
    PREVIEW_STATES[state].show();

    const url = new URL(location.href);
    url.searchParams.set("preview", state);
    if (theme === "auto") url.searchParams.delete("theme");
    else url.searchParams.set("theme", theme);
    history.replaceState(null, "", url);

    bar.innerHTML =
      `<div class="preview-row">${Object.entries(PREVIEW_STATES)
        .map(([key, s]) => `<button type="button" data-state="${key}" aria-pressed="${key === state}">${s.label}</button>`)
        .join("")}</div>` +
      `<div class="preview-row">${Object.entries(THEMES)
        .map(([key, label]) => `<button type="button" data-theme-option="${key}" aria-pressed="${key === theme}">${label}</button>`)
        .join("")}</div>`;
  };

  bar.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button) return;
    if (button.dataset.state) state = button.dataset.state;
    if (button.dataset.themeOption) theme = button.dataset.themeOption;
    render();
  });

  render();
}

// ==========================================
// START
// ==========================================

tg?.ready();
tg?.expand();
tg?.disableVerticalSwipes?.();
applyTheme();
tg?.onEvent?.("themeChanged", () => applyTheme());

const jobId = params.get("job");
const formatParam = params.get("format");
const sizeParam = Number(params.get("size"));

if (previewState !== null && !inTelegram) {
  startPreviewMode(previewState);
} else if (jobId && isQrFormat(formatParam)) {
  // Dari tombol ukuran/format di chat: langsung buat & kirim
  startJobMode(jobId, { format: formatParam, size: formatParam === "png" ? sizeParam : 1000 });
} else if (jobId && !formatParam && params.has("size")) {
  // Tombol lama (sebelum ada pilihan format) tetap jalan sebagai PNG
  startJobMode(jobId, { format: "png", size: sizeParam });
} else {
  startFormView();
  checkAccess().then(async (allowed) => {
    if (!allowed) return;
    loadHistory();
    // Dari riwayat di chat: isi form dengan job itu
    if (jobId) {
      try {
        const job = await fetchJob(jobId);
        if (job) fillForm(job);
      } catch (error) {
        showProblem(error instanceof Error ? error.message : String(error), undefined, true);
      }
    }
  });
}

// Untuk pengujian dari konsol browser
window.__qr = { renderQr, renderOne, renderSvg, renderPdf, renderBatchZip, loadLogo, scanMatches, FORMAT_LABEL };
