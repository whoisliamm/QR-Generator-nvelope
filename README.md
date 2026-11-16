# QR Generator énvelope

Bot Telegram untuk membuat QR berlogo énvelope, misalnya untuk link undangan tiap tamu.
QR dibuat lewat Telegram Mini App, dan hasilnya dikirim sebagai file ke chat.
Berjalan 24 jam di Cloudflare Workers (paket gratis).

## Fitur

- **Satu QR atau sampai 50 sekaligus.** Batch dikirim sebagai satu file ZIP. URL bisa dipisah dengan
  baris baru, spasi, koma, `|`, atau `;`. URL ganda dilewati otomatis.
- **PNG 1000 sampai 4000 px**, atau **SVG dan PDF vektor** untuk percetakan.
- **Tampilan QR:** bentuk titik (kotak, membulat, bulat), warna QR dan latar, logo énvelope, logo sendiri,
  atau tanpa logo, beserta ukurannya.
- **Cek scan otomatis.** Setiap QR dibaca ulang sebelum dikirim. QR yang tidak terbaca tidak dikirim.
- **Riwayat** 10 QR terakhir, bisa dibuat lagi dengan pengaturan lain.
- **Akses khusus tim.** Admin memberi atau mencabut akses langsung dari chat bot.

## Cara kerja

```
Chat Telegram ──webhook──▶ Cloudflare Worker ──▶ D1 (job, riwayat, akses)
      ▲                         │
      │                 tombol "QR Generator"
      │                         ▼
      └── file PNG/SVG/PDF/ZIP ◀── Mini App (QR dibuat di HP/PC pengguna)
```

QR dibuat di perangkat pengguna, bukan di server. Dengan begitu ukuran 4000 px dan batch tetap
berjalan di batas CPU paket gratis Cloudflare.

## Isi repo

| Folder / file | Isi |
|---|---|
| [`cloudflare/`](cloudflare/) | Bot versi sekarang: Worker, Mini App, skema database, skrip setup. **Panduan deploy ada di [`cloudflare/README.md`](cloudflare/README.md).** |
| [`telegram-profile/`](telegram-profile/) | Foto profil dan gambar deskripsi bot untuk diunggah lewat @BotFather |
| `bot.py`, `logo.png` | Versi awal bot dalam Python (polling). Tidak dipakai lagi sejak pindah ke Cloudflare, disimpan sebagai arsip. |

## Mulai cepat

Butuh Node.js, akun Cloudflare, dan token bot dari @BotFather.

1. Buat file `.env` di root repo berisi `BOT_TOKEN=token-dari-botfather`.
2. Ikuti langkah deploy di [`cloudflare/README.md`](cloudflare/README.md):
   login Cloudflare, buat database D1, `npm run deploy`, lalu `npm run setup`.

Untuk mencoba tampilan Mini App tanpa Telegram: jalankan `npm run dev` di folder `cloudflare`, lalu buka
`http://127.0.0.1:8787/?preview=form`.

## Keamanan

- `.env` (token bot) dan `cloudflare/.dev.vars` tidak pernah di-commit (lihat `.gitignore`).
- Di Cloudflare, token bot, secret webhook, dan daftar admin disimpan sebagai *secret* Worker, bukan di kode.
- Permintaan dari Mini App diverifikasi dengan tanda tangan Telegram (`initData`), dan webhook diverifikasi dengan secret token.
