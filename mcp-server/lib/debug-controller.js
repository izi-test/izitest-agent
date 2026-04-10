// Debug controller for step-by-step test execution with breakpoints

import { log } from './logger.js';

const PAUSE_MODE_BREAKPOINT = 'breakpoint';
const PAUSE_MODE_STEP = 'step';

/**
 * Registry of active debug sessions.
 * Key: executionId (number), Value: DebugController instance.
 * Shared between REST API routes and MCP tools.
 */
export const activeDebugControllers = new Map();

/**
 * Controls debug execution flow for a single test run.
 * 
 * Before each step, the executor calls `waitIfPaused(stepIndex)`.
 * Depending on the pause mode and breakpoints, the controller either
 * resolves immediately (step can proceed) or blocks until `resume()`,
 * `stepOver()`, or `continueAll()` is called externally.
 */
export class DebugController {
  #breakpoints;
  #pauseMode;
  #isPaused;
  #pausedAtStep;
  #isAborted;
  #pendingResolve;
  #executionId;

  /**
   * @param {number[]} breakpoints - Step numbers (1-indexed) to pause at.
   * @param {string} pauseMode - 'step' pauses on every step, 'breakpoint' only at breakpoints.
   */
  constructor(breakpoints = [], pauseMode = PAUSE_MODE_STEP) {
    this.#breakpoints = new Set(breakpoints);
    this.#pauseMode = pauseMode;
    this.#isPaused = false;
    this.#pausedAtStep = null;
    this.#isAborted = false;
    this.#pendingResolve = null;
    this.#executionId = null;
  }

  get isPaused() { return this.#isPaused; }
  get pausedAtStep() { return this.#pausedAtStep; }
  get isAborted() { return this.#isAborted; }
  get executionId() { return this.#executionId; }

  get breakpoints() {
    return [...this.#breakpoints];
  }

  /**
   * Bind this controller to an execution and register it globally.
   */
  register(executionId) {
    this.#executionId = executionId;
    activeDebugControllers.set(executionId, this);
    log(`DebugController registered for execution #${executionId} (mode: ${this.#pauseMode}, breakpoints: [${this.breakpoints.join(', ')}])`);
  }

  /**
   * Remove this controller from the global registry.
   */
  unregister() {
    if (this.#executionId !== null) {
      activeDebugControllers.delete(this.#executionId);
      log(`DebugController unregistered for execution #${this.#executionId}`);
    }
  }

  /**
   * Called before each step. Resolves immediately if no pause needed,
   * otherwise blocks until a resume signal arrives.
   *
   * @param {number} stepNumber - 1-indexed step number
   * @param {function} onPause - callback invoked when pausing, receives { step }
   * @returns {Promise<void>} resolves when step is allowed to proceed
   */
  async waitIfPaused(stepNumber, onPause) {
    if (this.#isAborted) {
      throw new Error('Debug execution aborted');
    }

    const shouldPause =
      this.#pauseMode === PAUSE_MODE_STEP ||
      this.#breakpoints.has(stepNumber);

    if (!shouldPause) return;

    this.#isPaused = true;
    this.#pausedAtStep = stepNumber;
    log(`Debug: paused at step ${stepNumber}`);

    if (onPause) {
      onPause({ step: stepNumber, breakpoints: this.breakpoints });
    }

    // Block until resume/step/continue is called
    return new Promise((resolve, reject) => {
      this.#pendingResolve = { resolve, reject };
    });
  }

  /**
   * Resume execution until the next breakpoint.
   * Switches to breakpoint mode so non-breakpoint steps run freely.
   */
  resume() {
    if (!this.#isPaused || !this.#pendingResolve) return;

    this.#pauseMode = PAUSE_MODE_BREAKPOINT;
    this.#isPaused = false;
    const step = this.#pausedAtStep;
    this.#pausedAtStep = null;
    log(`Debug: resume from step ${step} (breakpoint mode)`);

    const { resolve } = this.#pendingResolve;
    this.#pendingResolve = null;
    resolve();
  }

  /**
   * Execute the current step, then pause again on the next step.
   * Switches to step mode.
   */
  stepOver() {
    if (!this.#isPaused || !this.#pendingResolve) return;

    this.#pauseMode = PAUSE_MODE_STEP;
    this.#isPaused = false;
    const step = this.#pausedAtStep;
    this.#pausedAtStep = null;
    log(`Debug: step over from step ${step}`);

    const { resolve } = this.#pendingResolve;
    this.#pendingResolve = null;
    resolve();
  }

  /**
   * Remove step-by-step mode and continue execution.
   * Still pauses at remaining breakpoints.
   */
  continueAll() {
    if (!this.#isPaused || !this.#pendingResolve) return;

    this.#pauseMode = PAUSE_MODE_BREAKPOINT;
    this.#isPaused = false;
    const step = this.#pausedAtStep;
    this.#pausedAtStep = null;
    log(`Debug: continue all from step ${step}`);

    const { resolve } = this.#pendingResolve;
    this.#pendingResolve = null;
    resolve();
  }

  /**
   * Toggle a breakpoint on/off for a given step number.
   * @param {number} stepNumber
   * @returns {boolean} true if breakpoint is now set, false if removed
   */
  toggleBreakpoint(stepNumber) {
    if (this.#breakpoints.has(stepNumber)) {
      this.#breakpoints.delete(stepNumber);
      log(`Debug: breakpoint removed at step ${stepNumber}`);
      return false;
    }
    this.#breakpoints.add(stepNumber);
    log(`Debug: breakpoint set at step ${stepNumber}`);
    return true;
  }

  /**
   * Abort the debug session. Rejects the pending pause promise
   * so the execution loop can exit cleanly.
   */
  abort() {
    this.#isAborted = true;
    this.#isPaused = false;
    log(`Debug: execution aborted`);

    if (this.#pendingResolve) {
      const { reject } = this.#pendingResolve;
      this.#pendingResolve = null;
      reject(new Error('Debug execution aborted'));
    }

    this.unregister();
  }
}
