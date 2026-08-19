"""
ast_feedback.py
────────────────────────────────────────────────────────────────────────────
AST-based feedback engine untuk ExGen.

Prinsip:
  1. READ-ONLY diagnose, tidak memodifikasi AST siswa maupun reference.
  2. Pakai lineno/col_offset ASLI dari `ast` module Python.
  3. Mendukung MULTI-REFERENCE.
  4. AST diff untuk feedback/highlight.
  5. SyntaxError ditangani terpisah dari logic mismatch.
  6. Tidak ada dependensi LLM/API untuk feedback.
  7. Scoring berbasis test case.
────────────────────────────────────────────────────────────────────────────
"""

import ast
import re
import io
import keyword
import tokenize
from difflib import SequenceMatcher
from typing import Any, Optional


# ── Topic tagging ────────────────────────────────────────────────────────────

CONTEXT_TOPIC_MAP = {
    "If": "Branching",
    "While": "Iterations",
    "For": "Iterations",
    "List": "Composite",
    "Dict": "Composite",
    "Tuple": "Composite",
    "Subscript": "Composite",
    "ListComp": "Composite",
    "DictComp": "Composite",
}

DEFAULT_TOPIC = "Simple Data Types"


def _topic_for(context: Optional[str]) -> str:
    return CONTEXT_TOPIC_MAP.get(
        context,
        DEFAULT_TOPIC
    )


# ── Operator symbol ──────────────────────────────────────────────────────────

def _op_symbol(op) -> str:
    mapping = {
        ast.Add: "+",
        ast.Sub: "-",
        ast.Mult: "*",
        ast.Div: "/",
        ast.FloorDiv: "//",
        ast.Mod: "%",
        ast.Pow: "**",
        ast.Eq: "==",
        ast.NotEq: "!=",
        ast.Lt: "<",
        ast.LtE: "<=",
        ast.Gt: ">",
        ast.GtE: ">=",
    }

    return mapping.get(
        type(op),
        type(op).__name__
    )


# ── Syntax error position correction ─────────────────────────────────────────

def _keyword_similarity(
    a: str,
    b: str
) -> float:
    """
    Menghitung kemiripan dua string.

    Digunakan untuk mendeteksi typo keyword Python.

    Contoh:

        eturn  -> return
        els    -> else
        retun  -> return
        whlie  -> while
        pritn  -> print

    Return:
        Nilai 0.0 - 1.0
    """

    return SequenceMatcher(
        None,
        a,
        b
    ).ratio()


# Keyword yang membuka BLOK (diikuti ':' dan body ter-indent). Kalau salah
# satu keyword ini typo jadi identifier biasa (mis. "if" -> "i"), Python
# tetap sukses mem-parse baris itu sebagai ekspresi (mis. pemanggilan fungsi
# "i(...)"), lalu baru meledak jauh setelahnya -- biasanya di ':' penutup
# blok yang jadi "nyasar". Karena itu heuristik untuk kelompok keyword ini
# TIDAK boleh dibatasi jarak ke posisi error yang dilaporkan Python (lihat
# `_find_better_syntax_error_position`), beda dengan typo keyword umum
# (mis. "eturn" -> "return") yang biasanya tetap dekat dengan posisi error.
_BLOCK_KEYWORDS = frozenset({
    "if", "elif", "else", "while", "for",
    "def", "class", "try", "except", "finally", "with",
})

# Similarity minimum untuk keyword umum (typo yang posisinya dekat dengan
# lokasi error yang dilaporkan Python). Contoh: "eturn" -> "return".
_GENERIC_TYPO_THRESHOLD = 0.75

# Similarity minimum untuk block-keyword di awal statement. Sedikit lebih
# longgar karena kata pendek seperti "i" vs "if" secara matematis tidak
# akan pernah setinggi typo kata panjang -- tapi posisinya (awal statement,
# diikuti pola yang berujung syntax error) sudah jadi sinyal kuat dengan
# sendirinya, jadi threshold-nya bisa sedikit diturunkan tanpa banyak
# menambah false positive pada identifier pendek yang valid (mis. "id",
# "is") karena keduanya tetap di bawah 0.6 terhadap seluruh _BLOCK_KEYWORDS.
_BLOCK_KEYWORD_THRESHOLD = 0.6

# Pesan SyntaxError yang menandakan masalah STRUKTURAL pada bracket
# ( '(' '[' '{' ) -- bukan typo satu token. Untuk error jenis ini, posisi
# yang dilaporkan Python 3.10+ SUDAH akurat (menunjuk ke bracket pembuka
# yang tidak ditutup / bracket penutup yang tidak berpasangan), jadi tidak
# perlu -- dan tidak boleh -- dikoreksi lebih lanjut oleh heuristik typo.
_BRACKET_ERROR_MARKERS = (
    "was never closed",
    "unmatched",
    "does not match",
    "closing parenthesis",
    "closing bracket",
)


def _is_bracket_structural_error(msg: Optional[str]) -> bool:
    """
    True kalau SyntaxError ini soal bracket yang tidak seimbang
    ('(', '[', '{' yang tidak ditutup, atau penutup yang salah pasangan).
    """

    text = (msg or "").lower()

    return any(
        marker in text
        for marker in _BRACKET_ERROR_MARKERS
    )


def _tokenize_best_effort(source: str) -> list:
    """
    Tokenize `source` seluruhnya, sekuat tokenizer bisa jalan.

    `source` di sini kode yang MEMANG rusak (itulah kenapa kita di sini),
    jadi tokenizer bisa gagal di tengah jalan. Iterasi manual (bukan
    `list(...)` langsung) supaya token-token valid sebelum titik
    kegagalan tetap tersimpan, bukan ikut hilang karena exception.
    """

    tokens = []

    try:
        for token in tokenize.generate_tokens(
            io.StringIO(source).readline
        ):
            tokens.append(token)
    except (
        tokenize.TokenError,
        IndentationError
    ):
        pass

    return tokens


def _find_logical_statement_start(
    tokens: list,
    lineno: int,
    col: int
):
    """
    Cari token PALING AWAL dari logical statement yang mengandung (atau,
    kalau error-nya di EOF, yang terakhir mendahului) posisi (lineno, col).

    "Logical statement" di sini beda dari "physical line": kalau ada
    bracket yang masih terbuka, Python menyambung banyak baris fisik jadi
    SATU logical line (tidak ada token NEWLINE di antaranya, cuma NL).
    Karena itu batasnya ditentukan lewat token NEWLINE milik tokenizer
    sendiri, bukan lewat hitung baris manual -- supaya otomatis benar
    untuk kasus seperti:

        if (
            a > b
            or (c == d)
        ):
            ...

    yang keseluruhannya (baris "if (" sampai "):") adalah SATU logical
    statement, walau errornya baru meledak di baris "):" paling bawah.
    """

    current_start = None

    for token in tokens:

        ttype = token.type

        if ttype == tokenize.NEWLINE:
            current_start = None
            continue

        if ttype in (
            tokenize.NL,
            tokenize.COMMENT,
            tokenize.INDENT,
            tokenize.DEDENT,
            tokenize.ENCODING,
        ):
            continue

        if ttype == tokenize.ENDMARKER:
            break

        if current_start is None:
            current_start = token

        start_row, start_col = token.start

        if (start_row, start_col) >= (lineno, col):
            return current_start

    return current_start


