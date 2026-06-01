import sys
import json
import os
import random
import ast
import traceback
from tinydb import TinyDB, Query

DB_PATH = os.path.join(os.path.dirname(__file__), 'db.json')

def get_db():
    return TinyDB(DB_PATH)

def import_seeds(seed_json_path: str):
    """Import seed exercises into TinyDB (only if DB is empty)."""
    db = get_db()
    if len(db.all()) > 0:
        print(json.dumps({"status": "skipped", "message": "DB already populated"}))
        return

    with open(seed_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    seeds = data.get('seed_exercises', [])
    for seed in seeds:
        db.insert(seed)

    print(json.dumps({"status": "ok", "imported": len(seeds)}))

def get_seeds_for_shot(difficulty: str, shot_count: int):
    """Get N seeds based on difficulty for few-shot examples."""
    if shot_count == 0:
        print(json.dumps([]))
        return

    db = get_db()
    Exercise = Query()

    results = db.search(Exercise.difficulty == difficulty.lower())

    if not results:
        print(json.dumps([]))
        return

    random.shuffle(results)
    selected = results[:shot_count]

    print(json.dumps(selected))

def get_all_exercises():
    """Get all exercises from the database, sorted by difficulty."""
    db = get_db()
    results = db.all()
    difficulty_order = {'easy': 0, 'intermediate': 1, 'hard': 2}
    results.sort(key=lambda x: (difficulty_order.get(x.get('difficulty', ''), 99), x.get('id', 0)))
    print(json.dumps(results))

def run_filters(payload: dict) -> dict:
    """
    Chain of filters sesuai paper ExGen (Fig. 6):
      1. Compilation Check  — apakah solution bisa di-compile ke bytecode tanpa error?
      2. Unit Testing Check — apakah semua test_cases pass saat solution dijalankan?

    Returns dict:
      {
        "passed": bool,
        "compilation": { "passed": bool, "error": str|null },
        "unit_test":   { "passed": bool, "error": str|null }   # null jika compilation gagal
      }
    """
    solution   = payload.get("solution", "")
    test_cases = payload.get("test_cases", [])   # list of assert strings

    result = {
        "passed": False,
        "compilation": {"passed": False, "error": None},
        "unit_test":   None
    }

    # ── Filter 1: Compilation Check ──────────────────────────────────────────
    # memeriksa syntax solution dengan ast.parse + compile. Jika error, catat pesan error dan stop.
    try:
        tree = ast.parse(solution)
        compile(tree, "<exercise>", "exec")
        result["compilation"]["passed"] = True
    except SyntaxError as e:
        result["compilation"]["error"] = f"SyntaxError: {e}"
        # Gagal di compilation → stop, tidak perlu lanjut ke unit test
        print(json.dumps(result))
        return result

    # ── Filter 2: Unit Testing Check ─────────────────────────────────────────
    # Jalankan solution lalu eksekusi setiap assert string.
    result["unit_test"] = {"passed": False, "error": None}

    if not test_cases:
        result["unit_test"]["error"] = "No test cases provided"
        print(json.dumps(result))
        return result

    try:
        namespace: dict = {}
        exec(compile(ast.parse(solution), "<exercise>", "exec"), namespace)

        for i, assert_str in enumerate(test_cases):
            try:
                exec(assert_str, namespace)
            except AssertionError:
                result["unit_test"]["error"] = (
                    f"Test case {i + 1} failed: {assert_str}"
                )
                print(json.dumps(result))
                return result
            except Exception as e:
                result["unit_test"]["error"] = (
                    f"Test case {i + 1} raised an exception: {type(e).__name__}: {e}"
                )
                print(json.dumps(result))
                return result

        result["unit_test"]["passed"] = True
        result["passed"] = True

    except Exception as e:
        result["unit_test"]["error"] = (
            f"Failed to execute solution: {type(e).__name__}: {e}\n"
            f"{traceback.format_exc()}"
        )

    print(json.dumps(result))
    return result

def check_difficulty(payload: dict) -> dict:
    """
    LLM-based self-reflection untuk memverifikasi difficulty exercise.
    Meminta LLM mengklasifikasikan apakah exercise sesuai level yang diminta.

    Args:
        payload: {
            exercise: { title, problem_statement, example, function_stub, test_cases, solution },
            expectedDifficulty: 'Easy' | 'Medium' | 'Hard'
        }

    Returns:
        { "passed": bool, "error": str|null }
    """
    import urllib.request
    import urllib.error

    exercise = payload.get("exercise", {})
    expected = payload.get("expectedDifficulty", "Medium")

    difficulty_map = {
        "Easy": "easy",
        "Medium": "intermediate",
        "Hard": "hard"
    }
    expected_label = difficulty_map.get(expected, "intermediate")

    prompt = (
        "You are a teaching assistant evaluating whether a Python exercise matches the requested difficulty level.\n\n"
        f"Analyze the following exercise and determine if it matches '{expected_label}' difficulty. Consider:\n"
        "- Easy: basic concepts, straightforward logic, few lines of code\n"
        "- Intermediate: combines multiple concepts, more complex reasoning\n"
        "- Hard: requires deeper understanding, advanced problem-solving\n\n"
        'Respond only with JSON: {"matches": true/false, "reason": "brief explanation"}.\n\n'
        f"Exercise title: {exercise.get('title', '')}\n"
        f"Problem: {exercise.get('problem_statement', '')}\n"
        f"Example: {exercise.get('example', '')}\n"
        f"Function stub: {exercise.get('function_stub', '')}\n"
    )

    use_ollama = os.environ.get("USE_OLLAMA") == "true"
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    model = os.environ.get("OPENROUTER_MODEL", "llama3.2" if use_ollama else "nvidia/nemotron-3-super-120b-a12b:free")

    messages = [{"role": "user", "content": prompt}]
    data = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 500
    }).encode("utf-8")

    url = "http://localhost:11434/v1/chat/completions" if use_ollama else "https://openrouter.ai/api/v1/chat/completions"
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "" if use_ollama else f"Bearer {api_key}"
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            resp_json = json.loads(response.read().decode("utf-8"))
            content = resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")
            # Debug: print raw LLM response
            print(json.dumps({"debug_llm_response": content}), file=sys.stderr)
            # Try to parse JSON, handle cases where LLM doesn't follow format
            try:
                match_json = json.loads(content.strip()) if content else {}
                matches = bool(match_json.get("matches", False))
                reason = match_json.get("reason", "No reason provided by LLM")
            except json.JSONDecodeError:
                # LLM didn't return JSON, try to detect true/false
                matches = "true" in content.lower() and "matches" not in content.lower()
                if not matches:
                    reason = f"LLM response was not valid JSON: {content[:200]}"
                else:
                    reason = "Detected as match from non-JSON response"
            result = {
                "passed": matches,
                "error": None if matches else f"Classification mismatch: expected '{expected}'. Reason: {reason}"
            }
    except Exception as e:
        result = {
            "passed": False,
            "error": f"Difficulty check error: {e}"
        }

    print(json.dumps(result))
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided"}))
        sys.exit(1)

    command = sys.argv[1]

    if command == 'import_seeds':
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing seed path"}))
            sys.exit(1)
        import_seeds(sys.argv[2])

    elif command == 'get_seeds':
        if len(sys.argv) < 4:
            print(json.dumps({"error": "Missing difficulty or shot_count"}))
            sys.exit(1)
        difficulty = sys.argv[2]
        shot_count = int(sys.argv[3])
        get_seeds_for_shot(difficulty, shot_count)

    elif command == 'get_all':
        get_all_exercises()

    elif command == 'save_generated':
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing payload"}))
            sys.exit(1)
        payload = json.loads(sys.argv[2])

        db = get_db()
        existing = db.all()
        existing_topics = list({
            ex['topic'] for ex in existing if ex.get('topic')
        })

        raw_topic = payload.get('topic', '').strip()
        matched_topic = raw_topic

        for t in existing_topics:
            if t.lower() == raw_topic.lower():
                matched_topic = t 
                break

        if matched_topic == raw_topic and raw_topic:
            matched_topic = raw_topic.title()

        payload['topic'] = matched_topic

        new_id = db.insert(payload)

        Exercise = Query()
        db.update({'id': new_id}, doc_ids=[new_id])

        print(json.dumps({"ok": True, "id": new_id}))

    elif command == 'run_filters':
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing payload"}))
            sys.exit(1)
        payload = json.loads(sys.argv[2])
        run_filters(payload)

    elif command == 'check_difficulty':
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing payload"}))
            sys.exit(1)
        payload = json.loads(sys.argv[2])
        check_difficulty(payload)

    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)

if __name__ == '__main__':
    main()