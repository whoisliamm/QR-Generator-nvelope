// Render QR berlogo énvelope di browser (pengganti generate_qr() di bot.py).
//
// Semua format digambar dari daftar bentuk yang sama (titik, kotak penanda, latar logo),
// jadi PNG, SVG, dan PDF selalu identik. Tampilan bisa diatur: bentuk titik, warna QR & latar,
// logo (énvelope / logo sendiri / tanpa), dan ukuran logo. Logo selalu di tengah.
//
// Setiap QR dibaca ulang (jsQR) sebelum dikirim. QR yang tidak terbaca atau isinya
// tidak sama dengan URL tidak akan dikirim.

import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { zipSync, type Zippable } from "fflate";
import { batchFilename, uniqueNames, withExtension, type QrFormat } from "../src/shared/qr";
import { LOGO_COLOR, LOGO_H, LOGO_PATHS, LOGO_W } from "./logo-vector";

// Encode teks sebagai UTF-8 (default library hanya mengambil 8 bit terbawah)
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

const BORDER = 6;
const PADDING_RATIO = 0.35;
const RADIUS_RATIO = 0.1;
// Ukuran nominal file vektor. Bisa diperbesar/diperkecil tanpa pecah.
const VECTOR_SIZE_MM = 100;

// ==========================================
// GAYA
// ==========================================

export type DotShape = "square" | "rounded" | "dots";
export type LogoChoice = "envelope" | "custom" | "none";
export type LogoSize = "small" | "medium" | "large";
export type CustomLogo = { image: HTMLImageElement; dataUrl: string };

export type QrStyle = {
  shape: DotShape;
  fg: string;
  bg: string;
  logo: LogoChoice;
  logoSize: LogoSize;
  customLogo?: CustomLogo | null;
};

export const DEFAULT_STYLE: QrStyle = {
  shape: "square",
  fg: "#000000",
  bg: "#FFFFFF",
  logo: "envelope",
  logoSize: "medium",
  customLogo: null,
};

// Lebar logo terhadap lebar QR. "Sedang" = 18%, sama dengan versi Python.
const LOGO_RATIOS: Record<LogoSize, number> = { small: 0.13, medium: 0.18, large: 0.22 };

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// Rasio kontras WCAG antara warna QR dan latar
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// QR perlu titik gelap di atas latar terang dengan kontras cukup supaya mudah dipindai
export function styleWarning(style: QrStyle): string | null {
  if (luminance(style.fg) >= luminance(style.bg)) {
    return "Warna QR harus lebih gelap dari latar, QR terbalik sering tidak terbaca. Pilih warna QR yang lebih gelap.";
  }
  if (contrastRatio(style.fg, style.bg) < 4) {
    return "Warna QR terlalu terang dibanding latar, QR bisa tidak terbaca. Pilih warna yang lebih gelap.";
  }
  return null;
}

// ==========================================
// CEK SCAN
// ==========================================

export class VerifyError extends Error {
  constructor(public failures: { position: number; url: string }[]) {
    super(
      failures.length === 1
        ? `QR ${failures[0].position > 0 ? `untuk URL ke-${failures[0].position} ` : ""}tidak lolos cek scan, jadi tidak dikirim.`
        : `${failures.length} QR tidak lolos cek scan, jadi tidak ada yang dikirim.`,
    );
  }
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Baca QR dari gambar yang diperkecil (seperti kamera melihatnya) dan cocokkan isinya dengan URL.
// Dicoba di dua resolusi (4 dan 8 px per modul), seperti kamera yang memotret dari jauh dan dekat.
export function scanMatches(source: CanvasImageSource, modules: number, url: string, smooth: boolean): boolean {
  return [4, 8].some((px) => scanAt(source, modules, url, smooth, px));
}

function scanAt(source: CanvasImageSource, modules: number, url: string, smooth: boolean, px: number): boolean {
  const side = (modules + BORDER * 2) * px;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, side, side);
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(source, 0, 0, side, side);
  const image = ctx.getImageData(0, 0, side, side);
  const result = jsQR(image.data, side, side, { inversionAttempts: "dontInvert" });
  canvas.width = 0;
  canvas.height = 0;
  return !!result && sameBytes(result.binaryData, new TextEncoder().encode(url));
}