def _tokenize_best_effort(source: str) -> list:
    """
    Tokenize `source` seluruhnya, sekuat tokenizer bisa jalan.

    `source` di sini kode yang MEMANG rusak (itulah kenapa kita di sini),
    jadi tokenizer bisa gagal di tengah jalan. Iterasi manual (bukan
    `list(...)` langsung) supaya token-token valid sebelum titik
    kegagalan tetap tersimpan, bukan ikut hilang karena exception.
    """

    tokens = []

    try:
        for token in tokenize.generate_tokens(
            io.StringIO(source).readline
        ):
            tokens.append(token)
    except (
        tokenize.TokenError,
        IndentationError
    ):
        pass

    return tokens


def _find_logical_statement_start(
    tokens: list,
    lineno: int,
    col: int
):
    """
    Cari token PALING AWAL dari logical statement yang mengandung (atau,
    kalau error-nya di EOF, yang terakhir mendahului) posisi (lineno, col).

    "Logical statement" di sini beda dari "physical line": kalau ada
    bracket yang masih terbuka, Python menyambung banyak baris fisik jadi
    SATU logical line (tidak ada token NEWLINE di antaranya, cuma NL).
    Karena itu batasnya ditentukan lewat token NEWLINE milik tokenizer
    sendiri, bukan lewat hitung baris manual -- supaya otomatis benar
    untuk kasus seperti:

        if (
            a > b
            or (c == d)
        ):
            ...

    yang keseluruhannya (baris "if (" sampai "):") adalah SATU logical
    statement, walau errornya baru meledak di baris "):" paling bawah.
    """

    current_start = None

    for token in tokens:

        ttype = token.type

        if ttype == tokenize.NEWLINE:
            current_start = None
            continue

        if ttype in (
            tokenize.NL,
            tokenize.COMMENT,
            tokenize.INDENT,
            tokenize.DEDENT,
            tokenize.ENCODING,
        ):
            continue

        if ttype == tokenize.ENDMARKER:
            break

        if current_start is None:
            current_start = token

        start_row, start_col = token.start

        if (start_row, start_col) >= (lineno, col):
            return current_start

    return current_start


# Pasangan bracket pembuka -> penutup, dan sebaliknya.
_BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}"}
_BRACKET_CLOSERS = {v: k for k, v in _BRACKET_PAIRS.items()}


def _find_unbalanced_bracket(tokens: list):
    """
    Lacak kecocokan bracket '(' '[' '{' sendiri lewat token stream --
    TIDAK bergantung pada teks pesan SyntaxError Python sama sekali.

    Kenapa ini perlu, padahal Python sendiri sudah kasih pesan soal
    bracket: pesan Python (baik "was never closed" maupun "closing
    parenthesis ')' does not match opening parenthesis '['") melaporkan
    TITIK KETAHUANNYA parser bahwa ada yang salah. Untuk kasus mismatch
    (bukan cuma "unclosed" di EOF), titik itu adalah closing bracket yang
    "nyasar" -- BUKAN posisi bracket pembuka yang sebenarnya butuh
    pasangan. Contoh:

        (x[1, x[0]))
             ^               <- '[' ini yang sebenarnya butuh ']'
                   ^          <- tapi Python nunjuk ke ')' pertama di sini

    Buat siswa, posisi yang actionable adalah yang pertama (bracket
    pembuka yang menggantung), bukan yang kedua. Karena itu dilacak
    manual pakai stack: tiap ketemu closer yang gak cocok sama opener
    paling atas, opener itulah "tersangka" yang butuh ditutup -- bukan
    closer yang baru saja dibaca.

    Return:
        Token bracket PEMBUKA yang menggantung (butuh pasangan), token
        bracket PENUTUP yang berlebih (kalau tidak ada opener yang
        menggantung sama sekali), atau None kalau bracket balanced.
    """

    stack = []

    for token in tokens:

        if token.type != tokenize.OP:
            continue

        text = token.string

        if text in _BRACKET_PAIRS:
            stack.append(token)
            continue

        if text in _BRACKET_CLOSERS:

            if (
                stack
                and stack[-1].string == _BRACKET_CLOSERS[text]
            ):
                # Cocok, pop seperti biasa.
                stack.pop()
                continue

            # Closer ini TIDAK cocok dengan opener paling atas.
            # Kalau masih ada opener yang menggantung di stack, dialah
            # yang jadi tersangka utama (dia yang butuh pasangan).
            # Kalau stack sudah kosong, berarti closer ini sendiri yang
            # berlebih / tidak punya pasangan sama sekali.
            if stack:
                return stack[-1]

            return token

    # Tidak ada mismatch eksplisit yang ketemu -- tapi kalau masih ada
    # opener tersisa di stack sampai akhir token, itu juga menggantung
    # (kasus klasik "was never closed").
    if stack:
        return stack[-1]

    return None


