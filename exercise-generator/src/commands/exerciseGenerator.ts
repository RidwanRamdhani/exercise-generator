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
import { DatabaseService, FilterResult } from '../services/DatabaseService';

export async function exerciseGeneratorCommand(
  viewProvider: ExerciseViewProvider,
  db: DatabaseService,
  extensionPath: string
): Promise<void> {
	const topicInput = await askForTopic();
	if (topicInput === undefined) {
		showCancelledMessage('input topic');
		return;
	}

	const difficultyInput = await askForDifficulty();
	if (!difficultyInput) {
		showCancelledMessage('choosing difficulty');
		return;
	}

	const shotInput = await askForShot();
	if (!shotInput) {
		showCancelledMessage('choosing shot amount');
		return;
	}

	const inputFilter = await askForFilters();
	if (!inputFilter || inputFilter.length === 0) {
		showCancelledMessage('filter selection');
		return;
	}

	const config: ExerciseConfig = {
		topic: topicInput,
		difficulty: difficultyInput.label as Difficulty,
		shot: shotInput.label as Shot,
		filters: inputFilter.map(f => f.label)
	};

  showExerciseSummary({
    topic: config.topic,
    difficultyLabel: config.difficulty,
    shotLabel: config.shot,
    filterLabels: config.filters.join(', ')
  });

  const diffMap: Record<Difficulty, 'easy' | 'intermediate' | 'hard'> = {
		'Easy': 'easy', 'Medium': 'intermediate', 'Hard': 'hard'
	};
	const shotCountMap: Record<Shot, number> = {
		'0-shot': 0, '1-shot': 1, '2-shot': 2, '3-shot': 3
	};

  const fewShotExamples = await db.getSeedsForShot(
    diffMap[config.difficulty],
    shotCountMap[config.shot]
  );

  console.log('[ExGen] Config:', config);
  console.log('[ExGen] Few-shot examples:', fewShotExamples.map((e, i) =>
    `\n  [Shot ${i + 1}] ${e.title}: ${e.problem_statement}`
  ).join(''));

  const applyTestcaseCheck = config.filters.includes('Testcase Check');
  const applyDifficultyCheck = config.filters.includes('Difficulty Check');

  const sessionId = `${config.topic}-${config.difficulty}-${config.shot}-${Date.now()}`;
  const csvPath = path.join(extensionPath, 'exgen_results.csv');
  let exerciseNo = 0;

  const statusBar = vscode.window.setStatusBarMessage('$(sync~spin) ExGen: Generating exercises...');

  try {
    const { exercises: results, model: usedModel } = await callLLM(config, fewShotExamples, extensionPath);

    let passed  = 0;
    let skipped = 0;

    for (const result of results) {
      exerciseNo++;

      let unitTestStatus    = '';
      let unitTestError     = '';
      let unitTestReasoning = '';
      let diffCheckStatus    = '';
      let diffCheckError     = '';
      let diffCheckReasoning = '';

      // ── Filter Chain ──────────────────────────────────────────────────────
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
            console.warn(`[ExGen] Exercise "${result.title}" FAILED compilation:`, unitTestError);
          } else if (filterResult.unit_test && !filterResult.unit_test.passed) {
            unitTestError     = filterResult.unit_test.error ?? '';
            unitTestReasoning = `Unit test failed: ${unitTestError}`;
            console.warn(`[ExGen] Exercise "${result.title}" FAILED unit test:`, unitTestError);
          }

          console.warn(
            `[ExGen] Exercise "${result.title}" FAILED test filters.`,
            `Reason: ${unitTestReasoning}`,
            `Problem stmt: ${result.problem_statement.substring(0, 5000)}`
          );

          appendToCSV(
            csvPath, sessionId, usedModel, config, fewShotExamples,
            exerciseNo, result.title, result.problem_statement,
            unitTestStatus, unitTestError, unitTestReasoning,
            diffCheckStatus, diffCheckError, diffCheckReasoning
          );
          continue;
        }

        unitTestStatus = 'passed';
        console.log(`[ExGen] Exercise "${result.title}" PASSED test filters.`);
      }

      // ── Difficulty Check ──────────────────────────────────────────────────
      if (applyDifficultyCheck) {
        vscode.window.setStatusBarMessage(`$(sync~spin) ExGen: Verifying difficulty "${result.title}"...`);

        const difficultyCheck = await db.checkDifficulty(
          { ...result, topic: config.topic, difficulty: config.difficulty, shot: config.shot, filters_applied: config.filters, solution: result.solution ?? '' },
          config.difficulty
        );

        console.log(`[ExGen] Difficulty check result for "${result.title}"`, difficultyCheck);

        if (!difficultyCheck.passed) {
          skipped++;
          diffCheckStatus    = 'failed';
          diffCheckError     = difficultyCheck.error ?? '';
          diffCheckReasoning = (difficultyCheck as any).reason ?? '';

          console.warn(
            `[ExGen] Exercise "${result.title}" FAILED difficulty check:`,
            diffCheckError,
            `Reason: ${diffCheckReasoning}`,
            `Problem stmt: ${result.problem_statement.substring(0, 5000)}`
          );

          appendToCSV(
            csvPath, sessionId, usedModel, config, fewShotExamples,
            exerciseNo, result.title, result.problem_statement,
            unitTestStatus, unitTestError, unitTestReasoning,
            diffCheckStatus, diffCheckError, diffCheckReasoning
          );
          continue;
        }

        diffCheckStatus = 'passed';
        console.log(`[ExGen] Exercise "${result.title}" PASSED difficulty check.`);
      }

      // ── Exercise lolos semua filter ───────────────────────────────────────
      appendToCSV(
        csvPath, sessionId, usedModel, config, fewShotExamples,
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
        `${skipped} exercise(s) were discarded (failed compilation, unit test${difficultyMsg} or difficulty mismatch).`
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

// Jumlah kolom shot_ref selalu tetap 3 (best practice: fixed schema)
const MAX_SHOT_COLS = 3;

function appendToCSV(
  csvPath: string,
  sessionId: string,
  model: string,
  config: ExerciseConfig,
  fewShotExamples: any[],
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
  const orNull = (s: string) => (s === undefined || s === null || s.trim() === '') ? 'NULL' : escape(s);

  const header =
    'session_id;model;topic;difficulty;shot;' +
    'shot_ref_1;shot_ref_2;shot_ref_3;' +
    'no;title;problem_statement;' +
    'unit_test;unit_test_error;unit_test_reasoning;' +
    'diff_check;diff_check_error;diff_check_reasoning\n';

  const shotRefValues = Array.from({ length: MAX_SHOT_COLS }, (_, i) => {
    const ex = fewShotExamples[i];
    return ex ? escape(ex.problem_statement) : 'NULL';
  });

  const row = [
    escape(sessionId),
    escape(model),
    escape(config.topic),
    escape(config.difficulty),
    escape(config.shot),
    ...shotRefValues,
    String(no),
    escape(title),
    escape(problemStatement),
    orNull(unitTestStatus),
    orNull(unitTestError),
    orNull(unitTestReasoning),
    orNull(diffCheckStatus),
    orNull(diffCheckError),
    orNull(diffCheckReasoning)
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

    const exampleJson = JSON.stringify({
      title: ex.title,
      problem_statement: ex.problem_statement,
      example: ex.example ?? '',
      function_stub: ex.function_stub ?? `def solution():\n    pass`,
      test_cases: ex.test_cases ?? [],
      solution: ex.solution ?? ''
    }, null, 2);

    messages.push({
      role: 'assistant',
      content: `Here is one ${difficultyLabel} Python exercise:\n${exampleJson}`
    });
  }

  const isZeroShot = fewShotExamples.length === 0;

  const finalUserContent = isZeroShot
    ? `Give me 5 ${difficultyLabel} Python exercises using this keyword: ` +
      `${config.topic}. ` +
      `Return a JSON array where each element has fields: title, ` +
      `problem_statement, example, function_stub, test_cases, solution. ` +
      `Return JSON only.`
    : `Good. I want 5 more ${difficultyLabel} Python exercises using this ` +
      `keyword: ${config.topic}. ` +
      `Print the result with the same format as the previous ones. ` +
      `Return a JSON array only.`;

  messages.push({
    role: 'user',
    content: finalUserContent
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
  const apiKey = useOllama ? 'ollama' : process.env.OPENROUTER_API_KEY;

  if (!useOllama && !apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY in environment. Set USE_OLLAMA=true for local Ollama.');
  }

  const model = process.env.OPENROUTER_MODEL || (useOllama ? 'llama3.2' : 'nvidia/nemotron-3-super-120b-a12b:free');

  const diffMap: Record<Difficulty, string> = {
    'Easy': 'easy',
    'Medium': 'intermediate',
    'Hard': 'hard'
  };
  const difficultyLabel = diffMap[config.difficulty];

  const messages = buildMessages(config, fewShotExamples, difficultyLabel);

  console.log('[ExGen] Prompting strategy:', fewShotExamples.length === 0 ? 'zero-shot' : `${fewShotExamples.length}-shot`);
  console.log('[ExGen] Total messages in prompt:', messages.length);
  console.log('[ExGen] Using:', useOllama ? 'Ollama (localhost)' : 'OpenRouter');
  console.log('[ExGen] Model:', model);

  const payload = JSON.stringify({
    model,
    temperature: 0.7,
    max_tokens: 8000,
    messages
  });

  const baseUrl = useOllama
    ? 'http://localhost:11434/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  const responseText = await httpRequest(
    baseUrl,
    payload,
    {
      Authorization: useOllama ? '' : `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
      'HTTP-Referer': 'vscode-extension',
      'X-Title': 'exercise-generator'
    },
    useOllama
  );

  let responseJson: OpenRouterResponse;
  try {
    responseJson = JSON.parse(responseText) as OpenRouterResponse;
  } catch {
    throw new Error('LLM response is not valid JSON');
  }

  const content = responseJson.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM response missing content');
  }

  const parsed = parseJsonFromContent(content);
  const exercises = Array.isArray(parsed) ? parsed : [parsed];
  for (const exercise of exercises) {
    validateLLMExercise(exercise);
  }

  return { exercises, model };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadEnvFromFile(extensionPath: string): void {
  if (process.env.OPENROUTER_API_KEY || process.env.USE_OLLAMA === 'true') {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const candidateRoots = [extensionPath, workspaceRoot].filter(
    (root): root is string => Boolean(root)
  );

  const envPath = candidateRoots
    .map(root => path.join(root, '.env'))
    .find(candidate => fs.existsSync(candidate));

  if (!envPath) { return; }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    const idx = trimmed.indexOf('=');
    if (idx === -1) { continue; }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function httpRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  useHttp: boolean = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestFn = useHttp ? http.request : https.request;
    const request = requestFn(url, { method: 'POST', headers }, (res) => {
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

    request.on('error', (err) => reject(err));
    request.write(body);
    request.end();
  });
}

function parseJsonFromContent(content: string): LLMExercise | LLMExercise[] {
  const trimmed = content.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : trimmed;

  if (jsonStr.startsWith('[')) {
    return JSON.parse(jsonStr) as LLMExercise[];
  }

  if (jsonStr.startsWith('{')) {
    return JSON.parse(jsonStr) as LLMExercise;
  }

  const match = jsonStr.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) {
    throw new Error('LLM content does not contain JSON');
  }
  return JSON.parse(match[0]) as LLMExercise | LLMExercise[];
}

function validateLLMExercise(data: LLMExercise): void {
  if (!data || typeof data !== 'object') {
    throw new Error('LLM response is empty');
  }
  const requiredStrings = ['title', 'problem_statement', 'example', 'function_stub'] as const;
  for (const key of requiredStrings) {
    if (!data[key] || typeof data[key] !== 'string') {
      throw new Error(`LLM response missing ${key}`);
    }
  }
  if (!Array.isArray(data.test_cases) || data.test_cases.length === 0) {
    throw new Error('LLM response missing test_cases');
  }
}