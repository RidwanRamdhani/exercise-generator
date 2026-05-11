import * as cp from 'child_process';
import * as path from 'path';

export interface SeedExercise {
  id: number;
  title: string;
  difficulty: 'easy' | 'intermediate' | 'hard';
  type?: 'concept' | 'domain';
  keywords?: string[];
  problem_statement: string;
  solution: string;
  test_cases: string[];
}

export class DatabaseService {
  private scriptPath: string;
  private seedJsonPath: string;
  private pythonCmd: string;

  constructor(extensionPath: string) {
    this.scriptPath = path.join(extensionPath, 'tinydb_service.py');
    this.seedJsonPath = path.join(extensionPath, 'src', 'data', 'seed_exercises.json');
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

  async getSeedsForShot(
    difficulty: 'easy' | 'intermediate' | 'hard',
    shotCount: number
  ): Promise<SeedExercise[]> {
    if (shotCount === 0) { return []; }
    try {
      const result = await this._run(['get_seeds', difficulty, String(shotCount)]);
      return result as SeedExercise[];
    } catch (err) {
      console.error('[ExGen DB] getSeedsForShot failed:', err);
      return [];
    }
  }
}