// ==========================================
// TATA LETAK: daftar bentuk dalam satuan modul
// ==========================================

type Radii = [tl: number, tr: number, br: number, bl: number];
type Prim =
  | { kind: "rect"; x: number; y: number; w: number; h: number; r: Radii; paint: "fg" | "bg" }
  | { kind: "circle"; cx: number; cy: number; r: number };

type Layout = {
  modules: number;
  total: number;
  prims: Prim[];
  box: { x: number; y: number; size: number; r: number } | null;
  logoRect: { x: number; y: number; w: number; h: number } | null;
};

function makeQr(url: string, version: number = 0) {
  const qr = qrcode(version as Parameters<typeof qrcode>[0], "H");
  qr.addData(url, "Byte");
  qr.make();
  return qr;
}

// Batas aman logo (dicari lewat uji semua kombinasi gaya × format × panjang URL):
// - kotak logo menutup maks 20% area data
// - kotak logo tidak menutup penanda pojok kanan bawah (alignment pattern, versi 2 ke atas),
//   yang dipakai pemindai untuk meluruskan gambar
// Kalau hasilnya tetap tidak lolos cek scan (bisa terjadi pada QR sangat kecil, tergantung susunan
// datanya), QR dibuat ulang dengan versi lebih rapat. Lihat RETRY_BUMPS.
const MAX_LOGO_AREA = 0.2;
const RETRY_BUMPS = 4;

function logoBoxSize(total: number, ratio: number, aspect: number): number {
  const lmax = total * ratio;
  const lw = aspect >= 1 ? lmax : lmax * aspect;
  const lh = aspect >= 1 ? lmax / aspect : lmax;
  return Math.max(lw, lh) + lw * PADDING_RATIO * 2;
}

const versionOf = (qr: ReturnType<typeof makeQr>) => (qr.getModuleCount() - 17) / 4;

// QR versi otomatis, dinaikkan (lebih rapat) sampai logo aman, lalu ditambah `bump` versi
// bila percobaan sebelumnya tidak lolos cek scan. Ukuran logo tidak perlu dikecilkan.
function makeQrForLogo(url: string, ratio: number, aspect: number | null, bump: number) {
  let qr = makeQr(url);
  if (aspect) {
    for (let version = versionOf(qr); version <= 40; version++) {
      if (version > versionOf(qr)) qr = makeQr(url, version);
      const n = qr.getModuleCount();
      const size = logoBoxSize(n + BORDER * 2, ratio, aspect);
      const fitsArea = (size / n) ** 2 <= MAX_LOGO_AREA;
      // Tepi kotak logo boleh menyentuh paling banyak setengah modul cincin luar alignment pattern
      const clearsAlignment = version === 1 || (n + size) / 2 <= n - 8.5;
      if (fitsArea && clearsAlignment) break;
    }
  }
  return bump > 0 ? makeQr(url, Math.min(40, versionOf(qr) + bump)) : qr;
}

