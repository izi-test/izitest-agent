// Replay engine: executes a recorded workflow step sequence.
import { getPage, detachBrowser } from '../puppeteer-client';
import { resolveTabId, delay, TOP_FRAME } from '../helpers';
import { clickViaLocator, clickToggleViaHandle, focusViaLocator, clearAndType, isStaleContextError, toggleStateOf } from './page-helpers';
import { findElementWithLocators, type ElementCondition } from './locators';
import { resolveVariableElement, type ReplayStep } from './variable-resolver';
import { cmdNavigate, cmdClick, cmdFill, cmdSelect, cmdUpload, cmdDrag, cmdKeyboard, cmdScroll, wantedChecked } from './actions';
import { dragElements } from './drag';
import { cmdExecuteJs, cmdWait } from './queries';
import { setPickedValue } from '../dom/picked-input';
import { actsOnPage } from '../page-url';
import { missedWait } from '../wait-outcome';
import { fileInputOf, putFiles } from '../dom/file-input';
import type { ReplaySequenceParams, Locator } from '../types';
import type { ElementHandle, Page } from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';

const STEP_DELAY_MS: Record<string, number> = { navigate: 300, click: 150 };

// Locators whose value finds the element again in page.evaluate (see queryElementBox). A
// role, a name, a text or a placeholder does not: looked up again as CSS, the role "button"
// was the page's first button, and an accessible name only matched an aria-label.
const SELECTOR_LOCATORS = new Set(['css', 'testid', 'attribute', 'xpath']);

