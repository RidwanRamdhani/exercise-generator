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

// JudgeExercise strukturnya identik dengan SeedExercise,
// dibedakan hanya via type alias untuk kejelasan semantik
export type JudgeExercise = SeedExercise;

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
  private judgeJsonPath: string;
  private pythonCmd: string;

  constructor(extensionPath: string) {
    this.scriptPath    = path.join(extensionPath, 'tinydb_service.py');
    this.seedJsonPath  = path.join(extensionPath, 'src', 'data', 'seed_exercises_v3.json');
    this.judgeJsonPath = path.join(extensionPath, 'src', 'data', 'judge_exercises.json');
    this.pythonCmd     = this._detectPython();
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

  /**
   * Import seed exercises (untuk few-shot generator) ke tabel 'seeds'.
   * Dipanggil sekali saat ekstensi aktif.
   */
  async importSeeds(): Promise<void> {
    try {
      const result = await this._run(['import_seeds', this.seedJsonPath]);
      console.log('[ExGen DB] Seeds:', result);
    } catch (err) {
      console.error('[ExGen DB] importSeeds failed:', err);
    }
  }

  /**
   * Import judge exercises (untuk difficulty classifier) ke tabel 'judges'.
   * Dipanggil sekali saat ekstensi aktif, setelah importSeeds.
   */
  async importJudges(): Promise<void> {
    try {
      const result = await this._run(['import_judges', this.judgeJsonPath]);
      console.log('[ExGen DB] Judges:', result);
    } catch (err) {
      console.error('[ExGen DB] importJudges failed:', err);
    }
  }

  /**
   * Ambil seed exercises untuk few-shot generator.
   *
   * Prioritas:
   *   1. difficulty + topic sama
   *   2. difficulty cocok, topic bebas
   *   3. fallback semua seeds
   *
   * @param difficulty - 'easy' | 'intermediate' | 'hard'
   * @param shotCount  - jumlah contoh (0 → array kosong)
   * @param topic      - topik dari input user, misal "String", "List"
   */
  async getSeedsForShot(
    difficulty: 'easy' | 'intermediate' | 'hard',
    shotCount: number,
    topic: string = ''
  ): Promise<SeedExercise[]> {
    if (shotCount === 0) { return []; }
    try {
      const result = await this._run(['get_seeds', difficulty, String(shotCount), topic]);
      return result as SeedExercise[];
    } catch (err) {
      console.error('[ExGen DB] getSeedsForShot failed:', err);
      return [];
    }
  }

  /**
   * Ambil judge exercises untuk referensi difficulty classifier.
   *
   * Prioritas:
   *   1. difficulty + topic sama
   *   2. difficulty cocok, topic bebas
   *   3. fallback semua judges
   *
   * Jumlah judge_count mengikuti shot count yang dipilih user di awal.
   *
   * @param difficulty  - 'easy' | 'intermediate' | 'hard'
   * @param judgeCount  - jumlah referensi (mengikuti shotCount user)
   * @param topic       - topik dari input user, misal "String", "Iterations"
   */
  async getJudgesForCheck(
    difficulty: 'easy' | 'intermediate' | 'hard',
    judgeCount: number,
    topic: string = ''
  ): Promise<JudgeExercise[]> {
    if (judgeCount === 0) { return []; }
    try {
      const result = await this._run(['get_judges', difficulty, String(judgeCount), topic]);
      return result as JudgeExercise[];
    } catch (err) {
      console.error('[ExGen DB] getJudgesForCheck failed:', err);
      return [];
    }
  }

  async getAllExercises(): Promise<SeedExercise[]> {
    try {
      const result = await this._run(['get_all']);
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

      const result = await this._run(['save_generated', JSON.stringify(normalized)]);
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

  /**
   * Jalankan difficulty check dengan judge examples sebagai referensi konkret.
   *
   * @param exercise           - soal yang akan dicek
   * @param expectedDifficulty - difficulty yang diharapkan
   * @param judgeExamples      - referensi soal dari tabel judges (dikirim ke LLM classifier)
   */
  async checkDifficulty(
    exercise: GeneratedExerciseRecord,
    expectedDifficulty: 'Easy' | 'Medium' | 'Hard',
    judgeExamples: JudgeExercise[] = []
  ): Promise<CheckResult> {
    try {
      const result = await this._run([
        'check_difficulty',
        JSON.stringify({
          exercise,
          expectedDifficulty,
          judgeExamples   // <-- dikirim ke Python untuk dimasukkan ke prompt classifier
        })
      ]);
      return result as CheckResult;
    } catch (err) {
      console.error('[ExGen DB] checkDifficulty failed:', err);
      return { passed: false, error: 'Difficulty check failed unexpectedly' };
    }
  }

  

    /**
   * Export exercises dari file JSON ke Moodle XML (CodeRunner python3).
   *
   * @param inputPath  - path ke file JSON (bisa seeds / generated exercises)
   * @param outputPath - path file XML yang akan dihasilkan
   */
  async exportMoodleXml(
    inputPath: string,
    outputPath: string
  ): Promise<{ ok: boolean; count?: number; output?: string }> {
    try {
      const convertScript = path.join(
        path.dirname(this.scriptPath),
        'convert.py'
      );
      const result = await this._runScript(convertScript, [inputPath, outputPath]);
      return result as { ok: boolean; count?: number; output?: string };
    } catch (err) {
      console.error('[ExGen DB] exportMoodleXml failed:', err);
      return { ok: false };
    }
  }

  /**
   * Spawn script Python arbitrer (bukan cuma tinydb_service.py).
   * Dipakai untuk convert.py yang terpisah dari tinydb_service.
   */
  private _runScript(scriptPath: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(this.pythonCmd, [scriptPath, ...args]);

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
}