def _find_better_syntax_error_position(
    source: str,
    error: SyntaxError
) -> tuple[int, int, int, int, Optional[str]]:
    """
    Mencari posisi syntax error yang lebih akurat, dan (kalau relevan)
    kata kunci Python yang paling mirip dengan token di posisi tsb.

    Python kadang memberikan posisi error pada token setelah
    token yang sebenarnya bermasalah.

    Contoh:

        eturn 'even'

    Python dapat menunjuk ke:

        eturn 'even'
              ^^^^^^

    Padahal typo sebenarnya:

        eturn
        ^^^^^

    Kasus lain, keyword pembuka blok yang typo (mis. "if" -> "i") bisa
    membuat Python sukses mem-parse baris itu sebagai ekspresi lain
    (pemanggilan fungsi), dan baru melempar error JAUH setelahnya (mis. di
    ':' penutup blok). Untuk kasus ini dicek terpisah lewat posisi
    (awal statement), bukan lewat jarak ke posisi error yang dilaporkan
    Python -- lihat `_BLOCK_KEYWORDS`.

    PENTING -- ini BUKAN daftar typo yang di-hardcode. Kandidat "kata mirip"
    dihitung dengan membandingkan token asli terhadap SELURUH daftar
    `keyword.kwlist` bawaan Python (if/elif/else/for/while/return/def/...),
    jadi otomatis ikut lengkap kalau Python nambah keyword baru, dan tidak
    perlu ada yang didaftarkan manual satu-satu.

    Kalau SyntaxError-nya soal bracket yang tidak seimbang (lihat
    `_is_bracket_structural_error`), fungsi ini TIDAK melakukan koreksi
    apapun dan langsung memakai posisi asli dari Python -- posisi itu
    sendiri sudah akurat sejak Python 3.10 (PEG parser), dan mencoba
    mencari "token mirip keyword" di dekatnya cuma berisiko salah arah.

    Return:
        (
            line,
            col,
            end_line,
            end_col,
            suggested_keyword_or_None
        )

    Format:
        line      = 1-based
        col       = 0-based
        end_line  = 1-based
        end_col   = 0-based
    """

    # ----------------------------------------------------------
    # Posisi default dari Python
    # ----------------------------------------------------------

    lineno = (
        error.lineno
        or 1
    )

    col = max(
        0,
        (error.offset or 1) - 1
    )

    end_lineno = (
        getattr(
            error,
            "end_lineno",
            None
        )
        or lineno
    )

    raw_end_col = getattr(
        error,
        "end_offset",
        None
    )

    end_col = (
        raw_end_col - 1
        if raw_end_col
        else col + 1
    )

    # Pastikan range tidak kosong.
    if (
        end_lineno == lineno
        and end_col <= col
    ):
        end_col = col + 1

    default_position = (
        lineno,
        col,
        end_lineno,
        end_col,
        None
    )

    # ----------------------------------------------------------
    # Error struktural bracket -- cari sendiri lewat bracket-tracker,
    # JANGAN pakai posisi Python apa adanya (lihat docstring
    # `_find_unbalanced_bracket` soal kenapa).
    # ----------------------------------------------------------

    if _is_bracket_structural_error(error.msg):

        all_tokens_for_bracket = _tokenize_best_effort(source)

        unbalanced = _find_unbalanced_bracket(
            all_tokens_for_bracket
        )

        if unbalanced is not None:

            b_row, b_col = unbalanced.start
            _, b_end_col = unbalanced.end

            if unbalanced.string in _BRACKET_PAIRS:
                # Bracket PEMBUKA yang menggantung -- ini kasus umumnya.
                expected_close = _BRACKET_PAIRS[unbalanced.string]
                tag = f"__UNCLOSED_BRACKET__{expected_close}"
            else:
                # Bracket PENUTUP yang berlebih, tidak ada opener sama
                # sekali yang menggantung untuk dipasangkan.
                tag = "__EXTRA_CLOSING_BRACKET__"

            return (
                b_row,
                b_col,
                b_row,
                b_end_col,
                tag
            )

        # Bracket-tracker sendiri gak nemu masalah (jarang terjadi, tapi
        # kalau iya, fallback ke posisi asli Python).
        return default_position


    # ----------------------------------------------------------
    # Ambil semua baris source
    # ----------------------------------------------------------

    source_lines = source.splitlines()

    if (
        lineno < 1
        or lineno > len(source_lines)
    ):
        return default_position


    # ----------------------------------------------------------
    # Ambil baris yang menyebabkan SyntaxError
    # ----------------------------------------------------------

    error_line = source_lines[
        lineno - 1
    ]


    # ----------------------------------------------------------
    # Tokenize baris tersebut.
    #
    # Diiterasi satu-per-satu (bukan list() langsung) karena baris
    # ini sendiri bisa punya masalah lain (mis. unterminated string
    # setelah kata yang typo) -- list() akan membuang semua token
    # yang sempat berhasil dibaca sebelum exception. Iterasi manual
    # tetap menyimpan token yang valid sebelum tokenizer gagal.
    # ----------------------------------------------------------

    tokens = []

    try:
        for token in tokenize.generate_tokens(
            io.StringIO(error_line).readline
        ):
            tokens.append(token)
    except (
        tokenize.TokenError,
        IndentationError
    ):
        pass

    if not tokens:
        return default_position


    # ----------------------------------------------------------
    # Semua keyword Python -- sumbernya langsung dari `keyword` module,
    # bukan daftar manual.
    # ----------------------------------------------------------

    python_keywords = set(
        keyword.kwlist
    )


    # ----------------------------------------------------------
    # Cari kandidat typo keyword.
    #
    # Dua jalur independen:
    #
    #   1. `block_candidate` -- token PALING AWAL dari logical statement
    #      (lihat `_find_logical_statement_start`) yang mengandung posisi
    #      error, dicek kemiripannya ke _BLOCK_KEYWORDS. Tidak dibatasi
    #      jarak fisik ke posisi error yang dilaporkan Python, karena
    #      keyword blok yang typo (mis. "if" -> "i") bisa membuat Python
    #      baru meledak beberapa BARIS setelahnya (lihat docstring di
    #      atas). Dicari lewat tokenisasi SELURUH source (bukan cuma
    #      baris error) supaya statement yang menjalar ke banyak baris
    #      lewat bracket tetap ketemu titik awalnya dengan benar.
    #      Prioritas lebih tinggi kalau ketemu.
    #
    #   2. `generic_candidate` -- token NAME apapun di baris error yang
    #      dekat dengan posisi error dan mirip keyword manapun. Ini
    #      perilaku lama, untuk typo seperti "eturn" -> "return".
    # ----------------------------------------------------------

    block_candidate = None

    all_tokens = _tokenize_best_effort(source)

    stmt_start_token = _find_logical_statement_start(
        all_tokens,
        lineno,
        col
    )

    if (
        stmt_start_token is not None
        and stmt_start_token.type == tokenize.NAME
        and stmt_start_token.string not in python_keywords
    ):

        best_block_kw = None
        best_block_similarity = 0.0

        for kw in _BLOCK_KEYWORDS:

            similarity = _keyword_similarity(
                stmt_start_token.string,
                kw
            )

            if similarity > best_block_similarity:
                best_block_similarity = similarity
                best_block_kw = kw

        if (
            best_block_kw is not None
            and best_block_similarity >= _BLOCK_KEYWORD_THRESHOLD
        ):

            stmt_start_row, stmt_start_col = stmt_start_token.start
            _, stmt_end_col = stmt_start_token.end

            block_candidate = (
                stmt_start_row,
                stmt_start_col,
                stmt_end_col,
                stmt_start_token.string,
                best_block_kw,
                best_block_similarity
            )

    generic_candidate = None

    for token in tokens:

        token_type = token.type
        token_text = token.string

        start_row, start_col = token.start
        end_row, token_end_col = token.end

        # Hanya identifier/NAME.
        if token_type != tokenize.NAME:
            continue

        # Jika memang keyword valid, bukan typo.
        if token_text in python_keywords:
            continue

        # ------------------------------------------------------
        # Typo keyword umum, dibatasi jarak ke posisi error.
        # ------------------------------------------------------

        distance = min(
            abs(start_col - col),
            abs(token_end_col - col)
        )

        # Jangan mengambil token yang terlalu jauh.
        if distance > 8:
            continue

        best_keyword = None
        best_similarity = 0.0

        for kw in python_keywords:

            similarity = _keyword_similarity(
                token_text,
                kw
            )

            if similarity > best_similarity:

                best_similarity = similarity
                best_keyword = kw

        if (
            best_keyword is not None
            and best_similarity >= _GENERIC_TYPO_THRESHOLD
        ):

            if (
                generic_candidate is None
                or best_similarity > generic_candidate[4]
            ):

                generic_candidate = (
                    lineno,
                    start_col,
                    token_end_col,
                    token_text,
                    best_keyword,
                    best_similarity
                )

    # `block_candidate` selalu diprioritaskan: kalau dia ketemu, itu
    # tandanya statement-nya kemungkinan besar rusak sejak dari
    # keyword pembuka bloknya, dan itu penjelasan yang lebih mendasar
    # dibanding typo NAME biasa yang kebetulan dekat posisi error.
    candidate = block_candidate or generic_candidate


    # ----------------------------------------------------------
    # Jika ditemukan typo keyword
    # ----------------------------------------------------------

    if candidate is not None:

        (
            candidate_line,
            candidate_start,
            candidate_end,
            wrong_word,
            expected_keyword,
            similarity
        ) = candidate

        return (
            candidate_line,
            candidate_start,
            candidate_line,
            max(
                candidate_start + 1,
                candidate_end
            ),
            expected_keyword
        )


    # ----------------------------------------------------------
    # Tidak ditemukan typo.
    #
    # Gunakan posisi asli Python.
    # ----------------------------------------------------------

    return default_position


