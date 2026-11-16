<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/header-dark.png">
    <img src="docs/header-light.png" alt="énvelope QR Generator" width="420">
  </picture>
</p>

<p align="center">
  Bot Telegram untuk membuat QR berlogo énvelope, misalnya untuk link undangan tiap tamu.<br>
  QR dibuat lewat Telegram Mini App, dicek bisa dipindai, lalu dikirim sebagai file ke chat.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers + D1">
  <img src="https://img.shields.io/badge/Telegram-Mini%20App-26A5E4?logo=telegram&logoColor=white" alt="Telegram Mini App">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

---

## Tampilan

<table>
  <tr>
    <td align="center" valign="top" width="25%"><img src="docs/screenshots/form-1-url.png" alt="Form dengan pratinjau QR" width="200"></td>
    <td align="center" valign="top" width="25%"><img src="docs/screenshots/tampilan-qr.png" alt="Pengaturan Lanjutan dan Tampilan QR" width="200"></td>
    <td align="center" valign="top" width="25%"><img src="docs/screenshots/batch.png" alt="Batch sedang dibuat" width="200"></td>
    <td align="center" valign="top" width="25%"><img src="docs/screenshots/berhasil.png" alt="QR terkirim ke chat" width="200"></td>
  </tr>
  <tr>
    <td align="center"><b>Form</b><br><sub>Tempel URL, pratinjau langsung muncul</sub></td>
    <td align="center"><b>Lanjutan</b><br><sub>Format, ukuran, nama file, tampilan QR</sub></td>
    <td align="center"><b>Batch</b><br><sub>Sampai 50 QR sekaligus dalam ZIP</sub></td>
    <td align="center"><b>Berhasil</b><br><sub>File QR langsung masuk ke chat</sub></td>
  </tr>
</table>

<sub>Mini App mengikuti tema terang atau gelap Telegram pengguna.</sub>

## Cara membuat QR

<p align="center">
  <img src="docs/cara-membuat-qr.webp" alt="Cara membuat QR: 1 buka QR Generator, 2 tempel URL, 3 atur Lanjutan (opsional), 4 buat QR yang dicek bisa dipindai, 5 file masuk ke chat." width="900">
</p>

1. **Buka QR Generator** lewat tombol menu di chat bot, atau tempel URL langsung di chat.
2. **Tempel URL**: satu, atau sampai 50 sekaligus.
3. **Lanjutan** *(opsional)*: pilih format, ukuran, nama file, dan tampilan QR. Pilihan diingat untuk berikutnya.
4. **Buat QR**: setiap QR dicek bisa dipindai sebelum dikirim.
5. **File masuk ke chat**: PNG, SVG, PDF, atau ZIP untuk batch.

## Fitur

| Fitur | Keterangan |
|---|---|
| **Satu atau banyak QR** | Satu QR, atau sampai 50 sekaligus dalam satu ZIP. URL boleh dipisah baris baru, spasi, koma, `\|`, atau `;`. URL ganda dilewati otomatis. |
| **Format** | PNG 1000 sampai 4000 px untuk layar, SVG atau PDF vektor untuk percetakan (tajam di ukuran berapa pun). |
| **Tampilan QR** | Bentuk titik, warna QR dan latar (dengan peringatan kontras), logo énvelope, logo sendiri, atau tanpa logo, beserta ukurannya. |
| **Cek scan otomatis** | Setiap QR dibaca ulang sebelum dikirim. QR yang tidak terbaca tidak dikirim. |
| **Riwayat** | 10 QR terakhir tersimpan 30 hari dan bisa dibuat lagi dengan pengaturan lain. |
| **Akses khusus tim** | Orang di luar tim ditolak. Admin memberi atau mencabut akses langsung dari chat bot. |

### Contoh hasil

<table>
  <tr>
    <td align="center"><img src="docs/qr/qr-kotak.png" alt="QR kotak hitam" width="180"></td>
    <td align="center"><img src="docs/qr/qr-membulat.png" alt="QR membulat di latar krem" width="180"></td>
    <td align="center"><img src="docs/qr/qr-bulat.png" alt="QR titik bulat biru tua" width="180"></td>
  </tr>
  <tr>
    <td align="center"><sub>Kotak (bawaan)</sub></td>
    <td align="center"><sub>Membulat, latar krem</sub></td>
    <td align="center"><sub>Titik bulat, biru tua</sub></td>
  </tr>
</table>

## Cara kerja

<p align="center">
  <img src="docs/cara-kerja.webp" alt="Cara kerja: Telegram membuka QR Generator (Mini App) yang membuat QR di perangkat pengguna, lalu file QR dikirim ke chat. Didukung Cek scan, Cloudflare Worker, dan D1 Database." width="900">
</p>

**Kenapa QR dibuat di perangkat pengguna?** Paket gratis Cloudflare hanya memberi sekitar 10 ms CPU
per permintaan, tidak cukup untuk membuat PNG 4000 px atau 50 QR sekaligus. Dengan membuat QR di
Mini App, server cukup menyimpan data dan meneruskan file, jadi bot tetap gratis dan berjalan 24 jam.

## Isi repo

| Folder / file | Isi |
|---|---|
| [`cloudflare/`](cloudflare/) | Bot versi sekarang: Worker, Mini App, skema database, skrip setup. Panduan lengkap ada di [`cloudflare/README.md`](cloudflare/README.md). |
| [`docs/`](docs/) | Screenshot, contoh QR, dan diagram (cara membuat QR, cara kerja) untuk README ini |
| [`telegram-profile/`](telegram-profile/) | Foto profil dan gambar deskripsi bot untuk diunggah lewat @BotFather |
| `bot.py`, `logo.png` | Versi awal bot dalam Python. Tidak dipakai lagi sejak pindah ke Cloudflare, disimpan sebagai arsip. |

## Mulai cepat

Butuh Node.js, akun Cloudflare, dan token bot dari @BotFather.

1. Buat file `.env` di root repo berisi `BOT_TOKEN=token-dari-botfather`.
2. Di folder `cloudflare`, jalankan `npm install`.
3. Ikuti langkah deploy di [`cloudflare/README.md`](cloudflare/README.md): login Cloudflare, buat database D1,
   `npm run deploy`, lalu `npm run setup`.

Mencoba tampilan Mini App tanpa Telegram: jalankan `npm run dev` di folder `cloudflare`, lalu buka
`http://127.0.0.1:8787/?preview=form`. Bar di atas halaman berisi tombol untuk berpindah ke semua layar
dan tema.

## Keamanan

- `.env` (token bot) dan `cloudflare/.dev.vars` tidak pernah di-commit (lihat [`.gitignore`](.gitignore)).
- Di Cloudflare, token bot, secret webhook, dan daftar admin disimpan sebagai *secret* Worker, bukan di kode.
- Webhook diverifikasi dengan secret token, dan setiap permintaan dari Mini App diverifikasi dengan
  tanda tangan Telegram (`initData`) sebelum file dikirim.
