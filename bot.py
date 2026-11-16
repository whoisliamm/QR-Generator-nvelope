import os
import io
import re
import zipfile
from urllib.parse import urlparse

import qrcode
from PIL import Image, ImageDraw
from dotenv import load_dotenv

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)

from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)


# ==========================================
# CONFIGURATION
# ==========================================

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")

if not BOT_TOKEN:
    raise ValueError(
        "BOT_TOKEN belum ditemukan di file .env"
    )

LOGO_PATH = "logo.png"

# Maksimal URL dalam satu batch
MAX_BATCH = 50


# ==========================================
# USER DATA
# ==========================================

user_urls = {}
user_qr_files = {}
user_batch_urls = {}
user_mode = {}
user_filenames = {}


# ==========================================
# VALIDATE URL
# ==========================================

def is_valid_url(url):
    pattern = r"^https?://[^\s]+$"
    return re.match(pattern, url) is not None


# ==========================================
# CREATE AUTOMATIC FILE NAME
# ==========================================

def create_filename(url, index):
    parsed = urlparse(url)

    path = parsed.path.strip("/")

    if path:
        name = path.split("/")[-1]
    else:
        name = parsed.netloc

    # Bersihkan karakter yang tidak cocok
    name = re.sub(
        r"[^a-zA-Z0-9_-]",
        "-",
        name
    )

    name = name.strip("-")

    if not name:
        name = f"qr-{index}"

    return f"QR-{name}.png"


# ==========================================
# CLEAN CUSTOM FILE NAME
# ==========================================

def clean_filename(name):
    name = name.strip()

    # Hilangkan ekstensi jika user mengetik .png
    if name.lower().endswith(".png"):
        name = name[:-4]

    # Ganti karakter yang tidak aman untuk nama file
    name = re.sub(
        r'[\\/:*?"<>|]',
        "-",
        name
    )

    # Rapikan spasi
    name = re.sub(
        r"\s+",
        " ",
        name
    )

    # Ganti spasi dengan tanda -
    name = name.replace(
        " ",
        "-"
    )

    # Hilangkan tanda - berlebihan
    name = re.sub(
        r"-+",
        "-",
        name
    )

    name = name.strip("-")

    if not name:
        return "QR-Code.png"

    return f"QR-{name}.png"


# ==========================================
# FILE NAME KEYBOARD
# ==========================================

def filename_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "✏️ Input Nama File",
                callback_data="filename_custom"
            )
        ],
        [
            InlineKeyboardButton(
                "🤖 Nama Otomatis",
                callback_data="filename_auto"
            )
        ]
    ])


# ==========================================
# GENERATE QR
# ==========================================

def generate_qr(url, target_size):

    # --------------------------------------
    # CREATE QR
    # --------------------------------------

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=30,
        border=6,
    )

    qr.add_data(url)

    qr.make(fit=True)

    qr_image = qr.make_image(
        fill_color="black",
        back_color="white"
    ).convert("RGBA")


    # --------------------------------------
    # RESIZE
    # --------------------------------------

    qr_image = qr_image.resize(
        (target_size, target_size),
        Image.Resampling.NEAREST
    )


    # --------------------------------------
    # LOGO
    # --------------------------------------

    if os.path.exists(LOGO_PATH):

        logo = Image.open(
            LOGO_PATH
        ).convert("RGBA")

        qr_width, qr_height = qr_image.size

        # Logo 18%
        logo_size = int(
            qr_width * 0.18
        )

        logo.thumbnail(
            (logo_size, logo_size),
            Image.Resampling.LANCZOS
        )


        # ----------------------------------
        # ROUNDED WHITE BACKGROUND
        # ----------------------------------

        padding = int(
            logo.width * 0.35
        )

        background_size = (
            max(
                logo.width,
                logo.height
            )
            + (padding * 2)
        )

        logo_background = Image.new(
            "RGBA",
            (
                background_size,
                background_size
            ),
            (255, 255, 255, 0)
        )

        draw = ImageDraw.Draw(
            logo_background
        )

        corner_radius = int(
            background_size * 0.10
        )

        draw.rounded_rectangle(
            (
                0,
                0,
                background_size - 1,
                background_size - 1
            ),
            radius=corner_radius,
            fill="white"
        )


        # ----------------------------------
        # LOGO CENTER
        # ----------------------------------

        logo_x = (
            background_size - logo.width
        ) // 2

        logo_y = (
            background_size - logo.height
        ) // 2

        logo_background.alpha_composite(
            logo,
            (
                logo_x,
                logo_y
            )
        )


        # ----------------------------------
        # PLACE LOGO
        # ----------------------------------

        position = (
            (qr_width - background_size) // 2,
            (qr_height - background_size) // 2
        )

        qr_image.alpha_composite(
            logo_background,
            position
        )


    # --------------------------------------
    # EXPORT PNG
    # --------------------------------------

    output = io.BytesIO()

    qr_image.convert("RGB").save(
        output,
        format="PNG"
    )

    output.seek(0)

    return output


