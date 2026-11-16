// Logika bersama Worker & Mini App: validasi URL, nama file, konstanta.
// Port langsung dari bot.py supaya hasil nama file sama.

export const MAX_BATCH = 50;
export const SIZES = [1000, 2000, 3000, 4000] as const;
export type QrSize = (typeof SIZES)[number];

export function isQrSize(value: number): value is QrSize {
  return (SIZES as readonly number[]).includes(value);
}

// PNG = gambar piksel (pakai ukuran px). SVG & PDF = vektor, tajam di ukuran cetak berapa pun.
export const FORMATS = ["png", "svg", "pdf"] as const;
export type QrFormat = (typeof FORMATS)[number];

export function isQrFormat(value: string | null | undefined): value is QrFormat {
  return (FORMATS as readonly (string | null | undefined)[]).includes(value);
}

export const FORMAT_LABEL: Record<QrFormat, string> = { png: "PNG", svg: "SVG (vektor)", pdf: "PDF (vektor)" };

// QR-andi.png -> QR-andi.svg
export function withExtension(filename: string, format: QrFormat): string {
  return filename.replace(/\.(png|svg|pdf)$/i, "") + "." + format;
}

export function batchZipName(format: QrFormat, size: number): string {
  return format === "png" ? `QR-Batch-${size}px.zip` : `QR-Batch-${format.toUpperCase()}.zip`;
}

// bot.py: is_valid_url -> ^https?://[^\s]+$
export function isValidUrl(url: string): boolean {
  return /^https?:\/\/\S+$/.test(url);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Bagian terakhir path URL, atau host jika path kosong (sama seperti urlparse di bot.py).
function lastUrlSegment(url: string): string {
  const match = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(url);
  const host = match?.[1] ?? "";
  const path = (match?.[2] ?? "").replace(/^\/+|\/+$/g, "");
  if (path) {
    const parts = path.split("/");
    return safeDecode(parts[parts.length - 1]);
  }
  return host;
}

// bot.py: clean_filename -> dipakai untuk nama custom & nama otomatis QR tunggal
export function cleanFilename(input: string): string {
  let name = input.trim();
  if (name.toLowerCase().endsWith(".png")) name = name.slice(0, -4);
  name = name.replace(/[\\/:*?"<>|]/g, "-");
  name = name.replace(/\s+/g, " ");
  name = name.replace(/ /g, "-");
  name = name.replace(/-+/g, "-");
  name = name.replace(/^-+|-+$/g, "");
  // Hindari nama yang terlalu panjang untuk sistem file / Telegram
  name = name.slice(0, 120);
  if (!name) return "QR-Code.png";
  return `QR-${name}.png`;
}

// bot.py: tombol "Nama Otomatis"
export function autoFilename(url: string): string {
  return cleanFilename(lastUrlSegment(url));
}

// bot.py: create_filename -> dipakai di batch
export function batchFilename(url: string, index: number): string {
  let name = lastUrlSegment(url)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!name) name = `qr-${index}`;
  return `QR-${name}.png`;
}

// Hindari nama file duplikat di dalam ZIP: QR-andi.png, QR-andi-2.png, ...
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((original) => {
    let name = original;
    let counter = 2;
    while (used.has(name)) {
      name = original.replace(/\.png$/, `-${counter}.png`);
      counter += 1;
    }
    used.add(name);
    return name;
  });
}

// Karakter sebelum "http(s)://" yang menandakan URL itu bagian dari URL lain,
// misalnya ?redirect=https://... , jadi tidak boleh dipisah di situ.
const INSIDE_URL_BEFORE_SCHEME = "=?&/:#%";

// Pisah dua URL yang tertempel tanpa pemisah: ".../andihttps://..." -> 2 URL.
function splitGluedUrls(chunk: string): string[] {
  const parts: string[] = [];
  const scheme = /https?:\/\//gi;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = scheme.exec(chunk))) {
    const at = match.index;
    if (at > start && !INSIDE_URL_BEFORE_SCHEME.includes(chunk[at - 1])) {
      parts.push(chunk.slice(start, at));
      start = at;
    }
  }
  parts.push(chunk.slice(start));
  return parts;
}

// Pisahkan teks menjadi daftar URL. Pemisah dideteksi otomatis:
//   baris baru, spasi, tab, "|" dan ";" selalu memisah;
//   koma hanya memisah bila setelahnya URL baru (koma boleh ada di dalam URL);
//   "/" tidak pernah dipakai sebagai pemisah karena ada di setiap URL.
// Potongan yang bukan URL tetap dikembalikan supaya bisa ditandai sebagai error.
export function parseUrls(text: string): string[] {
  return text
    .split(/[\s|;]+/)
    .flatMap((chunk) => chunk.split(/,(?=https?:\/\/)/i))
    .flatMap(splitGluedUrls)
    .map((token) => token.replace(/^[,|;"']+|[,|;"']+$/g, ""))
    .filter(Boolean);
}

// URL yang tidak valid beserta urutannya (mulai dari 1)
export function findInvalidUrls(urls: string[]): { position: number; url: string }[] {
  return urls
    .map((url, i) => ({ position: i + 1, url }))
    .filter(({ url }) => !isValidUrl(url));
}

export const SEPARATOR_HINT = "Pisahkan URL dengan baris baru, spasi, koma, atau |.";

export type Duplicate = { position: number; firstPosition: number; url: string };

// Buang URL yang sama persis dengan URL sebelumnya. QR-nya pasti identik,
// jadi tidak ada yang hilang, tapi pengguna tetap diberi tahu mana yang dilewati.
export function dedupeUrls(urls: string[]): { unique: string[]; duplicates: Duplicate[] } {
  const firstSeen = new Map<string, number>();
  const unique: string[] = [];
  const duplicates: Duplicate[] = [];
  urls.forEach((url, i) => {
    const first = firstSeen.get(url);
    if (first !== undefined) {
      duplicates.push({ position: i + 1, firstPosition: first, url });
    } else {
      firstSeen.set(url, i + 1);
      unique.push(url);
    }
  });
  return { unique, duplicates };
}

export function duplicateSummary(duplicates: Duplicate[], max = 3): string {
  const list = duplicates
    .slice(0, max)
    .map((d) => `URL ke-${d.position} sama dengan URL ke-${d.firstPosition}`)
    .join(", ");
  const more = duplicates.length > max ? `, dan ${duplicates.length - max} lainnya` : "";
  return `${duplicates.length} URL ganda dilewati: ${list}${more}.`;
}
