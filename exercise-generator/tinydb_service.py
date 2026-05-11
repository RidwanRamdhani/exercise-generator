import sys
import json
import os
import random
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

    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)

if __name__ == '__main__':
    main()