// logoAspect = lebar/tinggi logo yang dipakai, dipakai untuk menghitung kotak logo
function buildLayout(url: string, style: QrStyle, logoAspect: number | null, bump = 0): Layout {
  const qr = makeQrForLogo(url, LOGO_RATIOS[style.logoSize], logoAspect, bump);
  const n = qr.getModuleCount();
  const total = n + BORDER * 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const finderAt: [number, number][] = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
  const inFinder = (r: number, c: number) => finderAt.some(([fr, fc]) => r >= fr && r < fr + 7 && c >= fc && c < fc + 7);
  const prims: Prim[] = [];

  if (style.shape === "square") {
    // Modul bersebelahan digabung jadi satu persegi panjang (file lebih kecil, tanpa celah)
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!dark(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && dark(r, c)) c++;
        prims.push({ kind: "rect", x: start + BORDER, y: r + BORDER, w: c - start, h: 1, r: [0, 0, 0, 0], paint: "fg" });
      }
    }
  } else {
    // Kotak penanda di tiga pojok digambar utuh supaya pemindai tetap mudah menemukannya
    for (const [fr, fc] of finderAt) {
      const x = fc + BORDER;
      const y = fr + BORDER;
      const round = (v: number): Radii => [v, v, v, v];
      prims.push({ kind: "rect", x, y, w: 7, h: 7, r: round(1.6), paint: "fg" });
      prims.push({ kind: "rect", x: x + 1, y: y + 1, w: 5, h: 5, r: round(1), paint: "bg" });
      prims.push({ kind: "rect", x: x + 2, y: y + 2, w: 3, h: 3, r: round(0.8), paint: "fg" });
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!dark(r, c) || inFinder(r, c)) continue;
        if (style.shape === "dots") {
          prims.push({ kind: "circle", cx: c + BORDER + 0.5, cy: r + BORDER + 0.5, r: 0.48 });
        } else {
          // Sudut dibulatkan hanya bila dua tetangga di sisi sudut itu kosong, jadi modul yang
          // bersambung tetap menyatu
          const up = dark(r - 1, c);
          const down = dark(r + 1, c);
          const left = dark(r, c - 1);
          const right = dark(r, c + 1);
          const R = 0.5;
          prims.push({
            kind: "rect",
            x: c + BORDER,
            y: r + BORDER,
            w: 1,
            h: 1,
            r: [!up && !left ? R : 0, !up && !right ? R : 0, !down && !right ? R : 0, !down && !left ? R : 0],
            paint: "fg",
          });
        }
      }
    }
  }

  let box: Layout["box"] = null;
  let logoRect: Layout["logoRect"] = null;
  if (logoAspect) {
    const lmax = total * LOGO_RATIOS[style.logoSize];
    const lw = logoAspect >= 1 ? lmax : lmax * logoAspect;
    const lh = logoAspect >= 1 ? lmax / logoAspect : lmax;
    const size = logoBoxSize(total, LOGO_RATIOS[style.logoSize], logoAspect);
    // Logo selalu di tengah: pojok-pojok QR berisi penanda yang dibutuhkan pemindai
    const bx = (total - size) / 2;
    box = { x: bx, y: bx, size, r: size * RADIUS_RATIO };
    logoRect = { x: bx + (size - lw) / 2, y: bx + (size - lh) / 2, w: lw, h: lh };
  }

  return { modules: n, total, prims, box, logoRect };
}

function logoAspectFor(style: QrStyle, envelopeAspect: number): number | null {
  if (style.logo === "none") return null;
  if (style.logo === "custom") {
    const img = style.customLogo?.image;
    return img ? img.naturalWidth / img.naturalHeight : null;
  }
  return envelopeAspect;
}

// ==========================================
// PNG (canvas)
// ==========================================

let logoPromise: Promise<HTMLImageElement> | null = null;

export function loadLogo(src = "logo.png"): Promise<HTMLImageElement> {
  logoPromise ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Logo gagal dimuat."));
    img.src = src;
  });
  return logoPromise;
}

// Perkecil logo bertahap (maks. setengah per langkah) supaya hasilnya tetap halus,
// mendekati kualitas LANCZOS di Pillow.
function scaledLogo(logo: HTMLImageElement, width: number, height: number): CanvasImageSource {
  let source: CanvasImageSource = logo;
  let w = logo.naturalWidth;
  let h = logo.naturalHeight;
  while (w / 2 > width && h / 2 > height) {
    w = Math.max(width, Math.floor(w / 2));
    h = Math.max(height, Math.floor(h / 2));
    const step = document.createElement("canvas");
    step.width = w;
    step.height = h;
    const ctx = step.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    source = step;
  }
  return source;
}

function canvasRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: Radii) {
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2));
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Browser gagal membuat gambar (memori tidak cukup?)."))),
      type,
      quality,
    );
  });
}

