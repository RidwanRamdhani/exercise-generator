import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ExerciseConfig, Difficulty, Shot } from '../types/exercise';
import {
  askForTopic,
  askForDifficulty,
  askForShot,
  askForFilters,
  showCancelledMessage,
  showExerciseSummary
} from '../dialogs';
import { ExerciseViewProvider, GeneratedExercise } from '../views/ExerciseViewProvider';
import { DatabaseService, JudgeExercise, FilterResult } from '../services/DatabaseService';

export async function exerciseGeneratorCommand(
  viewProvider: ExerciseViewProvider,
  db: DatabaseService,
  extensionPath: string
): Promise<void> {
  const topicInput = await askForTopic();
  if (topicInput === undefined) { showCancelledMessage('input topic'); return; }

  const difficultyInput = await askForDifficulty();
  if (!difficultyInput) { showCancelledMessage('choosing difficulty'); return; }

  const shotInput = await askForShot();
  if (!shotInput) { showCancelledMessage('choosing shot amount'); return; }

  const inputFilter = await askForFilters();
  if (!inputFilter || inputFilter.length === 0) { showCancelledMessage('filter selection'); return; }

  const config: ExerciseConfig = {
    topic:      topicInput,
    difficulty: difficultyInput.label as Difficulty,
    shot:       shotInput.label as Shot,
    filters:    inputFilter.map(f => f.label)
  };

  showExerciseSummary({
    topic:          config.topic,
    difficultyLabel: config.difficulty,
    shotLabel:       config.shot,
    filterLabels:    config.filters.join(', ')
  });

  const diffMap: Record<Difficulty, 'easy' | 'intermediate' | 'hard'> = {
    'Easy': 'easy', 'Medium': 'intermediate', 'Hard': 'hard'
  };
  const shotCountMap: Record<Shot, number> = {
    '0-shot': 0, '1-shot': 1, '2-shot': 2, '3-shot': 3
  };

  const shotCount = shotCountMap[config.shot];
  const dbDifficulty = diffMap[config.difficulty];

  // ── Ambil few-shot examples untuk generator (dari tabel seeds) ─────────────
  const fewShotExamples = await db.getSeedsForShot(dbDifficulty, shotCount, config.topic);

  // ── Ambil judge examples untuk difficulty classifier (dari tabel judges) ───
  // Jumlah judge mengikuti shot count yang dipilih user di awal
  // Topic dikirim supaya judge examples diprioritaskan dari kategori yang sama
  const applyDifficultyCheck = config.filters.includes('Difficulty Check');
  const judgeExamples: JudgeExercise[] = applyDifficultyCheck
    ? await db.getJudgesForCheck(dbDifficulty, shotCount, config.topic)
    : [];

  console.log('[ExGen] Config:', config);
  console.log('[ExGen] Few-shot examples (seeds):', fewShotExamples.map((e, i) =>
    `\n  [Shot ${i + 1}] [${e.topic ?? 'unknown'}] ${e.title}`
  ).join(''));
  console.log('[ExGen] Judge examples:', judgeExamples.map((e, i) =>
    `\n  [Judge ${i + 1}] [${e.difficulty}] ${e.title}`
  ).join(''));

  const applyTestcaseCheck = config.filters.includes('Testcase Check');

  const sessionId = `${config.topic}-${config.difficulty}-${config.shot}-${Date.now()}`;
  const csvPath   = path.join(extensionPath, 'exgen_results.csv');
  let exerciseNo  = 0;

  const statusBar = vscode.window.setStatusBarMessage('$(sync~spin) ExGen: Generating exercises...');

  try {
    const { exercises: results, model: usedModel } = await callLLM(config, fewShotExamples, extensionPath);

    let passed  = 0;
    let skipped = 0;

    for (const result of results) {
      exerciseNo++;

      let unitTestStatus     = '';
      let unitTestError      = '';
      let unitTestReasoning  = '';
      let diffCheckStatus    = '';
      let diffCheckError     = '';
      let diffCheckReasoning = '';

      // ── Filter 1: Testcase Check ──────────────────────────────────────────
      if (applyTestcaseCheck) {
        vscode.window.setStatusBarMessage(`$(sync~spin) ExGen: Checking "${result.title}"...`);

        const filterResult = await db.runFilters({
          solution:   result.solution ?? '',
          test_cases: result.test_cases ?? []
        });

        if (!filterResult.passed) {
          skipped++;
          unitTestStatus = 'failed';

          if (!filterResult.compilation.passed) {
            unitTestError     = filterResult.compilation.error ?? '';
            unitTestReasoning = `Compilation failed: ${unitTestError}`;
          } else if (filterResult.unit_test && !filterResult.unit_test.passed) {
            unitTestError     = filterResult.unit_test.error ?? '';
            unitTestReasoning = `Unit test failed: ${unitTestError}`;
          }

          console.warn(`[ExGen] "${result.title}" FAILED test filters. Reason: ${unitTestReasoning}`);

          appendToCSV(
            csvPath, sessionId, usedModel, config, fewShotExamples, judgeExamples,
            exerciseNo, result.title, result.problem_statement,
            unitTestStatus, unitTestError, unitTestReasoning,
            diffCheckStatus, diffCheckError, diffCheckReasoning
          );
          continue;
        }

        unitTestStatus = 'passed';
        console.log(`[ExGen] "${result.title}" PASSED test filters.`);
      }

      // ── Filter 2: Difficulty Check (dengan judge examples) ────────────────
      if (applyDifficultyCheck) {
        vscode.window.setStatusBarMessage(`$(sync~spin) ExGen: Verifying difficulty "${result.title}"...`);

        const difficultyCheck = await db.checkDifficulty(
          {
            ...result,
            topic:           config.topic,
            difficulty:      config.difficulty,
            shot:            config.shot,
            filters_applied: config.filters,
            solution:        result.solution ?? ''
          },
          config.difficulty,
          judgeExamples  // <-- judge examples dikirim ke classifier
        );

        console.log(`[ExGen] Difficulty check for "${result.title}":`, difficultyCheck);

        if (!difficultyCheck.passed) {
          skipped++;
          diffCheckStatus    = 'failed';
          diffCheckError     = difficultyCheck.error ?? '';
          diffCheckReasoning = (difficultyCheck as any).reason ?? '';

          console.warn(`[ExGen] "${result.title}" FAILED difficulty check: ${diffCheckError}`);

          appendToCSV(
            csvPath, sessionId, usedModel, config, fewShotExamples, judgeExamples,
            exerciseNo, result.title, result.problem_statement,
            unitTestStatus, unitTestError, unitTestReasoning,
            diffCheckStatus, diffCheckError, diffCheckReasoning
          );
          continue;
        }

        diffCheckStatus = 'passed';
        console.log(`[ExGen] "${result.title}" PASSED difficulty check.`);
      }

      // ── Lolos semua filter ────────────────────────────────────────────────
      appendToCSV(
        csvPath, sessionId, usedModel, config, fewShotExamples, judgeExamples,
        exerciseNo, result.title, result.problem_statement,
        unitTestStatus || 'passed', '', '',
        diffCheckStatus || 'passed', '', ''
      );

      const exercise: Omit<GeneratedExercise, 'id'> = {
        title:             result.title,
        topic:             config.topic,
        difficulty:        config.difficulty,
        problem_statement: result.problem_statement,
        example:           result.example,
        function_stub:     result.function_stub,
        test_cases:        result.test_cases,
        shot:              config.shot,
        filters_applied:   config.filters
      };

      viewProvider.addGeneratedExercise(exercise);
      passed++;
    }

    const difficultyMsg = applyDifficultyCheck ? ' difficulty check,' : '';
    if ((applyTestcaseCheck || applyDifficultyCheck) && skipped > 0) {
      vscode.window.showInformationMessage(
        `[ExGen] ${passed} exercise(s) passed filters. ` +
        `${skipped} exercise(s) discarded (failed compilation, unit test${difficultyMsg} or difficulty mismatch).`
      );
    }

    if (passed === 0) {
      vscode.window.showWarningMessage(
        '[ExGen] No ready-to-use exercises were generated. ' +
        'Try again or adjust the keyword/difficulty.'
      );
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to generate exercise: ${message}`);
  } finally {
    statusBar.dispose();
  }
}

// ── CSV Export ────────────────────────────────────────────────────────────────

const MAX_SHOT_COLS  = 3;
const MAX_JUDGE_COLS = 3;

function computeOverallStatus(unitTestStatus: string, diffCheckStatus: string): string {
  if (unitTestStatus === 'failed' || diffCheckStatus === 'failed') {
    return 'failed';
  }
  return 'passed';
}

function appendToCSV(
  csvPath: string,
  sessionId: string,
  model: string,
  config: ExerciseConfig,
  fewShotExamples: any[],
  judgeExamples: any[],
  no: number,
  title: string,
  problemStatement: string,
  unitTestStatus: string,
  unitTestError: string,
  unitTestReasoning: string,
  diffCheckStatus: string,
  diffCheckError: string,
  diffCheckReasoning: string
): void {
  const escape = (s: string) => `"${String(s).replace(/"/g, '""').replace(/\n/g, ' ')}"`;
  const orNull = (s: string) => (!s || s.trim() === '') ? 'NULL' : escape(s);

  const overallStatus = computeOverallStatus(unitTestStatus, diffCheckStatus);

  const header =
    'session_id;model;topic;difficulty;shot;' +
    'shot_ref_1;shot_ref_2;shot_ref_3;' +
    'judge_ref_1;judge_ref_2;judge_ref_3;' +
    'no;title;problem_statement;' +
    'unit_test;unit_test_error;unit_test_reasoning;' +
    'diff_check;diff_check_error;diff_check_reasoning;' +
    'overall_status\n';

  const shotRefValues = Array.from({ length: MAX_SHOT_COLS }, (_, i) => {
    const ex = fewShotExamples[i];
    return ex ? escape(ex.title) : 'NULL';
  });

  const judgeRefValues = Array.from({ length: MAX_JUDGE_COLS }, (_, i) => {
    const ex = judgeExamples[i];
    return ex ? escape(ex.title) : 'NULL';
  });

  const row = [
    escape(sessionId),
    escape(model),
    escape(config.topic),
    escape(config.difficulty),
    escape(config.shot),
    ...shotRefValues,
    ...judgeRefValues,
    String(no),
    escape(title),
    escape(problemStatement),
    orNull(unitTestStatus),
    orNull(unitTestError),
    orNull(unitTestReasoning),
    orNull(diffCheckStatus),
    orNull(diffCheckError),
    orNull(diffCheckReasoning),
    escape(overallStatus)
  ].join(';') + '\n';

  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, header, 'utf8');
  }
  fs.appendFileSync(csvPath, row, 'utf8');
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LLMExercise = {
  title: string;
  problem_statement: string;
  example: string;
  function_stub: string;
  test_cases: string[];
  solution?: string;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

// ── Prompt Builder ────────────────────────────────────────────────────────────

function buildMessages(
  config: ExerciseConfig,
  fewShotExamples: any[],
  difficultyLabel: string
): ChatMessage[] {
  const systemMessage: ChatMessage = {
    role: 'system',
    content:
      'You are a helpful teaching assistant for undergraduates who are learning ' +
      'introductory programming in Python. You need to generate Python exercises ' +
      'for students to practice.\n\n' +
      'There are three levels of difficulty for the exercises:\n' +
      'Easy: most students will solve the problem quickly with a few lines of code.\n' +
      'Intermediate: most students will take more time to solve the problem, and ' +
      'they need to write more code. Many students, but not all, will be able to ' +
      'solve the problem in the end.\n' +
      'Hard: most students will take a lot of time to solve the problem. Many of ' +
      'them will not be able to solve the problem in the end.\n\n' +
      'For each exercise you generate, respond ONLY with valid JSON containing ' +
      'these fields: title, problem_statement, example, function_stub, ' +
      'test_cases, solution.\n' +
      'The function_stub must include a Python function definition ending with pass.\n' +
      'test_cases must be an array of assert strings.\n' +
      'solution must be the complete correct Python implementation.'
  };

  const messages: ChatMessage[] = [systemMessage];

  for (const ex of fewShotExamples) {
    messages.push({
      role: 'user',
      content: `Give me a ${difficultyLabel} Python exercise.`
    });
    messages.push({
      role: 'assistant',
      content: `Here is one ${difficultyLabel} Python exercise:\n${JSON.stringify({
        title:            ex.title,
        problem_statement: ex.problem_statement,
        example:          ex.example ?? '',
        function_stub:    ex.function_stub ?? `def solution():\n    pass`,
        test_cases:       ex.test_cases ?? [],
        solution:         ex.solution ?? ''
      }, null, 2)}`
    });
  }

  const isZeroShot = fewShotExamples.length === 0;
  messages.push({
    role: 'user',
    content: isZeroShot
      ? `Give me 5 ${difficultyLabel} Python exercises using this keyword: ${config.topic}. ` +
        `Return a JSON array where each element has fields: title, problem_statement, example, function_stub, test_cases, solution. ` +
        `Return JSON only.`
      : `Good. I want 5 more ${difficultyLabel} Python exercises using this keyword: ${config.topic}. ` +
        `Print the result with the same format as the previous ones. Return a JSON array only.`
  });

  return messages;
}

// ── LLM Call ──────────────────────────────────────────────────────────────────

async function callLLM(
  config: ExerciseConfig,
  fewShotExamples: any[],
  extensionPath: string
): Promise<{ exercises: LLMExercise[]; model: string }> {
  loadEnvFromFile(extensionPath);

  const useOllama = process.env.USE_OLLAMA === 'true';
  const apiKey    = useOllama ? 'ollama' : process.env.OPENROUTER_API_KEY;

  if (!useOllama && !apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY in environment. Set USE_OLLAMA=true for local Ollama.');
  }

  const model = process.env.OPENROUTER_MODEL || (useOllama ? 'llama3.2' : 'nvidia/nemotron-3-super-120b-a12b:free');

  const diffMap: Record<Difficulty, string> = {
    'Easy': 'easy', 'Medium': 'intermediate', 'Hard': 'hard'
  };

  const messages = buildMessages(config, fewShotExamples, diffMap[config.difficulty]);

  console.log('[ExGen] Strategy:', fewShotExamples.length === 0 ? 'zero-shot' : `${fewShotExamples.length}-shot`);
  console.log('[ExGen] Model:', model);

  const payload = JSON.stringify({ model, temperature: 0.7, max_tokens: 8000, messages });
  const baseUrl = useOllama
    ? 'http://localhost:11434/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  const responseText = await httpRequest(baseUrl, payload, {
    Authorization:    useOllama ? '' : `Bearer ${apiKey}`,
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
    'HTTP-Referer':   'vscode-extension',
    'X-Title':        'exercise-generator'
  }, useOllama);

  const responseJson = JSON.parse(responseText) as OpenRouterResponse;
  const content = responseJson.choices?.[0]?.message?.content;
  if (!content) { throw new Error('LLM response missing content'); }

  const parsed    = parseJsonFromContent(content);
  const exercises = Array.isArray(parsed) ? parsed : [parsed];
  for (const exercise of exercises) { validateLLMExercise(exercise); }

  return { exercises, model };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadEnvFromFile(extensionPath: string): void {
  if (process.env.OPENROUTER_API_KEY || process.env.USE_OLLAMA === 'true') { return; }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const envPath = [extensionPath, workspaceRoot]
    .filter((r): r is string => Boolean(r))
    .map(r => path.join(r, '.env'))
    .find(p => fs.existsSync(p));

  if (!envPath) { return; }

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    const idx = trimmed.indexOf('=');
    if (idx === -1) { continue; }
    const key   = trimmed.slice(0, idx).trim();
    let   value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) { process.env[key] = value; }
  }
}

function httpRequest(
  url: string, body: string, headers: Record<string, string>, useHttp = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = (useHttp ? http : https).request(url, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJsonFromContent(content: string): LLMExercise | LLMExercise[] {
  const trimmed = content.trim();
  const fenced  = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : trimmed;

  if (jsonStr.startsWith('[')) { return JSON.parse(jsonStr) as LLMExercise[]; }
  if (jsonStr.startsWith('{')) { return JSON.parse(jsonStr) as LLMExercise; }

  const match = jsonStr.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) { throw new Error('LLM content does not contain JSON'); }
  return JSON.parse(match[0]) as LLMExercise | LLMExercise[];
}

function validateLLMExercise(data: LLMExercise): void {
  if (!data || typeof data !== 'object') { throw new Error('LLM response is empty'); }
  for (const key of ['title', 'problem_statement', 'example', 'function_stub'] as const) {
    if (!data[key] || typeof data[key] !== 'string') {
      throw new Error(`LLM response missing ${key}`);
    }
  }
  if (!Array.isArray(data.test_cases) || data.test_cases.length === 0) {
    throw new Error('LLM response missing test_cases');
  }
}