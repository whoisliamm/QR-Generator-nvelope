# QR Generator énvelope — versi Cloudflare

Versi bot Telegram `bot.py` yang berjalan 24 jam di **Cloudflare Workers (paket gratis)**.

## Cara kerja

```
Chat Telegram ──webhook──▶ Cloudflare Worker ──▶ D1 (state chat & job)
      ▲                         │
      │                 tombol ukuran (Mini App)
      │                         ▼
      └── file PNG / ZIP ◀── Mini App (QR dibuat di HP/PC pengguna)
```

- **QR hanya dibuat lewat Mini App** (tombol menu "QR Generator" atau tombol "🔳 Buka QR Generator").
- **Chat adalah pintu masuk:** `/start` dan `/help` membalas dengan tombol pembuka Mini App, dan `/riwayat`
  membuka QR lama. URL yang ditempel di chat (atau lewat `/qr` dan `/batch` lama) membuat tombol
  **"Buka form yang sudah terisi"**.
- File hasil dikirim ke chat dengan tombol **"🔳 Buat QR lagi"**.
- Tombol ukuran dari pesan versi lama (`?job=…&format=…`) tetap berfungsi.
- QR dibuat di perangkat pengguna karena paket gratis Cloudflare hanya memberi ~10 ms CPU per request,
  tidak cukup untuk PNG 4000 px.

## Struktur

| Path | Isi |
|---|---|
| `src/worker.ts` | Webhook Telegram, alur chat, API untuk Mini App |
| `src/telegram.ts` | Pembungkus Bot API + validasi `initData` Mini App |
| `src/shared/qr.ts` | Validasi URL & aturan nama file (port dari `bot.py`) |
| `miniapp/render.ts` | Render QR berlogo + ZIP batch di browser |
| `miniapp/app.ts` | Logika Mini App (mode job dari chat & mode form) |
| `public/` | Halaman Mini App (`index.html`, `logo.png`, `app.js` hasil build) |
| `schema.sql` | Tabel D1 `sessions` & `jobs` |
| `scripts/setup-telegram.mjs` | Set secret, webhook, command, dan tombol menu |

## Deploy (sekali saja)

Jalankan di folder `cloudflare/`:

1. Login ke Cloudflare (browser akan terbuka):
   ```bash
   npx wrangler login
   ```
2. Buat database D1, lalu salin `database_id` yang muncul ke `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create qr-bot
   ```
3. Buat tabel:
   ```bash
   npm run db:init
   ```
4. Deploy Worker + Mini App. Catat URL `https://envelope-qr-bot.<akun>.workers.dev`:
   ```bash
   npm run deploy
   ```
5. Hubungkan bot ke Worker (token dibaca dari `../.env`). `--admin` diisi ID Telegram Anda:
   ```bash
   npm run setup -- https://envelope-qr-bot.<akun>.workers.dev --admin 123456789
   ```
   Belum tahu ID-nya? Jalankan tanpa `--admin`, kirim `/start` ke bot (bot membalas dengan ID Anda),
   lalu jalankan perintah di atas sekali lagi dengan ID tersebut.

## Fitur

- **Format:** PNG (1000 sampai 4000 px) untuk layar, atau SVG/PDF vektor (10 × 10 cm, bisa diperbesar tanpa pecah)
  untuk percetakan. Logo di SVG/PDF juga vektor, diambil dari brand kit énvelope (`miniapp/logo-vector.ts`).
- **Tampilan QR (di Lanjutan):** bentuk titik (kotak, membulat, bulat), warna QR dan latar
  (dengan peringatan kontras), logo énvelope / logo sendiri (PNG/JPG maks 2 MB, disimpan di perangkat) / tanpa
  logo, dan ukuran logo. Logo selalu di tengah, karena pojok QR berisi penanda yang dibutuhkan pemindai.
  QR otomatis memakai versi lebih rapat bila logo besar atau URL sangat pendek, supaya tetap terbaca.
- **Cek scan otomatis:** setiap QR dibaca ulang dengan jsQR sebelum dikirim. QR yang tidak terbaca
  atau isinya tidak sama dengan URL tidak dikirim, dan pengguna diberi tahu URL ke berapa yang bermasalah.
- **Pemisah otomatis:** batch menerima baris baru, spasi, koma, `|`, atau `;` sebagai pemisah URL.
- **URL ganda:** URL yang sama persis dilewati otomatis, dan pengguna diberi tahu mana yang dilewati.
- **Riwayat:** 10 QR terakhir (disimpan 30 hari) di `/riwayat` dan di bawah form Mini App.
  Ketuk untuk membuka form yang sudah terisi.

## Akses bot

Bot hanya melayani tim énvelope. Orang lain mendapat balasan berisi ID Telegram mereka,
supaya bisa minta akses ke admin. Mini App juga terkunci untuk mereka.

- **Admin** diatur lewat secret `ADMIN_USER_IDS` (dipisah koma) memakai `npm run setup -- … --admin ID1,ID2`.
  Admin selalu punya akses dan bisa mengelola anggota tim.
- Menu `/` di chat admin menampilkan perintah admin juga (dipasang oleh `npm run setup … --admin`).
  Anggota tim lain hanya melihat `/start /riwayat /help`.
- **Anggota tim** dikelola admin langsung dari chat bot:
  - `/izinkan 123456789 Nama`: beri akses
  - `/cabut 123456789`: cabut akses
  - `/akses`: lihat daftar admin dan anggota tim

Setelah langkah 5, `bot.py` lokal **tidak bisa dijalankan bersamaan**, karena Telegram hanya
mengirim update lewat webhook. Untuk kembali ke `bot.py`, hapus webhook dulu:
`https://api.telegram.org/bot<TOKEN>/deleteWebhook`.

## Update kode

```bash
npm run deploy
```

## Uji lokal

```bash
npm run db:init:local
npm run dev
```

Buka `http://127.0.0.1:8787` di browser. Di luar Telegram, form langsung **mengunduh** file
(tidak mengirim ke chat). Secret lokal disimpan di `.dev.vars` (`BOT_TOKEN`, `WEBHOOK_SECRET`).

### Mode preview (untuk mendesain tampilan)

Buka `http://127.0.0.1:8787/?preview=form`. Bar hitam di atas berisi tombol untuk berpindah ke
semua layar (Form kosong, Form 1 URL, Lanjutan, Form batch, Membuat, Batch, Mengirim, Berhasil,
Gagal kirim, Cek gagal, Akses) dan tema (Otomatis, Terang, Gelap). Tampilannya mengikuti desain
"Mini App QR énvelope" di artifact.
Layar status dari chat biasanya hanya terlihat di Telegram, tapi lewat mode ini bisa dicek di browser.
URL langsung ke layar tertentu juga bisa dipakai, misalnya `?preview=success&theme=dark`.

- Warna, font, dan layout ada di `public/index.html` (bagian `<style>`, token warna di `:root`).
  Cukup refresh browser setelah mengubahnya.
- Teks status dan label tombol ada di `miniapp/app.ts`. Jalankan `npm run build` setelah mengubahnya.

## Batas paket gratis (perkiraan)

- Workers: 100.000 request/hari. Satu QR memakai sekitar 4–6 request.
- D1: 100.000 baris ditulis/hari. Job & session lama dihapus otomatis setiap hari.
- Telegram: file maks 50 MB. Batch 50 × 4000 px sekitar 15 MB.
- Mini App hanya berjalan di **chat pribadi** dengan bot.