export async function renderPng(
  url: string,
  size: number,
  style: QrStyle,
  envelopeLogo: HTMLImageElement | null,
  position = 0,
  bump = 0,
): Promise<Blob> {
  // Logo énvelope digambar dari vektor brand kit (transparan, tajam di ukuran berapa pun),
  // sama dengan SVG & PDF. Parameter envelopeLogo hanya dipertahankan untuk kompatibilitas.
  void envelopeLogo;
  const layout = buildLayout(url, style, logoAspectFor(style, LOGO_W / LOGO_H), bump);
  const k = size / layout.total;
  // Batas piksel modul setelah resize nearest-neighbour (tajam, tanpa garis samar)
  const edge = (u: number) => Math.max(0, Math.ceil(u * k - 0.5));

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas tidak didukung di perangkat ini.");

  try {
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, size, size);

    for (const p of layout.prims) {
      if (p.kind === "circle") {
        ctx.fillStyle = style.fg;
        ctx.beginPath();
        ctx.arc(p.cx * k, p.cy * k, p.r * k, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = p.paint === "fg" ? style.fg : style.bg;
      const x0 = edge(p.x);
      const y0 = edge(p.y);
      const w = edge(p.x + p.w) - x0;
      const h = edge(p.y + p.h) - y0;
      if (p.r.every((v) => v === 0)) {
        ctx.fillRect(x0, y0, w, h);
      } else {
        ctx.beginPath();
        canvasRoundRect(ctx, x0, y0, w, h, p.r.map((v) => v * k) as Radii);
        ctx.fill();
      }
    }

    if (layout.box && layout.logoRect) {
      const { box, logoRect } = layout;
      ctx.fillStyle = style.bg;
      ctx.beginPath();
      canvasRoundRect(ctx, box.x * k, box.y * k, box.size * k, box.size * k, [box.r * k, box.r * k, box.r * k, box.r * k]);
      ctx.fill();

      if (style.logo === "envelope") {
        cachedLogoPath ??= logoSvgPath();
        const scale = (logoRect.h * k) / LOGO_H;
        ctx.save();
        ctx.translate(logoRect.x * k, logoRect.y * k);
        ctx.scale(scale, scale);
        ctx.fillStyle = LOGO_COLOR;
        ctx.fill(new Path2D(cachedLogoPath), "evenodd");
        ctx.restore();
      }
      const image = style.logo === "custom" ? style.customLogo?.image : null;
      if (image) {
        const lw = logoRect.w * k;
        const lh = logoRect.h * k;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          scaledLogo(image, Math.round(lw), Math.round(lh)),
          Math.round((box.x + box.size / 2) * k - lw / 2),
          Math.round((box.y + box.size / 2) * k - lh / 2),
          Math.round(lw),
          Math.round(lh),
        );
      }
    }

    if (!scanMatches(canvas, layout.modules, url, false)) throw new VerifyError([{ position, url }]);
    return await canvasToBlob(canvas);
  } finally {
    // Lepaskan memori canvas segera (penting di iPhone saat batch 4000 px)
    canvas.width = 0;
    canvas.height = 0;
  }
}

// ==========================================
// SVG
// ==========================================

const num = (n: number) => String(+n.toFixed(3));

function svgRoundRect(x: number, y: number, w: number, h: number, r: Radii): string {
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2));
  const arc = (rad: number, ex: number, ey: number) => (rad ? `A${num(rad)} ${num(rad)} 0 0 1 ${num(ex)} ${num(ey)}` : `L${num(ex)} ${num(ey)}`);
  return (
    `M${num(x + tl)} ${num(y)}H${num(x + w - tr)}${arc(tr, x + w, y + tr)}` +
    `V${num(y + h - br)}${arc(br, x + w - br, y + h)}` +
    `H${num(x + bl)}${arc(bl, x, y + h - bl)}` +
    `V${num(y + tl)}${arc(tl, x + tl, y)}Z`
  );
}

function logoSvgPath(): string {
  return LOGO_PATHS.map((path) => {
    let d = `M${num(path.s[0])} ${num(path.s[1])}`;
    for (const seg of path.g) {
      const v = (seg.slice(1) as number[]).map(num);
      d += seg[0] === "C" ? `C${v.join(" ")}` : `L${v[0]} ${v[1]}L${v[2]} ${v[3]}`;
    }
    return d + "Z";
  }).join("");
}

