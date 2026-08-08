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

# ── Table names ───────────────────────────────────────────────────────────────
TABLE_SEEDS   = 'seeds'    
TABLE_JUDGES  = 'judges'   
TABLE_GENERATED = '_default'  

# ─────────────────────────────────────────────────────────────────────────────

def import_seeds(seed_json_path: str):
    """
    Import seed exercises ke tabel 'seeds' (untuk few-shot generator).
    Hanya dijalankan jika tabel masih kosong.
    """
    db = get_db()
    table = db.table(TABLE_SEEDS)

    if len(table.all()) > 0:
        print(json.dumps({"status": "skipped", "message": "Seeds table already populated"}))
        return

    with open(seed_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    seeds = data.get('seed_exercises', [])
    for seed in seeds:
        table.insert(seed)

    print(json.dumps({"status": "ok", "imported": len(seeds), "table": TABLE_SEEDS}))


def import_judges(judge_json_path: str):
    """
    Import judge exercises ke tabel 'judges' (untuk referensi difficulty classifier).
    Hanya dijalankan jika tabel masih kosong.
    """
    db = get_db()
    table = db.table(TABLE_JUDGES)

    if len(table.all()) > 0:
        print(json.dumps({"status": "skipped", "message": "Judges table already populated"}))
        return

    with open(judge_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    judges = data.get('judge_exercises', [])
    for judge in judges:
        table.insert(judge)

    print(json.dumps({"status": "ok", "imported": len(judges), "table": TABLE_JUDGES}))


def get_seeds_for_shot(difficulty: str, shot_count: int, topic: str = ""):
    """
    Ambil N seed exercises dari tabel 'seeds' untuk few-shot generator.

    Prioritas:
      1. difficulty + topic cocok
      2. difficulty cocok, topic bebas
      3. fallback semua soal
    """
    if shot_count == 0:
        print(json.dumps([]))
        return

    db = get_db()
    table = db.table(TABLE_SEEDS)
    Exercise = Query()

    topic_lower = topic.strip().lower()

    # Pool 1: difficulty + topic
    if topic_lower:
        pool_topic = table.search(
            (Exercise.difficulty == difficulty.lower()) &
            (Exercise.topic.test(lambda t: str(t).lower() == topic_lower))
        )
    else:
        pool_topic = []

    # Pool 2: difficulty saja
    pool_difficulty = table.search(Exercise.difficulty == difficulty.lower())

    selected_ids = set()
    selected = []

    random.shuffle(pool_topic)
    for ex in pool_topic:
        if len(selected) >= shot_count:
            break
        ex_id = ex.get('id')
        if ex_id not in selected_ids:
            selected.append(ex)
            selected_ids.add(ex_id)

    random.shuffle(pool_difficulty)
    for ex in pool_difficulty:
        if len(selected) >= shot_count:
            break
        ex_id = ex.get('id')
        if ex_id not in selected_ids:
            selected.append(ex)
            selected_ids.add(ex_id)

    # Fallback: semua soal di tabel seeds
    if len(selected) < shot_count:
        all_ex = table.all()
        random.shuffle(all_ex)
        for ex in all_ex:
            if len(selected) >= shot_count:
                break
            ex_id = ex.get('id')
            if ex_id not in selected_ids:
                selected.append(ex)
                selected_ids.add(ex_id)

    print(json.dumps(selected[:shot_count]))


def get_judges_for_check(difficulty: str, judge_count: int, topic: str = ""):
    """
    Ambil N judge exercises dari tabel 'judges' untuk referensi difficulty classifier.

    Prioritas:
      1. difficulty + topic cocok  ← prioritas utama
      2. difficulty cocok, topic bebas  ← fallback jika kurang
      3. semua soal judge  ← last resort
    """
    if judge_count == 0:
        print(json.dumps([]))
        return

    db = get_db()
    table = db.table(TABLE_JUDGES)
    Exercise = Query()

    topic_lower = topic.strip().lower()

    # Pool 1: difficulty + topic
    if topic_lower:
        pool_topic = table.search(
            (Exercise.difficulty == difficulty.lower()) &
            (Exercise.topic.test(lambda t: str(t).lower() == topic_lower))
        )
    else:
        pool_topic = []

    # Pool 2: difficulty saja (topic bebas)
    pool_difficulty = table.search(Exercise.difficulty == difficulty.lower())

    selected_ids = set()
    selected = []

    random.shuffle(pool_topic)
    for ex in pool_topic:
        if len(selected) >= judge_count:
            break
        ex_id = ex.get('id')
        if ex_id not in selected_ids:
            selected.append(ex)
            selected_ids.add(ex_id)

    random.shuffle(pool_difficulty)
    for ex in pool_difficulty:
        if len(selected) >= judge_count:
            break
        ex_id = ex.get('id')
        if ex_id not in selected_ids:
            selected.append(ex)
            selected_ids.add(ex_id)

    # Fallback: semua soal judge
    if len(selected) < judge_count:
        all_judges = table.all()
        random.shuffle(all_judges)
        for ex in all_judges:
            if len(selected) >= judge_count:
                break
            ex_id = ex.get('id')
            if ex_id not in selected_ids:
                selected.append(ex)
                selected_ids.add(ex_id)

    print(json.dumps(selected[:judge_count]))


def get_all_exercises():
    """Get all exercises dari tabel seeds, sorted by difficulty."""
    db = get_db()
    table = db.table(TABLE_SEEDS)
    results = table.all()
    difficulty_order = {"easy": 0, "intermediate": 1, "hard": 2}
    results.sort(key=lambda x: (difficulty_order.get(x.get("difficulty", ""), 99), x.get("id", 0)))
    print(json.dumps(results))


def run_filters(payload: dict) -> dict:
    """
    Chain of filters sesuai paper ExGen (Fig. 6):
      1. Compilation Check
      2. Unit Testing Check
    """
    solution   = payload.get("solution", "")
    test_cases = payload.get("test_cases", [])

    result = {
        "passed": False,
        "compilation": {"passed": False, "error": None},
        "unit_test":   None
    }

    # ── Filter 1: Compilation Check ──────────────────────────────────────────
    try:
        tree = ast.parse(solution)
        compile(tree, "<exercise>", "exec")
        result["compilation"]["passed"] = True
    except SyntaxError as e:
        result["compilation"]["error"] = f"SyntaxError: {e}"
        print(json.dumps(result))
        return result

    # ── Filter 2: Unit Testing Check ─────────────────────────────────────────
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
                result["unit_test"]["error"] = f"Test case {i + 1} failed: {assert_str}"
                print(json.dumps(result))
                return result
            except Exception as e:
                result["unit_test"]["error"] = f"Test case {i + 1} raised an exception: {type(e).__name__}: {e}"
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
    Difficulty classifier dengan judge examples sebagai referensi konkret.

    payload:
      - exercise          : soal yang akan diklasifikasikan
      - expectedDifficulty: 'Easy' | 'Medium' | 'Hard'
      - judgeExamples     : list soal dari tabel judges (dikirim dari TypeScript)
    """
    import urllib.request

    exercise       = payload.get("exercise", {})
    expected       = payload.get("expectedDifficulty", "Medium")
    judge_examples = payload.get("judgeExamples", [])  

    difficulty_map = {
        "Easy": "easy",
        "Medium": "intermediate",
        "Hard": "hard"
    }
    expected_label = difficulty_map.get(expected, "intermediate")

    # ── System prompt ─────────────────────────────────────────────────────────
    messages = [
        {
            "role": "system",
            "content": (
                "You are a classification model that will classify the difficulty of Python exercises. "
                "There are three levels of difficulty for the exercises:\n"
                "easy: This is for easy problems. Most students will solve the problem quickly with a few lines of code.\n"
                "intermediate: This is for intermediate problems. Most students will take more time to solve the problem, "
                "and they need to write more code. Many students, but not all, will be able to solve the problem in the end.\n"
                "hard: This is for hard problems. Most students will take a lot of time to solve the problem. "
                "Many of them will not be able to solve the problem in the end.\n\n"
                "Respond in this exact format:\n"
                "Difficulty: <easy/intermediate/hard>\n"
                "Reason: <explain why>"
            )
        }
    ]

    # ── Judge examples sebagai few-shot referensi classifier ──────────────────
    # Setiap judge example dimasukkan sebagai pasangan user/assistant turn
    # supaya LLM punya anchor konkret untuk tiap level difficulty
    for ex in judge_examples:
        ex_summary = (
            f"Title: {ex.get('title', '')}\n"
            f"Problem: {ex.get('problem_statement', '')}\n"
            f"Example: {ex.get('example', '')}\n"
            f"Function stub: {ex.get('function_stub', '')}"
        )
        messages.append({
            "role": "user",
            "content": f"I want you to classify this exercise:\n{ex_summary}"
        })
        messages.append({
            "role": "assistant",
            "content": (
                f"Difficulty: {ex.get('difficulty', 'easy')}\n"
                f"Reason: This is a reference exercise with known difficulty level."
            )
        })

    # ── Soal yang akan diklasifikasikan ──────────────────────────────────────
    candidate_summary = (
        f"Title: {exercise.get('title', '')}\n"
        f"Problem: {exercise.get('problem_statement', '')}\n"
        f"Example: {exercise.get('example', '')}\n"
        f"Function stub: {exercise.get('function_stub', '')}"
    )
    messages.append({
        "role": "user",
        "content": (
            f"I want you to classify this exercise:\n{candidate_summary}\n\n"
            f"Respond in this format:\n"
            f"Difficulty: <easy/intermediate/hard>\n"
            f"Reason: <explain why>"
        )
    })

    # ── API call ──────────────────────────────────────────────────────────────
    use_ollama = os.environ.get("USE_OLLAMA") == "true"
    api_key    = os.environ.get("OPENROUTER_API_KEY", "")
    model      = os.environ.get("OPENROUTER_MODEL", "llama3.2" if use_ollama else "nvidia/nemotron-3-super-120b-a12b:free")

    data = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 5000
    }).encode("utf-8")

    url = "http://localhost:11434/v1/chat/completions" if use_ollama else "https://openrouter.ai/api/v1/chat/completions"
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "" if use_ollama else f"Bearer {api_key}"
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            resp_json = json.loads(response.read().decode("utf-8"))
            content   = resp_json.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            print(json.dumps({"debug_llm_response": content}), file=sys.stderr)

            predicted_label = None
            reason          = None

            for line in content.splitlines():
                if line.lower().startswith("difficulty:"):
                    predicted_label = line.split(":", 1)[-1].strip().lower()
                elif line.lower().startswith("reason:"):
                    reason = line.split(":", 1)[-1].strip()

            # Fallback: cari keyword di response
            if predicted_label is None:
                content_lower = content.lower()
                if "intermediate" in content_lower:
                    predicted_label = "intermediate"
                elif "easy" in content_lower:
                    predicted_label = "easy"
                elif "hard" in content_lower:
                    predicted_label = "hard"

            matches = predicted_label == expected_label
            result  = {
                "passed": matches,
                "error": None if matches else (
                    f"Classification mismatch: expected '{expected}' (level {expected_label}), "
                    f"got '{predicted_label}'"
                ),
                "reason": reason
            }

    except Exception as e:
        result = {
            "passed": False,
            "error": f"Difficulty check error: {e}",
            "reason": None
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

    elif command == 'import_judges':
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing judge path"}))
            sys.exit(1)
        import_judges(sys.argv[2])

    elif command == 'get_seeds':
        # Args: get_seeds <difficulty> <shot_count> [topic]
        if len(sys.argv) < 4:
            print(json.dumps({"error": "Missing difficulty or shot_count"}))
            sys.exit(1)
        difficulty  = sys.argv[2]
        shot_count  = int(sys.argv[3])
        topic       = sys.argv[4] if len(sys.argv) >= 5 else ""
        get_seeds_for_shot(difficulty, shot_count, topic)

    elif command == 'get_judges':
        # Args: get_judges <difficulty> <judge_count> [topic]
        if len(sys.argv) < 4:
            print(json.dumps({"error": "Missing difficulty or judge_count"}))
            sys.exit(1)
        difficulty  = sys.argv[2]
        judge_count = int(sys.argv[3])
        topic       = sys.argv[4] if len(sys.argv) >= 5 else ""
        get_judges_for_check(difficulty, judge_count, topic)

    elif command == 'get_all':
        get_all_exercises()

    elif command == 'save_generated':
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing payload"}))
            sys.exit(1)
        payload = json.loads(sys.argv[2])

        db    = get_db()
        table = db.table(TABLE_SEEDS)

        existing_topics = list({
            ex['topic'] for ex in table.all() if ex.get('topic')
        })

        raw_topic     = payload.get('topic', '').strip()
        matched_topic = raw_topic

        for t in existing_topics:
            if t.lower() == raw_topic.lower():
                matched_topic = t
                break

        if matched_topic == raw_topic and raw_topic:
            matched_topic = raw_topic.title()

        payload['topic'] = matched_topic

        # Simpan ke tabel default (generated exercises)
        default_table = db.table(TABLE_GENERATED)
        new_id        = default_table.insert(payload)
        default_table.update({'id': new_id}, doc_ids=[new_id])

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