# ── Generic multi-error syntax scanner ─────────────────────────────────────

_MAX_SYNTAX_PASSES = 25


def _blank_out_span(
    lines: list[str],
    start_lineno: int,
    end_lineno: int
) -> None:
    """
    Netralkan satu error di tempat (in place), tanpa mengubah baris lain.

    Baris pertama diganti dengan statement placeholder yang aman, dengan
    indentasi yang sama seperti baris aslinya. Baris tambahan (kalau
    errornya menjalar ke beberapa baris, mis. triple-quoted string yang
    tidak ditutup) dikosongkan saja. Jumlah baris & nomor baris file TIDAK
    berubah, supaya posisi error berikutnya yang dilaporkan Python tetap
    akurat.

    Placeholder-nya dipilih secara dinamis, bukan selalu `pass`:
    kalau baris SETELAH span ini punya indentasi lebih dalam, berarti baris
    yang error tadi kemungkinan besar adalah header blok (if/elif/else/
    while/for/def/... yang diakhiri ':') dan baris-baris di bawahnya
    adalah body yang mengharapkan blok itu tetap terbuka. Menggantinya
    dengan `pass` (statement biasa, tidak membuka blok) akan membuat body
    itu jadi "unexpected indent" -- error palsu yang sebenarnya tidak ada
    di kode siswa. Untuk kasus itu dipakai `if True:` (selalu valid
    membuka blok apapun). Kalau tidak ada body yang lebih dalam, `pass`
    tetap dipakai karena baris itu memang cuma statement biasa.

    CATATAN: fungsi ini HANYA dipanggil untuk error non-struktural-bracket
    (lihat `_is_bracket_structural_error`). Error bracket yang tidak
    seimbang sengaja tidak lewat sini -- span-nya bisa menjalar ke banyak
    baris/logical-line sekaligus (implicit line joining di dalam bracket),
    jadi "menetralkan" span itu justru berisiko ikut menghapus/merusak
    baris-baris valid dan memicu error palsu berantai di pass berikutnya.
    Lihat `_find_all_syntax_errors` untuk penanganan error bracket.
    """

    first = lines[start_lineno - 1]
    indent = first[: len(first) - len(first.lstrip())]

    next_indent = None
    for probe in lines[end_lineno:]:
        stripped = probe.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        next_indent = len(probe) - len(probe.lstrip())
        break

    opens_block = (
        next_indent is not None
        and next_indent > len(indent)
    )

    placeholder = "if True:" if opens_block else "pass"
    lines[start_lineno - 1] = indent + placeholder

    for i in range(start_lineno, end_lineno):
        lines[i] = ""


def _find_all_syntax_errors(
    student_code: str,
    max_passes: int = _MAX_SYNTAX_PASSES
) -> list:
    """
    Temukan SEMUA syntax error dalam kode siswa, bukan cuma yang pertama.

    BEST PRACTICE / kenapa begini:
    Python's parser secara desain cuma pernah melempar SATU SyntaxError per
    ast.parse() -- begitu ketemu masalah pertama, ia langsung berhenti dan
    tidak tahu apa-apa lagi soal sisa file. Pendekatan lama mencoba
    menambal ini dengan daftar typo yang di-hardcode manual (mis. "retrn"
    harus didaftarkan satu-satu supaya kedeteksi) -- rapuh, dan selalu
    ketinggalan typo yang belum pernah ditulis di daftar.

    Solusi generic (dipakai oleh tool-tool seperti Pyright/Pylance untuk
    multi-error reporting): re-parse berulang.
      1. Parse. Kalau sukses -> selesai, tidak ada error.
      2. Kalau gagal -> catat errornya (posisi diperhalus otomatis lewat
         `_find_better_syntax_error_position`, yang membandingkan ke
         SELURUH `keyword.kwlist` bawaan Python -- bukan daftar manual).
      3. "Netralkan" baris yang bermasalah itu saja (ganti jadi `pass`,
         baris lain tidak disentuh, nomor baris tidak berubah).
      4. Parse ulang dari langkah 1. Error berikutnya (kalau ada) akan
         muncul dengan sendirinya, karena Python sekarang bisa membaca
         lebih jauh.
    Diulang sampai file bersih, tidak ada progres baru, atau `max_passes`
    tercapai (guard rail terhadap kasus pathological / infinite loop).

    PENGECUALIAN -- bracket yang tidak seimbang (unclosed/unmatched '(' '['
    '{'): error jenis ini SENGAJA tidak dilanjutkan ke pass berikutnya.
    Bracket yang tidak ditutup membuat Python menggabungkan banyak baris
    fisik jadi satu "logical line" (implicit line joining) sampai ia
    ketemu penutupnya atau EOF -- artinya span masalahnya tidak bisa
    diisolasi dengan aman ke satu baris seperti error lain. Kalau tetap
    dipaksa "netralkan lalu lanjut", baris-baris valid di dalam span itu
    ikut ke-blank, dan pass berikutnya akan melaporkan error-error palsu
    di banyak tempat yang sebenarnya tidak ada masalah -- persis gejala
    "highlight menyebar ke banyak tempat" untuk satu `]` yang hilang.
    Karena itu, begitu ketemu error jenis ini, kita laporkan SATU kali
    (di posisi yang sudah akurat dari Python 3.10+) dan langsung berhenti.

    Karena murni mengandalkan `ast.parse()` milik Python sendiri, metode
    ini otomatis mencakup SEMUA jenis SyntaxError -- unterminated string,
    missing colon, indentation error, keyword typo, dll -- tanpa ada
    satupun pola yang perlu didaftarkan manual.
    """

    findings = []
    lines = student_code.splitlines()

    if not lines:
        return findings

    seen_positions = set()

    for _ in range(max_passes):

        candidate_source = "\n".join(lines)

        try:
            ast.parse(candidate_source)
            break  # bersih, tidak ada error lagi.

        except SyntaxError as e:

            (
                better_line,
                better_col,
                better_end_line,
                better_end_col,
                suggestion
            ) = _find_better_syntax_error_position(
                candidate_source,
                e
            )

            position_key = (better_line, better_col)

            if position_key in seen_positions:
                # Netralisasi tidak mengubah apa-apa yang berarti di posisi
                # ini -- berhenti supaya tidak infinite loop.
                break

            seen_positions.add(position_key)

            if suggestion and suggestion.startswith("__UNCLOSED_BRACKET__"):
                expected_close = suggestion[len("__UNCLOSED_BRACKET__"):]
                message = "Unclosed bracket"
                detail = (
                    f"This bracket is missing its matching '{expected_close}'"
                )
            elif suggestion == "__EXTRA_CLOSING_BRACKET__":
                message = "Unexpected closing bracket"
                detail = (
                    "This closing bracket doesn't have a matching "
                    "opening bracket"
                )
            elif suggestion:
                message = "Possible syntax error"
                detail = (
                    f"Did you mean '{suggestion}'? "
                    f"({e.msg})"
                )
            else:
                message = "Syntax error"
                detail = str(e.msg)

            findings.append({
                "line": better_line,
                "col": better_col,
                "end_line": better_end_line,
                "end_col": better_end_col,
                "message": message,
                "detail": detail,
                "topic": "Syntax",
                "severity": "error",
            })

            # Bracket tidak seimbang -- lihat penjelasan panjang di
            # docstring di atas. Berhenti di sini, jangan blank & lanjut.
            if _is_bracket_structural_error(e.msg):
                break

            # Koreksi "loncat baris" (mis. block-keyword typo yang
            # dikoreksi ke baris JAUH sebelum baris yang dilaporkan
            # Python -- lihat `_find_logical_statement_start`) berarti
            # error yang sebenarnya adalah bagian dari SATU logical
            # statement yang menjalar melewati banyak baris fisik lewat
            # bracket. `_blank_out_span` bekerja per baris fisik memakai
            # posisi ASLI dari Python (`e.lineno`/`e.end_lineno`), yang
            # cuma mewakili ujung ekor statement itu (mis. baris "):"),
            # bukan keseluruhan span-nya. Menetralkan cuma ekornya lalu
            # lanjut parse ulang akan merusak pasangan bracket yang tadinya
            # valid (mis. "(" di baris awal kehilangan pasangannya) dan
            # memicu error palsu baru. Jadi berhenti di sini juga.
            corrected_to_earlier_line = (
                better_line != (e.lineno or better_line)
            )

            if suggestion and corrected_to_earlier_line:
                break

            raw_lineno = e.lineno or better_line
            raw_end_lineno = (
                getattr(e, "end_lineno", None)
                or raw_lineno
            )

            if (
                raw_lineno < 1
                or raw_lineno > len(lines)
            ):
                # Posisi di luar jangkauan -- tidak bisa dinetralkan,
                # berhenti di sini daripada looping tanpa progres.
                break

            _blank_out_span(
                lines,
                raw_lineno,
                max(raw_end_lineno, raw_lineno)
            )

    return findings

