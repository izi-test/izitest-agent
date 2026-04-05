// Replay engine: executes a recorded workflow step sequence.
import { getPage, detachBrowser } from '../puppeteer-client';
import { resolveTabId, delay } from '../helpers';
import { clickViaLocator, clickToggleViaHandle, focusViaLocator, clearAndType, isStaleContextError } from './page-helpers';
import { findElementWithLocators, type ElementCondition } from './locators';
import { resolveVariableElement, type ReplayStep } from './variable-resolver';
import { cmdNavigate, cmdClick, cmdFill, cmdKeyboard, cmdScroll } from './actions';
import { cmdExecuteJs, cmdWait } from './queries';
import type { ReplaySequenceParams, Locator } from '../types';
import type { Page } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';

const STEP_DELAY_MS: Record<string, number> = { navigate: 300, click: 150 };
const DEFAULT_STEP_DELAY_MS = 50;

const COMMAND_DISPATCH: Record<string, (params: any) => Promise<any>> = {
  navigate: cmdNavigate,
  keyboard: cmdKeyboard,
  click: cmdClick,
  fill: cmdFill,
  scroll: cmdScroll,
  execute_js: cmdExecuteJs,
  wait: cmdWait,
};

function makeStepResult(
  step: number, command: string, intent: string | undefined,
  status: string, startedAt: number, extra?: Record<string, any>
) {
  const finishedAt = Date.now();
  return { step, command, intent, status, startedAt, finishedAt, durationMs: finishedAt - startedAt, ...extra };
}