# ==========================================
# SIZE KEYBOARD
# ==========================================

def size_keyboard(prefix="size"):

    return InlineKeyboardMarkup([

        [
            InlineKeyboardButton(
                "1000 × 1000 px",
                callback_data=f"{prefix}_1000"
            ),

            InlineKeyboardButton(
                "2000 × 2000 px",
                callback_data=f"{prefix}_2000"
            ),
        ],

        [
            InlineKeyboardButton(
                "3000 × 3000 px",
                callback_data=f"{prefix}_3000"
            ),

            InlineKeyboardButton(
                "4000 × 4000 px",
                callback_data=f"{prefix}_4000"
            ),
        ],

    ])


# ==========================================
# START
# ==========================================

async def start(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE
):

    keyboard = [

        [
            InlineKeyboardButton(
                "🔳 Buat QR Code",
                callback_data="create_qr"
            )
        ],

        [
            InlineKeyboardButton(
                "📦 Batch QR",
                callback_data="batch_start"
            )
        ],

        [
            InlineKeyboardButton(
                "❓ Help",
                callback_data="help"
            )
        ],

    ]

    reply_markup = InlineKeyboardMarkup(
        keyboard
    )

    await update.message.reply_text(
        "👋 *QR Generator*\n\n"
        "Buat énvelope General QR Code.\n\n"

        "*Command:*\n"
        "`/qr URL`\n"
        "`/batch`\n\n"

        "Pilih menu di bawah:",
        parse_mode="Markdown",
        reply_markup=reply_markup
    )


# ==========================================
# QR COMMAND
# ==========================================

async def qr_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE
):

    if not context.args:

        await update.message.reply_text(
            "❌ URL belum diberikan.\n\n"
            "Contoh:\n"
            "`/qr https://example.com`",
            parse_mode="Markdown"
        )

        return

    url = " ".join(
        context.args
    ).strip()

    if not is_valid_url(url):

        await update.message.reply_text(
            "❌ URL tidak valid.\n\n"
            "Pastikan URL dimulai dengan:\n"
            "`https://`",
            parse_mode="Markdown"
        )

        return

    user_id = update.effective_user.id

    user_urls[user_id] = url

    user_mode[user_id] = "filename"

    await update.message.reply_text(
        "📁 *Nama file QR*\n\n"
        "Pilih apakah ingin memasukkan "
        "nama file sendiri atau menggunakan "
        "nama otomatis dari URL:",
        parse_mode="Markdown",
        reply_markup=filename_keyboard()
    )


# ==========================================
# BATCH COMMAND
# ==========================================

async def batch_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE
):

    user_id = update.effective_user.id

    user_mode[user_id] = "batch"

    await update.message.reply_text(
        "📦 *BATCH QR GENERATOR*\n\n"

        "Kirim URL yang ingin dibuat menjadi QR.\n\n"

        "⚠️ *Satu URL per baris.*\n\n"

        "Contoh:\n"
        "`https://website.com/tamu/andi`\n"
        "`https://website.com/tamu/budi`\n"
        "`https://website.com/tamu/citra`\n"
        "`https://website.com/tamu/david`\n\n"

        f"Maksimal *{MAX_BATCH} URL*.",
        parse_mode="Markdown"
    )


