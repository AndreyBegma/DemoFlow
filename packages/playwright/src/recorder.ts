import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StepInput } from '@demoflow/core';
import type { Page, TestInfo } from '@playwright/test';
import { scenarioPath, toSlashes, WrittenPaths } from './paths.ts';
import { serializeScenario, toScenario } from './scenario.ts';
import { lineIn } from './source.ts';

// One test's recording: the steps its calls resolved to, what was left out,
// and the refusal that fails it. Written at teardown, only for a passing test
// (spec 208, Decisions 4, 6 and 7).

/** The scenarios this worker has written. */
const written = new WrittenPaths();

let active: Recorder | undefined;

/**
 * The recording of the test running in this worker, for what is not reached
 * through its `page`: `test.step` and `expect.poll`.
 */
export function activeRecorder(): Recorder | undefined {
  return active;
}

export function setActiveRecorder(recorder: Recorder | undefined): void {
  active = recorder;
}

/** The stack of the current call, deep enough to reach the test file through helpers. */
export function stackHere(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  return stack;
}

export class Recorder {
  readonly steps: StepInput[] = [];
  /** How deep in `test.step` the test is: only the outermost is a scene. */
  stepDepth = 0;
  #refusal: Error | undefined;
  readonly configDir: string;
  readonly testInfo: TestInfo;
  readonly page: Page;

  constructor(testInfo: TestInfo, page: Page) {
    this.testInfo = testInfo;
    this.page = page;
    const { configFile } = testInfo.config;
    this.configDir =
      configFile === undefined ? process.cwd() : path.dirname(configFile);
  }

  /** The test file relative to the config directory, with `/` on every OS. */
  get file(): string {
    return toSlashes(path.relative(this.configDir, this.testInfo.file));
  }

  /** `<file>:<line>` of the test code in `stack`. */
  where(stack: string): string {
    const line = lineIn(stack, this.testInfo.file);
    return line === undefined ? this.file : `${this.file}:${line}`;
  }

  push(step: StepInput): void {
    this.steps.push(step);
  }

  /**
   * The error that fails the test: a call the scenario cannot express. Kept,
   * so a test that catches it still fails at teardown and writes nothing.
   */
  refuse(message: string): Error {
    const error = new Error(`demoflow: ${message}`);
    this.#refusal ??= error;
    return error;
  }

  cannotRecord(call: string, stack: string, reason: string): Error {
    return this.refuse(
      `cannot record ${call} at ${this.where(stack)}: ${reason}`,
    );
  }

  /** A call left out of the scenario, reported as a test annotation. */
  omit(call: string, stack: string, reason: string): void {
    this.testInfo.annotations.push({
      type: 'demoflow',
      description: `not recorded: ${call} at ${this.where(stack)}: ${reason}`,
    });
  }

  /** Writes the scenario of a passing test; throws what failed it otherwise. */
  async finish(): Promise<void> {
    if (this.testInfo.status !== 'passed') return;
    // The test caught the refusal and went on: it still fails.
    if (this.#refusal !== undefined) throw this.#refusal;
    const { config, project } = this.testInfo;
    const titles = this.testInfo.titlePath.slice(1);
    const target = scenarioPath({
      configDir: this.configDir,
      testDir: project.testDir,
      file: this.testInfo.file,
      titles,
      ...(config.projects.length > 1 ? { project: project.name } : {}),
    });
    const shown = toSlashes(path.relative(this.configDir, target));
    written.claim(target, titles.join(' › '), shown);
    const result = serializeScenario(
      toScenario({
        titles,
        file: this.file,
        viewport: this.page.viewportSize(),
        steps: this.steps,
      }),
    );
    if (!result.ok) {
      const issues = result.errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ');
      throw new Error(`demoflow: ${shown} is not a valid scenario: ${issues}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, result.text);
  }
}