# ── Diagnostic Entry ──────────────────────────────────────────────────────────

class DiagnosticEntry:
    """
    Satu temuan mismatch,
    siap diserialisasi ke posisi editor VS Code.
    """

    __slots__ = (
        "lineno",
        "col_offset",
        "end_lineno",
        "end_col_offset",
        "message",
        "detail",
        "topic",
        "severity"
    )

    def __init__(
        self,
        node,
        message,
        detail,
        topic,
        severity="warning"
    ):

        self.lineno = getattr(
            node,
            "lineno",
            1
        )

        self.col_offset = getattr(
            node,
            "col_offset",
            0
        )

        self.end_lineno = getattr(
            node,
            "end_lineno",
            self.lineno
        )

        self.end_col_offset = getattr(
            node,
            "end_col_offset",
            self.col_offset + 1
        )

        self.message = message
        self.detail = detail
        self.topic = topic
        self.severity = severity


    def to_dict(self) -> dict:

        return {
            "line": self.lineno,
            "col": self.col_offset,
            "end_line": self.end_lineno,
            "end_col": self.end_col_offset,
            "message": self.message,
            "detail": self.detail,
            "topic": self.topic,
            "severity": self.severity,
        }


# ── Structural similarity ────────────────────────────────────────────────────

def node_similarity(
    b_node,
    c_node
) -> float:
    """
    Skor kemiripan struktural dua node AST.

    Return:
        0.0 - 1.0
    """

    if type(b_node) is not type(c_node):

        loop_types = (
            ast.While,
            ast.For
        )

        if (
            isinstance(
                b_node,
                loop_types
            )
            and isinstance(
                c_node,
                loop_types
            )
        ):

            return 0.5

        return 0.0


    if isinstance(
        b_node,
        ast.FunctionDef
    ):

        return (
            1.0
            if b_node.name == c_node.name
            else 0.6
        )


    if isinstance(
        b_node,
        ast.Assign
    ):

        try:

            b_targets = [
                ast.dump(t)
                for t in b_node.targets
            ]

            c_targets = [
                ast.dump(t)
                for t in c_node.targets
            ]

            return (
                1.0
                if b_targets == c_targets
                else 0.5
            )

        except Exception:

            return 0.5


    if isinstance(
        b_node,
        ast.Call
    ):

        b_name = (
            getattr(
                b_node.func,
                "id",
                None
            )
            or getattr(
                b_node.func,
                "attr",
                None
            )
        )

        c_name = (
            getattr(
                c_node.func,
                "id",
                None
            )
            or getattr(
                c_node.func,
                "attr",
                None
            )
        )

        return (
            1.0
            if b_name == c_name
            else 0.5
        )


    if isinstance(
        b_node,
        (
            ast.If,
            ast.While,
            ast.For
        )
    ):

        return 0.8


    if isinstance(
        b_node,
        (
            ast.BinOp,
            ast.Compare,
            ast.BoolOp,
            ast.UnaryOp,
            ast.Constant,
            ast.Name,
            ast.Return
        )
    ):

        try:

            return (
                1.0
                if ast.dump(b_node)
                == ast.dump(c_node)
                else 0.5
            )

        except Exception:

            return 0.5


    return 0.5


# ── Align lists ───────────────────────────────────────────────────────────────

def align_lists(
    buggy_list: list,
    correct_list: list
):

    """
    Mencocokkan urutan statement buggy vs correct
    menggunakan similarity score.

    Return:
        (
            matches,
            unmatched_buggy_idx,
            unmatched_correct_idx
        )
    """

    matched_b = set()
    matched_c = set()

    matches = []


    # ----------------------------------------------------------
    # Dua tahap matching.
    # ----------------------------------------------------------

    for threshold in (
        0.8,
        0.3
    ):

        for c_idx, c_stmt in enumerate(
            correct_list
        ):

            if c_idx in matched_c:
                continue


            best_b_idx = -1
            best_score = 0.0


            for b_idx, b_stmt in enumerate(
                buggy_list
            ):

                if b_idx in matched_b:
                    continue


                score = node_similarity(
                    b_stmt,
                    c_stmt
                )


                if score > best_score:

                    best_score = score
                    best_b_idx = b_idx


            if best_score >= threshold:

                matches.append(
                    (
                        best_b_idx,
                        c_idx
                    )
                )

                matched_b.add(
                    best_b_idx
                )

                matched_c.add(
                    c_idx
                )


    unmatched_b = [
        i
        for i in range(
            len(buggy_list)
        )
        if i not in matched_b
    ]


    unmatched_c = [
        i
        for i in range(
            len(correct_list)
        )
        if i not in matched_c
    ]


    return (
        matches,
        unmatched_b,
        unmatched_c
    )


# ── Core recursive diff ───────────────────────────────────────────────────────

MAX_DEPTH = 60