# ==========================================
# HANDLE MESSAGE
# ==========================================

async def handle_message(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE
):

    user_id = update.effective_user.id

    text = update.message.text.strip()


    # ======================================
    # CUSTOM FILE NAME
    # ======================================

    if user_mode.get(user_id) == "filename_custom":

        filename = clean_filename(text)

        user_filenames[user_id] = filename

        user_mode[user_id] = "single"

        await update.message.reply_text(
            f"✅ *Nama file disimpan:*\n"
            f"`{filename}`\n\n"
            "Sekarang pilih ukuran QR:",
            parse_mode="Markdown",
            reply_markup=size_keyboard()
        )

        return


    # ======================================
    # BATCH MODE
    # ======================================

    if user_mode.get(user_id) == "batch":

        lines = [
            line.strip()
            for line in text.splitlines()
            if line.strip()
        ]

        if len(lines) == 0:

            await update.message.reply_text(
                "❌ Tidak ada URL."
            )

            return

        if len(lines) > MAX_BATCH:

            await update.message.reply_text(
                f"❌ Maksimal {MAX_BATCH} URL "
                "dalam satu batch."
            )

            return

        invalid_urls = [
            url
            for url in lines
            if not is_valid_url(url)
        ]

        if invalid_urls:

            await update.message.reply_text(
                "❌ Ada URL yang tidak valid.\n\n"
                "Pastikan setiap URL menggunakan:\n"
                "`https://...`",
                parse_mode="Markdown"
            )

            return

        user_batch_urls[user_id] = lines

        user_mode[user_id] = "batch_size"

        await update.message.reply_text(
            f"✅ *{len(lines)} URL diterima.*\n\n"
            "Sekarang pilih ukuran QR:",
            parse_mode="Markdown",
            reply_markup=size_keyboard("batch_size")
        )

        return


    # ======================================
    # NORMAL URL
    # ======================================

    if not is_valid_url(text):

        await update.message.reply_text(
            "❌ Link tidak valid.\n\n"

            "Kirim URL seperti:\n"
            "`https://example.com`\n\n"

            "Atau gunakan:\n"
            "`/qr https://example.com`\n\n"

            "Untuk banyak URL:\n"
            "`/batch`",
            parse_mode="Markdown"
        )

        return

    user_urls[user_id] = text

    user_mode[user_id] = "filename"

    await update.message.reply_text(
        "📁 *Nama file QR*\n\n"
        "Pilih nama file:",
        parse_mode="Markdown",
        reply_markup=filename_keyboard()
    )


# ==========================================
# BUTTON HANDLER
# ==========================================

