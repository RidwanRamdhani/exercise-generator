import * as cp from 'child_process';
import * as path from 'path';

export interface SeedExercise {
  id: number;
  title: string;
  difficulty: 'easy' | 'intermediate' | 'hard';
  topic?: string;
  type?: 'concept' | 'domain';
  keywords?: string[];
  problem_statement: string;
  example: string;
  solution: string;
  function_stub?: string;
  test_cases: string[];
}

export interface GeneratedExerciseRecord {
  title: string;
  topic: string;
  difficulty: string;
  problem_statement: string;
  example: string;
  function_stub: string;
  test_cases: string[];
  solution: string;
  shot?: string;
  filters_applied?: string[];
}

// ── Filter result types ───────────────────────────────────────────────────────

export interface CheckResult {
  passed: boolean;
  error: string | null;
}

export interface FilterResult {
  passed: boolean;
  compilation: CheckResult;
  unit_test: CheckResult | null;
  difficulty_check?: CheckResult | null;
}

export interface FilterPayload {
  solution: string;
  test_cases: string[];
}

// ─────────────────────────────────────────────────────────────────────────────

export class DatabaseService {
  private scriptPath: string;
  private seedJsonPath: string;
  private pythonCmd: string;

  constructor(extensionPath: string) {
    this.scriptPath = path.join(extensionPath, 'tinydb_service.py');
    this.seedJsonPath = path.join(extensionPath, 'src', 'data', 'seed_exercises_v2.json');
    this.pythonCmd = this._detectPython();
  }

  private _detectPython(): string {
    try {
      cp.execSync('python3 --version', { stdio: 'ignore' });
      return 'python3';
    } catch {
      return 'python';
    }
  }

  private _run(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(this.pythonCmd, [this.scriptPath, ...args]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python error (code ${code}): ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`Failed to parse Python output: ${stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Python: ${err.message}`));
      });
    });
  }

  async importSeeds(): Promise<void> {
    try {
      const result = await this._run(['import_seeds', this.seedJsonPath]);
      console.log('[ExGen DB]', result);
    } catch (err) {
      console.error('[ExGen DB] Import failed:', err);
    }
  }

  /**
   * Ambil seed exercises untuk few-shot examples.
   *
   * Prioritas retrieval:
   *   1. Soal dengan difficulty + topic yang cocok (topic-aware)
   *   2. Soal dengan difficulty yang sama (topic berbeda) — sebagai pelengkap
   *   3. Fallback: soal apapun jika pool atas tidak cukup
   *
   * @param difficulty - level kesulitan ('easy' | 'intermediate' | 'hard')
   * @param shotCount  - jumlah contoh yang diambil (0 → array kosong)
   * @param topic      - topik dari input user (misal "String", "List", "Loop")
   */
  async getSeedsForShot(
    difficulty: 'easy' | 'intermediate' | 'hard',
    shotCount: number,
    topic: string = ''
  ): Promise<SeedExercise[]> {
    if (shotCount === 0) { return []; }
    try {
      // Pass topic sebagai argumen ke-4 ke Python script
      const result = await this._run(['get_seeds', difficulty, String(shotCount), topic]);
      return result as SeedExercise[];
    } catch (err) {
      console.error('[ExGen DB] getSeedsForShot failed:', err);
      return [];
    }
  }

  async getAllExercises(): Promise<SeedExercise[]> {
    try {
      console.log('[ExGen DB] Calling get_all');
      const result = await this._run(['get_all']);
      console.log('[ExGen DB] get_all raw result type:', typeof result, 'length:', Array.isArray(result) ? result.length : 'not array');
      return result as SeedExercise[];
    } catch (err) {
      console.error('[ExGen DB] getAllExercises failed:', err);
      return [];
    }
  }

  async saveGeneratedExercise(exercise: GeneratedExerciseRecord): Promise<{ ok: boolean; id?: number }> {
    try {
      const diffMap: Record<string, string> = {
        'Easy': 'easy',
        'Medium': 'intermediate',
        'Hard': 'hard'
      };

      const normalized = {
        ...exercise,
        difficulty: diffMap[exercise.difficulty] ?? exercise.difficulty.toLowerCase()
      };

      const payload = JSON.stringify(normalized);
      const result = await this._run(['save_generated', payload]);
      return result as { ok: boolean; id?: number };
    } catch (err) {
      console.error('[ExGen DB] saveGeneratedExercise failed:', err);
      return { ok: false };
    }
  }

  async runFilters(payload: FilterPayload): Promise<FilterResult> {
    const fallback: FilterResult = {
      passed: false,
      compilation: { passed: false, error: 'Filter runner failed unexpectedly' },
      unit_test: null
    };

    try {
      const result = await this._run(['run_filters', JSON.stringify(payload)]);
      return result as FilterResult;
    } catch (err) {
      console.error('[ExGen DB] runFilters failed:', err);
      return fallback;
    }
  }

  async checkDifficulty(
    exercise: GeneratedExerciseRecord,
    expectedDifficulty: 'Easy' | 'Medium' | 'Hard'
  ): Promise<CheckResult> {
    try {
      const result = await this._run([
        'check_difficulty',
        JSON.stringify({
          exercise,
          expectedDifficulty
        })
      ]);
      return result as CheckResult;
    } catch (err) {
      console.error('[ExGen DB] checkDifficulty failed:', err);
      return { passed: false, error: 'Difficulty check failed unexpectedly' };
    }
  }
}