def diff_nodes(
    buggy,
    correct,
    diagnostics: list,
    stats: dict,
    context: Optional[str] = None,
    depth: int = 0
) -> None:

    """
    Recursive diagnose.

    Tidak pernah mengubah AST buggy maupun correct.
    """

    if depth > MAX_DEPTH:
        return


    if (
        buggy is None
        or correct is None
    ):
        return


    # ----------------------------------------------------------
    # List statements / expressions
    # ----------------------------------------------------------

    if (
        isinstance(buggy, list)
        and isinstance(correct, list)
    ):

        (
            matches,
            unmatched_b,
            unmatched_c
        ) = align_lists(
            buggy,
            correct
        )


        for (
            b_idx,
            c_idx
        ) in matches:

            diff_nodes(
                buggy[b_idx],
                correct[c_idx],
                diagnostics,
                stats,
                context,
                depth + 1
            )


        for idx in unmatched_c:

            node = correct[idx]

            anchor = (
                buggy[0]
                if buggy
                else node
            )


            try:

                expected_code = ast.unparse(
                    node
                )

            except Exception:

                expected_code = "(unavailable)"


            diagnostics.append(
                DiagnosticEntry(
                    anchor,
                    "Missing statement",
                    (
                        "Expected something like: "
                        f"{expected_code}"
                    ),
                    _topic_for(context),
                    severity="error"
                )
            )


            stats["total"] += 1


        for idx in unmatched_b:

            node = buggy[idx]


            try:

                found_code = ast.unparse(
                    node
                )

            except Exception:

                found_code = "(unavailable)"


            diagnostics.append(
                DiagnosticEntry(
                    node,
                    "Unexpected/extra statement",
                    (
                        "This statement doesn't "
                        "match the expected solution: "
                        f"{found_code}"
                    ),
                    _topic_for(context),
                    severity="warning"
                )
            )


            stats["total"] += 1


        return


    if (
        not isinstance(
            buggy,
            ast.AST
        )
        or not isinstance(
            correct,
            ast.AST
        )
    ):

        return


    # ----------------------------------------------------------
    # Context
    # ----------------------------------------------------------

    new_context = context


    if isinstance(
        correct,
        (
            ast.If,
            ast.While,
            ast.For,
            ast.ListComp,
            ast.DictComp,
            ast.Dict,
            ast.List,
            ast.Tuple
        )
    ):

        new_context = type(
            correct
        ).__name__


    # ----------------------------------------------------------
    # Structural type mismatch
    # ----------------------------------------------------------

    if type(buggy) is not type(correct):

        try:

            expected_code = ast.unparse(
                correct
            )

        except Exception:

            expected_code = type(
                correct
            ).__name__


        diagnostics.append(
            DiagnosticEntry(
                buggy,
                "Different kind of statement/expression than expected",
                (
                    f"Expected '{type(correct).__name__}', "
                    f"found '{type(buggy).__name__}': "
                    f"{expected_code}"
                ),
                _topic_for(new_context),
                severity="error"
            )
        )


        stats["total"] += 1

        return


    # ----------------------------------------------------------
    # Arithmetic operator
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.BinOp
    ):

        stats["total"] += 1


        if type(
            buggy.op
        ) is not type(
            correct.op
        ):

            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong arithmetic operator",
                    (
                        f"Expected '{_op_symbol(correct.op)}', "
                        f"found '{_op_symbol(buggy.op)}'"
                    ),
                    _topic_for(new_context)
                )
            )


        diff_nodes(
            buggy.left,
            correct.left,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )


        diff_nodes(
            buggy.right,
            correct.right,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )

        return


    # ----------------------------------------------------------
    # Comparison operator
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Compare
    ):

        stats["total"] += 1


        b_ops = [
            type(o)
            for o in buggy.ops
        ]

        c_ops = [
            type(o)
            for o in correct.ops
        ]


        if b_ops != c_ops:

            try:

                b_code = ast.unparse(
                    buggy
                )

                c_code = ast.unparse(
                    correct
                )

            except Exception:

                b_code = "?"
                c_code = "?"


            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong comparison operator",
                    (
                        f"Expected '{c_code}', "
                        f"found '{b_code}'"
                    ),
                    _topic_for(new_context)
                )
            )


        diff_nodes(
            buggy.left,
            correct.left,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )


        for (
            b_c,
            c_c
        ) in zip(
            buggy.comparators,
            correct.comparators
        ):

            diff_nodes(
                b_c,
                c_c,
                diagnostics,
                stats,
                new_context,
                depth + 1
            )


        return


    # ----------------------------------------------------------
    # Boolean operator
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.BoolOp
    ):

        stats["total"] += 1


        if type(
            buggy.op
        ) is not type(
            correct.op
        ):

            expected_op = (
                "and"
                if isinstance(
                    correct.op,
                    ast.And
                )
                else "or"
            )


            found_op = (
                "and"
                if isinstance(
                    buggy.op,
                    ast.And
                )
                else "or"
            )


            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong boolean operator",
                    (
                        f"Expected '{expected_op}', "
                        f"found '{found_op}'"
                    ),
                    _topic_for(new_context)
                )
            )


        if len(
            buggy.values
        ) == len(
            correct.values
        ):

            for (
                b_v,
                c_v
            ) in zip(
                buggy.values,
                correct.values
            ):

                diff_nodes(
                    b_v,
                    c_v,
                    diagnostics,
                    stats,
                    new_context,
                    depth + 1
                )


        return


    # ----------------------------------------------------------
    # Constant value
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Constant
    ):

        stats["total"] += 1


        if buggy.value != correct.value:

            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong value",
                    (
                        f"Expected {correct.value!r}, "
                        f"found {buggy.value!r}"
                    ),
                    _topic_for(new_context)
                )
            )


        return


    # ----------------------------------------------------------
    # Variable name
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Name
    ):

        stats["total"] += 1


        if buggy.id != correct.id:

            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong variable name",
                    (
                        f"Expected '{correct.id}', "
                        f"found '{buggy.id}'"
                    ),
                    _topic_for(new_context)
                )
            )


        return


    # ----------------------------------------------------------
    # Assignment
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Assign
    ):

        stats["total"] += 1


        try:

            b_targets = [
                ast.dump(t)
                for t in buggy.targets
            ]

            c_targets = [
                ast.dump(t)
                for t in correct.targets
            ]

        except Exception:

            b_targets = []
            c_targets = []


        if b_targets != c_targets:

            try:

                b_code = ast.unparse(
                    buggy.targets[0]
                )

                c_code = ast.unparse(
                    correct.targets[0]
                )

            except Exception:

                b_code = "?"
                c_code = "?"


            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong assignment target",
                    (
                        f"Expected assigning to '{c_code}', "
                        f"found '{b_code}'"
                    ),
                    _topic_for(new_context)
                )
            )


        diff_nodes(
            buggy.value,
            correct.value,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )


        return


    # ----------------------------------------------------------
    # Augmented assignment
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.AugAssign
    ):

        stats["total"] += 1


        if type(
            buggy.op
        ) is not type(
            correct.op
        ):

            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong compound assignment operator",
                    (
                        f"Expected '{_op_symbol(correct.op)}=', "
                        f"found '{_op_symbol(buggy.op)}='"
                    ),
                    _topic_for(new_context)
                )
            )


        diff_nodes(
            buggy.value,
            correct.value,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )


        return


    # ----------------------------------------------------------
    # If
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.If
    ):

        diff_nodes(
            buggy.test,
            correct.test,
            diagnostics,
            stats,
            "If",
            depth + 1
        )


        diff_nodes(
            buggy.body,
            correct.body,
            diagnostics,
            stats,
            "If",
            depth + 1
        )


        diff_nodes(
            buggy.orelse,
            correct.orelse,
            diagnostics,
            stats,
            "If",
            depth + 1
        )


        return


    # ----------------------------------------------------------
    # While
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.While
    ):

        diff_nodes(
            buggy.test,
            correct.test,
            diagnostics,
            stats,
            "While",
            depth + 1
        )


        diff_nodes(
            buggy.body,
            correct.body,
            diagnostics,
            stats,
            "While",
            depth + 1
        )


        return


    # ----------------------------------------------------------
    # For
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.For
    ):

        diff_nodes(
            buggy.target,
            correct.target,
            diagnostics,
            stats,
            "For",
            depth + 1
        )


        diff_nodes(
            buggy.iter,
            correct.iter,
            diagnostics,
            stats,
            "For",
            depth + 1
        )


        diff_nodes(
            buggy.body,
            correct.body,
            diagnostics,
            stats,
            "For",
            depth + 1
        )


        return


    # ----------------------------------------------------------
    # Function call
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Call
    ):
        stats["total"] += 1

        b_name = (
            getattr(buggy.func, "id", None)
            or getattr(buggy.func, "attr", None)
        )

        c_name = (
            getattr(correct.func, "id", None)
            or getattr(correct.func, "attr", None)
        )

        if b_name != c_name:
            diagnostics.append(
                DiagnosticEntry(
                    buggy.func,
                    "Wrong function/method called",
                    (
                        f"Expected call to '{c_name}', "
                        f"found '{b_name}'"
                    ),
                    _topic_for(new_context),
                    severity="error"
                )
            )

        # Positional arguments.
        if len(buggy.args) == len(correct.args):
            for b_arg, c_arg in zip(buggy.args, correct.args):
                diff_nodes(
                    b_arg,
                    c_arg,
                    diagnostics,
                    stats,
                    new_context,
                    depth + 1
                )
        else:
            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Wrong number of arguments",
                    (
                        f"Expected {len(correct.args)} argument(s), "
                        f"found {len(buggy.args)}"
                    ),
                    _topic_for(new_context),
                    severity="error"
                )
            )
            stats["total"] += 1

            # Tetap bandingkan pasangan argument yang tersedia supaya
            # kesalahan lain di dalam call tidak hilang hanya karena
            # jumlah argument berbeda.
            for b_arg, c_arg in zip(
                buggy.args,
                correct.args
            ):
                diff_nodes(
                    b_arg,
                    c_arg,
                    diagnostics,
                    stats,
                    new_context,
                    depth + 1
                )

        # Keyword arguments, misalnya:
        #     sorted(numbers, reverse=True)
        # dibandingkan dengan:
        #     sorted(numbers, reverse=false)
        #
        # ast.Call menyimpan bagian `reverse=...` di `.keywords`,
        # bukan di `.args`. Karena itu harus dibandingkan terpisah.
        buggy_keywords = {
            kw.arg: kw
            for kw in buggy.keywords
            if kw.arg is not None
        }

        correct_keywords = {
            kw.arg: kw
            for kw in correct.keywords
            if kw.arg is not None
        }

        buggy_names = set(buggy_keywords)
        correct_names = set(correct_keywords)

        # Keyword yang seharusnya ada tetapi tidak ada pada siswa.
        for name in sorted(correct_names - buggy_names):
            expected = correct_keywords[name]
            try:
                expected_code = ast.unparse(expected.value)
            except Exception:
                expected_code = type(expected.value).__name__

            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Missing keyword argument",
                    (
                        f"Expected '{name}={expected_code}'"
                    ),
                    _topic_for(new_context),
                    severity="error"
                )
            )
            stats["total"] += 1

        # Keyword tambahan yang tidak ada pada reference.
        for name in sorted(buggy_names - correct_names):
            found = buggy_keywords[name]
            try:
                found_code = ast.unparse(found.value)
            except Exception:
                found_code = type(found.value).__name__

            diagnostics.append(
                DiagnosticEntry(
                    found.value,
                    "Unexpected keyword argument",
                    (
                        f"Unexpected '{name}={found_code}'"
                    ),
                    _topic_for(new_context),
                    severity="warning"
                )
            )
            stats["total"] += 1

        # Keyword yang sama dibandingkan nilainya secara recursive.
        for name in sorted(buggy_names & correct_names):
            diff_nodes(
                buggy_keywords[name].value,
                correct_keywords[name].value,
                diagnostics,
                stats,
                new_context,
                depth + 1
            )

        # **kwargs tidak mempunyai kw.arg. Tetap beri diagnostic bila
        # struktur reference berbeda.
        buggy_kwargs = [kw for kw in buggy.keywords if kw.arg is None]
        correct_kwargs = [kw for kw in correct.keywords if kw.arg is None]

        if len(buggy_kwargs) != len(correct_kwargs):
            node = (
                buggy_kwargs[0].value
                if buggy_kwargs
                else buggy
            )
            diagnostics.append(
                DiagnosticEntry(
                    node,
                    "Wrong number of **kwargs",
                    (
                        f"Expected {len(correct_kwargs)} **kwargs, "
                        f"found {len(buggy_kwargs)}"
                    ),
                    _topic_for(new_context),
                    severity="error"
                )
            )
            stats["total"] += 1
        else:
            for b_kw, c_kw in zip(buggy_kwargs, correct_kwargs):
                diff_nodes(
                    b_kw.value,
                    c_kw.value,
                    diagnostics,
                    stats,
                    new_context,
                    depth + 1
                )

        return

    # ----------------------------------------------------------
    # Return
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Return
    ):

        diff_nodes(
            buggy.value,
            correct.value,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )

        return


    # ----------------------------------------------------------
    # Function definition
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.FunctionDef
    ):

        diff_nodes(
            buggy.body,
            correct.body,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )

        return


    # ----------------------------------------------------------
    # Module
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Module
    ):

        diff_nodes(
            buggy.body,
            correct.body,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )

        return


    # ----------------------------------------------------------
    # List / Tuple / Set
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        (
            ast.List,
            ast.Tuple,
            ast.Set
        )
    ):

        diff_nodes(
            list(buggy.elts),
            list(correct.elts),
            diagnostics,
            stats,
            new_context,
            depth + 1
        )

        return


    # ----------------------------------------------------------
    # Subscript
    # ----------------------------------------------------------

    if isinstance(
        buggy,
        ast.Subscript
    ):

        diff_nodes(
            buggy.value,
            correct.value,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )


        diff_nodes(
            buggy.slice,
            correct.slice,
            diagnostics,
            stats,
            new_context,
            depth + 1
        )


        return


    # ----------------------------------------------------------
    # Fallback
    # ----------------------------------------------------------

    stats["total"] += 1


    try:

        buggy_code = ast.unparse(
            buggy
        )

        correct_code = ast.unparse(
            correct
        )


        if buggy_code != correct_code:

            diagnostics.append(
                DiagnosticEntry(
                    buggy,
                    "Mismatch",
                    (
                        f"Expected '{correct_code}', "
                        f"found '{buggy_code}'"
                    ),
                    _topic_for(new_context)
                )
            )

    except Exception:
        pass