export async function cmdReplaySequence(
  { steps, startIndex, newWindow }: ReplaySequenceParams,
  onProgress?: (data: any) => void
) {
  const results: any[] = [];
  let currentTabId: number | undefined = undefined;
  const totalSteps = steps.length;
  const executionStartedAt = Date.now();

  console.log(`\n🎬 ════════════════════════════════════════════════════`);
  console.log(`🎬 REPLAY SEQUENCE STARTED — ${totalSteps} steps (starting at #${startIndex + 1})`);
  console.log(`🎬 ════════════════════════════════════════════════════\n`);

  for (let s = 0; s < startIndex; s++) {
    results.push({ step: s + 1, command: steps[s].command, intent: steps[s].intent, status: 'skipped' });
  }

  let executionError: string | undefined;

  for (let i = startIndex; i < totalSteps; i++) {
    const step = steps[i] as ReplayStep;
    const baseParams = { ...step.params };
    const stepStartedAt = Date.now();

    console.log(`\n▶ Step ${i + 1}/${totalSteps}: [${step.command}] ${step.intent || step.command}`);
    console.log(`  Params: ${JSON.stringify(baseParams)}`);

    onProgress?.({ type: 'step_start', step: i + 1, command: step.command, intent: step.intent });

    if (currentTabId) {
      baseParams.tabId = currentTabId;
    } else {
      delete baseParams.tabId;
      if (newWindow) baseParams.newWindow = true;
    }

    try {
      // ─── Variable Resolution (list/box item selection) ───────
      let resolvedViaVariable = false;
      if (step.variableResolve && step.command === 'click') {
        console.log(`  🔀 Variable resolve: ${step.variableResolve.selectionMode}="${step.variableResolve.value}"`);

        const resolvedTab = await resolveTabId(baseParams.tabId);
        const page = await getPage(resolvedTab);
        currentTabId = resolvedTab;

        const varResult = await resolveVariableElement(page, resolvedTab, step.variableResolve);

        if (varResult) {
          try {
            console.log(`  🖱️ Clicking variable-resolved element...`);
            await varResult.handle.click();
            await varResult.handle.dispose();
            console.log(`  ✅ Step ${i + 1} completed via variable resolve (${varResult.description})`);
            const stepResult = makeStepResult(i + 1, step.command, step.intent, 'success', stepStartedAt,
              { resolvedVia: 'variable', detail: varResult.description });
            results.push(stepResult);
            onProgress?.({ type: 'step_complete', stepResult });
            resolvedViaVariable = true;
          } catch (err) {
            await varResult.handle.dispose().catch(() => {});
            console.warn(`  ⚠️ Variable resolve click failed, falling back to locators: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          console.warn(`  ⚠️ Variable resolve returned null, falling back to locators`);
        }
      }

      if (resolvedViaVariable) {
        const delayMs = STEP_DELAY_MS[step.command] ?? DEFAULT_STEP_DELAY_MS;
        console.log(`  ⏳ Waiting ${delayMs}ms...`);
        await delay(delayMs);
        continue;
      }

      // ─── Locator-based element commands ─────────────────────
      const elementCommands = ['click', 'fill', 'scroll'];
      const hasLocators = step.locators && step.locators.length > 0 && elementCommands.includes(step.command);

      if (hasLocators) {
        console.log(`  Locators available: ${step.locators!.length} (${step.locators!.map((l: Locator) => l.type).join(', ')})`);

        const resolvedTab = await resolveTabId(baseParams.tabId);
        currentTabId = resolvedTab;

        const elementCondition: ElementCondition =
          step.command === 'click' ? 'visible' :
          step.command === 'fill'  ? 'enabled' :
          'any';

        const executeWithLocators = async (page: Page) => {
          const { result, errors } = await findElementWithLocators(page, step.locators!, elementCondition);
          if (!result) throw new Error(`All ${step.locators!.length} locators failed:\n${errors.join('\n')}`);

          const { locatorUsed, locatorValue, handle } = result;

          try {
            if (step.command === 'click') {
              // Check if this is a toggle element (checkbox/radio/switch).
              // Custom component wrappers (Radix, Spark) double-toggle on mouse click
              // because pointer events bubble through nested handlers.
              // handle.evaluate(el.click()) is the equivalent of DevTools el.click()
              // and avoids this issue entirely.
              const isToggle = await handle.evaluate((el) => {
                const role = el.getAttribute('role') || '';
                const inputType = (el as HTMLInputElement).type || '';
                return ['checkbox', 'radio', 'switch'].includes(role)
                    || ['checkbox', 'radio'].includes(inputType);
              });

              if (isToggle) {
                console.log(`  🔘 Toggle element (${locatorUsed}="${locatorValue}") — using handle.evaluate(el.click())`);
                await clickToggleViaHandle(handle);
              } else {
                // Dispose handle — handle.click() uses stale context ID.
                // page.evaluate uses Runtime.evaluate with the current frame context.
                await handle.dispose().catch(() => {});
                console.log(`  🖱️ Querying element position via page.evaluate (${locatorUsed}="${locatorValue}")...`);
                await clickViaLocator(page, locatorUsed, locatorValue);
              }
            } else if (step.command === 'fill') {
              console.log(`  ⌨️ Filling with value: "${baseParams.value}"`);
              await handle.dispose().catch(() => {});
              await focusViaLocator(page, locatorUsed, locatorValue);
              await delay(50);
              await clearAndType(page, String(baseParams.value), baseParams.clear ?? true);
            } else if (step.command === 'scroll') {
              console.log(`  📜 Scrolling to element...`);
              await page.evaluate((el: Element) => el.scrollIntoView({ behavior: 'instant', block: 'center' }), handle);
            }
          } finally {
            await handle.dispose().catch(() => {});
          }

          return locatorUsed;
        };

        // Attempt with stale-context retry
        let locatorUsed: string;
        let page = await getPage(resolvedTab);
        try {
          locatorUsed = await executeWithLocators(page);
        } catch (firstErr) {
          if (!isStaleContextError(firstErr)) throw firstErr;

          console.log(`  ⚠️ Stale execution context on step ${i + 1}, evicting page cache and retrying...`);
          detachBrowser(resolvedTab);
          await delay(300);
          page = await getPage(resolvedTab);
          console.log(`  🔄 Retrying step ${i + 1} with fresh page connection...`);
          locatorUsed = await executeWithLocators(page);
        }

        console.log(`  ✅ Step ${i + 1} completed successfully (via ${locatorUsed})`);
        const stepResult = makeStepResult(i + 1, step.command, step.intent, 'success', stepStartedAt,
          { locator: locatorUsed });
        results.push(stepResult);
        onProgress?.({ type: 'step_complete', stepResult });
      } else {
        // ─── Direct command dispatch (no locators) ──────────────
        console.log(`  No locators — dispatching command directly`);
        const handler = COMMAND_DISPATCH[step.command];
        if (!handler) throw new Error(`Unsupported command in sequence: ${step.command}`);

        const res = await handler(baseParams);
        if (res && res.tabId) currentTabId = res.tabId;

        console.log(`  ✅ Step ${i + 1} completed successfully`);
        const stepResult = makeStepResult(i + 1, step.command, step.intent, 'success', stepStartedAt);
        results.push(stepResult);
        onProgress?.({ type: 'step_complete', stepResult });
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`  🚨 Step ${i + 1} FAILED: ${errorMessage}`);

      const failedResult = makeStepResult(i + 1, step.command, step.intent, 'failed', stepStartedAt,
        { error: errorMessage });
      results.push(failedResult);
      onProgress?.({ type: 'step_complete', stepResult: failedResult });

      executionError = `Step ${i + 1}/${totalSteps} (${step.intent || step.command}) failed: ${errorMessage}`;

      for (let s = i + 1; s < totalSteps; s++) {
        const skippedResult = { step: s + 1, command: steps[s].command, intent: steps[s].intent, status: 'skipped' };
        results.push(skippedResult);
        onProgress?.({ type: 'step_complete', stepResult: skippedResult });
      }
      break;
    }

    const delayMs = STEP_DELAY_MS[step.command] ?? DEFAULT_STEP_DELAY_MS;
    console.log(`  ⏳ Waiting ${delayMs}ms...`);
    await delay(delayMs);
  }

  const executionFinishedAt = Date.now();
  const executionDurationMs = executionFinishedAt - executionStartedAt;
  const executionSuccess = !executionError;

  console.log(`\n🎬 ════════════════════════════════════════════════════`);
  console.log(`🎬 REPLAY SEQUENCE ${executionSuccess ? 'COMPLETED' : 'FAILED'} — ${results.filter(r => r.status === 'success').length}/${totalSteps} steps in ${executionDurationMs}ms`);
  console.log(`🎬 ════════════════════════════════════════════════════\n`);

  if (!executionSuccess) {
    throw Object.assign(new Error(executionError!), {
      results,
      startedAt: executionStartedAt,
      finishedAt: executionFinishedAt,
      durationMs: executionDurationMs
    });
  }

  return {
    success: true,
    startedAt: executionStartedAt,
    finishedAt: executionFinishedAt,
    durationMs: executionDurationMs,
    results
  };
}