let cachedLogoPath: string | null = null;

export function renderSvg(url: string, style: QrStyle = DEFAULT_STYLE): string {
  return buildSvg(url, style).svg;
}

function buildSvg(url: string, style: QrStyle, bump = 0): { svg: string; modules: number } {
  const layout = buildLayout(url, style, logoAspectFor(style, LOGO_W / LOGO_H), bump);
  const T = layout.total;
  // Painter's order: urutan bentuk dipertahankan (penting untuk lapisan kotak penanda)
  const parts: string[] = [];
  let fgPath = "";
  const flushFg = () => {
    if (fgPath) parts.push(`<path fill="${style.fg}" d="${fgPath}"/>`);
    fgPath = "";
  };
  for (const p of layout.prims) {
    if (p.kind === "circle") {
      fgPath += `M${num(p.cx - p.r)} ${num(p.cy)}a${num(p.r)} ${num(p.r)} 0 1 0 ${num(p.r * 2)} 0a${num(p.r)} ${num(p.r)} 0 1 0 ${num(-p.r * 2)} 0Z`;
    } else if (p.paint === "fg") {
      fgPath += p.r.every((v) => v === 0)
        ? `M${num(p.x)} ${num(p.y)}h${num(p.w)}v${num(p.h)}h${num(-p.w)}z`
        : svgRoundRect(p.x, p.y, p.w, p.h, p.r);
    } else {
      flushFg();
      parts.push(`<path fill="${style.bg}" d="${svgRoundRect(p.x, p.y, p.w, p.h, p.r)}"/>`);
    }
  }
  flushFg();

  if (layout.box && layout.logoRect) {
    const { box, logoRect } = layout;
    parts.push(
      `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.size)}" height="${num(box.size)}" rx="${num(box.r)}" fill="${style.bg}"/>`,
    );
    if (style.logo === "custom" && style.customLogo) {
      parts.push(
        `<image href="${style.customLogo.dataUrl}" x="${num(logoRect.x)}" y="${num(logoRect.y)}" width="${num(logoRect.w)}" height="${num(logoRect.h)}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else if (style.logo === "envelope") {
      cachedLogoPath ??= logoSvgPath();
      const scale = logoRect.h / LOGO_H;
      parts.push(
        `<path fill="${LOGO_COLOR}" fill-rule="evenodd" transform="translate(${num(logoRect.x)} ${num(logoRect.y)}) scale(${scale.toFixed(6)})" d="${cachedLogoPath}"/>`,
      );
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${T} ${T}" width="${VECTOR_SIZE_MM}mm" height="${VECTOR_SIZE_MM}mm" shape-rendering="${style.shape === "square" ? "crispEdges" : "geometricPrecision"}">` +
    `<rect width="${T}" height="${T}" fill="${style.bg}"/>` +
    parts.join("") +
    `</svg>`;
  return { svg, modules: layout.modules };
}

// ==========================================
// PDF (ditulis langsung, tanpa library)
// ==========================================

function rgb(hex: string): string {
  return [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(" ");
}

// Logo sendiri disisipkan sebagai JPEG di atas warna latar (PDF tidak butuh transparansi di sini)
async function logoJpeg(image: HTMLImageElement, bg: string): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const max = 600;
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(scaledLogo(image, w, h), 0, 0, w, h);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  canvas.width = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
}

export async function renderPdf(url: string, style: QrStyle = DEFAULT_STYLE, bump = 0): Promise<Uint8Array> {
  const layout = buildLayout(url, style, logoAspectFor(style, LOGO_W / LOGO_H), bump);
  const W = (VECTOR_SIZE_MM / 25.4) * 72; // point
  const k = W / layout.total;
  // Koordinat modul (y ke bawah) ke koordinat PDF (y ke atas)
  const X = (u: number) => num(u * k);
  const Y = (u: number) => num(W - u * k);
  const ops: string[] = [`${rgb(style.bg)} rg 0 0 ${num(W)} ${num(W)} re f`];
  const C = 0.5523; // bezier untuk seperempat lingkaran

  const roundRect = (x: number, y: number, w: number, h: number, r: Radii) => {
    const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2));
    const out = [`${X(x + tl)} ${Y(y)} m`, `${X(x + w - tr)} ${Y(y)} l`];
    if (tr) out.push(`${X(x + w - tr + tr * C)} ${Y(y)} ${X(x + w)} ${Y(y + tr - tr * C)} ${X(x + w)} ${Y(y + tr)} c`);
    out.push(`${X(x + w)} ${Y(y + h - br)} l`);
    if (br) out.push(`${X(x + w)} ${Y(y + h - br + br * C)} ${X(x + w - br + br * C)} ${Y(y + h)} ${X(x + w - br)} ${Y(y + h)} c`);
    out.push(`${X(x + bl)} ${Y(y + h)} l`);
    if (bl) out.push(`${X(x + bl - bl * C)} ${Y(y + h)} ${X(x)} ${Y(y + h - bl + bl * C)} ${X(x)} ${Y(y + h - bl)} c`);
    out.push(`${X(x)} ${Y(y + tl)} l`);
    if (tl) out.push(`${X(x)} ${Y(y + tl - tl * C)} ${X(x + tl - tl * C)} ${Y(y)} ${X(x + tl)} ${Y(y)} c`);
    out.push("h");
    return out.join("\n");
  };
  const circle = (cx: number, cy: number, r: number) => {
    const c = r * C;
    return [
      `${X(cx + r)} ${Y(cy)} m`,
      `${X(cx + r)} ${Y(cy + c)} ${X(cx + c)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c`,
      `${X(cx - c)} ${Y(cy + r)} ${X(cx - r)} ${Y(cy + c)} ${X(cx - r)} ${Y(cy)} c`,
      `${X(cx - r)} ${Y(cy - c)} ${X(cx - c)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c`,
      `${X(cx + c)} ${Y(cy - r)} ${X(cx + r)} ${Y(cy - c)} ${X(cx + r)} ${Y(cy)} c`,
      "h",
    ].join("\n");
  };

  // Painter's order sama dengan SVG: kumpulkan bentuk fg, isi saat bertemu bentuk bg
  let fg: string[] = [];
  const flushFg = () => {
    if (fg.length) ops.push(`${rgb(style.fg)} rg`, ...fg, "f");
    fg = [];
  };
  for (const p of layout.prims) {
    if (p.kind === "circle") fg.push(circle(p.cx, p.cy, p.r));
    else if (p.paint === "fg") fg.push(p.r.every((v) => v === 0) ? `${X(p.x)} ${Y(p.y + p.h)} ${num(p.w * k)} ${num(p.h * k)} re` : roundRect(p.x, p.y, p.w, p.h, p.r));
    else {
      flushFg();
      ops.push(`${rgb(style.bg)} rg`, roundRect(p.x, p.y, p.w, p.h, p.r), "f");
    }
  }
  flushFg();

  let image: { bytes: Uint8Array; w: number; h: number } | null = null;
  if (layout.box && layout.logoRect) {
    const { box, logoRect } = layout;
    ops.push(`${rgb(style.bg)} rg`, roundRect(box.x, box.y, box.size, box.size, [box.r, box.r, box.r, box.r]), "f");

    if (style.logo === "envelope") {
      const ls = (logoRect.h / LOGO_H) * k;
      ops.push(`q ${rgb(LOGO_COLOR)} rg ${ls.toFixed(6)} 0 0 ${(-ls).toFixed(6)} ${X(logoRect.x)} ${Y(logoRect.y)} cm`);
      for (const path of LOGO_PATHS) {
        ops.push(`${num(path.s[0])} ${num(path.s[1])} m`);
        for (const seg of path.g) {
          const v = (seg.slice(1) as number[]).map(num);
          ops.push(seg[0] === "C" ? `${v.join(" ")} c` : `${v[0]} ${v[1]} l ${v[2]} ${v[3]} l`);
        }
        ops.push("h");
      }
      ops.push("f* Q");
    } else if (style.logo === "custom" && style.customLogo) {
      image = await logoJpeg(style.customLogo.image, style.bg);
      ops.push(`q ${num(logoRect.w * k)} 0 0 ${num(logoRect.h * k)} ${X(logoRect.x)} ${Y(logoRect.y + logoRect.h)} cm /Im1 Do Q`);
    }
  }

  // Susun file PDF per byte (gambar JPEG berisi data biner)
  const enc = new TextEncoder();
  const content = ops.join("\n");
  const objects: (string | [string, Uint8Array])[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(W)}] /Contents 4 0 R /Resources << ${image ? "/XObject << /Im1 5 0 R >>" : ""} >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (image) {
    objects.push([
      `<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`,
      image.bytes,
    ]);
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  push("%PDF-1.4\n");
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    if (typeof body === "string") push(body);
    else {
      push(body[0]);
      push(body[1]);
      push("\nendstream");
    }
    push("\nendobj\n");
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  push(offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join(""));
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const pdf = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    pdf.set(c, at);
    at += c.length;
  }
  return pdf;
}