/** Click the middle of the element found, scrolled into view — inside iframes too. */
async function clickAtHandle(page: Page, handle: ElementHandle<Element>): Promise<void> {
  await handle.scrollIntoView().catch(() => {});
  const box = await handle.boundingBox();
  if (!box) throw new Error('The element found has no box to click');
  console.log(`  🖱️ Clicking the element found at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const DEFAULT_STEP_DELAY_MS = 50;

const COMMAND_DISPATCH: Record<string, (params: any) => Promise<any>> = {
  navigate: cmdNavigate,
  keyboard: cmdKeyboard,
  click: cmdClick,
  fill: cmdFill,
  select: cmdSelect,
  upload: cmdUpload,
  drag: cmdDrag,
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

export let isAbortRequested = false;
export function abortSequence() {
  isAbortRequested = true;
}

export async function cmdReplaySequence(
  { steps, startIndex, newWindow, tabId, sessionId, viewportWidth, viewportHeight }: ReplaySequenceParams,
  onProgress?: (data: any) => void
) {
  isAbortRequested = false;
  const results: any[] = [];
  let currentTabId: number | undefined = tabId ?? undefined;
  const totalSteps = steps.length;
  const executionStartedAt = Date.now();

  // When a tabId is provided (e.g. debug step-by-step mode), make the target tab the
  // active one of its window. Its window is not brought to the front: the user clicking
  // Resume/Step in the dashboard stays there, and the page is told it has the focus anyway
  // (getPage emulates it).
  if (currentTabId) {
    try {
      await chrome.tabs.update(currentTabId, { active: true });
      await delay(100);
    } catch (focusErr) {
      console.warn(`⚠️ Could not refocus tab ${currentTabId}: ${focusErr instanceof Error ? focusErr.message : String(focusErr)}`);
    }
  }

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
    // The page the step runs on: a step recorded before steps kept theirs gets it (server's
    // fillStepPages).
    const pageUrl = currentTabId && actsOnPage(step.command)
      ? await chrome.tabs.get(currentTabId).then((tab) => tab.url, () => undefined)
      : undefined;

    if (isAbortRequested) {
      executionError = 'Sequence aborted artificially by user via Stop button.';
      break;
    }

    console.log(`\n▶ Step ${i + 1}/${totalSteps}: [${step.command}] ${step.intent || step.command}`);
    // An upload's files, in base64, would fill the console.
    console.log(`  Params: ${JSON.stringify(baseParams, (key, value) => key === 'fileData' ? `[${value.length} file(s)]` : value)}`);

    onProgress?.({ type: 'step_start', step: i + 1, command: step.command, intent: step.intent });
    
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        type: 'update_overlay',
        state: { mode: 'playing', step: i + 1, totalSteps, stepName: step.intent || step.command }
      }, { frameId: TOP_FRAME }).catch(() => {});
    }

    if (currentTabId) {
      baseParams.tabId = currentTabId;
    } else {
      delete baseParams.tabId;
      if (newWindow) {
        baseParams.newWindow = true;
      }
    }

    if (i === startIndex) {
      if (viewportWidth) baseParams.viewportWidth = viewportWidth;
      if (viewportHeight) baseParams.viewportHeight = viewportHeight;
    }

    try {
      // A checkbox recorded with its state: replayed to that state, not toggled whatever
      // it is now (a box the page remembers as checked would be unchecked).
      const wanted = step.command === 'click' ? wantedChecked(baseParams.checked) : undefined;
      const alreadySet = async (handle: Parameters<typeof toggleStateOf>[0]) =>
        wanted !== undefined && (await toggleStateOf(handle).catch(() => null)) === wanted;
      const alreadyDetail = wanted ? 'already checked: not clicked' : 'already unchecked: not clicked';

      // ─── Variable Resolution (list/box item selection) ───────
      let resolvedViaVariable = false;
      if (step.variableResolve && step.command === 'click') {
        console.log(`  🔀 Variable resolve: ${step.variableResolve.selectionMode}="${step.variableResolve.value}"`);

        const resolvedTab = await resolveTabId(baseParams.tabId, sessionId);
        const page = await getPage(resolvedTab);
        currentTabId = resolvedTab;

        const varResult = await resolveVariableElement(page, resolvedTab, step.variableResolve);

        if (varResult) {
          try {
            const skip = await alreadySet(varResult.handle);
            if (!skip) {
              console.log(`  🖱️ Clicking variable-resolved element...`);
              await varResult.handle.click();
            }
            await varResult.handle.dispose();
            console.log(`  ✅ Step ${i + 1} completed via variable resolve (${varResult.description})`);
            const stepResult = makeStepResult(i + 1, step.command, step.intent, 'success', stepStartedAt,
              { resolvedVia: 'variable', detail: skip ? `${varResult.description}, ${alreadyDetail}` : varResult.description, tabId: currentTabId });
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
      const elementCommands = ['click', 'fill', 'select', 'upload', 'drag', 'scroll'];
      const hasLocators = step.locators && step.locators.length > 0 && elementCommands.includes(step.command);

      if (hasLocators) {
        console.log(`  Locators available: ${step.locators!.length} (${step.locators!.map((l: Locator) => l.type).join(', ')})`);

        const resolvedTab = await resolveTabId(baseParams.tabId, sessionId);
        currentTabId = resolvedTab;

        // A box clicked through its label (viaLabel) is hidden by design: waiting for it to
        // show cost 2 s on every replay before the fallback found it. Present is enough —
        // a toggle is clicked from script below, as the label would.
        const elementCondition: ElementCondition =
          step.command === 'click' && baseParams.viaLabel ? 'any' :
          step.command === 'click'  ? 'visible' :
          step.command === 'drag'   ? 'visible' :
          step.command === 'fill'   ? 'enabled' :
          step.command === 'select' ? 'enabled' :
          'any';

        let skippedClick = false;
        const executeWithLocators = async (page: Page) => {
          const { result, errors } = await findElementWithLocators(page, step.locators!, elementCondition);
          if (!result) throw new Error(`All ${step.locators!.length} locators failed:\n${errors.join('\n')}`);

          const { locatorUsed, locatorValue, handle } = result;

          try {
            if (step.command === 'click' && await alreadySet(handle)) {
              console.log(`  ☑️ ${alreadyDetail} (${locatorUsed}="${locatorValue}")`);
              skippedClick = true;
            } else if (step.command === 'click') {
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
              } else if (!SELECTOR_LOCATORS.has(locatorUsed)) {
                // Found by name or text: there is no selector to look it up again, the
                // element found is the one clicked.
                await clickAtHandle(page, handle);
              } else {
                // Dispose handle — handle.click() uses stale context ID.
                // page.evaluate uses Runtime.evaluate with the current frame context.
                await handle.dispose().catch(() => {});
                console.log(`  🖱️ Querying element position via page.evaluate (${locatorUsed}="${locatorValue}")...`);
                await clickViaLocator(page, locatorUsed, locatorValue);
              }
            } else if (step.command === 'fill') {
              console.log(`  ⌨️ Filling with value: "${baseParams.value}"`);
              // A date, colour or range input is not typed into: its value is set.
              const picked = await handle.evaluate(setPickedValue, String(baseParams.value));
              if (picked && 'error' in picked) throw new Error(picked.error);
              if (!picked) {
                if (SELECTOR_LOCATORS.has(locatorUsed)) {
                  await handle.dispose().catch(() => {});
                  await focusViaLocator(page, locatorUsed, locatorValue);
                } else {
                  await clickAtHandle(page, handle);
                }
                await delay(50);
                await clearAndType(page, String(baseParams.value), baseParams.clear ?? true);
              }
            } else if (step.command === 'select') {
              console.log(`  📋 Selecting option: "${baseParams.value}"`);
              await handle.dispose().catch(() => {});
              // Use the locator to find the select's CSS selector and call cmdSelect
              const selectSelector = ['css', 'testid', 'attribute'].includes(locatorUsed)
                ? locatorValue
                : baseParams.selector;
              await cmdSelect({
                selector: selectSelector,
                value: String(baseParams.value),
                tabId: currentTabId,
                matchBy: baseParams.matchBy || 'text'
              });
            } else if (step.command === 'upload') {
              // The files' content was read by the server (fileData): the extension cannot.
              const files = baseParams.fileData ?? [];
              console.log(`  📎 Uploading ${files.map((f: { name: string }) => f.name).join(', ')}`);
              const found = await handle.evaluateHandle(fileInputOf);
              const input = found.asElement() as ElementHandle<Element> | null;
              try {
                if (!input) throw new Error('No file input there: not one, nor in it, nor its label\'s, nor a single one around it');
                const put = await input.evaluate(putFiles, files);
                if ('error' in put) throw new Error(put.error);
              } finally {
                await found.dispose().catch(() => {});
              }
            } else if (step.command === 'drag') {
              // Where it is dropped has locators of its own, recorded with the step's params;
              // a step written by hand may only give its selector.
              const targetLocators: Locator[] = baseParams.targetLocators?.length
                ? baseParams.targetLocators
                : [{ type: 'css', value: String(baseParams.target ?? '') }];
              const dropped = await findElementWithLocators(page, targetLocators, 'visible');
              if (!dropped.result) throw new Error(`Where to drop it was not found: all ${targetLocators.length} locators failed:\n${dropped.errors.join('\n')}`);
              try {
                const how = await dragElements(page, handle, dropped.result.handle, baseParams.position);
                console.log(`  ✋ Dropped on ${dropped.result.locatorUsed}="${dropped.result.locatorValue}" (${how} drag)`);
              } finally {
                await dropped.result.handle.dispose().catch(() => {});
              }
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
          { locator: locatorUsed, tabId: currentTabId, ...(skippedClick ? { detail: alreadyDetail } : {}) });
        results.push(stepResult);
        onProgress?.({ type: 'step_complete', stepResult });
      } else {
        // ─── Direct command dispatch (no locators) ──────────────
        console.log(`  No locators — dispatching command directly`);
        const handler = COMMAND_DISPATCH[step.command];
        if (!handler) throw new Error(`Unsupported command in sequence: ${step.command}`);

        const res = await handler(baseParams);
        if (res && res.tabId) currentTabId = res.tabId;
        // What a wait waited for never came: the steps after it would act on another page.
        const missed = missedWait(step.command, res);
        if (missed) throw new Error(missed);

        console.log(`  ✅ Step ${i + 1} completed successfully`);
        const stepResult = makeStepResult(i + 1, step.command, step.intent, 'success', stepStartedAt, { tabId: currentTabId });
        results.push(stepResult);
        onProgress?.({ type: 'step_complete', stepResult });
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`  🚨 Step ${i + 1} FAILED: ${errorMessage}`);

      const failedResult = makeStepResult(i + 1, step.command, step.intent, 'failed', stepStartedAt,
        { error: errorMessage, tabId: currentTabId });
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

    const done = results[results.length - 1];
    if (pageUrl && done?.step === i + 1 && done.status === 'success') done.pageUrl = pageUrl;

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
