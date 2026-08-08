"""
ExGen JSON -> CodeRunner Moodle XML converter.
"""

import ast
import html
import json
import sys
from xml.sax.saxutils import escape as xml_escape


def _get_source_segment(source: str, node):
    """Fallback-safe wrapper untuk ekstrak source code dari AST node."""
    segment = ast.get_source_segment(source, node)
    if segment is not None:
        return segment
    try:
        return ast.unparse(node)
    except Exception:
        raise ValueError(f"Gagal ekstrak source code dari AST node: {ast.dump(node)}")


def parse_assert(assert_str: str):
    """
    Parse assert menjadi (call_expr_str, expected_value).
    Support:
      - assert func(args) == expected
      - assert isinstance(expr, type)  -> expected True
      - assert func(...)                -> expected True
    """
    tree = ast.parse(assert_str.strip(), mode="exec")
    if not (len(tree.body) == 1 and isinstance(tree.body[0], ast.Assert)):
        raise ValueError(f"Bukan single assert statement: {assert_str}")

    test = tree.body[0].test

    # Kasus 1: assert func(...) == expected
    if isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq):
        call_node = test.left
        expected_node = test.comparators[0]
        call_expr = _get_source_segment(assert_str, call_node)
        expected_value = ast.literal_eval(expected_node)
        return call_expr, expected_value

    # Kasus 2: assert isinstance(expr, type)
    if (isinstance(test, ast.Call) and
        isinstance(test.func, ast.Name) and
        test.func.id == 'isinstance'):
        expr_node = test.args[0]
        call_expr = _get_source_segment(assert_str, expr_node)
        return call_expr, True

    # Kasus 3: assert func(...) tanpa perbandingan
    if isinstance(test, ast.Call):
        call_expr = _get_source_segment(assert_str, test)
        return call_expr, True

    raise ValueError(f"Tidak bisa parse assert: {assert_str}")


def python_print_repr(value) -> str:
    """Representasi string persis seperti hasil print(value) di Python."""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return value
    return str(value)


def build_testcase_xml(call_expr: str, expected_value, is_example: bool) -> str:
    testcode = f"print({call_expr})"
    expected_text = python_print_repr(expected_value)

    return f'''    <testcase testtype="0" useasexample="{1 if is_example else 0}" hiderestiffail="0" mark="1.0000000">
      <testcode>
        <text><![CDATA[{testcode}]]></text>
      </testcode>
      <stdin>
        <text></text>
      </stdin>
      <expected>
        <text><![CDATA[{expected_text}]]></text>
      </expected>
      <extra>
        <text></text>
      </extra>
      <display>
        <text>SHOW</text>
      </display>
    </testcase>'''


def build_question_xml(entry: dict) -> str:
    name = xml_escape(entry["title"])
    problem_html = html.escape(entry["problem_statement"]).replace("\n", "<br>")
    example_html = html.escape(entry.get("example", "")).replace("\n", "<br>")
    solution = entry["solution"]

    testcases_xml = []
    for i, assert_str in enumerate(entry["test_cases"]):
        try:
            call_expr, expected_value = parse_assert(assert_str)
        except ValueError as e:
            print(f"[convert.py] SKIP testcase #{i+1}: {e}", file=sys.stderr)
            continue
        is_example = i < 2
        testcases_xml.append(build_testcase_xml(call_expr, expected_value, is_example))

    if not testcases_xml:
        raise ValueError(f"Tidak ada testcase valid untuk soal: {entry.get('title', 'unknown')}")

    testcases_block = "\n".join(testcases_xml)

    question_text = f"<p>{problem_html}</p>"
    if example_html:
        question_text += f"<p><b>Contoh:</b><br>{example_html}</p>"

    return f'''  <question type="coderunner">
    <name>
      <text>{name}</text>
    </name>
    <questiontext format="html">
      <text><![CDATA[{question_text}]]></text>
    </questiontext>
    <generalfeedback format="html">
      <text></text>
    </generalfeedback>
    <defaultgrade>1.0000000</defaultgrade>
    <penalty>0.3333333</penalty>
    <hidden>0</hidden>
    <coderunnertype>python3</coderunnertype>
    <prototypetype>0</prototypetype>
    <allornothing>1</allornothing>
    <penaltyregime>10, 20, ...</penaltyregime>
    <precheck>0</precheck>
    <showsource>0</showsource>
    <answerboxlines>18</answerboxlines>
    <answerboxcolumns>100</answerboxcolumns>
    <answer><![CDATA[{solution}]]></answer>
    <answerpreload><![CDATA[{entry.get("function_stub", "")}]]></answerpreload>
    <testcases>
{testcases_block}
    </testcases>
  </question>'''


def convert(seeds: dict):
    questions_xml = []
    skipped = 0
    for entry in seeds.values():
        try:
            questions_xml.append(build_question_xml(entry))
        except ValueError as e:
            print(f"[convert.py] SKIP soal '{entry.get('title', 'unknown')}': {e}", file=sys.stderr)
            skipped += 1
    body = "\n".join(questions_xml)
    xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<quiz>
{body}
</quiz>'''
    return xml, len(seeds) - skipped, skipped


if __name__ == "__main__":
    input_path = sys.argv[1] if len(sys.argv) > 1 else "seeds.json"
    output_path = sys.argv[2] if len(sys.argv) > 2 else "output.xml"

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    seeds = data["seeds"] if "seeds" in data else data
    xml_output, converted_count, skipped_count = convert(seeds)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(xml_output)

    print(json.dumps({
        "ok": True,
        "count": converted_count,
        "skipped": skipped_count,
        "output": output_path
    }))