async def button_handler(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE
):

    query = update.callback_query

    await query.answer()

    user_id = query.from_user.id

    data = query.data


    # ======================================
    # CUSTOM FILE NAME
    # ======================================

    if data == "filename_custom":

        user_mode[user_id] = "filename_custom"

        await query.message.reply_text(
            "✏️ *Masukkan nama file QR.*\n\n"
            "Contoh:\n"
            "`Andreas Hada`\n\n"
            "Bot akan membuat:\n"
            "`QR-Andreas-Hada.png`",
            parse_mode="Markdown"
        )

        return


    # ======================================
    # AUTOMATIC FILE NAME
    # ======================================

    if data == "filename_auto":

        url = user_urls.get(user_id)

        if not url:

            await query.message.reply_text(
                "❌ URL tidak ditemukan."
            )

            return

        parsed = urlparse(url)

        path = parsed.path.strip("/")

        if path:
            name = path.split("/")[-1]
        else:
            name = parsed.netloc

        filename = clean_filename(name)

        user_filenames[user_id] = filename

        user_mode[user_id] = "single"

        await query.message.reply_text(
            f"🤖 *Nama otomatis:*\n"
            f"`{filename}`\n\n"
            "Sekarang pilih ukuran QR:",
            parse_mode="Markdown",
            reply_markup=size_keyboard()
        )

        return


    # ======================================
    # CREATE QR
    # ======================================

    if data == "create_qr":

        user_mode[user_id] = "single"

        await query.message.reply_text(
            "🔗 Kirim URL yang ingin dibuat "
            "menjadi QR."
        )

        return


    # ======================================
    # BATCH START
    # ======================================

    if data == "batch_start":

        user_mode[user_id] = "batch"

        await query.message.reply_text(
            "📦 *BATCH QR GENERATOR*\n\n"

            "Kirim URL satu per baris.\n\n"

            "Contoh:\n"
            "`https://website.com/tamu/andi`\n"
            "`https://website.com/tamu/budi`\n"
            "`https://website.com/tamu/citra`\n\n"

            f"Maksimal *{MAX_BATCH} URL*.",
            parse_mode="Markdown"
        )

        return


    # ======================================
    # HELP
    # ======================================

    if data == "help":

        await query.message.reply_text(
            "📖 *QR Generator Help*\n\n"

            "*Single QR:*\n"
            "`/qr https://example.com`\n\n"

            "*Batch QR:*\n"
            "`/batch`\n\n"

            "Batch menerima beberapa URL "
            "sekaligus, satu URL per baris.\n\n"

            "*Ukuran:*\n"
            "1000 × 1000 px\n"
            "2000 × 2000 px\n"
            "3000 × 3000 px\n"
            "4000 × 4000 px",
            parse_mode="Markdown"
        )

        return


    # ======================================
    # SINGLE SIZE
    # ======================================

    if data.startswith("size_"):

        size = int(
            data.split("_")[1]
        )

        url = user_urls.get(user_id)

        if not url:

            await query.message.reply_text(
                "❌ URL tidak ditemukan."
            )

            return

        await query.edit_message_text(
            f"⏳ Membuat QR "
            f"{size} × {size} px..."
        )

        try:

            qr_image = generate_qr(
                url,
                size
            )

            qr_bytes = qr_image.getvalue()

            user_qr_files[user_id] = {
                "data": qr_bytes,
                "size": size,
                "url": url
            }

            preview = io.BytesIO(
                qr_bytes
            )

            preview.seek(0)

            keyboard = [

                [
                    InlineKeyboardButton(
                        "📥 Download PNG HD",
                        callback_data="download_qr"
                    )
                ],

                [
                    InlineKeyboardButton(
                        "🔄 Buat QR Baru",
                        callback_data="create_qr"
                    )
                ],

            ]

            await query.message.reply_photo(
                photo=preview,
                caption=(
                    "✅ *QR Code berhasil dibuat!*\n\n"
                    f"📐 `{size} × {size} px`\n"
                    f"🔗 `{url}`"
                ),
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup(
                    keyboard
                )
            )

        except Exception as error:

            print(
                "ERROR:",
                error
            )

            await query.message.reply_text(
                "❌ Terjadi error."
            )

        return


    # ======================================
    # BATCH SIZE
    # ======================================

    if data.startswith("batch_size_"):

        size = int(
            data.split("_")[2]
        )

        urls = user_batch_urls.get(
            user_id
        )

        if not urls:

            await query.message.reply_text(
                "❌ Data batch tidak ditemukan."
            )

            return

        await query.edit_message_text(
            f"⏳ Membuat {len(urls)} QR...\n\n"
            f"Ukuran: {size} × {size} px\n"
            "Mohon tunggu..."
        )

        try:

            # ----------------------------------
            # CREATE ZIP
            # ----------------------------------

            zip_buffer = io.BytesIO()

            with zipfile.ZipFile(
                zip_buffer,
                "w",
                zipfile.ZIP_DEFLATED
            ) as zip_file:

                used_names = set()

                for index, url in enumerate(
                    urls,
                    start=1
                ):

                    print(
                        f"Creating QR "
                        f"{index}/{len(urls)}"
                    )

                    qr_image = generate_qr(
                        url,
                        size
                    )

                    filename = create_filename(
                        url,
                        index
                    )

                    # Hindari nama file duplikat
                    original_filename = filename

                    counter = 2

                    while filename in used_names:

                        filename = (
                            original_filename
                            .replace(
                                ".png",
                                f"-{counter}.png"
                            )
                        )

                        counter += 1

                    used_names.add(
                        filename
                    )

                    zip_file.writestr(
                        filename,
                        qr_image.getvalue()
                    )


            zip_buffer.seek(0)


            # ----------------------------------
            # SEND ZIP
            # ----------------------------------

            await query.message.reply_document(
                document=zip_buffer,
                filename=f"QR-Batch-{size}px.zip",
                caption=(
                    "✅ *Batch QR selesai!*\n\n"
                    f"📦 Jumlah QR: `{len(urls)}`\n"
                    f"📐 Ukuran: `{size} × {size} px`\n"
                    "📄 Format: PNG\n"
                    "⬇️ Semua QR ada di dalam ZIP."
                ),
                parse_mode="Markdown"
            )


            # Reset batch
            user_batch_urls.pop(
                user_id,
                None
            )

            user_mode.pop(
                user_id,
                None
            )

        except Exception as error:

            print(
                "BATCH ERROR:",
                error
            )

            await query.message.reply_text(
                "❌ Terjadi error saat membuat batch."
            )

        return


    # ======================================
    # DOWNLOAD SINGLE QR
    # ======================================

    if data == "download_qr":

        qr_data = user_qr_files.get(
            user_id
        )

        if not qr_data:

            await query.message.reply_text(
                "❌ File QR sudah tidak tersedia."
            )

            return

        file_data = io.BytesIO(
            qr_data["data"]
        )

        file_data.seek(0)

        size = qr_data["size"]

        filename = user_filenames.get(
            user_id,
            f"QR-{size}px.png"
        )

        await query.message.reply_document(
            document=file_data,
            filename=filename,
            caption=(
                "📥 *QR PNG HD*\n\n"
                f"Nama file: `{filename}`\n"
                f"Ukuran: `{size} × {size} px`\n"
                "Format: PNG\n"
                "Error Correction: H"
            ),
            parse_mode="Markdown"
        )

        return


