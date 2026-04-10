// Floating Overlay UI for recording and replay tracking
// Uses Shadow DOM to isolate styles from the host page.

let overlayHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;

function renderOverlayUI(state: { mode: 'recording' | 'playing' | 'success' | 'failed', stepName?: string, step?: number, totalSteps?: number, error?: string }) {
  if (!shadowRoot) return;

  const isRecording = state.mode === 'recording';
  const isPlaying = state.mode === 'playing';
  const isFinished = state.mode === 'success' || state.mode === 'failed';
  
  let statusColor = '#3b82f6';
  let statusText = 'Running';
  
  if (isRecording) {
    statusColor = '#ef4444';
    statusText = 'Recording';
  } else if (state.mode === 'success') {
    statusColor = '#10b981'; // emerald
    statusText = 'Complete';
  } else if (state.mode === 'failed') {
    statusColor = '#ef4444';
    statusText = 'Failed';
  }

  const stepText = state.step !== undefined ? 
    (isRecording ? `Step ${state.step}` : `Step ${state.step}${state.totalSteps ? '/' + state.totalSteps : ''}`) 
    : '';
  
  const actionName = state.error ? state.error : (state.stepName || 'Waiting for action...');

  shadowRoot.innerHTML = `
    <style>
      :host {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647; /* Max z-index */
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      .bp-overlay {
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 9999px; /* Pill shape */
        padding: 8px 16px 8px 12px;
        display: flex;
        align-items: center;
        gap: 12px;
        color: white;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
        font-size: 13px;
        animation: bp-slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes bp-slide-up {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .bp-status-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        font-size: 11px;
        color: ${statusColor};
      }
      .bp-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: ${statusColor};
        box-shadow: 0 0 8px ${statusColor};
        ${isRecording || isPlaying ? 'animation: bp-pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;' : ''}
      }
      @keyframes bp-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .bp-divider {
        ${!stepText ? 'display: none;' : ''}
        width: 1px;
        height: 16px;
        background: rgba(255, 255, 255, 0.2);
      }
      .bp-step-info {
        display: flex;
        flex-direction: column;
        justify-content: center;
        line-height: 1.2;
      }
      .bp-step-count {
        font-weight: 600;
        color: #e2e8f0;
      }
      .bp-step-name {
        font-size: 11px;
        color: #94a3b8;
        max-width: 300px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        ${state.mode === 'failed' ? 'color: #fca5a5;' : ''}
      }
      .bp-stop-btn {
        background: ${isFinished ? 'rgba(255, 255, 255, 0.1)' : 'rgba(239, 68, 68, 0.15)'};
        border: 1px solid ${isFinished ? 'rgba(255, 255, 255, 0.2)' : 'rgba(239, 68, 68, 0.3)'};
        color: ${isFinished ? 'white' : '#fca5a5'};
        border-radius: 9999px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: 4px;
      }
      .bp-stop-btn:hover {
        background: ${isFinished ? 'rgba(255, 255, 255, 0.2)' : 'rgba(239, 68, 68, 0.3)'};
        color: white;
      }
      .bp-stop-icon {
        width: 8px;
        height: 8px;
        background-color: currentColor;
        border-radius: ${isFinished ? '50%' : '1px'};
      }
    </style>
    <div class="bp-overlay" id="bp-overlay-container">
      <div class="bp-status-indicator">
        <div class="bp-dot"></div>
        ${statusText}
      </div>
      ${stepText ? '<div class="bp-divider"></div>' : ''}
      <div class="bp-step-info">
        ${stepText ? `<span class="bp-step-count">${stepText}</span>` : ''}
        <span class="bp-step-name">${actionName}</span>
      </div>
      <button class="bp-stop-btn" id="bp-stop-btn">
        <div class="bp-stop-icon"></div>
        ${isFinished ? 'CLOSE' : 'STOP'}
      </button>
    </div>
  `;

  const stopBtn = shadowRoot.getElementById('bp-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (isFinished) {
        hideOverlay();
      } else {
        chrome.runtime.sendMessage({ type: 'stop_automation', mode: state.mode });
      }
    });
  }
}

export function showOverlay(state: Parameters<typeof renderOverlayUI>[0]) {
  if (!overlayHost) {
    overlayHost = document.createElement('div');
    overlayHost.id = 'browser-pilot-overlay-host';
    // Position fixed so shadow root itself sits right but internal is also fixed
    // Actually best to just attach it directly to body
    // and let the internal CSS host absolute/fixed position
    shadowRoot = overlayHost.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(overlayHost);
  }
  renderOverlayUI(state);
}

export function updateOverlay(state: Parameters<typeof renderOverlayUI>[0]) {
  if (overlayHost && shadowRoot) {
    renderOverlayUI(state);
  } else {
    showOverlay(state);
  }
}

export function hideOverlay() {
  if (overlayHost) {
    overlayHost.remove();
    overlayHost = null;
    shadowRoot = null;
  }
}