// Cek scan file vektor: SVG dirender browser lalu dibaca. PDF memakai tata letak yang sama persis,
// jadi lolosnya SVG berarti PDF-nya juga terbaca.
async function verifyVector(url: string, svg: string, modules: number, position: number) {
  const src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    if (!scanMatches(img, modules, url, true)) throw new VerifyError([{ position, url }]);
  } finally {
    URL.revokeObjectURL(src);
  }
}

// ==========================================
// SATU QR / BATCH
// ==========================================

export const MIME: Record<QrFormat, string> = { png: "image/png", svg: "image/svg+xml", pdf: "application/pdf" };

export async function renderOne(
  url: string,
  format: QrFormat,
  size: number,
  style: QrStyle,
  envelopeLogo: HTMLImageElement | null,
  position = 0,
): Promise<Blob> {
  // Tidak lolos cek scan: coba lagi dengan QR yang lebih rapat sebelum menyerah
  for (let bump = 0; ; bump++) {
    try {
      if (format === "png") return await renderPng(url, size, style, envelopeLogo, position, bump);
      const { svg, modules } = buildSvg(url, style, bump);
      await verifyVector(url, svg, modules, position);
      if (format === "svg") return new Blob([svg], { type: MIME.svg });
      return new Blob([(await renderPdf(url, style, bump)) as Uint8Array<ArrayBuffer>], { type: MIME.pdf });
    } catch (error) {
      if (!(error instanceof VerifyError) || bump >= RETRY_BUMPS) throw error;
    }
  }
}