# ── Test-case runner ─────────────────────────────────────────────────────────

def run_test_cases(
    student_code: str,
    test_cases: list
) -> dict:

    """
    Jalankan kode siswa terhadap setiap test case.

    Return:

        {
            "total": int,
            "passed_count": int,
            "results": [
                {
                    "index": int,
                    "test": str,
                    "passed": bool,
                    "error": str | None
                }
            ]
        }
    """

    result = {
        "total": len(test_cases),
        "passed_count": 0,
        "results": []
    }


    if not test_cases:
        return result


    # ----------------------------------------------------------
    # Jalankan / definisikan kode siswa
    # ----------------------------------------------------------

    try:

        base_namespace: dict = {}


        exec(
            compile(
                ast.parse(student_code),
                "<student>",
                "exec"
            ),
            base_namespace
        )


    except Exception as e:

        for (
            i,
            tc
        ) in enumerate(test_cases):

            result["results"].append({

                "index": i,

                "test": tc,

                "passed": False,

                "error": (
                    "Could not run your code: "
                    f"{type(e).__name__}: {e}"
                ),
            })


        return result


    # ----------------------------------------------------------
    # Jalankan setiap test case
    # ----------------------------------------------------------

    for (
        i,
        tc
    ) in enumerate(test_cases):

        namespace = dict(
            base_namespace
        )


        entry = {

            "index": i,

            "test": tc,

            "passed": False,

            "error": None
        }


        try:

            exec(
                tc,
                namespace
            )

            entry["passed"] = True


        except AssertionError:

            entry["error"] = (
                "Assertion failed"
            )


        except Exception as e:

            entry["error"] = (
                f"{type(e).__name__}: {e}"
            )


        if entry["passed"]:

            result["passed_count"] += 1


        result["results"].append(
            entry
        )


    return result