# ==========================================
# HELP COMMAND
# ==========================================

async def help_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE
):

    await update.message.reply_text(
        "📖 *QR Generator*\n\n"

        "*Command:*\n"
        "`/start` - Menu utama\n"
        "`/qr URL` - Single QR\n"
        "`/batch` - Banyak QR sekaligus\n"
        "`/help` - Bantuan\n\n"

        "*Contoh single:*\n"
        "`/qr https://example.com`\n\n"

        "*Contoh batch:*\n"
        "`/batch`",
        parse_mode="Markdown"
    )


# ==========================================
# MAIN
# ==========================================

def main():

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .build()
    )


    # --------------------------------------
    # COMMANDS
    # --------------------------------------

    application.add_handler(
        CommandHandler(
            "start",
            start
        )
    )

    application.add_handler(
        CommandHandler(
            "qr",
            qr_command
        )
    )

    application.add_handler(
        CommandHandler(
            "batch",
            batch_command
        )
    )

    application.add_handler(
        CommandHandler(
            "help",
            help_command
        )
    )


    # --------------------------------------
    # BUTTONS
    # --------------------------------------

    application.add_handler(
        CallbackQueryHandler(
            button_handler
        )
    )


    # --------------------------------------
    # MESSAGES
    # --------------------------------------

    application.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            handle_message
        )
    )


    # --------------------------------------
    # START BOT
    # --------------------------------------

    print("================================")
    print("       TELEGRAM QR BOT")
    print("================================")
    print("Bot sedang berjalan...")
    print("QR: HIGH RESOLUTION")
    print("Logo: ROUNDED SQUARE")
    print("Single QR: ENABLED")
    print("Batch QR: ENABLED")
    print("File Name: CUSTOM / AUTO")
    print("Sizes: 1000 / 2000 / 3000 / 4000 px")
    print("Download: PNG + ZIP")
    print("Jangan tutup CMD ini.")


    application.run_polling()


# ==========================================
# RUN
# ==========================================

if __name__ == "__main__":
    main()