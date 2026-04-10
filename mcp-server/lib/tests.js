// Barrel re-export — kept for backward compatibility with existing imports.
// New code should import directly from the relevant module.

export {
  getRecording, setRecording,
  getLastRefMap, setLastRefMap,
  getAction, saveActionToHistory
} from './recording.js';

export { classifyWithLLM, detectListContext } from './classify.js';

export {
  loadTest, saveTest,
  updateTestStep,
  deleteTest, listTests
} from './test-store.js';

export { executeTest, evaluateAssertion } from './test-execute.js';