# ── Public entry point ────────────────────────────────────────────────────────

def get_feedback(
    student_code: str,
    reference_solutions: list,
    test_cases: Optional[list] = None
) -> dict:

    """
    Bandingkan student_code terhadap 1+ reference_solutions
    untuk highlight, dan hitung score dari test cases.

    Highlight:
        AST diff ke reference yang paling mirip.

    Score:
        Jumlah test case yang berhasil dijalankan.

    Return:

        {
            "compiled": bool,
            "compile_error": str | None,
            "score": float,
            "passed": bool,
            "diagnostics": [...],
            "test_summary": {...}
        }
    """

    test_cases = test_cases or []


    # ==========================================================
    # 1. PARSE STUDENT CODE
    # ==========================================================

    try:

        student_ast = ast.parse(
            student_code
        )


    except SyntaxError as e:

        syntax_details = _find_all_syntax_errors(
            student_code
        )

        # Guard rail: _find_all_syntax_errors always finds at least the
        # error `e` itself on its first pass, but fall back safely just in
        # case of an edge case (e.g. an empty file) it can't recover from.
        if not syntax_details:
            syntax_details = [{
                "line": e.lineno or 1,
                "col": max(0, (e.offset or 1) - 1),
                "end_line": getattr(e, "end_lineno", None) or (e.lineno or 1),
                "end_col": max(0, (e.offset or 1) - 1) + 1,
                "message": "Syntax error",
                "detail": str(e.msg),
                "topic": "Syntax",
                "severity": "error",
            }]

        return {
            "compiled": False,
            "compile_error": f"SyntaxError: {e.msg}",
            "compile_error_detail": syntax_details[0],
            "compile_error_details": syntax_details,
            "score": 0.0,
            "passed": False,
            "diagnostics": [],
        }

    # ==========================================================
    # 2. AST DIFF KE REFERENCE TERBAIK
    # ==========================================================

    best = None

    # Format:
    #
    # (
    #     len(diagnostics),
    #     diagnostics,
    #     stats
    # )


    for ref in reference_solutions:

        # Mendukung dua format agar kompatibel dengan data lama:
        #   1. "def ..."
        #   2. {"id": ..., "technique": ..., "solution": ...}
        if isinstance(ref, dict):
            ref_code = ref.get("solution", "")
        else:
            ref_code = ref

        if not isinstance(ref_code, str) or not ref_code.strip():
            continue

        try:

            ref_ast = ast.parse(
                ref_code
            )

        except SyntaxError:

            # Reference rusak -> skip.
            continue


        diagnostics = []

        stats = {
            "total": 0
        }


        diff_nodes(
            student_ast.body,
            ref_ast.body,
            diagnostics,
            stats,
            None
        )


        # ------------------------------------------------------
        # Pilih reference dengan diagnostic paling sedikit.
        # ------------------------------------------------------

        if (
            best is None
            or len(diagnostics)
            < len(best[1])
        ):

            best = (
                len(diagnostics),
                diagnostics,
                stats
            )


    # ----------------------------------------------------------
    # Ambil hasil reference terbaik.
    # ----------------------------------------------------------

    if best is None:

        diagnostics = []

        stats = {
            "total": 0
        }

        diagnostics_available = False


    else:

        (
            _,
            diagnostics,
            stats
        ) = best

        diagnostics_available = True


    # ==========================================================
    # 3. SCORE & PASSED
    # ==========================================================

    if test_cases:

        test_summary = run_test_cases(
            student_code,
            test_cases
        )


        score = (
            round(
                test_summary["passed_count"]
                / test_summary["total"],
                3
            )
            if test_summary["total"]
            else 0.0
        )


        passed = (
            test_summary["passed_count"]
            == test_summary["total"]
        )


        # ------------------------------------------------------
        # Kalau SEMUA test case lolos (real execution), kode siswa
        # sudah terbukti benar secara fungsional -- terlepas dari
        # teknik/gaya apa yang dipakai. Diagnostic dari diff_nodes
        # cuma menandakan "struktur AST-nya beda dari reference",
        # bukan "salah" -- jadi kalau sudah terbukti benar lewat
        # test case, diagnostic itu HARUS disembunyikan supaya
        # siswa tidak melihat highlight merah di kode yang
        # sebenarnya sudah sepenuhnya benar.
        #
        # Kalau belum semua lolos, diagnostic tetap ditampilkan
        # apa adanya -- itu petunjuk berguna soal bagian mana yang
        # kemungkinan jadi penyebab test case gagal.
        # ------------------------------------------------------

        visible_diagnostics = (
            []
            if passed
            else [
                d.to_dict()
                for d in diagnostics
            ]
        )


        output = {

            "compiled": True,

            "compile_error": None,

            "score": score,

            "passed": passed,

            "diagnostics": visible_diagnostics,

            "test_summary": test_summary,
        }


        if not diagnostics_available and not passed:

            output["error"] = (
                "No valid reference solution "
                "to compare against for highlighting"
            )


        return output


    # ==========================================================
    # 4. FALLBACK JIKA TIDAK ADA TEST CASE
    # ==========================================================

    if not diagnostics_available:

        return {

            "compiled": True,

            "compile_error": None,

            "score": 0.0,

            "passed": False,

            "diagnostics": [],

            "error": (
                "No valid reference solution "
                "to compare against"
            ),
        }


    total_checkpoints = max(
        1,
        stats["total"]
    )


    mismatch_count = len(
        diagnostics
    )


    score = max(
        0.0,
        1.0 - (
            mismatch_count
            / total_checkpoints
        )
    )


    return {

        "compiled": True,

        "compile_error": None,

        "score": round(
            score,
            3
        ),

        "passed": (
            mismatch_count == 0
        ),

        "diagnostics": [
            d.to_dict()
            for d in diagnostics
        ],
    }