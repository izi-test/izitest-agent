// IziTest Agent — Popup Debug Panel

// ─── Tab Navigation ───
const tabButtons = document.querySelectorAll('.tab-btn');
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Connection Status ───
const connectionPill = document.getElementById('connectionPill');
const connectionLabel = document.getElementById('connectionLabel');
const profileInput = document.getElementById('profileId');
const saveBtn = document.getElementById('saveBtn');

chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
  if (resp?.connected) {
    connectionPill.className = 'connection-pill connected';
    connectionLabel.textContent = 'Online';
  }
  if (resp?.profileId) {
    profileInput.value = resp.profileId;
  }
});

saveBtn.addEventListener('click', () => {
  const pid = profileInput.value.trim();
  if (!pid) return;
  chrome.runtime.sendMessage({ type: 'setProfileId', profileId: pid }, () => {
    chrome.runtime.sendMessage({ type: 'reconnect' });
    connectionLabel.textContent = 'Reconnecting…';
    connectionPill.className = 'connection-pill disconnected';
  });
});

// ─── Purpose Filter ───
let selectedPurpose = 'read';
const purposeButtons = document.querySelectorAll('.purpose-btn');
purposeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    purposeButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPurpose = btn.dataset.purpose;
  });
});

// ─── Helper: Build snapshot options from UI ───
function getSnapshotOptions() {
  const options = {};
  if (document.getElementById('optInteractive').checked) options.interactiveOnly = true;
  if (document.getElementById('optCompact').checked) options.compact = true;
  if (document.getElementById('optRects').checked) options.includeRects = true;
  if (document.getElementById('optHidden').checked) options.includeHidden = true;
  if (selectedPurpose && selectedPurpose !== 'read') options.purposeFilter = selectedPurpose;
  const scope = document.getElementById('optScope').value.trim();
  if (scope) options.scope = scope;
  const searchText = document.getElementById('optSearchText').value.trim();
  if (searchText) options.searchText = searchText;
  options.format = 'text';
  return options;
}

// ─── Helper: Execute command via background ───
function executeCommand(command, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'executeLocal', command, params },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || 'Command failed'));
          return;
        }
        resolve(response.result);
      }
    );
  });
}

// ─── UI Refs ───
const outputContainer = document.getElementById('outputContainer');
const outputArea = document.getElementById('outputArea');
const outputLabel = document.getElementById('outputLabel');
const statsRow = document.getElementById('statsRow');
const screenshotPreview = document.getElementById('screenshotPreview');
const screenshotImg = document.getElementById('screenshotImg');

function setLoading(button, loading) {
  if (loading) {
    button.classList.add('loading');
    button.disabled = true;
  } else {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function showStats(refs, tree) {
  const refCount = refs ? Object.keys(refs).length : 0;
  const lines = tree ? tree.split('\n').length : 0;
  const chars = tree ? tree.length : 0;

  document.getElementById('statRefs').textContent = refCount;
  document.getElementById('statLines').textContent = lines;
  document.getElementById('statSize').textContent = chars > 1000 ? `${(chars / 1000).toFixed(1)}k` : chars;

  statsRow.style.display = 'flex';
}

function showOutput(label, text, { hideScreenshot = true } = {}) {
  outputLabel.textContent = label;
  outputArea.value = text;
  outputContainer.style.display = 'block';
  if (hideScreenshot) screenshotPreview.style.display = 'none';
}

// ─── Snapshot Button ───
document.getElementById('btnSnapshot').addEventListener('click', async () => {
  const btn = document.getElementById('btnSnapshot');
  setLoading(btn, true);

  const startTime = performance.now();

  try {
    const options = getSnapshotOptions();
    const result = await executeCommand('snapshot', options);

    const elapsed = Math.round(performance.now() - startTime);
    document.getElementById('statTime').textContent = elapsed;

    const header = [
      `Page: ${result.title}`,
      `URL: ${result.url}`,
      `Timestamp: ${new Date(result.timestamp).toISOString()}`,
      ''
    ].join('\n');

    showOutput(`Snapshot — ${selectedPurpose}`, header + result.tree);
    showStats(result.refs, result.tree);
  } catch (error) {
    showOutput('Error', error.message);
    statsRow.style.display = 'none';
  }

  setLoading(btn, false);
});

// ─── Screenshot Button ───
document.getElementById('btnScreenshot').addEventListener('click', async () => {
  const btn = document.getElementById('btnScreenshot');
  setLoading(btn, true);

  const startTime = performance.now();

  try {
    // Take a snapshot with current filter options, then annotate + capture
    const options = getSnapshotOptions();
    options.interactiveOnly = true;
    const snapResult = await executeCommand('snapshot', options);

    const elapsed = Math.round(performance.now() - startTime);
    document.getElementById('statTime').textContent = elapsed;
    showStats(snapResult.refs, snapResult.tree);

    const screenshotResult = await executeCommand('screenshot', { annotate: true });

    showOutput(`Screenshot + Snapshot — ${selectedPurpose}`, snapResult.tree, { hideScreenshot: false });

    if (screenshotResult.dataUrl) {
      screenshotImg.src = screenshotResult.dataUrl;
      screenshotPreview.style.display = 'block';
    }
  } catch (error) {
    showOutput('Error', error.message);
    statsRow.style.display = 'none';
  }

  setLoading(btn, false);
});

// ─── Screenshot Actions ───
document.getElementById('btnDownloadScreenshot').addEventListener('click', () => {
  const dataUrl = screenshotImg.src;
  if (!dataUrl || dataUrl === '') return;

  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = dataUrl;
  link.download = `screenshot-${timestamp}.png`;
  link.click();
});

document.getElementById('btnCloseScreenshot').addEventListener('click', () => {
  screenshotPreview.style.display = 'none';
});

screenshotImg.addEventListener('click', () => {
  window.open(screenshotImg.src, '_blank');
});

// ─── Annotate / Clear Buttons ───
document.getElementById('btnAnnotate').addEventListener('click', async () => {
  try {
    // Trigger snapshot first to populate refMap, then draw persistent annotations
    const options = getSnapshotOptions();
    options.interactiveOnly = true;
    await executeCommand('snapshot', options);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'draw_annotations' });
    }
  } catch (error) {
    showOutput('Error', error.message);
  }
});

document.getElementById('btnClearAnnot').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'clear_annotations' });
    }
  } catch (error) {
    showOutput('Error', error.message);
  }
});

// ─── Copy Button ───
document.getElementById('btnCopy').addEventListener('click', () => {
  navigator.clipboard.writeText(outputArea.value).then(() => {
    const btn = document.getElementById('btnCopy');
    const originalLabel = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = originalLabel; }, 1500);
  });
});
