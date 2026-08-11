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

    PENTING -- ini BUKAN daftar typo yang di-hardcode. Kandidat "kata mirip"
    dihitung dengan membandingkan token asli terhadap SELURUH daftar
    `keyword.kwlist` bawaan Python (if/elif/else/for/while/return/def/...),
    jadi otomatis ikut lengkap kalau Python nambah keyword baru, dan tidak
    perlu ada yang didaftarkan manual satu-satu.

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


    # ----------------------------------------------------------
    # Ambil semua baris source
    # ----------------------------------------------------------

    source_lines = source.splitlines()

    if (
        lineno < 1
        or lineno > len(source_lines)
    ):
        return (
            lineno,
            col,
            end_lineno,
            end_col,
            None
        )


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
        return (
            lineno,
            col,
            end_lineno,
            end_col,
            None
        )


    # ----------------------------------------------------------
    # Semua keyword Python -- sumbernya langsung dari `keyword` module,
    # bukan daftar manual.
    # ----------------------------------------------------------

    python_keywords = set(
        keyword.kwlist
    )


    # ----------------------------------------------------------
    # Cari kandidat typo keyword
    # ----------------------------------------------------------

    candidate = None

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
        # Hitung jarak token dari posisi SyntaxError.
        # ------------------------------------------------------

        distance = min(
            abs(start_col - col),
            abs(token_end_col - col)
        )

        # Jangan mengambil token yang terlalu jauh.
        if distance > 8:
            continue


        # ------------------------------------------------------
        # Cari keyword yang paling mirip -- dibandingkan ke SEMUA
        # keyword.kwlist, bukan ke daftar typo yang dikurasi manual.
        # ------------------------------------------------------

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


        # ------------------------------------------------------
        # Threshold typo.
        #
        # Contoh yang akan lolos threshold ini secara otomatis
        # (tanpa didaftarkan satu-satu):
        #
        # eturn -> return
        # els   -> else
        # retun -> return
        # retrn -> return
        #
        # Kita tidak ingin identifier normal dianggap typo.
        # ------------------------------------------------------

        if (
            best_keyword is not None
            and best_similarity >= 0.75
        ):

            if (
                candidate is None
                or best_similarity > candidate[4]
            ):

                candidate = (
                    start_col,
                    token_end_col,
                    token_text,
                    best_keyword,
                    best_similarity
                )


    # ----------------------------------------------------------
    # Jika ditemukan typo keyword
    # ----------------------------------------------------------

    if candidate is not None:

        (
            candidate_start,
            candidate_end,
            wrong_word,
            expected_keyword,
            similarity
        ) = candidate

        return (
            lineno,
            candidate_start,
            lineno,
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

    return (
        lineno,
        col,
        end_lineno,
        end_col,
        None
    )


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

    Karena murni mengandalkan `ast.parse()` milik Python sendiri, metode
    ini otomatis mencakup SEMUA jenis SyntaxError -- unterminated string,
    missing colon, indentation error, bracket tidak seimbang, keyword
    typo, dll -- tanpa ada satupun pola yang perlu didaftarkan manual.
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

            if suggestion:
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


        output = {

            "compiled": True,

            "compile_error": None,

            "score": score,

            "passed": passed,

            "diagnostics": [
                d.to_dict()
                for d in diagnostics
            ],

            "test_summary": test_summary,
        }


        if not diagnostics_available:

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