export async function renderBatchZip(
  urls: string[],
  format: QrFormat,
  size: number,
  style: QrStyle,
  envelopeLogo: HTMLImageElement | null,
  onProgress: (done: number, total: number, current: string) => void,
): Promise<Blob> {
  const names = uniqueNames(urls.map((url, i) => batchFilename(url, i + 1))).map((n) => withExtension(n, format));
  const files: Zippable = {};
  const failures: { position: number; url: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    onProgress(i, urls.length, names[i]);
    try {
      const file = await renderOne(urls[i], format, size, style, envelopeLogo, i + 1);
      // PNG sudah terkompresi, jadi disimpan tanpa kompresi ulang (lebih cepat). SVG/PDF berupa teks.
      files[names[i]] = [new Uint8Array(await file.arrayBuffer()), { level: format === "png" ? 0 : 6 }];
    } catch (error) {
      if (error instanceof VerifyError) failures.push(...error.failures);
      else throw error;
    }
  }
  onProgress(urls.length, urls.length, "");
  if (failures.length) throw new VerifyError(failures);
  const zipped = zipSync(files);
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

// Untuk konsol pengujian: QR gaya bawaan
export const renderQr = (url: string, size: number, logo: HTMLImageElement | null) =>
  renderPng(url, size, DEFAULT_STYLE, logo);
