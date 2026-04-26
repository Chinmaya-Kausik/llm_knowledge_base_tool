// === Loom Knowledge Base UI v3 ===
// Canvas stack with drill-in sub-canvases, edge aggregation, border resizing

// Polyfill: crypto.randomUUID not available in non-secure contexts (HTTP on iOS Safari)
if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  crypto.randomUUID = function() {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16));
  };
}

// Debug mode — enable with localStorage.setItem('loom-debug', '1')
const LOOM_DEBUG = localStorage.getItem('loom-debug') === '1';
function debugLog(...args) { if (LOOM_DEBUG) debugLog(...args); }

// --- Keybindings ---
const DEFAULT_KEYBINDINGS = {
  'view-canvas':    { key: '1', mod: true, label: 'Canvas view' },
  'view-files':     { key: '2', mod: true, label: 'Files view' },
  'view-tags':      { key: '3', mod: true, label: 'Tags view' },
  'view-health':    { key: '4', mod: true, label: 'Health view' },
  'toggle-tree-tile': { key: 't', mod: true, label: 'Toggle tree/tile' },
  'toggle-sidebar': { key: 'b', mod: true, label: 'Toggle sidebar' },
  'toggle-chat':    { key: '\\', mod: true, label: 'Toggle chat' },
  'new-chat':       { key: 'n', mod: true, label: 'New chat panel' },
  'fork-chat':      { key: 'N', mod: true, shift: true, label: 'Fork chat' },
  'settings':       { key: ',', mod: true, label: 'Open settings' },
  'fit-view':       { key: '0', mod: true, label: 'Fit view' },
  'auto-layout':    { key: 'l', mod: true, label: 'Auto layout' },
  'toggle-edit':    { key: 'e', mod: true, label: 'Toggle edit mode' },
  'save-edit':      { key: 's', mod: true, label: 'Save edits' },
  'search':         { key: 'f', mod: true, label: 'Search' },
  'toggle-tools':   { key: 'o', mod: true, label: 'Toggle tool details' },
  'cycle-model':    { key: 'p', alt: true, label: 'Cycle model' },
  'nav-back':       { key: '[', mod: true, label: 'Navigate back' },
  'nav-forward':    { key: ']', mod: true, label: 'Drill into folder' },
  'show-shortcuts': { key: 'k', mod: true, label: 'Show shortcuts' },
  'cycle-chat-focus': { key: 'j', mod: true, label: 'Cycle chat focus' },
  'cycle-chat-solo':  { key: '/', mod: true, label: 'Solo cycle chats' },
  'new-terminal':   { key: '`', mod: true, label: 'New terminal' },
  'restart-server': { key: 'H', mod: true, shift: true, label: 'Restart server' },
  'delete-file':    { key: 'Backspace', mod: true, label: 'Delete file' },
  'background-agent': { key: 'B', mod: true, shift: true, label: 'Background agent' },
};

let keyBindings = { ...DEFAULT_KEYBINDINGS };

// Load saved overrides
try {
  const saved = JSON.parse(localStorage.getItem('loom-keybindings') || '{}');
  for (const [action, binding] of Object.entries(saved)) {
    if (keyBindings[action]) keyBindings[action] = { ...keyBindings[action], ...binding };
  }
} catch {}

function matchesBinding(e, action) {
  const b = keyBindings[action];
  if (!b) return false;
  if (b.mod && !(e.ctrlKey || e.metaKey)) return false;
  if (!b.mod && (e.ctrlKey || e.metaKey)) return false;
  if (b.alt && !e.altKey) return false;
  if (!b.alt && e.altKey) return false;
  if (b.shift && !e.shiftKey) return false;
  if (!b.shift && e.shiftKey) return false;
  return e.key === b.key || e.key.toLowerCase() === b.key.toLowerCase();
}

function bindingToString(b) {
  const parts = [];
  if (b.mod) parts.push('Cmd');
  if (b.alt) parts.push('Opt');
  if (b.shift) parts.push('Shift');
  parts.push(b.key === '\\' ? '\\' : b.key === ' ' ? 'Space' : b.key.toUpperCase());
  return parts.join('+');
}

function saveKeyBindings() {
  // Only save non-default bindings
  const overrides = {};
  for (const [action, binding] of Object.entries(keyBindings)) {
    const def = DEFAULT_KEYBINDINGS[action];
    if (def && (binding.key !== def.key || binding.mod !== def.mod || binding.alt !== def.alt || binding.shift !== def.shift)) {
      overrides[action] = { key: binding.key, mod: binding.mod, alt: binding.alt, shift: binding.shift };
    }
  }
  localStorage.setItem('loom-keybindings', JSON.stringify(overrides));
}

// --- API ---
// --- Endpoint Switcher ---
// Tries multiple backends in order: local WiFi -> Tailscale -> VM fallback
let activeBackend = null; // {label, url, token} or null (same-origin)

function getBackends() {
  try { return JSON.parse(localStorage.getItem('loom-backends') || '[]'); } catch { return []; }
}
function setBackends(list) { localStorage.setItem('loom-backends', JSON.stringify(list)); }
function getBaseUrl() { return activeBackend?.url || ''; }
function getWsUrl() {
  if (!activeBackend?.url) return `ws://${location.host}`;
  const url = new URL(activeBackend.url);
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
}
function getTokenParam() {
  const token = activeBackend?.token || '';
  return token ? `token=${encodeURIComponent(token)}` : '';
}

function authFetch(url, opts = {}) {
  const token = activeBackend?.token;
  if (token) {
    opts.headers = { ...opts.headers, 'Authorization': `Bearer ${token}` };
  }
  return fetch(url, opts);
}

async function probeBackend(backend, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const start = performance.now();
    const r = await fetch(`${backend.url}/api/ping`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch {}
  return { ok: false, latencyMs: -1 };
}

async function selectBackend() {
  const backends = getBackends();
  if (backends.length === 0) { activeBackend = null; return true; } // Same-origin, no switching needed

  // Try last-working backend first (fast path)
  const lastLabel = localStorage.getItem('loom-active-backend');
  if (lastLabel) {
    const last = backends.find(b => b.label === lastLabel);
    if (last) {
      const probe = await probeBackend(last, 1500);
      if (probe.ok) { activeBackend = last; return true; }
    }
  }

  // Try all in order
  for (const backend of backends) {
    const probe = await probeBackend(backend, 2000);
    if (probe.ok) {
      activeBackend = backend;
      localStorage.setItem('loom-active-backend', backend.label);
      debugLog(`[backend] Connected to ${backend.label} (${probe.latencyMs}ms)`);
      return true;
    }
  }

  // None responded
  activeBackend = null;
  return false;
}

function showOfflineOverlay() {
  let overlay = document.getElementById('offline-overlay');
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'offline-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;';
  overlay.innerHTML = `
    <h1 style="color:var(--text);font-family:var(--font)">Loom</h1>
    <p style="color:var(--text-muted);font-family:var(--font)">Cannot reach any backend. Turn on your laptop or check your connection.</p>
    <button onclick="retryBackendConnection()" style="background:var(--accent);color:#fff;border:none;padding:8px 24px;border-radius:6px;cursor:pointer;font-family:var(--font)">Retry</button>
  `;
  document.body.appendChild(overlay);
}

function hideOfflineOverlay() {
  document.getElementById('offline-overlay')?.remove();
}

async function retryBackendConnection() {
  const ok = await selectBackend();
  if (ok) { hideOfflineOverlay(); location.reload(); }
}

const api = {
  graph:       () => { const url = `${getBaseUrl()}/api/graph?show_internals=${localStorage.getItem('loom-show-internals') === 'true'}&include_hidden=${localStorage.getItem('loom-show-hidden') === 'true'}&include_dotfiles=${localStorage.getItem('loom-show-dotfiles') === 'true'}`; debugLog('[API] graph:', url); return authFetch(url).then(r => r.json()); },
  page:        (p) => authFetch(`${getBaseUrl()}/api/page/${p}`).then(r => r.json()),
  tree:        () => { const url = `${getBaseUrl()}/api/tree?show_internals=${localStorage.getItem('loom-show-internals') === 'true'}&include_hidden=${localStorage.getItem('loom-show-hidden') === 'true'}&include_dotfiles=${localStorage.getItem('loom-show-dotfiles') === 'true'}`; debugLog('[API] tree:', url); return authFetch(url).then(r => r.json()); },
  search:      (q, s='all', mode='both') => authFetch(`${getBaseUrl()}/api/search?q=${encodeURIComponent(q)}&scope=${s}&mode=${mode}`).then(r => r.json()),
  health:      () => authFetch(`${getBaseUrl()}/api/health`).then(r => r.json()),
  brokenLinks: () => authFetch(`${getBaseUrl()}/api/broken-links`).then(r => r.json()),
  orphans:     () => authFetch(`${getBaseUrl()}/api/orphans`).then(r => r.json()),
  stale:       () => authFetch(`${getBaseUrl()}/api/stale`).then(r => r.json()),
  getLayout:   () => authFetch(`${getBaseUrl()}/api/layout`).then(r => r.json()).catch(() => ({})),
  saveLayout:  (d) => authFetch(`${getBaseUrl()}/api/layout`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}),
  savePage:    (p, fm, c) => authFetch(`${getBaseUrl()}/api/page/${p}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({frontmatter:fm, content:c})}),
  // Unified APIs — route to local or VM based on current target
  fetchGraph: () => {
    const filters = `show_internals=${localStorage.getItem('loom-show-internals') === 'true'}&include_hidden=${localStorage.getItem('loom-show-hidden') === 'true'}&include_dotfiles=${localStorage.getItem('loom-show-dotfiles') === 'true'}`;
    const url = isVMTarget()
      ? `${getBaseUrl()}/api/vms/${currentTarget.id}/graph?${filters}`
      : `${getBaseUrl()}/api/graph?${filters}`;
    debugLog('[API] fetchGraph:', url);
    return authFetch(url).then(r => r.json());
  },
  fetchTree: () => {
    const filters = `show_internals=${localStorage.getItem('loom-show-internals') === 'true'}&include_hidden=${localStorage.getItem('loom-show-hidden') === 'true'}&include_dotfiles=${localStorage.getItem('loom-show-dotfiles') === 'true'}`;
    const url = isVMTarget()
      ? `${getBaseUrl()}/api/vms/${currentTarget.id}/tree?${filters}`
      : `${getBaseUrl()}/api/tree?${filters}`;
    debugLog('[API] fetchTree:', url);
    return authFetch(url).then(r => r.json());
  },
  fetchSearch: (q, scope='all', mode='both') => {
    const url = isVMTarget()
      ? `${getBaseUrl()}/api/vms/${currentTarget.id}/search?q=${encodeURIComponent(q)}&scope=${scope}&mode=${mode}`
      : `${getBaseUrl()}/api/search?q=${encodeURIComponent(q)}&scope=${scope}&mode=${mode}`;
    return authFetch(url).then(r => r.json());
  },
  // VM-specific APIs
  vms:         () => authFetch(`${getBaseUrl()}/api/vms`).then(r => r.json()),
  vmAdd:       (d) => authFetch(`${getBaseUrl()}/api/vms`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json()),
  vmUpdate:    (id,d) => authFetch(`${getBaseUrl()}/api/vms/${id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json()),
  vmDelete:    (id) => authFetch(`${getBaseUrl()}/api/vms/${id}`, {method:'DELETE'}).then(r=>r.json()),
  vmFile:      (id,p) => authFetch(`${getBaseUrl()}/api/vms/${id}/file?path=${encodeURIComponent(p)}`).then(r=>r.json()),
  vmPush:      (id,d={}) => authFetch(`${getBaseUrl()}/api/vms/${id}/push`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json()),
  vmPull:      (id,d={}) => authFetch(`${getBaseUrl()}/api/vms/${id}/pull`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json()),
  vmSyncStatus:(id) => authFetch(`${getBaseUrl()}/api/vms/${id}/sync-status`).then(r=>r.json()),
  vmMetrics:   (id) => authFetch(`${getBaseUrl()}/api/vms/${id}/metrics`).then(r=>r.json()),
  vmJobs:      (id) => authFetch(`${getBaseUrl()}/api/vms/${id}/jobs`).then(r=>r.json()),
  vmStartJob:  (id,d) => authFetch(`${getBaseUrl()}/api/vms/${id}/jobs`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json()),
  vmStopJob:   (id,jid) => authFetch(`${getBaseUrl()}/api/vms/${id}/jobs/${jid}`, {method:'DELETE'}).then(r=>r.json()),
  vmJobOutput: (id,jid) => authFetch(`${getBaseUrl()}/api/vms/${id}/jobs/${jid}/output`).then(r=>r.json()),
  vmTunnels:   (id) => authFetch(`${getBaseUrl()}/api/vms/${id}/tunnels`).then(r=>r.json()),
  vmAddTunnel: (id,d) => authFetch(`${getBaseUrl()}/api/vms/${id}/tunnels`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json()),
  vmCloseTunnel:(id,p) => authFetch(`${getBaseUrl()}/api/vms/${id}/tunnels/${p}`, {method:'DELETE'}).then(r=>r.json()),
};

// --- VM / Target Switching ---
let currentTarget = { type: 'local' }; // {type:'local'} or {type:'vm', id:'...', label:'...', host:'...'}
let vmMetricsWs = null; // WebSocket for streaming metrics

function isVMTarget() { return currentTarget.type === 'vm'; }

async function initTargetSelector() {
  const btn = document.getElementById('target-btn');
  const dropdown = document.getElementById('target-dropdown');
  if (!btn || !dropdown) return;
  // Move to body to escape toolbar stacking context
  document.body.appendChild(dropdown);

  btn.onclick = async (e) => {
    e.stopPropagation();
    const wasHidden = dropdown.classList.contains('hidden');
    closeAllDropdowns();
    if (wasHidden) {
      dropdown.classList.remove('hidden');
      await populateTargetDropdown();
    }
  };
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

async function populateTargetDropdown() {
  const dropdown = document.getElementById('target-dropdown');
  let vms = [];
  try { vms = await api.vms(); } catch { /* no VMs configured */ }

  let html = `<div class="target-item ${currentTarget.type==='local'?'active':''}" data-type="local">
    <span class="target-dot" style="color:#4caf50">&#9679;</span> Local
  </div>`;

  if (vms.length > 0) {
    html += '<div class="target-separator"></div>';
    for (const vm of vms) {
      const active = currentTarget.type === 'vm' && currentTarget.id === vm.id;
      const color = vm.status === 'connected' ? '#4caf50' : vm.status === 'connecting' ? '#ff9800' : '#666';
      html += `<div class="target-item ${active?'active':''}" data-type="vm" data-vm-id="${vm.id}" data-vm-label="${vm.label}" data-vm-host="${vm.user||''}@${vm.host}">
        <span class="target-dot" style="color:${color}">&#9679;</span> ${vm.label}
        <span class="target-host">${vm.user||''}@${vm.host}</span>
      </div>`;
    }
  }

  html += '<div class="target-separator"></div>';
  html += '<div class="target-item target-action" data-action="add-vm">+ Add VM...</div>';
  html += '<div class="target-item target-action" data-action="manage-vms">Manage VMs...</div>';

  // VM-specific actions when a VM is selected
  if (currentTarget.type === 'vm') {
    html += '<div class="target-separator"></div>';
    html += `<div class="target-item target-action" data-action="vm-terminal">&#9002; Terminal</div>`;
    html += `<div class="target-item target-action" data-action="vm-sync">&#8645; Sync</div>`;
    html += `<div class="target-item target-action" data-action="vm-metrics">&#9670; Metrics</div>`;
    html += `<div class="target-item target-action" data-action="vm-jobs">&#9881; Jobs</div>`;
    html += `<div class="target-item target-action" data-action="vm-ports">&#8644; Ports</div>`;
  }

  dropdown.innerHTML = html;

  // Wire click handlers
  dropdown.querySelectorAll('.target-item').forEach(item => {
    item.onclick = async () => {
      const type = item.dataset.type;
      const action = item.dataset.action;
      if (type === 'local') {
        await switchTarget({ type: 'local' });
      } else if (type === 'vm') {
        await switchTarget({ type: 'vm', id: item.dataset.vmId, label: item.dataset.vmLabel, host: item.dataset.vmHost });
      } else if (action === 'add-vm') {
        showAddVMModal();
      } else if (action === 'manage-vms') {
        showManageVMsModal();
      } else if (action === 'vm-terminal') {
        createVMTerminalPanel(currentTarget.id, currentTarget.label);
      } else if (action === 'vm-sync') {
        showVMSyncPanel(currentTarget.id);
      } else if (action === 'vm-metrics') {
        showVMMetricsPanel(currentTarget.id);
      } else if (action === 'vm-jobs') {
        showVMJobsPanel(currentTarget.id);
      } else if (action === 'vm-ports') {
        showVMPortsPanel(currentTarget.id);
      }
      dropdown.classList.add('hidden');
    };
  });
}

async function switchTarget(target) {
  // Close any open VM metrics WebSocket
  if (vmMetricsWs) { vmMetricsWs.close(); vmMetricsWs = null; }

  currentTarget = target;
  const btn = document.getElementById('target-btn');
  if (target.type === 'local') {
    btn.innerHTML = 'Local <span class="target-caret">&#9662;</span>';
    btn.classList.remove('target-vm');
  } else {
    btn.innerHTML = `${target.label} <span class="target-caret">&#9662;</span>`;
    btn.classList.add('target-vm');
  }

  // Update chat context for VM targeting
  if (target.type === 'vm') {
    // Set page_path to vm:<id> so Claude gets VM context
    activePanel.pagePath = `vm:${target.id}`;
  } else {
    activePanel.pagePath = lastFocusedPath || null;
  }

  // Refresh the active view
  const activeView = document.querySelector('.view-tab.active')?.dataset?.view || 'graph';
  await refreshCurrentView(activeView);
}

async function refreshCurrentView(viewName) {
  if (viewName === 'graph') {
    await initGraphView();
  } else if (viewName === 'files') {
    filesInitialized = false;
    await initFilesView();
  } else if (viewName === 'search') {
    const q = document.getElementById('search-input')?.value;
    if (q) doSearch(q);
  } else if (viewName === 'tags') {
    if (!isVMTarget()) initTagCloud();
  } else if (viewName === 'health') {
    if (!isVMTarget()) initHealth();
  }
}

// VM-specific init functions removed — merged into initGraphView() and initFilesView()

// --- VM Terminal Panel ---
function createVMTerminalPanel(vmId, vmLabel) {
  const card = document.createElement('div');
  card.className = 'floating-chat-panel floating-terminal';
  card.style.cssText = 'width:600px;height:400px;right:40px;bottom:80px;position:fixed;';

  const header = document.createElement('div');
  header.className = 'fcp-header';
  header.style.borderTop = `3px solid ${currentTarget.color || '#4fc3f7'}`;
  header.innerHTML = `
    <span class="fcp-label" contenteditable="true" spellcheck="false">${vmLabel} (SSH)</span>
    <span style="flex:1"></span>
    <button class="fcp-btn fcp-minimize" title="Minimize">&#9472;</button>
    <button class="fcp-btn fcp-close" title="Close">&#10005;</button>
  `;

  const termContainer = document.createElement('div');
  termContainer.className = 'terminal-container';
  termContainer.style.cssText = 'flex:1;overflow:hidden;';

  // Resize handles
  const handles = ['right','bottom','left','top','corner'].map(dir => {
    const h = document.createElement('div');
    h.className = `fcp-resize fcp-resize-${dir}`;
    h.dataset.dir = dir;
    return h;
  });

  card.appendChild(header);
  handles.forEach(h => card.appendChild(h));
  card.appendChild(termContainer);
  document.body.appendChild(card);
  bringToFront(card);

  // xterm.js
  const XTerm = window.Terminal;
  const XFitAddon = window.FitAddon?.FitAddon;
  const term = new XTerm({
    cursorBlink: true, fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: getTerminalTheme(),
  });
  const fitAddon = new XFitAddon();
  term.loadAddon(fitAddon);
  term.open(termContainer);
  _activeTerminals.add(term);
  requestAnimationFrame(() => fitAddon.fit());

  // WebSocket to VM terminal
  const ws = new WebSocket(`${getWsUrl()}/ws/vm-terminal/${vmId}?${getTokenParam()}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { ws.send(`RESIZE:${term.cols}:${term.rows}`); };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
    else term.write(e.data);
  };
  ws.onerror = () => term.write('\r\n\x1b[31mSSH connection error\x1b[0m\r\n');
  ws.onclose = () => term.write('\r\n\x1b[33mSSH session closed\x1b[0m\r\n');
  term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  term.onResize(({cols, rows}) => { if (ws.readyState === WebSocket.OPEN) ws.send(`RESIZE:${cols}:${rows}`); });

  // Resize observer
  const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
  ro.observe(termContainer);

  // Minimize / Close
  header.querySelector('.fcp-minimize').onclick = (e) => {
    e.stopPropagation();
    card.classList.toggle('minimized');
    if (!card.classList.contains('minimized')) requestAnimationFrame(() => fitAddon.fit());
  };
  header.querySelector('.fcp-close').onclick = (e) => { e.stopPropagation(); ws.close(); ro.disconnect(); _activeTerminals.delete(term); card.remove(); };

  // Drag with drag guard for header click
  let dx, dy, vmStartX, vmStartY, vmDragged = false;
  header.onpointerdown = (e) => {
    if (e.target.closest('button') || e.target.isContentEditable) return;
    vmDragged = false;
    vmStartX = e.clientX; vmStartY = e.clientY;
    const r = card.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    card.style.position = 'fixed';
    const move = (ev) => {
      if (!vmDragged && Math.abs(ev.clientX - vmStartX) + Math.abs(ev.clientY - vmStartY) < 5) return;
      vmDragged = true;
      card.style.left = (ev.clientX - dx) + 'px'; card.style.top = (ev.clientY - dy) + 'px'; card.style.right = 'auto'; card.style.bottom = 'auto';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setTimeout(() => { vmDragged = false; }, 0);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  // Header click toggles minimize (if not dragged)
  header.addEventListener('click', (e) => {
    if (vmDragged) return;
    if (e.target.closest('button') || e.target.isContentEditable) return;
    card.classList.toggle('minimized');
    if (!card.classList.contains('minimized')) requestAnimationFrame(() => fitAddon.fit());
  });

  // Resize handles
  handles.forEach(h => {
    h.onpointerdown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const dir = h.dataset.dir;
      const startX = e.clientX, startY = e.clientY;
      const startW = card.offsetWidth, startH = card.offsetHeight;
      const startL = card.offsetLeft, startT = card.offsetTop;
      const move = (ev) => {
        const dxR = ev.clientX - startX, dyR = ev.clientY - startY;
        if (dir === 'right' || dir === 'corner') card.style.width = Math.max(300, startW + dxR) + 'px';
        if (dir === 'bottom' || dir === 'corner') card.style.height = Math.max(200, startH + dyR) + 'px';
        if (dir === 'left') { card.style.width = Math.max(300, startW - dxR) + 'px'; card.style.left = (startL + dxR) + 'px'; }
        if (dir === 'top') { card.style.height = Math.max(200, startH - dyR) + 'px'; card.style.top = (startT + dyR) + 'px'; }
        try { fitAddon.fit(); } catch {}
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
  });
}

// --- Card Context Menu (right-click) ---
let cardContextMenu = null;

function showCardContextMenu(e, path, isFolder) {
  e.preventDefault();
  e.stopPropagation();
  if (cardContextMenu) cardContextMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'card-context-menu';
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99999;`;

  const items = [
    { label: 'Open', action: () => { const nd = nodeById(path); if (nd) { const fakeCard = document.createElement('div'); fakeCard.dataset.path = path; fakeCard.dataset.isFolder = String(isFolder); expandCardFullPage(fakeCard); } }},
    { label: 'Open in New Tab', action: () => window.open(`/media/${path}`, '_blank') },
    { sep: true },
    { label: 'Copy Path', action: () => navigator.clipboard.writeText(path) },
    { label: 'Copy Name', action: () => navigator.clipboard.writeText(path.split('/').pop()) },
    { sep: true },
    { label: 'Pin to Board', action: () => pinCard(path) },
    { sep: true },
    { label: 'Ask Claude about this', action: () => {
      createFloatingPanel({ prefill: `Tell me about \`${path}\`` });
    }},
    { sep: true },
    { label: 'Rename...', action: () => {
      const newName = prompt('New name:', path.split('/').pop());
      if (newName && newName !== path.split('/').pop()) {
        const newPath = path.split('/').slice(0, -1).concat(newName).join('/');
        // TODO: implement rename API
        debugLog('Rename:', path, '→', newPath);
      }
    }},
    { label: 'Delete', action: () => {
      if (confirm(`Delete ${path}?`)) {
        authFetch(`${getBaseUrl()}/api/delete`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ path }),
        }).then(() => { initGraphView(); initSidebar(); });
      }
    }, danger: true },
  ];

  menu.innerHTML = items.map(item => {
    if (item.sep) return '<div class="ccm-sep"></div>';
    return `<div class="ccm-item${item.danger ? ' ccm-danger' : ''}">${item.label}</div>`;
  }).join('');

  // Wire click handlers
  let itemIdx = 0;
  menu.querySelectorAll('.ccm-item').forEach(el => {
    while (items[itemIdx]?.sep) itemIdx++;
    const action = items[itemIdx]?.action;
    el.onclick = () => { menu.remove(); cardContextMenu = null; if (action) action(); };
    itemIdx++;
  });

  document.body.appendChild(menu);
  cardContextMenu = menu;

  // Close on click outside
  const closeMenu = () => { menu.remove(); cardContextMenu = null; document.removeEventListener('click', closeMenu); };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// Pinboard stub (will be expanded in pinboard feature)
let pinnedCards = JSON.parse(localStorage.getItem('loom-pinned') || '[]');
function pinCard(path) {
  if (!pinnedCards.includes(path)) {
    pinnedCards.push(path);
    if (pinnedCards.length > 6) pinnedCards.shift();
    localStorage.setItem('loom-pinned', JSON.stringify(pinnedCards));
    renderPinboard();
  }
}
function unpinCard(path) {
  pinnedCards = pinnedCards.filter(p => p !== path);
  localStorage.setItem('loom-pinned', JSON.stringify(pinnedCards));
  renderPinboard();
}
function renderPinboard() {
  let board = document.getElementById('pinboard');
  if (!board) {
    board = document.createElement('div');
    board.id = 'pinboard';
    const canvasContainer = document.getElementById('canvas-container');
    if (canvasContainer) canvasContainer.appendChild(board);
  }

  if (pinnedCards.length === 0) {
    board.innerHTML = '';
    return;
  }

  const currentPath = currentLevel().parentPath || '';
  let html = `<div class="pin-label"><span>PINNED</span><span>${pinnedCards.length}/6</span></div>`;

  for (const path of pinnedCards) {
    const name = path.split('/').pop();
    const parentDir = path.split('/').slice(0, -1).join('/');
    const isAway = parentDir !== currentPath && currentPath !== '';
    html += `<div class="pin-card" data-pin-path="${path}" onclick="navigateToPinnedCard('${path}')">
      <div class="pin-title">${name}</div>
      ${isAway ? `<div class="pin-path">${parentDir}</div>` : ''}
      <button class="pin-x" onclick="event.stopPropagation(); unpinCard('${path}')">&times;</button>
    </div>`;
  }

  board.innerHTML = html;
}

function navigateToPinnedCard(path) {
  // Navigate to the folder containing this card, then focus it
  const parts = path.split('/');
  if (parts.length > 1) {
    const folderPath = parts.slice(0, -1).join('/');
    if (currentLevel().parentPath !== folderPath) {
      const nd = nodeById(folderPath);
      if (nd) drillInto(folderPath);
    }
  }
  // Focus the card
  const card = cardElements.get(path);
  if (card) {
    setFocusedItem(path, card);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// --- VM Add Modal ---
function showAddVMModal() {
  const existing = document.getElementById('vm-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'vm-modal';
  modal.className = 'vm-modal-overlay';
  modal.innerHTML = `
    <div class="vm-modal">
      <div class="vm-modal-header">Add VM <button class="vm-modal-close" onclick="this.closest('.vm-modal-overlay').remove()">&#10005;</button></div>
      <div class="vm-modal-body">
        <label>Label <input type="text" id="vm-add-label" placeholder="my-gpu-box"></label>
        <label>Host <input type="text" id="vm-add-host" placeholder="10.0.1.5 or hostname"></label>
        <label>User <input type="text" id="vm-add-user" placeholder="root"></label>
        <label>Port <input type="number" id="vm-add-port" value="22"></label>
        <label>SSH Key Path <input type="text" id="vm-add-key" placeholder="~/.ssh/id_ed25519"></label>
        <label>Remote Working Dir <input type="text" id="vm-add-syncdir" placeholder="~"></label>
        <div class="vm-modal-actions">
          <button id="vm-add-test" class="vm-btn">Test Connection</button>
          <button id="vm-add-save" class="vm-btn vm-btn-primary">Add VM</button>
        </div>
        <div id="vm-add-status"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  function getVMFormValues() {
    const val = (id) => { const el = document.getElementById(id); return el.value.trim() || el.placeholder; };
    return {
      label: document.getElementById('vm-add-label').value.trim() || val('vm-add-host'),
      host: val('vm-add-host'),
      user: val('vm-add-user'),
      port: parseInt(document.getElementById('vm-add-port').value) || 22,
      key_path: val('vm-add-key'),
      sync_dir: val('vm-add-syncdir'),
    };
  }

  document.getElementById('vm-add-test').onclick = async () => {
    const status = document.getElementById('vm-add-status');
    status.textContent = 'Testing connection...';
    status.className = '';
    try {
      const result = await api.vmAdd({ ...getVMFormValues(), dry_run: true });
      if (result.ok) {
        status.textContent = 'Connection successful!';
        status.className = 'vm-status-ok';
      } else {
        status.textContent = result.error || 'Connection failed';
        status.className = 'vm-status-error';
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.className = 'vm-status-error';
    }
  };

  document.getElementById('vm-add-save').onclick = async () => {
    const status = document.getElementById('vm-add-status');
    status.textContent = 'Adding VM...';
    try {
      const result = await api.vmAdd(getVMFormValues());
      if (result.ok) {
        status.textContent = 'VM added!';
        status.className = 'vm-status-ok';
        setTimeout(() => modal.remove(), 1000);
      } else {
        status.textContent = result.error || 'Failed to add VM';
        status.className = 'vm-status-error';
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.className = 'vm-status-error';
    }
  };
}

// --- VM Manage Modal ---
async function showManageVMsModal() {
  const existing = document.getElementById('vm-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'vm-modal';
  modal.className = 'vm-modal-overlay';
  let vms = [];
  try { vms = await api.vms(); } catch {}

  let rows = vms.map(vm => {
    const statusColor = vm.status === 'connected' ? '#4caf50' : vm.status === 'connecting' ? '#ff9800' : '#666';
    return `<div class="vm-manage-row" data-id="${vm.id}">
      <span class="target-dot" style="color:${statusColor}">&#9679;</span>
      <span class="vm-manage-label">${vm.label}</span>
      <span class="vm-manage-host">${vm.user||''}@${vm.host}:${vm.port||22}</span>
      <button class="vm-btn vm-btn-sm" onclick="deleteVM('${vm.id}', this)">Delete</button>
    </div>`;
  }).join('');
  if (!rows) rows = '<div class="vm-manage-empty">No VMs configured</div>';

  modal.innerHTML = `
    <div class="vm-modal">
      <div class="vm-modal-header">Manage VMs <button class="vm-modal-close" onclick="this.closest('.vm-modal-overlay').remove()">&#10005;</button></div>
      <div class="vm-modal-body">${rows}</div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function deleteVM(vmId, btn) {
  if (!confirm('Delete this VM?')) return;
  await api.vmDelete(vmId);
  if (currentTarget.type === 'vm' && currentTarget.id === vmId) {
    await switchTarget({ type: 'local' });
  }
  btn.closest('.vm-manage-row').remove();
}

// --- VM Sync Panel (floating) ---
function showVMSyncPanel(vmId) {
  const existing = document.querySelector('.vm-panel-sync');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'floating-chat-panel vm-panel-sync';
  panel.style.cssText = 'width:380px;height:300px;right:40px;bottom:80px;position:fixed;';
  panel.innerHTML = `
    <div class="fcp-header">
      <span class="fcp-label">Sync &mdash; ${currentTarget.label}</span>
      <span style="flex:1"></span>
      <button class="fcp-btn fcp-close" onclick="this.closest('.vm-panel-sync').remove()">&#10005;</button>
    </div>
    <div class="vm-panel-body" id="vm-sync-body">
      <div class="vm-panel-loading">Checking sync status...</div>
    </div>
    <div class="vm-panel-actions">
      <button class="vm-btn" onclick="vmDoPush('${vmId}')">Push to VM</button>
      <button class="vm-btn" onclick="vmDoPull('${vmId}')">Pull from VM</button>
    </div>
  `;
  document.body.appendChild(panel);
  bringToFront(panel);
  refreshSyncStatus(vmId);
}

async function refreshSyncStatus(vmId) {
  const body = document.getElementById('vm-sync-body');
  if (!body) return;
  try {
    const status = await api.vmSyncStatus(vmId);
    body.innerHTML = `
      <div class="vm-sync-section"><strong>&#8593; Push pending:</strong> ${status.push_count} files<br>
        <div class="vm-sync-files">${(status.push_pending||[]).slice(0,10).map(f=>`<div>${f}</div>`).join('')}${status.push_count>10?`<div>...and ${status.push_count-10} more</div>`:''}</div>
      </div>
      <div class="vm-sync-section"><strong>&#8595; Pull pending:</strong> ${status.pull_count} files<br>
        <div class="vm-sync-files">${(status.pull_pending||[]).slice(0,10).map(f=>`<div>${f}</div>`).join('')}${status.pull_count>10?`<div>...and ${status.pull_count-10} more</div>`:''}</div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="vm-status-error">Error: ${err.message}</div>`;
  }
}

async function vmDoPush(vmId) {
  const body = document.getElementById('vm-sync-body');
  if (body) body.innerHTML = '<div class="vm-panel-loading">Pushing...</div>';
  const result = await api.vmPush(vmId);
  if (body) body.innerHTML = result.ok
    ? `<div class="vm-status-ok">Pushed ${result.files} files in ${result.elapsed_ms}ms</div>`
    : `<div class="vm-status-error">${result.error}</div>`;
}

async function vmDoPull(vmId) {
  const body = document.getElementById('vm-sync-body');
  if (body) body.innerHTML = '<div class="vm-panel-loading">Pulling...</div>';
  const result = await api.vmPull(vmId);
  if (body) body.innerHTML = result.ok
    ? `<div class="vm-status-ok">Pulled ${result.files} files in ${result.elapsed_ms}ms</div>`
    : `<div class="vm-status-error">${result.error}</div>`;
}

// --- VM Metrics Panel (floating, live WebSocket) ---
function showVMMetricsPanel(vmId) {
  const existing = document.querySelector('.vm-panel-metrics');
  if (existing) { existing.remove(); if (vmMetricsWs) { vmMetricsWs.close(); vmMetricsWs = null; } return; }

  const panel = document.createElement('div');
  panel.className = 'floating-chat-panel vm-panel-metrics';
  panel.style.cssText = 'width:340px;height:280px;right:40px;bottom:80px;position:fixed;';
  panel.innerHTML = `
    <div class="fcp-header">
      <span class="fcp-label">Metrics &mdash; ${currentTarget.label}</span>
      <span style="flex:1"></span>
      <button class="fcp-btn fcp-close" id="vm-metrics-close">&#10005;</button>
    </div>
    <div class="vm-panel-body" id="vm-metrics-body">
      <div class="vm-panel-loading">Connecting...</div>
    </div>
  `;
  document.body.appendChild(panel);
  bringToFront(panel);

  document.getElementById('vm-metrics-close').onclick = () => {
    if (vmMetricsWs) { vmMetricsWs.close(); vmMetricsWs = null; }
    panel.remove();
  };

  // History for sparklines
  const history = { cpu: [], ram: [], gpu: [] };
  const MAX_HISTORY = 60;

  vmMetricsWs = new WebSocket(`${getWsUrl()}/ws/vm-metrics/${vmId}?${getTokenParam()}`);
  vmMetricsWs.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const body = document.getElementById('vm-metrics-body');
    if (!body) return;
    if (m.error) { body.innerHTML = `<div class="vm-status-error">${m.error}</div>`; return; }

    history.cpu.push(m.cpu_pct); if (history.cpu.length > MAX_HISTORY) history.cpu.shift();
    const ramPct = m.ram_total_mb ? (m.ram_used_mb / m.ram_total_mb * 100) : 0;
    history.ram.push(ramPct); if (history.ram.length > MAX_HISTORY) history.ram.shift();

    let gpuHtml = '';
    if (m.gpu_pct !== null && m.gpu_pct !== undefined) {
      history.gpu.push(m.gpu_pct); if (history.gpu.length > MAX_HISTORY) history.gpu.shift();
      gpuHtml = `
        <div class="vm-metric-row">
          <span class="vm-metric-label">GPU</span>
          <div class="vm-metric-bar"><div class="vm-metric-fill" style="width:${m.gpu_pct}%;background:${barColor(m.gpu_pct)}"></div></div>
          <span class="vm-metric-val">${m.gpu_pct.toFixed(0)}%</span>
        </div>
        <div class="vm-metric-row">
          <span class="vm-metric-label">VRAM</span>
          <div class="vm-metric-bar"><div class="vm-metric-fill" style="width:${m.vram_total_mb?(m.vram_used_mb/m.vram_total_mb*100):0}%;background:#7aa2f7"></div></div>
          <span class="vm-metric-val">${m.vram_used_mb||0}/${m.vram_total_mb||0}MB</span>
        </div>
      `;
    }

    body.innerHTML = `
      <div class="vm-metric-row">
        <span class="vm-metric-label">CPU</span>
        <div class="vm-metric-bar"><div class="vm-metric-fill" style="width:${m.cpu_pct}%;background:${barColor(m.cpu_pct)}"></div></div>
        <span class="vm-metric-val">${m.cpu_pct.toFixed(1)}%</span>
      </div>
      <div class="vm-metric-row">
        <span class="vm-metric-label">RAM</span>
        <div class="vm-metric-bar"><div class="vm-metric-fill" style="width:${ramPct}%;background:${barColor(ramPct)}"></div></div>
        <span class="vm-metric-val">${m.ram_used_mb}/${m.ram_total_mb}MB</span>
      </div>
      <div class="vm-metric-row">
        <span class="vm-metric-label">Disk</span>
        <div class="vm-metric-bar"><div class="vm-metric-fill" style="width:${m.disk_total_gb?(m.disk_used_gb/m.disk_total_gb*100):0}%;background:#7aa2f7"></div></div>
        <span class="vm-metric-val">${m.disk_used_gb.toFixed(1)}/${m.disk_total_gb.toFixed(1)}GB</span>
      </div>
      ${gpuHtml}
      <div class="vm-sparkline-row">
        <canvas id="vm-spark-cpu" width="140" height="30" title="CPU history"></canvas>
        <canvas id="vm-spark-ram" width="140" height="30" title="RAM history"></canvas>
      </div>
    `;

    drawSparkline('vm-spark-cpu', history.cpu, '#9ece6a');
    drawSparkline('vm-spark-ram', history.ram, '#7aa2f7');
  };
  vmMetricsWs.onerror = () => {
    const body = document.getElementById('vm-metrics-body');
    if (body) body.innerHTML = '<div class="vm-status-error">WebSocket error</div>';
  };
}

function barColor(pct) {
  if (pct < 50) return '#4caf50';
  if (pct < 80) return '#ff9800';
  return '#f44336';
}

function drawSparkline(canvasId, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = w / Math.max(data.length - 1, 1);
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const y = h - (data[i] / 100) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// --- VM Jobs Panel (floating) ---
function showVMJobsPanel(vmId) {
  const existing = document.querySelector('.vm-panel-jobs');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'floating-chat-panel vm-panel-jobs';
  panel.style.cssText = 'width:420px;height:350px;right:40px;bottom:80px;position:fixed;';
  panel.innerHTML = `
    <div class="fcp-header">
      <span class="fcp-label">Jobs &mdash; ${currentTarget.label}</span>
      <span style="flex:1"></span>
      <button class="fcp-btn fcp-close" onclick="this.closest('.vm-panel-jobs').remove()">&#10005;</button>
    </div>
    <div class="vm-panel-body" id="vm-jobs-body">
      <div class="vm-panel-loading">Loading jobs...</div>
    </div>
    <div class="vm-panel-actions">
      <input type="text" id="vm-job-name" placeholder="Job name" class="vm-input" style="width:100px">
      <input type="text" id="vm-job-cmd" placeholder="Command" class="vm-input" style="flex:1">
      <button class="vm-btn vm-btn-primary" onclick="vmStartJob('${vmId}')">Start</button>
    </div>
  `;
  document.body.appendChild(panel);
  bringToFront(panel);
  refreshVMJobs(vmId);
}

async function refreshVMJobs(vmId) {
  const body = document.getElementById('vm-jobs-body');
  if (!body) return;
  try {
    const jobs = await api.vmJobs(vmId);
    if (!jobs.length) { body.innerHTML = '<div class="vm-manage-empty">No tracked jobs</div>'; return; }
    body.innerHTML = jobs.map(j => {
      const elapsed = j.status === 'running' ? formatElapsed(Date.now()/1000 - j.started) : (j.stopped ? formatElapsed(j.stopped - j.started) : '');
      const statusIcon = j.status === 'running' ? '&#10227;' : j.status === 'completed' ? '&#10003;' : j.status === 'failed' ? '&#10007;' : '&#9632;';
      return `<div class="vm-job-row">
        <span class="vm-job-status">${statusIcon}</span>
        <span class="vm-job-name">${j.name}</span>
        <span class="vm-job-cmd" title="${j.command}">${j.command.substring(0,40)}</span>
        <span class="vm-job-elapsed">${elapsed}</span>
        ${j.status==='running'?`<button class="vm-btn vm-btn-sm" onclick="vmKillJob('${vmId}','${j.id}')">Kill</button>`:''}
        <button class="vm-btn vm-btn-sm" onclick="vmShowOutput('${vmId}','${j.id}')">Logs</button>
      </div>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<div class="vm-status-error">Error: ${err.message}</div>`;
  }
}

function formatElapsed(secs) {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.round(secs%60)}s`;
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
}

async function vmStartJob(vmId) {
  const name = document.getElementById('vm-job-name')?.value || 'job';
  const cmd = document.getElementById('vm-job-cmd')?.value;
  if (!cmd) return;
  await api.vmStartJob(vmId, { name, command: cmd });
  document.getElementById('vm-job-name').value = '';
  document.getElementById('vm-job-cmd').value = '';
  refreshVMJobs(vmId);
}

async function vmKillJob(vmId, jobId) {
  await api.vmStopJob(vmId, jobId);
  refreshVMJobs(vmId);
}

async function vmShowOutput(vmId, jobId) {
  const result = await api.vmJobOutput(vmId, jobId);
  const existing = document.querySelector('.vm-panel-output');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.className = 'floating-chat-panel vm-panel-output';
  panel.style.cssText = 'width:500px;height:350px;right:480px;bottom:80px;position:fixed;';
  panel.innerHTML = `
    <div class="fcp-header">
      <span class="fcp-label">Job Output</span>
      <span style="flex:1"></span>
      <button class="fcp-btn fcp-close" onclick="this.closest('.vm-panel-output').remove()">&#10005;</button>
    </div>
    <pre class="vm-output-pre">${(result.output||'').replace(/</g,'&lt;')}</pre>
  `;
  document.body.appendChild(panel);
  bringToFront(panel);
}

// --- VM Ports Panel (floating) ---
function showVMPortsPanel(vmId) {
  const existing = document.querySelector('.vm-panel-ports');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'floating-chat-panel vm-panel-ports';
  panel.style.cssText = 'width:360px;height:250px;right:40px;bottom:80px;position:fixed;';
  panel.innerHTML = `
    <div class="fcp-header">
      <span class="fcp-label">Ports &mdash; ${currentTarget.label}</span>
      <span style="flex:1"></span>
      <button class="fcp-btn fcp-close" onclick="this.closest('.vm-panel-ports').remove()">&#10005;</button>
    </div>
    <div class="vm-panel-body" id="vm-ports-body">
      <div class="vm-panel-loading">Loading tunnels...</div>
    </div>
    <div class="vm-panel-actions">
      <input type="number" id="vm-port-local" placeholder="Local port" class="vm-input" style="width:90px">
      <span style="margin:0 4px">&#8594;</span>
      <input type="number" id="vm-port-remote" placeholder="Remote port" class="vm-input" style="width:90px">
      <button class="vm-btn vm-btn-primary" onclick="vmAddTunnel('${vmId}')">Add</button>
    </div>
  `;
  document.body.appendChild(panel);
  bringToFront(panel);
  refreshVMPorts(vmId);
}

async function refreshVMPorts(vmId) {
  const body = document.getElementById('vm-ports-body');
  if (!body) return;
  try {
    const tunnels = await api.vmTunnels(vmId);
    if (!tunnels.length) { body.innerHTML = '<div class="vm-manage-empty">No active tunnels</div>'; return; }
    body.innerHTML = tunnels.map(t => `
      <div class="vm-port-row">
        <span>localhost:${t.local_port}</span>
        <a href="http://localhost:${t.local_port}" target="_blank" class="vm-btn vm-btn-sm">Open</a>
        <button class="vm-btn vm-btn-sm" onclick="vmCloseTunnel('${vmId}',${t.local_port})">Close</button>
      </div>
    `).join('');
  } catch (err) {
    body.innerHTML = `<div class="vm-status-error">Error: ${err.message}</div>`;
  }
}

async function vmAddTunnel(vmId) {
  const local = parseInt(document.getElementById('vm-port-local')?.value);
  const remote = parseInt(document.getElementById('vm-port-remote')?.value);
  if (!local || !remote) return;
  await api.vmAddTunnel(vmId, { local_port: local, remote_port: remote });
  document.getElementById('vm-port-local').value = '';
  document.getElementById('vm-port-remote').value = '';
  refreshVMPorts(vmId);
}

async function vmCloseTunnel(vmId, localPort) {
  await api.vmCloseTunnel(vmId, localPort);
  refreshVMPorts(vmId);
}

// --- Markdown with [[wiki-links]] ---
marked.use({ extensions: [{
  name: 'wikiLink', level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = src.match(/^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
    if (m) return { type:'wikiLink', raw:m[0], target:m[1].trim(), display:(m[2]||m[1]).trim() };
  },
  renderer(tok) { return `<span class="wiki-link" data-target="${tok.target}">${tok.display}</span>`; },
}]});

// --- State ---
let graphData = null;       // Full graph from API — use nodeById() for O(1) lookup
let layoutData = {};        // Saved card positions
let currentTransform = { x:0, y:0, k:1 };
let cardElements = new Map();
let cardMeta = new Map();
let saveLayoutTimer = null;
let expandedCard = null;
let lastFocusedPath = null; // Last clicked/viewed file or folder path

function setFocusedItem(path, element) {
  // Clear all previous focus highlights
  document.querySelectorAll('.item-focused').forEach(el => el.classList.remove('item-focused'));
  lastFocusedPath = path || null;
  if (element) element.classList.add('item-focused');
}
let edgeRAF = null;         // rAF handle for edge debouncing
// Centralized z-index management — all layers defined here
// Fullpage overlay is position:absolute inside #canvas-container (z:200)
// Toolbar is position:relative z:250 (above #main, so above fullpage)
// Floating panels inside #canvas-container use bringToFront (201+)
const Z_LAYERS = {
  canvas: 1,           // Cards on the canvas
  floatingPanel: 100,  // Floating chat panels, terminals (default)
  fullpage: 200,       // Fullscreen file overlay (inside canvas-container)
  toolbar: 250,        // Toolbar (above #main entirely)
  dropdown: 310,       // Settings dropdown, filter menu (inside toolbar)
  palette: 300,        // Appearance/model palettes (fixed)
  modal: 400,          // Full settings modal, keybinding panel (fixed)
  tooltip: 500,        // Selection tooltip, toasts
};
let topZIndex = Z_LAYERS.floatingPanel; // Counter for bring-to-front within a layer

function bringToFront(el) {
  if (!el || !el.parentNode) return;
  // Ensure floating panels can get above fullpage overlay (z-index 200)
  topZIndex = Math.max(topZIndex + 1, Z_LAYERS.fullpage + 1);
  el.style.setProperty('z-index', String(topZIndex), 'important');
}

// Canvas stack for drill-in navigation (persisted to sessionStorage across reloads)
let canvasStack = [];  // [{parentPath: null|string, label: string}]
function currentLevel() { return canvasStack[canvasStack.length - 1] || { parentPath: null, label: 'Root' }; }
function saveCanvasStack() {
  try { sessionStorage.setItem('loom-canvas-stack', JSON.stringify(canvasStack)); } catch {}
}
function loadCanvasStack() {
  try {
    const saved = sessionStorage.getItem('loom-canvas-stack');
    if (saved) {
      const stack = JSON.parse(saved);
      // Dedup: remove circular entries
      const seen = new Set();
      const deduped = [];
      for (const entry of stack) {
        const key = entry.parentPath || '__root__';
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(entry);
      }
      return deduped;
    }
  } catch {}
  return null;
}

// --- Node helpers ---
// O(1) node lookup Map — rebuilt when graphData changes
let _nodeMap = new Map();
function _rebuildNodeMap() {
  _nodeMap.clear();
  if (graphData?.nodes) {
    for (const n of graphData.nodes) _nodeMap.set(n.data.id, n.data);
  }
}
function nodeById(id) { return _nodeMap.get(id) || null; }

function getChildIds(parentPath) {
  if (!graphData) return [];
  return graphData.nodes.filter(n => n.data.parent_id === parentPath).map(n => n.data.id);
}

// ========================================
// Canvas Controller
// ========================================
let zoomBehavior, zoomSelection;

function initCanvas() {
  const container = document.getElementById('infinite-canvas');
  const world = document.getElementById('world');
  const edgeLayer = document.getElementById('edge-layer');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.05, 2])
    .filter(event => {
      if (event.target.closest('.floating-chat-panel')) return false;
      if (event.target.closest('.floating-terminal')) return false;
      if (event.type === 'wheel' && event.target.closest('.doc-body')) return false;
      if (event.type === 'wheel' && event.target.closest('.doc-edit-area')) return false;
      const isStart = event.type === 'mousedown' || event.type === 'pointerdown' || event.type === 'touchstart';
      if (isStart && event.target.closest('.doc-card')) return false;
      return true;
    })
    .on('zoom', (event) => {
      const t = event.transform;
      currentTransform = { x: t.x, y: t.y, k: t.k };
      world.style.transform = `translate(${t.x}px,${t.y}px) scale(${t.k})`;
      edgeLayer.style.transform = `translate(${t.x}px,${t.y}px) scale(${t.k})`;
      let lod = 'readable';
      if (t.k < 0.2) lod = 'minimap';
      else if (t.k < 0.5) lod = 'overview';
      world.dataset.lod = lod;
    });

  zoomSelection = d3.select(container);
  zoomSelection.call(zoomBehavior);

  // Click outside any card → dismiss active edit and clear focus
  // Use capture phase to catch before other handlers
  document.addEventListener('pointerdown', (e) => {
    const clickedCard = e.target.closest('.doc-card');
    const clickedTreeItem = e.target.closest('.tree-item, .ftree-item, .file-tile');

    // Set focus / multi-select on clicked item
    if (clickedCard) {
      if ((e.metaKey || e.ctrlKey) && !e.target.closest('.doc-controls')) {
        // Cmd+click toggles multi-select
        if (selectedCards.has(clickedCard)) {
          selectedCards.delete(clickedCard);
          clickedCard.classList.remove('selected');
        } else {
          selectedCards.add(clickedCard);
          clickedCard.classList.add('selected');
        }
      }
      setFocusedItem(clickedCard.dataset.path, clickedCard);
    } else if (clickedTreeItem && clickedTreeItem.dataset.id) {
      setFocusedItem(clickedTreeItem.dataset.id, clickedTreeItem);
    } else if (!e.target.closest('.floating-chat-panel') && !e.target.closest('#chat-panel') && !e.target.closest('.floating-terminal') && !e.target.closest('#toolbar') && !e.target.closest('#sidebar') && !e.target.closest('.action-menu') && !e.target.closest('.filter-menu') && !e.target.closest('#fullpage-overlay')) {
      // Clicking empty space clears focus
      setFocusedItem(null, null);
    }

    if (!activeEditCard) return;
    if (!clickedCard || clickedCard !== activeEditCard) {
      exitCardEdit(activeEditCard);
    }
  });
}

function fitView() {
  const topCards = [...cardElements.values()].filter(c => c.style.left);
  if (topCards.length === 0) return;

  const container = document.getElementById('infinite-canvas');
  const cw = container.clientWidth, ch = container.clientHeight;
  // If container has no size yet, retry after a short delay
  if (cw === 0 || ch === 0) {
    setTimeout(fitView, 100);
    return;
  }

  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const c of topCards) {
    const x = parseInt(c.style.left)||0, y = parseInt(c.style.top)||0;
    const w = c.offsetWidth || 380, h = c.offsetHeight || 200;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  if (!isFinite(minX) || maxX <= minX || maxY <= minY) return;

  const pad = 60;
  const k = Math.min(cw/(maxX-minX+pad*2), ch/(maxY-minY+pad*2), 1);
  const tx = (cw-(maxX-minX)*k)/2 - minX*k;
  const ty = (ch-(maxY-minY)*k)/2 - minY*k;
  zoomSelection.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx,ty).scale(k));
}

// ========================================
// Card Creation
// ========================================
function createDocCard(nodeData, content, pos, options = {}) {
  const card = document.createElement('div');
  const isFolder = nodeData.is_folder;
  const category = nodeData.category || 'misc';
  const isMarkdown = category === 'markdown' || category === 'folder';

  card.className = 'doc-card' + (options.pinned ? ' pinned-parent' : '');
  card.dataset.path = nodeData.id;
  card.dataset.type = nodeData.type || 'unknown';
  card.dataset.category = category;
  card.dataset.isFolder = isFolder ? 'true' : 'false';
  card.dataset.expanded = isMarkdown ? 'true' : 'false'; // Markdown always expanded
  card.style.left = pos.x + 'px';
  card.style.top = pos.y + 'px';

  const childCount = (nodeData.children || []).length;
  const childBadge = isFolder ? `<button class="btn-children" title="Drill into subpages">${childCount > 0 ? childCount + ' sub' : '▶'}</button>` : '';

  // Type/category badge — right-aligned in header
  const typeLabel = nodeData.type && nodeData.type !== 'folder' && nodeData.type !== 'file' ? nodeData.type : (category !== 'folder' && category !== 'misc' ? category : '');
  const typeBadgeHtml = typeLabel ? `<span class="card-meta">${typeLabel}</span>` : '';

  const meta = cardMeta.get(nodeData.id);

  // Path breadcrumb for footer
  const pathParts = nodeData.id.split('/');
  const pathBreadcrumb = pathParts.length > 1 ? pathParts.slice(0, -1).join(' / ') : '';

  // Tags from frontmatter
  const tags = meta?.frontmatter?.tags || [];
  const tagChips = tags.map(t => `<span class="chip">${t}</span>`).join('');

  // Body content: markdown gets full render, files get summary initially
  let bodyHTML;
  if (isMarkdown && content) {
    bodyHTML = marked.parse(content);
  } else if (!isFolder && !isMarkdown) {
    if (content && (category === 'code' || category === 'data')) {
      const preview = content.slice(0, 500).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      bodyHTML = `<pre><code>${preview}${content.length > 500 ? '\n...' : ''}</code></pre>`;
    } else {
      const summary = nodeData.summary || nodeData.label;
      bodyHTML = `<div class="file-summary">${summary}</div>`;
    }
  } else {
    bodyHTML = content ? marked.parse(content) : '<em>Empty</em>';
  }

  // Footer — path breadcrumb + tags (only if we have either)
  const hasFooter = pathBreadcrumb || tagChips;
  const footerHtml = hasFooter ? `
    <div class="card-foot">
      ${pathBreadcrumb ? `<span class="card-foot-path">${pathBreadcrumb}</span>` : ''}
      ${pathBreadcrumb && tagChips ? '<span class="card-foot-sep">·</span>' : ''}
      ${tagChips}
    </div>` : '';

  card.innerHTML = `
    <div class="doc-handle">
      <span class="card-dot"></span>
      <div class="card-title-wrap">
        <span class="doc-title">${nodeData.label}</span>
      </div>
      ${typeBadgeHtml}
      <div class="doc-controls">
        ${childBadge}
        <button class="btn-history" title="Git history"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5V6L7.5 7.5"/></svg></button>
        <button class="btn-collapse" title="Collapse">-</button>
      </div>
    </div>
    <div class="doc-body">${bodyHTML}</div>
    ${footerHtml}
  `;

  card.addEventListener('pointerdown', () => bringToFront(card), true);
  wireCardDrag(card, options.pinned);
  wireCardBorderResize(card);
  wireCardButtons(card, isFolder);
  wireWikiLinks(card);
  return card;
}

// ========================================
// Card Interactions
// ========================================
function wireWikiLinks(card) {
  card.querySelectorAll('.wiki-link').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); focusCardByTitle(el.dataset.target); });
  });
}

function wireCardButtons(card, hasChildren) {
  const path = card.dataset.path;
  const category = card.dataset.category || 'misc';
  const isMarkdown = category === 'markdown' || category === 'folder';
  const isFolder = card.dataset.isFolder === 'true';

  // Right-click context menu
  card.addEventListener('contextmenu', (e) => showCardContextMenu(e, path, isFolder));

  // Single-click title: toggle expand/collapse
  card.querySelector('.doc-handle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (card._wasDragged) { card._wasDragged = false; return; }
    setFocusedItem(path, card);
    if (card.dataset.expanded === 'false' || body.style.display === 'none') {
      card.dataset.expanded = 'true';
      card.dataset.collapseState = 'expanded';
      body.style.display = '';
      card.querySelector('.btn-collapse').textContent = '-';
      const summary = card.querySelector('.doc-summary');
      if (summary) summary.style.display = 'none';
      if (!isMarkdown && !cardMeta.has(path)) expandCardContent(card, path);
    } else {
      card.dataset.expanded = 'false';
      card.dataset.collapseState = 'summary';
      body.style.display = 'none';
      card.querySelector('.btn-collapse').textContent = '~';
      // Show summary line
      let summary = card.querySelector('.doc-summary');
      if (!summary) {
        summary = document.createElement('div');
        summary.className = 'doc-summary';
        card.appendChild(summary);
      }
      const meta = cardMeta.get(path);
      const summaryText = meta?.frontmatter?.summary || body.textContent?.trim() || '';
      summary.textContent = summaryText ? summaryText.slice(0, 100) + (summaryText.length > 100 ? '...' : '') : 'Empty';
      summary.style.display = '';
    }
    scheduleEdgeUpdate();
  });

  // Suppress native dblclick on cards (prevents d3-zoom from zooming in)
  card.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); });

  // Double-click title (manual 300ms): folders → drill into canvas, files → full page
  let _handleLastClick = 0;
  card.querySelector('.doc-handle').addEventListener('click', (e) => {
    if (card._wasDragged) return;
    const now = Date.now();
    if (now - _handleLastClick < 300) {
      e.stopPropagation(); e.preventDefault();
      if (e.metaKey || e.ctrlKey) { openExternal(path); return; }
      const currentParent = currentLevel().parentPath;
      if (card.dataset.isFolder === 'true' && currentParent !== path) {
        drillInto(path);
      } else {
        expandCardFullPage(card);
      }
    }
    _handleLastClick = now;
  });

  const body = card.querySelector('.doc-body');

  // Single click body → expand content (for non-markdown files in summary mode)
  // Single click body → set focus + expand non-markdown content
  body.addEventListener('click', (e) => {
    setFocusedItem(path, card);
    if (!isMarkdown && card.dataset.expanded !== 'true' && card.dataset.editing !== 'true') {
      e.stopPropagation();
      expandCardContent(card, path);
    }
  });

  // Double-click body (manual 200ms) → edit if expanded, fullpage if collapsed
  let _bodyLastClick = 0;
  body.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - _bodyLastClick < 300) {
      e.stopPropagation(); e.preventDefault();
      if (card.dataset.editing === 'true') { _bodyLastClick = now; return; }
      if (card.dataset.expanded === 'true') {
        enterCardEdit(card, path);
      } else {
        expandCardFullPage(card);
      }
    }
    _bodyLastClick = now;
  });

  // Collapse button cycles: expanded → summary → hidden → expanded
  card.querySelector('.btn-collapse').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const state = card.dataset.collapseState || 'expanded';

    if (state === 'expanded') {
      card.dataset.expanded = 'false';
      card.dataset.collapseState = 'summary';
      body.style.display = '';
      btn.textContent = '~';
    } else if (state === 'summary') {
      body.style.display = 'none';
      card.dataset.collapseState = 'hidden';
      btn.textContent = '+';
    } else {
      card.dataset.expanded = 'true';
      card.dataset.collapseState = 'expanded';
      body.style.display = '';
      btn.textContent = '-';
      if (!isMarkdown && !cardMeta.has(path)) expandCardContent(card, path);
    }
    scheduleEdgeUpdate();
  });

  // Drill into children
  const childBtn = card.querySelector('.btn-children');
  if (childBtn && hasChildren) {
    childBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      drillInto(path);
    });
  }

  // History button — show git log for this file
  const histBtn = card.querySelector('.btn-history');
  if (histBtn) {
    histBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCardHistory(card, path);
    });
  }
}

async function showCardHistory(card, path) {
  // Toggle: if history pane already exists, remove it
  const existing = card.querySelector('.card-history');
  if (existing) { existing.remove(); return; }

  const histPane = document.createElement('div');
  histPane.className = 'card-history';
  histPane.innerHTML = '<div style="padding:8px;color:var(--text-dim);font-size:var(--fs-xs)">Loading history...</div>';
  card.querySelector('.doc-body').after(histPane);

  try {
    const resp = await authFetch(`${getBaseUrl()}/api/git-history?path=${encodeURIComponent(path)}&limit=10`);
    if (!resp.ok) throw new Error('Failed');
    const data = await resp.json();
    if (!data.commits?.length) {
      histPane.innerHTML = '<div style="padding:8px;color:var(--text-dim);font-size:var(--fs-xs)">No git history</div>';
      return;
    }
    histPane.innerHTML = data.commits.map(c => `
      <div class="card-history-item" data-hash="${c.hash}">
        <span class="card-history-msg">${c.message}</span>
        <span class="card-history-date">${c.date.split(' ')[0]}</span>
      </div>
    `).join('');

    // Click a commit to show diff
    histPane.querySelectorAll('.card-history-item').forEach(item => {
      item.onclick = async () => {
        const hash = item.dataset.hash;
        // Toggle active
        histPane.querySelectorAll('.card-history-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        // Show diff
        let diffEl = histPane.querySelector('.card-history-diff');
        if (!diffEl) {
          diffEl = document.createElement('div');
          diffEl.className = 'card-history-diff';
          histPane.appendChild(diffEl);
        }
        diffEl.innerHTML = '<span style="color:var(--text-dim)">Loading diff...</span>';
        try {
          const dr = await authFetch(`${getBaseUrl()}/api/git-diff?path=${encodeURIComponent(path)}&hash=${hash}`);
          const dd = await dr.json();
          if (dd.diff) {
            diffEl.innerHTML = renderDiff(dd.diff);
          } else {
            diffEl.innerHTML = '<span style="color:var(--text-dim)">No diff (initial commit)</span>';
          }
        } catch { diffEl.innerHTML = '<span style="color:var(--red)">Failed to load diff</span>'; }
      };
    });
  } catch {
    histPane.innerHTML = '<div style="padding:8px;color:var(--red);font-size:var(--fs-xs)">Could not load history</div>';
  }
}

function renderDiff(diffText) {
  const lines = diffText.split('\n');
  let html = '';
  for (const line of lines) {
    if (line.startsWith('@@')) {
      html += `<div class="diff-hunk">${line.replace(/</g, '&lt;')}</div>`;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      html += `<div class="diff-add">${line.replace(/</g, '&lt;')}</div>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      html += `<div class="diff-del">${line.replace(/</g, '&lt;')}</div>`;
    } else if (!line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++')) {
      html += `<div class="diff-ctx">${line.replace(/</g, '&lt;') || '&nbsp;'}</div>`;
    }
  }
  return html;
}

async function expandCardContent(card, path) {
  // Fetch and display full content for a file card
  const body = card.querySelector('.doc-body');
  const category = card.dataset.category || 'misc';
  body.innerHTML = '<em>Loading...</em>';

  try {
    // PDFs: render with pdf.js directly (no text extraction)
    if (path.endsWith('.pdf')) {
      await renderPdfInElement(body, `/media/${path}`);
      card.dataset.expanded = 'true';
      return;
    }

    const data = await api.page(path);
    const content = data.content || '';
    cardMeta.set(path, { frontmatter: data.frontmatter, content });

    if (category === 'code') {
      body.innerHTML = `<pre><code>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
    } else {
      body.innerHTML = `<pre>${content.replace(/</g, '&lt;')}</pre>`;
    }
    card.dataset.expanded = 'true';
    wireWikiLinks(card);
  } catch (e) {
    body.innerHTML = `<em>Failed to load</em>`;
  }
}

let activeEditCard = null; // Currently editing card

function enterCardEdit(card, path) {
  // Exit any other active edit first
  if (activeEditCard && activeEditCard !== card) exitCardEdit(activeEditCard);

  const body = card.querySelector('.doc-body');
  let rawContent = '';
  const meta = cardMeta.get(path);

  if (meta) {
    rawContent = meta.content || '';
  }

  body.innerHTML = `<textarea class="doc-edit-area">${rawContent.replace(/</g,'&lt;')}</textarea>`;
  card.dataset.editing = 'true';
  card.classList.add('editing');
  activeEditCard = card;
  const textarea = body.querySelector('.doc-edit-area');
  textarea?.focus();
  textarea?.addEventListener('pointerdown', (e) => e.stopPropagation());
}

let editSaving = false;
async function exitCardEdit(card) {
  if (!card || card.dataset.editing !== 'true' || editSaving) return;
  editSaving = true;
  const path = card.dataset.path;
  const body = card.querySelector('.doc-body');
  const textarea = body.querySelector('.doc-edit-area');
  const category = card.dataset.category || 'misc';

  // Get content from textarea
  const newContent = textarea ? textarea.value : '';

  // Save if changed
  let meta = cardMeta.get(path);
  if (textarea && newContent) {
    if (!meta) meta = { frontmatter: {}, content: '' };
    if (newContent !== meta.content) {
      meta.content = newContent;
      cardMeta.set(path, meta);
      try {
        await api.savePage(path, meta.frontmatter, newContent);
      } catch (err) { /* Save failed, content updated locally */ }
    }
  }

  // Re-render based on category
  const content = meta?.content || newContent || '';
  if (category === 'code') {
    body.innerHTML = `<pre><code>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
  } else if (category === 'markdown' || category === 'folder') {
    body.innerHTML = marked.parse(content);
  } else {
    body.innerHTML = `<pre>${content.replace(/</g, '&lt;')}</pre>`;
  }
  wireWikiLinks(card);

  card.dataset.editing = 'false';
  card.classList.remove('editing');
  if (activeEditCard === card) activeEditCard = null;
  editSaving = false;
}

// ========================================
// Card Drag
// ========================================
function wireCardDrag(card, pinned) {
  if (pinned) return;
  const handle = card.querySelector('.doc-handle');
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.doc-controls')) return;
    e.preventDefault(); e.stopPropagation();

    // Cmd+click toggles multi-select
    if (e.metaKey || e.ctrlKey) {
      if (selectedCards.has(card)) {
        selectedCards.delete(card);
        card.classList.remove('selected');
      } else {
        selectedCards.add(card);
        card.classList.add('selected');
      }
      return;
    }

    // Click without Cmd clears selection (unless dragging a selected card)
    if (!selectedCards.has(card)) {
      selectedCards.forEach(c => c.classList.remove('selected'));
      selectedCards.clear();
    }

    const startX = e.clientX, startY = e.clientY;
    const k = currentTransform.k;

    // Capture start positions for all selected cards + this card
    const dragCards = selectedCards.size > 0 && selectedCards.has(card) ? [...selectedCards] : [card];
    const startPositions = dragCards.map(c => ({
      card: c,
      x: parseInt(c.style.left) || 0,
      y: parseInt(c.style.top) || 0,
    }));

    let dragged = false;
    function onMove(e) {
      const dx = (e.clientX - startX) / k;
      const dy = (e.clientY - startY) / k;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < 4) return;
      dragged = true;
      for (const sp of startPositions) {
        sp.card.style.left = (sp.x + dx) + 'px';
        sp.card.style.top = (sp.y + dy) + 'px';
      }
      scheduleEdgeUpdate();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (dragged) card._wasDragged = true;
      for (const sp of startPositions) {
        layoutData[sp.card.dataset.path] = { x: parseInt(sp.card.style.left), y: parseInt(sp.card.style.top) };
      }
      debounceSaveLayout();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// ========================================
// Card Border Resize (right, bottom, corner)
// ========================================
function wireCardBorderResize(card) {
  // Create invisible resize handles overlaid on the card borders
  const handles = [
    { cls: 'resize-right', axis: 'e' },
    { cls: 'resize-bottom', axis: 's' },
    { cls: 'resize-corner', axis: 'se' },
  ];

  for (const { cls, axis } of handles) {
    const handle = document.createElement('div');
    handle.className = `resize-handle ${cls}`;
    card.appendChild(handle);

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const startW = card.offsetWidth;
      const startBodyH = card.querySelector('.doc-body')?.offsetHeight || 200;
      const k = currentTransform.k;

      function onMove(e) {
        if (axis === 'e' || axis === 'se') {
          card.style.width = Math.max(200, startW + (e.clientX - startX) / k) + 'px';
        }
        if (axis === 's' || axis === 'se') {
          const body = card.querySelector('.doc-body');
          if (body) body.style.maxHeight = Math.max(60, startBodyH + (e.clientY - startY) / k) + 'px';
        }
        scheduleEdgeUpdate();
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }
}

// ========================================
// Edges (SVG, with rAF debouncing)
// ========================================
function scheduleEdgeUpdate() {
  if (edgeRAF) return;
  edgeRAF = requestAnimationFrame(() => { edgeRAF = null; updateEdges(); });
}

function updateEdges() {
  const svg = document.getElementById('edge-layer');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!graphData) return;

  const level = currentLevel();
  const edges = level.parentPath === null ? graphData.top_edges : graphData.edges;

  // Filter edges to current level's visible cards
  const visiblePaths = new Set([...cardElements.keys()]);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5"
    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b3f57"/>
  </marker>`;
  svg.appendChild(defs);

  const useSimple = edges.length > 100;
  let drawn = 0;

  for (const edge of edges) {
    const srcPath = edge.data.source, tgtPath = edge.data.target;
    if (!visiblePaths.has(srcPath) || !visiblePaths.has(tgtPath)) continue;
    const srcCard = cardElements.get(srcPath), tgtCard = cardElements.get(tgtPath);
    if (!srcCard || !tgtCard) continue;
    if (srcCard.style.display === 'none' || tgtCard.style.display === 'none') continue;

    const sx = (parseInt(srcCard.style.left)||0) + srcCard.offsetWidth;
    const sy = (parseInt(srcCard.style.top)||0) + Math.min(20, srcCard.offsetHeight/2);
    const tx = parseInt(tgtCard.style.left)||0;
    const ty = (parseInt(tgtCard.style.top)||0) + Math.min(20, tgtCard.offsetHeight/2);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (useSimple) {
      path.setAttribute('d', `M ${sx} ${sy} L ${tx} ${ty}`);
    } else {
      const dx = Math.max(Math.abs(tx-sx)*0.4, 30);
      path.setAttribute('d', `M ${sx} ${sy} C ${sx+dx} ${sy}, ${tx-dx} ${ty}, ${tx} ${ty}`);
    }
    path.setAttribute('marker-end', 'url(#arrow)');
    svg.appendChild(path);
    drawn++;
  }
}

// ========================================
// Canvas Stack / Navigation
// ========================================
async function drillInto(parentPath) {
  const nd = nodeById(parentPath);
  if (!nd) return;

  // Lazy-load children if not already in graphData
  const existingChildren = getChildIds(parentPath);
  if (existingChildren.length === 0) {
    try {
      const showInternals = localStorage.getItem('loom-show-internals') === 'true';
      const resp = await fetch(`/api/children/${parentPath}?show_internals=${showInternals}`);
      const data = await resp.json();
      if (data.children && data.children.length > 0) {
        // Merge into graphData
        for (const child of data.children) {
          if (!nodeById(child.data.id)) {
            graphData.nodes.push(child);
            _nodeMap.set(child.data.id, child.data);
            if (child.data.content) {
              cardMeta.set(child.data.id, { frontmatter: {}, content: child.data.content });
            }
          }
        }
        debugLog(`[Drill] Lazy-loaded ${data.children.length} children for ${parentPath}`);
      }
    } catch (e) {
      console.warn('[Drill] Failed to lazy-load children:', e);
    }
  }

  // Guard against circular navigation — don't push if already at this path
  if (canvasStack.some(e => e.parentPath === parentPath)) {
    // Already in stack — navigate to it instead of pushing again
    const idx = canvasStack.findIndex(e => e.parentPath === parentPath);
    canvasStack = canvasStack.slice(0, idx + 1);
  } else {
    canvasStack.push({ parentPath, label: nd.label });
  }
  saveCanvasStack();
  renderCurrentLevel();
}

function navigateToLevel(index) {
  canvasStack = canvasStack.slice(0, index + 1);
  saveCanvasStack();
  renderCurrentLevel();
}

function syncEmptyChatScopes() {
  // Update all chat panels with no messages to match current location
  const level = currentLevel();
  const smartLevel = getSmartContextDefault();
  // Use fullscreen file path if in page mode, otherwise canvas path
  const path = (expandedCard && expandedCard.dataset?.path) || level.parentPath || '';

  for (const [id, panel] of chatPanels) {
    const msgs = panel.messages || [];
    if (msgs.length === 0) {
      panel.contextLevel = smartLevel;
      panel.contextPath = path || null;
      // Update chip display if this is the active panel
      if (id === 'main') {
        updateContextChip();
      }
    }
  }
}

function renderCurrentLevel() {
  const level = currentLevel();
  updateBreadcrumb();
  if (_mobileActive) updateMobileBreadcrumb();
  syncEmptyChatScopes();

  const world = document.getElementById('world');
  world.innerHTML = '';
  cardElements.clear();
  selectedCards.clear();
  // Reset z-index counter to prevent inflation
  topZIndex = 200;

  if (level.parentPath === null) {
    renderRootCanvas(world);
  } else {
    renderSubCanvas(world, level.parentPath);
  }

  scheduleEdgeUpdate();
  populateTagFilter();
  updateBreadcrumb(); // Update again after cards are rendered for accurate stats
  requestAnimationFrame(() => requestAnimationFrame(fitView));
}

function renderRootCanvas(world) {
  const topNodes = graphData.top_nodes || [];
  const hasSavedPositions = topNodes.some(n => layoutData[n.data.id]);

  // Initial positions: use saved or simple grid for first render
  const gridPositions = computeLayoutGrid(topNodes, layoutData);

  for (const node of topNodes) {
    const nd = node.data;
    const pos = gridPositions[nd.id] || { x: 0, y: 0 };
    const meta = cardMeta.get(nd.id);
    const content = meta?.content || '';
    const card = createDocCard(nd, content, pos);
    world.appendChild(card);
    cardElements.set(nd.id, card);
    layoutData[nd.id] = pos;
  }

  // If all cards had saved positions, keep them — don't re-layout
  if (hasSavedPositions) return;

  // After render, measure actual heights and run force layout with real sizes
  requestAnimationFrame(() => {
    const cardW = 400, pad = 40;
    const heights = {};
    for (const [id, el] of cardElements) {
      heights[id] = el.offsetHeight || 280;
    }

    // Run d3-force with actual heights
    if (typeof d3.forceSimulation !== 'function') return;

    const cols = Math.max(2, Math.ceil(Math.sqrt(topNodes.length * 1.8)));
    const simNodes = topNodes.map((node, i) => ({
      id: node.data.id,
      x: (i % cols) * (cardW + pad) + cardW / 2,
      y: Math.floor(i / cols) * 400 + 200,
    }));

    const idSet = new Set(topNodes.map(n => n.data.id));
    const edges = (graphData?.top_edges || graphData?.edges || []);
    const links = [];
    for (const e of edges) {
      if (idSet.has(e.data.source) && idSet.has(e.data.target))
        links.push({ source: e.data.source, target: e.data.target });
    }

    // Rectangular collision using actual card heights
    function forceRectCollide() {
      let nodes;
      function force(alpha) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const overlapX = (cardW + pad) / 2 - Math.abs(dx);
            const hA = heights[a.id] || 280, hB = heights[b.id] || 280;
            const overlapY = ((hA + hB) / 2 + pad) / 2 - Math.abs(dy);
            if (overlapX > 0 && overlapY > 0) {
              const str = alpha * 0.8;
              if (overlapX < overlapY) {
                a.x -= Math.sign(dx) * overlapX * str / 2;
                b.x += Math.sign(dx) * overlapX * str / 2;
              } else {
                a.y -= Math.sign(dy) * overlapY * str / 2;
                b.y += Math.sign(dy) * overlapY * str / 2;
              }
            }
          }
        }
      }
      force.initialize = function(n) { nodes = n; };
      return force;
    }

    const simulation = d3.forceSimulation(simNodes)
      .force('rectCollide', forceRectCollide())
      .force('charge', d3.forceManyBody().strength(-30))
      .force('link', d3.forceLink(links).id(d => d.id).distance(cardW * 0.8).strength(0.5))
      .force('center', d3.forceCenter(
        (cols * (cardW + pad)) / 2,
        (Math.ceil(topNodes.length / cols) * 400) / 2
      ))
      .stop();

    for (let i = 0; i < 150; i++) simulation.tick();

    // Animate cards to final positions
    for (const sn of simNodes) {
      const card = cardElements.get(sn.id);
      if (card) {
        const finalPos = { x: Math.round(sn.x - cardW / 2), y: Math.round(sn.y - (heights[sn.id] || 280) / 2) };
        card.style.transition = 'left 0.5s ease, top 0.5s ease';
        card.style.left = finalPos.x + 'px';
        card.style.top = finalPos.y + 'px';
        layoutData[sn.id] = finalPos;
      }
    }

    setTimeout(() => {
      for (const [, card] of cardElements) card.style.transition = '';
      scheduleEdgeUpdate();
      debounceSaveLayout();
      fitView();
    }, 550);
  });
}

function renderSubCanvas(world, parentPath) {
  const parentNode = nodeById(parentPath);
  if (!parentNode) return;

  const childIds = getChildIds(parentPath);
  const childNodes = childIds.map(id => nodeById(id)).filter(Boolean);

  // Pinned parent at top-left
  const parentMeta = cardMeta.get(parentPath);
  const parentCard = createDocCard(parentNode, parentMeta?.content || '', { x: 0, y: 0 }, { pinned: true });
  world.appendChild(parentCard);
  cardElements.set(parentPath, parentCard);

  // Layout children to the right and below the parent
  const cardW = 400, cardH = 280, gap = 30;
  const parentWidth = parentCard.offsetWidth || cardW;
  const parentHeight = parentCard.offsetHeight || 300;
  const startX = parentWidth + gap;
  const startY = 0;
  // Fill column to the right first, then wrap below
  const rightCols = Math.max(1, Math.ceil(Math.sqrt(childNodes.length)));
  const rightRows = Math.ceil(childNodes.length / rightCols);
  // If too many rows would extend far below, also use space below parent
  const maxRightRows = Math.max(2, Math.ceil(parentHeight / (cardH + gap)) + 1);

  childNodes.forEach((nd, i) => {
    const savedPos = layoutData[nd.id];
    let pos;
    if (savedPos) {
      pos = savedPos;
    } else {
      const col = Math.floor(i / maxRightRows);
      const row = i % maxRightRows;
      pos = { x: startX + col * (cardW + gap), y: startY + row * (cardH + gap) };
    }
    const meta = cardMeta.get(nd.id);
    const card = createDocCard(nd, meta?.content || '', pos);
    world.appendChild(card);
    cardElements.set(nd.id, card);
    layoutData[nd.id] = pos;
  });
}

function updateBreadcrumb() {
  const bar = document.getElementById('breadcrumb-bar');
  let html = '';
  // Root crumb
  html += `<span class="crumb${canvasStack.length <= 1 ? ' crumb-current' : ''}" onclick="navigateToLevel(0)">loom</span>`;
  for (let i = 1; i < canvasStack.length; i++) {
    html += `<span class="crumb crumb-sep">›</span>`;
    const isCurrent = i === canvasStack.length - 1;
    html += `<span class="crumb${isCurrent ? ' crumb-current' : ''}" onclick="navigateToLevel(${i})">${canvasStack[i].label}</span>`;
  }
  if (canvasStack.length <= 1) {
    html += `<span class="crumb crumb-sep">›</span><span class="crumb crumb-current">root canvas</span>`;
  }
  // Right-aligned stats
  const pageCount = cardElements.size;
  const edgeCount = graphData?.edges?.length || 0;
  const zoomPct = Math.round((currentTransform.k || 1) * 100);
  html += `<span class="breadcrumb-stats">${pageCount} pages · ${edgeCount} edges · zoom ${zoomPct}%</span>`;
  bar.innerHTML = html;
}

// ========================================
// Layout (WebCoLa — constraint-based with non-overlap)
// ========================================
function computeLayout(nodes, saved) {
  // d3-force is always available (vendored). Grid as fallback.
  if (typeof d3.forceSimulation === 'function') {
    return computeLayoutForce(nodes, saved);
  }
  return computeLayoutGrid(nodes, saved);
}

function computeLayoutForce(nodes, saved) {
  const positions = {};
  const cardW = 400, cardH = 280, pad = 40;

  // Build simulation nodes
  const cols = Math.max(2, Math.ceil(Math.sqrt(nodes.length * 1.8)));
  const simNodes = nodes.map((node, i) => {
    const s = saved[node.data.id];
    return {
      id: node.data.id,
      x: s ? s.x + cardW/2 : (i % cols) * (cardW + pad) + cardW/2 + (Math.random() - 0.5) * 50,
      y: s ? s.y + cardH/2 : Math.floor(i / cols) * (cardH + pad) + cardH/2 + (Math.random() - 0.5) * 50,
      fx: s ? s.x + cardW/2 : null,  // Fix saved positions
      fy: s ? s.y + cardH/2 : null,
    };
  });

  // Build links from edges
  const idSet = new Set(nodes.map(n => n.data.id));
  const edges = (graphData?.top_edges || graphData?.edges || []);
  const links = [];
  for (const e of edges) {
    if (idSet.has(e.data.source) && idSet.has(e.data.target)) {
      links.push({ source: e.data.source, target: e.data.target });
    }
  }

  // Custom rectangular collision force — prevents actual card overlap
  function forceRectCollide() {
    let nodes;
    function force(alpha) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          if (a.fx != null && b.fx != null) continue; // both fixed
          const dx = b.x - a.x, dy = b.y - a.y;
          const overlapX = (cardW + pad) / 2 - Math.abs(dx);
          const overlapY = (cardH + pad) / 2 - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            // Push apart along the axis with less overlap
            const str = alpha * 0.8;
            if (overlapX < overlapY) {
              const shift = overlapX * str / 2;
              if (a.fx == null) a.x -= Math.sign(dx) * shift;
              if (b.fx == null) b.x += Math.sign(dx) * shift;
            } else {
              const shift = overlapY * str / 2;
              if (a.fx == null) a.y -= Math.sign(dy) * shift;
              if (b.fx == null) b.y += Math.sign(dy) * shift;
            }
          }
        }
      }
    }
    force.initialize = function(n) { nodes = n; };
    return force;
  }

  // Run simulation — gentle repulsion, rectangular collision
  const simulation = d3.forceSimulation(simNodes)
    .force('rectCollide', forceRectCollide())
    .force('charge', d3.forceManyBody().strength(-30))
    .force('link', d3.forceLink(links).id(d => d.id).distance(cardW * 0.8).strength(0.5))
    .force('center', d3.forceCenter(
      (cols * (cardW + pad)) / 2,
      (Math.ceil(nodes.length / cols) * (cardH + pad)) / 2
    ))
    .stop();

  // Run 150 ticks synchronously (rect collision needs more iterations)
  for (let i = 0; i < 150; i++) simulation.tick();

  // Extract positions (simulation gives center, we need top-left)
  for (const sn of simNodes) {
    positions[sn.id] = {
      x: Math.round(sn.x - cardW / 2),
      y: Math.round(sn.y - cardH / 2),
    };
  }
  return positions;
}

// Fallback grid layout
function computeLayoutGrid(nodes, saved) {
  const positions = {};
  const cardW = 400, cardH = 280, pad = 30;
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  nodes.forEach((node, i) => {
    if (saved[node.data.id]) {
      positions[node.data.id] = saved[node.data.id];
    } else {
      positions[node.data.id] = {
        x: (i % cols) * (cardW + pad),
        y: Math.floor(i / cols) * (cardH + pad),
      };
    }
  });
  return positions;
}

function autoLayout() {
  const level = currentLevel();
  const isSubCanvas = level.parentPath !== null;
  const nodes = isSubCanvas
    ? graphData?.nodes.filter(n => n.data.parent_id === level.parentPath) || []
    : (graphData?.top_nodes || []);
  if (nodes.length === 0) return;

  const positions = computeLayout(nodes, {}); // Empty saved = layout all

  // In sub-canvases, offset all positions below the parent card
  if (isSubCanvas) {
    const parentCard = cardElements.get(level.parentPath);
    const parentBottom = parentCard ? (parentCard.offsetHeight || 300) + 50 : 400;
    // Find the minimum y in computed positions
    let minY = Infinity;
    for (const pos of Object.values(positions)) {
      if (pos.y < minY) minY = pos.y;
    }
    // Shift all positions so they start below the parent
    const offset = parentBottom - minY;
    if (offset > 0) {
      for (const pos of Object.values(positions)) {
        pos.y += offset;
      }
    }
  }

  // Animate cards to new positions
  for (const [path, card] of cardElements) {
    if (positions[path]) {
      card.style.transition = 'left 0.4s ease, top 0.4s ease';
      card.style.left = positions[path].x + 'px';
      card.style.top = positions[path].y + 'px';
      layoutData[path] = positions[path];
    }
  }
  // Remove transition after animation completes, update edges
  setTimeout(() => {
    for (const [, card] of cardElements) card.style.transition = '';
    scheduleEdgeUpdate();
    debounceSaveLayout();
  }, 450);
  // Fit view after animation
  setTimeout(fitView, 500);
}

// ========================================
// Focus / Full-page
// ========================================
function focusCardByTitle(title) {
  const tl = title.toLowerCase();
  // Check current visible cards first
  for (const [path, card] of cardElements) {
    const nd = nodeById(path);
    if (!nd) continue;
    if (nd.label.toLowerCase() === tl || (nd.aliases||[]).some(a => a.toLowerCase() === tl)) {
      focusCard(card); return;
    }
  }
  // Maybe it's a card not on this level — find it and drill to its parent
  const targetNode = graphData?.nodes.find(n => {
    const d = n.data;
    return d.label.toLowerCase() === tl || (d.aliases||[]).some(a => a.toLowerCase() === tl);
  });
  if (targetNode) {
    if (targetNode.data.parent_id) {
      drillInto(targetNode.data.parent_id);
      setTimeout(() => {
        const c = cardElements.get(targetNode.data.id);
        if (c) focusCard(c);
      }, 500);
    }
  }
}

function focusCard(card) {
  setFocusedItem(card.dataset.path, card);
  const container = document.getElementById('infinite-canvas');
  const x = parseInt(card.style.left)||0, y = parseInt(card.style.top)||0;
  const k = 0.8;
  const tx = container.clientWidth/2 - x*k - card.offsetWidth*k/2;
  const ty = container.clientHeight/2 - y*k - card.offsetHeight*k/2;
  zoomSelection.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx,ty).scale(k));
  document.querySelectorAll('.doc-card.focused').forEach(c => c.classList.remove('focused'));
  card.classList.add('focused');
  setTimeout(() => card.classList.remove('focused'), 2000);
}

async function expandCardFullPage(card, highlightQuery) {
  if (expandedCard) collapseFullPage();
  // Dismiss any canvas edit
  if (activeEditCard) exitCardEdit(activeEditCard);
  setFocusedItem(card.dataset.path, null);

  const path = card.dataset.path;
  // Always fetch full content for fullscreen view — cardMeta may have truncated (8000 char) version
  try {
    const data = await api.page(path);
    const prevLen = cardMeta.get(path)?.content?.length || 0;
    cardMeta.set(path, { frontmatter: data.frontmatter, content: data.content || '' });
    if ((data.content||'').length !== prevLen) {
      console.log(`[Fullpage] Fetched full content for ${path}: ${(data.content||'').length} chars (was ${prevLen})`);
    }
  } catch (e) {
    console.error(`[Fullpage] Failed to fetch ${path}:`, e);
  }
  const meta = cardMeta.get(path);
  const title = card.querySelector('.doc-title')?.textContent || path;
  const rawContent = meta?.content || '';
  console.log(`[Fullpage] Rendering ${path}: rawContent=${rawContent.length} chars, meta=${!!meta}`);
  const overlay = document.createElement('div');
  overlay.id = 'fullpage-overlay';
  overlay.dataset.path = path;
  overlay.dataset.mode = 'preview';
  overlay.innerHTML = `
    <div class="fullpage-header">
      <button class="fullpage-back" title="Back (Escape)">← Back</button>
      <span class="fullpage-title">${title}</span>
      <span class="fullpage-path">${path}</span>
      <span style="flex:1"></span>
      <div class="fullpage-width-controls">
        <button class="fp-width-btn active" data-w="50">50%</button>
        <button class="fp-width-btn" data-w="100">100%</button>
      </div>
      <button class="fullpage-toggle">Edit</button>
    </div>
    <div class="fullpage-body">
      <div class="fullpage-content"></div>
      <div class="fullpage-resize-handle" title="Drag to resize"></div>
    </div>
  `;
  // Append to canvas-container — fills content area, respects sidebar + toolbar
  document.getElementById('canvas-container').appendChild(overlay);
  expandedCard = overlay;
  syncEmptyChatScopes();
  // Auto-hide sidebar on fullscreen enter
  const sidebar = document.getElementById('sidebar');
  expandedCard._sidebarWasOpen = sidebar && !sidebar.classList.contains('collapsed');
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    sidebar.classList.add('collapsed');
  }
  overlay.querySelector('.fullpage-back').onclick = collapseFullPage;

  // Width preset buttons
  overlay.querySelectorAll('.fp-width-btn').forEach(btn => {
    btn.onclick = () => {
      const w = btn.dataset.w;
      overlay.querySelectorAll('.fp-width-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const c = overlay.querySelector('.fullpage-content');
      const handle = overlay.querySelector('.fullpage-resize-handle');
      if (w === '100') {
        c.style.width = '';
        c.style.flex = '';
        if (handle) handle.style.display = 'none';
        localStorage.setItem('loom-fullpage-content-width', 'full');
      } else {
        const px = Math.round(overlay.getBoundingClientRect().width * parseInt(w) / 100);
        c.style.width = px + 'px';
        c.style.flex = 'none';
        if (handle) handle.style.display = '';
        localStorage.setItem('loom-fullpage-content-width', px);
      }
    };
  });

  // Draggable right edge to resize content pane
  const resizeHandle = overlay.querySelector('.fullpage-resize-handle');
  const fpContent = overlay.querySelector('.fullpage-content');
  const savedFpWidth = localStorage.getItem('loom-fullpage-content-width');
  if (savedFpWidth === 'full') {
    // User explicitly chose 100%
    resizeHandle.style.display = 'none';
    overlay.querySelectorAll('.fp-width-btn').forEach(b => b.classList.remove('active'));
    overlay.querySelector('.fp-width-btn[data-w="100"]')?.classList.add('active');
  } else {
    // Default to 50% or use saved pixel width
    const px = savedFpWidth ? parseInt(savedFpWidth) : Math.round(overlay.getBoundingClientRect().width * 0.5);
    fpContent.style.width = px + 'px';
    fpContent.style.flex = 'none';
    resizeHandle.style.display = '';
  }

  let fpResizing = false;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    fpResizing = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!fpResizing) return;
    const overlayRect = overlay.getBoundingClientRect();
    const w = Math.max(400, Math.min(overlayRect.width - 40, e.clientX - overlayRect.left));
    fpContent.style.width = w + 'px';
    fpContent.style.flex = 'none';
  });
  document.addEventListener('mouseup', () => {
    if (!fpResizing) return;
    fpResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('loom-fullpage-content-width', parseInt(fpContent.style.width));
  });
  resizeHandle.addEventListener('dblclick', () => {
    fpContent.style.width = '';
    fpContent.style.flex = '';
    resizeHandle.style.display = 'none';
    localStorage.removeItem('loom-fullpage-content-width');
    overlay.querySelectorAll('.fp-width-btn').forEach(b => b.classList.remove('active'));
    overlay.querySelector('.fp-width-btn[data-w="100"]')?.classList.add('active');
  });

  // Saved chat transcripts: show "Continue" button
  if (path.startsWith('raw/chats/')) {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'fullpage-chat';
    continueBtn.textContent = 'Continue';
    continueBtn.title = 'Continue this conversation';
    overlay.querySelector('.fullpage-header').insertBefore(
      continueBtn, overlay.querySelector('.fullpage-toggle')
    );
    continueBtn.onclick = () => continueSavedChat(path, rawContent);
  }

  const contentEl = overlay.querySelector('.fullpage-content');

  if (path.endsWith('.tex')) {
    // TeX file: start as normal fullpage code editor with Compile button
    overlay.querySelector('.fullpage-toggle').style.display = 'none';

    const compileBtn = document.createElement('button');
    compileBtn.className = 'fullpage-chat';
    compileBtn.textContent = 'Compile';
    compileBtn.title = 'Compile to PDF (latexmk)';
    overlay.querySelector('.fullpage-header').insertBefore(
      compileBtn, overlay.querySelector('.fullpage-toggle')
    );

    createCodeEditor(contentEl, rawContent, path).then(view => {
      overlay._cmView = view;
      view.dom.addEventListener('keydown', (ev) => {
        const m = ev.metaKey || ev.ctrlKey;
        if (m && ev.key === '[') { ev.preventDefault(); ev.stopPropagation(); collapseFullPage(); }
      });
    });

    const pdfPath = path.replace(/\.tex$/, '.pdf');

    compileBtn.onclick = async () => {
      compileBtn.textContent = 'Compiling...';
      compileBtn.disabled = true;
      try {
        const resp = await authFetch('/api/compile-tex', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        const data = await resp.json();
        if (data.ok) {
          // Close fullpage, open split view
          collapseFullPage();
          const sv = openSplitView(
            {
              title: title,
              path: path,
              render: (el, headerEl) => {
                // Add compile button to left pane header
                const recompileBtn = document.createElement('button');
                recompileBtn.textContent = 'Compile';
                recompileBtn.title = 'Recompile to PDF';
                headerEl.appendChild(recompileBtn);
                recompileBtn.onclick = async () => {
                  recompileBtn.textContent = 'Compiling...';
                  recompileBtn.disabled = true;
                  try {
                    const r = await authFetch('/api/compile-tex', {
                      method: 'POST', headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ path }),
                    });
                    const d = await r.json();
                    if (d.ok && sv?._rightPane?._content) {
                      await renderPdfInElement(sv._rightPane._content, `/media/${d.pdf_path}?t=${Date.now()}`);
                      recompileBtn.textContent = 'Compile';
                    } else {
                      recompileBtn.textContent = 'Compile (failed)';
                    }
                  } catch { recompileBtn.textContent = 'Compile (error)'; }
                  recompileBtn.disabled = false;
                };
                createCodeEditor(el, rawContent, path);
              },
            },
            {
              title: pdfPath.split('/').pop(),
              path: pdfPath,
              render: (el) => renderPdfInElement(el, `/media/${data.pdf_path}?t=${Date.now()}`),
            }
          );
          if (sv) sv._sourcePath = path;
        } else {
          compileBtn.textContent = 'Compile (failed)';
          // Show error inline below editor
          let errEl = overlay.querySelector('.tex-error');
          if (!errEl) {
            errEl = document.createElement('pre');
            errEl.className = 'tex-error';
            contentEl.parentNode.appendChild(errEl);
          }
          errEl.textContent = data.log || data.error;
          compileBtn.disabled = false;
        }
      } catch (e) {
        compileBtn.textContent = 'Compile (error)';
        compileBtn.disabled = false;
      }
    };
    return;
  } else if (isCodeFile(path)) {
    // Render code files with CodeMirror
    overlay.querySelector('.fullpage-toggle').style.display = 'none';
    createCodeEditor(contentEl, rawContent, path).then(view => {
      overlay._cmView = view;
      // Cmd+[ to collapse even when CodeMirror is focused
      view.dom.addEventListener('keydown', (ev) => {
        const m = ev.metaKey || ev.ctrlKey;
        if (m && ev.key === '[') { ev.preventDefault(); ev.stopPropagation(); collapseFullPage(); }
      });
    });
  } else if (path.startsWith('raw/chats/') || path.match(/raw\/chats\/.*\.md$/)) {
    // Render chat transcript as chat UI
    overlay.querySelector('.fullpage-toggle').style.display = 'none';
    renderChatTranscript(contentEl, rawContent);
  } else {
    // Render markdown — marked-katex-extension handles $...$ and $$...$$ natively
    const html = marked.parse(rawContent);
    console.log(`[Fullpage] marked.parse: input=${rawContent.length} output=${html.length} chars`);
    contentEl.innerHTML = html;
    renderLatex(contentEl); // still needed for \(...\) and \[...\] delimiters
    overlay.querySelector('.fullpage-toggle').onclick = () => toggleFullPageEdit(overlay, path);
    wireFullPageLinks(overlay);
    if (highlightQuery) highlightMatches(contentEl, highlightQuery);
  }
}

function renderChatTranscript(container, rawContent) {
  // Parse chat transcript markdown into styled chat UI
  // Format: frontmatter, then ## You / ## Claude sections with <details> blocks
  container.className += ' chat-transcript';

  // Strip frontmatter
  let content = rawContent;
  if (content.startsWith('---')) {
    const endFm = content.indexOf('---', 3);
    if (endFm > 0) content = content.slice(endFm + 3).trim();
  }
  // Remove "Session: xxx" line
  content = content.replace(/^Session:\s*\S+\n*/m, '');

  // Split into sections by ## You / ## Claude
  const sections = [];
  const lines = content.split('\n');
  let current = null;

  for (const line of lines) {
    if (line.match(/^## (You|User)/i)) {
      if (current) sections.push(current);
      current = { role: 'user', lines: [] };
    } else if (line.match(/^## (Claude|Assistant)/i)) {
      if (current) sections.push(current);
      current = { role: 'assistant', lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  // Render each section as a chat message
  debugLog('[transcript] sections:', sections.length, sections.map(s => s.role));
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    debugLog('[transcript] rendering', section.role, 'section, length:', text.length);
    if (!text) continue;
    try {

    // Strip raw Python dict lines (subagent results that leaked outside <details>)
    function stripDicts(s) {
      return s.split('\n').filter(line =>
        !line.match(/^\s*[-*]?\s*\{'type':\s*'text'/)
      ).join('\n');
    }

    if (section.role === 'user') {
      // Extract user text: remove <details> blocks AND raw dict lines
      let userText = text.replace(/<details>[\s\S]*?<\/details>/g, '');
      userText = stripDicts(userText).trim();
      if (userText) {
        const msgEl = document.createElement('div');
        msgEl.className = 'chat-msg chat-msg-user';
        msgEl.textContent = userText;
        container.appendChild(msgEl);
      }
      // Render <details> blocks as activity (between user text and Claude response)
      const detailsBlocks = text.match(/<details>[\s\S]*?<\/details>/g) || [];
      for (const block of detailsBlocks) {
        container.appendChild(buildDetailsElement(block));
      }
    } else {
      // Assistant: render as HTML with native <details>
      const msgEl = document.createElement('div');
      msgEl.className = 'chat-msg chat-msg-assistant';
      const contentEl = document.createElement('div');
      contentEl.className = 'chat-msg-content chat-text';
      // Strip raw dict lines and line number prefixes
      let cleaned = stripDicts(text);
      cleaned = cleaned.replace(/^\d+\t/gm, '');
      contentEl.innerHTML = marked.parse(cleaned);
      msgEl.appendChild(contentEl);
      container.appendChild(msgEl);
    }
    } catch (err) {
      debugLog('[transcript] Error rendering section:', err);
    }
  }

  // If no sections parsed, fall back to markdown
  if (sections.length === 0) {
    container.innerHTML = marked.parse(rawContent);
  }

  renderLatex(container);
}

function highlightMatches(container, query) {
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    if (!regex.test(node.textContent)) continue;
    const frag = document.createDocumentFragment();
    const parts = node.textContent.split(regex);
    for (const part of parts) {
      if (regex.test(part)) {
        const mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = part;
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
      regex.lastIndex = 0; // Reset regex state
    }
    node.parentNode.replaceChild(frag, node);
  }

  // Scroll to first match
  const first = container.querySelector('.search-highlight');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function wireFullPageLinks(overlay) {
  overlay.querySelectorAll('.wiki-link').forEach(el => {
    el.addEventListener('click', () => { collapseFullPage(); focusCardByTitle(el.dataset.target); });
  });
}

async function toggleFullPageEdit(overlay, path) {
  const contentEl = overlay.querySelector('.fullpage-content');
  const toggleBtn = overlay.querySelector('.fullpage-toggle');
  const meta = cardMeta.get(path);

  if (overlay.dataset.mode === 'preview') {
    // Switch to edit
    contentEl.classList.add('editing');
    contentEl.innerHTML = `<textarea class="fullpage-edit-area">${(meta?.content||'').replace(/</g,'&lt;')}</textarea>`;
    overlay.dataset.mode = 'edit';
    toggleBtn.textContent = 'Preview';
    const editArea = contentEl.querySelector('.fullpage-edit-area');
    editArea?.addEventListener('keydown', (ev) => {
      const m = ev.metaKey || ev.ctrlKey;
      if (m && ev.key === '[') { ev.preventDefault(); ev.stopPropagation(); collapseFullPage(); }
    });
    // Selection tooltip in edit mode
    editArea?.addEventListener('mouseup', () => {
      const ta = editArea;
      if (ta.selectionStart === ta.selectionEnd) return;
      const selectedText = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      if (selectedText.trim().length < 5) return;
      const tooltip = document.getElementById('selection-tooltip');
      // Position near textarea cursor — approximate with textarea bounding rect
      const rect = ta.getBoundingClientRect();
      tooltip.style.left = (rect.left + rect.width / 2 - 40) + 'px';
      tooltip.style.top = (rect.top - 30) + 'px';
      tooltip.style.display = '';
      pendingSelection = { text: selectedText, file: path };
    });
    editArea?.focus();
  } else {
    // Save and switch to preview
    const textarea = contentEl.querySelector('.fullpage-edit-area');
    if (meta && textarea) {
      const newContent = textarea.value;
      if (newContent !== meta.content) {
        try {
          await api.savePage(path, meta.frontmatter, newContent);
          meta.content = newContent;
        } catch (err) { /* silent */ }
      }
      contentEl.classList.remove('editing');
      // Render based on file type
      const isCode = isCodeFile(path);
      if (isCode) {
        contentEl.innerHTML = `<pre><code>${meta.content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
      } else {
        contentEl.innerHTML = marked.parse(meta.content);
      }
      wireFullPageLinks(overlay);
      // Also update the canvas card if it exists
      const canvasCard = cardElements.get(path);
      if (canvasCard && canvasCard.dataset.editing !== 'true') {
        const cardBody = canvasCard.querySelector('.doc-body');
        if (isCode) {
          cardBody.innerHTML = `<pre><code>${meta.content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
        } else {
          cardBody.innerHTML = marked.parse(meta.content);
        }
        wireWikiLinks(canvasCard);
      }
    }
    overlay.dataset.mode = 'preview';
    toggleBtn.textContent = 'Edit';
  }
}

let fullpageReturnView = null; // View to return to when closing fullpage

function collapseFullPage() {
  if (expandedCard) {
    // Restore sidebar if it was open before fullscreen
    if (expandedCard._sidebarWasOpen) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.remove('collapsed');
    }
    expandedCard.remove();
    expandedCard = null;
    syncEmptyChatScopes();
    if (fullpageReturnView) {
      switchView(fullpageReturnView);
      fullpageReturnView = null;
    }
  }
}

// ========================================
// Split View (two files side by side)
// ========================================
let splitOverlay = null;

function openSplitView(leftConfig, rightConfig) {
  // leftConfig/rightConfig: { title, path, render: async (contentEl) => void }
  closeSplitView();

  const overlay = document.createElement('div');
  overlay.className = 'split-overlay';
  overlay.id = 'split-overlay';

  function makePane(config, side) {
    const pane = document.createElement('div');
    pane.className = `split-pane ${side}`;
    const isLeft = side === 'left';
    pane.innerHTML = `
      <div class="split-pane-header">
        ${isLeft ? '<button class="split-back" title="Return to canvas">← Back</button>' : ''}
        <span class="split-title">${config.title}</span>
        <span class="split-path">${config.path || ''}</span>
        <span style="flex:1"></span>
        ${!isLeft ? '<button class="split-close" title="Close this pane">✕</button>' : ''}
      </div>
      <div class="split-pane-content"></div>
    `;
    // Store header for adding buttons
    pane._header = pane.querySelector('.split-pane-header');
    pane._content = pane.querySelector('.split-pane-content');
    return pane;
  }

  const leftPane = makePane(leftConfig, 'left');
  const rightPane = makePane(rightConfig, 'right');
  overlay.appendChild(leftPane);
  overlay.appendChild(rightPane);
  document.getElementById('canvas-container').appendChild(overlay);
  splitOverlay = overlay;

  // Left back: close everything, return to canvas
  leftPane.querySelector('.split-back').onclick = () => {
    splitOverlay = null;
    overlay.remove();
  };
  // Right close: close PDF pane, return to fullpage editor
  const closeBtn = rightPane.querySelector('.split-close');
  if (closeBtn) {
    closeBtn.onclick = () => {
      const sourcePath = overlay._sourcePath;
      splitOverlay = null;
      overlay.remove();
      if (sourcePath) {
        const nd = nodeById(sourcePath);
        if (nd) {
          const fakeCard = document.createElement('div');
          fakeCard.dataset.path = sourcePath;
          fakeCard.dataset.isFolder = 'false';
          fakeCard.innerHTML = `<span class="doc-title">${nd.label}</span>`;
          expandCardFullPage(fakeCard);
        }
      }
    };
  }

  // Store pane refs on overlay for external access
  overlay._leftPane = leftPane;
  overlay._rightPane = rightPane;

  // Render content
  leftConfig.render(leftPane._content, leftPane._header);
  rightConfig.render(rightPane._content, rightPane._header);

  // Escape to close
  function onKey(e) {
    if (e.key === 'Escape') { closeSplitView(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);

  return overlay;
}

function closeSplitView() {
  if (splitOverlay) {
    const sourcePath = splitOverlay._sourcePath;
    splitOverlay.remove();
    splitOverlay = null;
    // Return to fullpage editor if there's a source file
    if (sourcePath) {
      const nd = nodeById(sourcePath);
      if (nd) {
        const fakeCard = document.createElement('div');
        fakeCard.dataset.path = sourcePath;
        fakeCard.dataset.isFolder = 'false';
        fakeCard.innerHTML = `<span class="doc-title">${nd.label}</span>`;
        expandCardFullPage(fakeCard);
      }
    }
  }
}

// ========================================
// Layout persistence
// ========================================
function debounceSaveLayout() {
  clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => api.saveLayout(layoutData), 1000);
}

// ========================================
// Filters
// ========================================
function getActiveTypes() {
  return new Set([...document.querySelectorAll('#filter-type-menu input[type="checkbox"]')].filter(c=>c.checked).map(c=>c.value));
}
function getActiveTags() {
  const checks = [...document.querySelectorAll('#filter-tag-menu input[type="checkbox"]')];
  const checked = checks.filter(c=>c.checked);
  if (checked.length===0 || checked.length===checks.length) return null;
  return new Set(checked.map(c=>c.value));
}
function getActiveFiletypes() {
  return new Set([...document.querySelectorAll('#filter-filetype-menu input[type="checkbox"]')].filter(c=>c.checked).map(c=>c.value));
}
function applyFilters() {
  const types = getActiveTypes(), tags = getActiveTags(), filetypes = getActiveFiletypes();

  // Update filter active indicator
  updateFilterDot();

  for (const [path,card] of cardElements) {
    const type = card.dataset.type||'unknown';
    const category = card.dataset.category||'misc';
    const meta = cardMeta.get(path);
    const t = meta?.frontmatter?.tags||[];
    // Type filter applies to wiki types (concept, summary, etc.). Non-wiki files always pass.
    const isWikiType = ['concept','summary','index','answer','structure-note'].includes(type);
    const typeMatch = !isWikiType || types.has(type);
    const tagMatch = tags===null || t.some(x=>tags.has(x));
    const ftMatch = filetypes.has(category);
    card.style.display = (typeMatch && tagMatch && ftMatch) ? '' : 'none';
  }
  // Sidebar
  document.querySelectorAll('#sidebar-tree .tree-item.file').forEach(item => {
    const meta = cardMeta.get(item.dataset.id);
    if (!meta) { item.style.opacity = ''; return; }
    const type = meta.frontmatter?.type||'unknown';
    const t = meta.frontmatter?.tags||[];
    item.style.opacity = (types.has(type) && (tags===null||t.some(x=>tags.has(x)))) ? '' : '0.3';
  });
  scheduleEdgeUpdate();
}

function updateFilterDot() {
  // Show dot on ⚙ button if any filter is narrowing the view
  const allType = document.querySelectorAll('#filter-type-menu input[type="checkbox"]');
  const allFt = document.querySelectorAll('#filter-filetype-menu input[type="checkbox"]');
  const typeFiltered = [...allType].some(c => !c.checked);
  const ftFiltered = [...allFt].some(c => !c.checked);
  const dot = document.getElementById('filter-active-dot');
  if (dot) dot.style.display = (typeFiltered || ftFiltered) ? '' : 'none';
}

function initFilterDropdowns() {
  const menus = ['filter-type-menu', 'filter-tag-menu', 'filter-filetype-menu'];

  function closeAll() { menus.forEach(id => document.getElementById(id)?.classList.remove('open')); }
  function toggleMenu(menuId, e) {
    e.stopPropagation();
    const menu = document.getElementById(menuId);
    const wasOpen = menu.classList.contains('open');
    closeAll();
    if (!wasOpen) menu.classList.add('open');
  }

  // Filters are now inside the toolbar ⚙ menu — no separate toggle buttons needed

  // Type filter
  const typeMenu = document.getElementById('filter-type-menu');
  typeMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.onchange = applyFilters);
  document.getElementById('filter-select-all').onclick = () => { typeMenu.querySelectorAll('input').forEach(c=>c.checked=true); applyFilters(); };
  document.getElementById('filter-clear-all').onclick = () => { typeMenu.querySelectorAll('input').forEach(c=>c.checked=false); applyFilters(); };

  // Filetype filter
  const ftMenu = document.getElementById('filter-filetype-menu');
  ftMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.onchange = applyFilters);
  document.getElementById('filetype-select-all').onclick = () => { ftMenu.querySelectorAll('input').forEach(c=>c.checked=true); applyFilters(); };
  document.getElementById('filetype-clear-all').onclick = () => { ftMenu.querySelectorAll('input').forEach(c=>c.checked=false); applyFilters(); };

  // Visibility toggles — affect ALL views (canvas, files, sidebar)
  function refreshAllViews() {
    refreshFileTree();
    initGraphView(); // Re-fetch graph with new visibility settings
    initSidebar();   // Re-fetch sidebar tree
  }

  const internalsCheckbox = document.getElementById('filter-show-internals');
  const dotfilesCheckbox = document.getElementById('filter-show-dotfiles');
  const hiddenCheckbox = document.getElementById('filter-show-hidden');
  if (internalsCheckbox) {
    internalsCheckbox.checked = localStorage.getItem('loom-show-internals') === 'true';
    internalsCheckbox.onchange = () => {
      localStorage.setItem('loom-show-internals', internalsCheckbox.checked);
      refreshAllViews();
    };
  }
  if (dotfilesCheckbox) {
    dotfilesCheckbox.checked = localStorage.getItem('loom-show-dotfiles') === 'true';
    dotfilesCheckbox.onchange = () => {
      localStorage.setItem('loom-show-dotfiles', dotfilesCheckbox.checked);
      refreshAllViews();
    };
  }
  if (hiddenCheckbox) {
    hiddenCheckbox.checked = localStorage.getItem('loom-show-hidden') === 'true';
    hiddenCheckbox.onchange = () => {
      localStorage.setItem('loom-show-hidden', hiddenCheckbox.checked);
      refreshAllViews();
    };
  }
}

function populateTagFilter() {
  const tagMenu = document.getElementById('filter-tag-menu');
  const counts = {};
  // Only count tags from cards on the current canvas level
  for (const [path] of cardElements) {
    const meta = cardMeta.get(path);
    for (const tag of meta?.frontmatter?.tags||[]) counts[tag]=(counts[tag]||0)+1;
  }
  const tags = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  tagMenu.innerHTML = tags.map(([t,c])=>`<label><input type="checkbox" value="${t}" checked> ${t} (${c})</label>`).join('')
    + '<hr><button id="tag-select-all">Select All</button><button id="tag-clear-all">Clear All</button>';
  tagMenu.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.onchange=applyFilters);
  tagMenu.querySelector('#tag-select-all')?.addEventListener('click',()=>{tagMenu.querySelectorAll('input').forEach(c=>c.checked=true);applyFilters();});
  tagMenu.querySelector('#tag-clear-all')?.addEventListener('click',()=>{tagMenu.querySelectorAll('input').forEach(c=>c.checked=false);applyFilters();});
}

// ========================================
// Initialize
// ========================================
async function initGraphView() {
  const isVM = isVMTarget();
  const world = document.getElementById('world');
  if (isVM) world.innerHTML = '<div class="empty-state" style="position:absolute;left:50px;top:50px;">Loading VM files...</div>';
  try {
    if (isVM) {
      graphData = await api.fetchGraph();
      layoutData = {};
    } else {
      [graphData, layoutData] = await Promise.all([api.fetchGraph(), api.getLayout()]);
    }
    cardElements.clear();
    cardMeta.clear();
    _rebuildNodeMap();
    if (!graphData || graphData.nodes.length === 0) {
      world.innerHTML = `<div class="empty-state" style="position:absolute;left:50px;top:50px;">${isVM ? 'No files on VM.' : 'No wiki pages yet.'}</div>`;
      return;
    }
    // Fetch page contents (local only — VM has no bulk page endpoint)
    if (!isVM) {
      try {
        const bulk = await authFetch('/api/pages/bulk', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(graphData.nodes.map(n => n.data.id)),
        }).then(r => r.json());
        for (const [id, data] of Object.entries(bulk)) {
          if (data) cardMeta.set(id, { frontmatter: data.frontmatter, content: data.content });
        }
      } catch {
        const pages = await Promise.all(graphData.nodes.map(n => api.page(n.data.id).then(d=>[n.data.id,d]).catch(()=>[n.data.id,null])));
        for (const [id, data] of pages) {
          if (data) cardMeta.set(id, { frontmatter: data.frontmatter, content: data.content });
        }
      }
    }
    // Restore saved position (local only) or start at root
    const rootLabel = isVM ? (currentTarget.label || 'VM') : 'Root';
    if (!isVM) {
      const savedStack = loadCanvasStack();
      if (savedStack && savedStack.length > 0) {
        canvasStack = [{ parentPath: null, label: rootLabel }];
        for (let i = 1; i < savedStack.length; i++) {
          const entry = savedStack[i];
          if (entry.parentPath) {
            const childIds = getChildIds(entry.parentPath);
            if (childIds.length === 0) {
              try {
                const resp = await fetch(`/api/children/${entry.parentPath}?show_internals=${localStorage.getItem('loom-show-internals') === 'true'}`);
                const data = await resp.json();
                if (data.children) {
                  for (const child of data.children) {
                    if (!nodeById(child.data.id)) {
                      graphData.nodes.push(child);
                      _nodeMap.set(child.data.id, child.data);
                      if (child.data.content) cardMeta.set(child.data.id, { frontmatter: {}, content: child.data.content });
                    }
                  }
                }
              } catch {}
            }
            canvasStack.push(entry);
          }
        }
      } else {
        canvasStack = [{ parentPath: null, label: rootLabel }];
      }
      saveCanvasStack();
    } else {
      canvasStack = [{ parentPath: null, label: rootLabel }];
    }
    renderCurrentLevel();
    debugLog(`Loom: rendered ${cardElements.size} cards`);
    if (!isVM) renderPinboard();
  } catch (err) {
    console.error('Loom initGraphView error:', err);
    world.innerHTML = `<div class="empty-state" style="position:absolute;left:50px;top:50px;">${isVM ? 'VM' : ''} Error: ${err.message}</div>`;
  }
}

async function initSidebar() {
  const treeData = await api.fetchTree();
  const container = document.getElementById('sidebar-tree');
  container.innerHTML = renderTree(treeData.children||[], 0);
  // Single click: focus item, expand/collapse folders
  container.addEventListener('click', (e) => {
    const item = e.target.closest('.tree-item');
    if (!item) return;
    if (item.dataset.id) setFocusedItem(item.dataset.id, item);
    if (item.classList.contains('folder')) {
      const ch = item.nextElementSibling;
      if (ch) {
        ch.classList.toggle('open');
        // Lazy-load children if folder is empty and being opened
        if (ch.classList.contains('open') && ch.children.length === 0 && item.dataset.id) {
          const showInternals = localStorage.getItem('loom-show-internals') === 'true';
          fetch(`/api/children/${item.dataset.id}?show_internals=${showInternals}`)
            .then(r => r.json())
            .then(data => {
              if (data.children) {
                const items = data.children.map(c => ({
                  id: c.data.id, name: c.data.label, type: c.data.is_folder ? 'folder' : 'file',
                  children: [], category: c.data.category,
                }));
                ch.innerHTML = renderTree(items, parseInt(item.style.paddingLeft || '8') / 14);
                // Update parent folder's count after lazy-load
                const count = items.length;
                let countEl = item.querySelector('.sb-count');
                if (count > 0) {
                  if (!countEl) {
                    countEl = document.createElement('span');
                    countEl.className = 'sb-count';
                    item.appendChild(countEl);
                  }
                  countEl.textContent = count;
                }
              }
            }).catch(() => {});
        }
      }
    }
  });
  // Double click: open file/folder in the current view
  container.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.tree-item');
    if (!item || !item.dataset.id) return;
    const id = item.dataset.id;
    if (e.metaKey || e.ctrlKey) { openExternal(id); return; }
    if (item.classList.contains('folder')) {
      // Navigate into folder in current view
      const view = document.querySelector('.view-tab.active')?.dataset.view || 'graph';
      if (view === 'files') {
        filesTilePath = id.split('/');
        if (filesMode === 'tree') renderFilesTree();
        else renderFilesTiles();
        updateBreadcrumbs();
      } else {
        // Canvas: drill into folder
        drillInto(id);
      }
    } else {
      // Open file in fullpage — stay in current view
      const currentView = document.querySelector('.view-tab.active')?.dataset.view || 'graph';
      fullpageReturnView = currentView;
      const card = cardElements.get(id);
      if (card) { expandCardFullPage(card); }
      else {
        const nd = nodeById(id);
        const fakeCard = document.createElement('div');
        fakeCard.dataset.path = id;
        fakeCard.innerHTML = `<span class="doc-title">${nd?.label || id.split('/').pop()}</span>`;
        expandCardFullPage(fakeCard);
      }
    }
  });

  // Drag tree items to canvas
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.tree-item');
    if (!item || !item.dataset.id) return;
    e.dataTransfer.setData('text/plain', item.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  // Make tree items draggable
  container.querySelectorAll('.tree-item').forEach(item => { item.draggable = true; });
  // Re-apply draggable after lazy-load
  new MutationObserver(() => {
    container.querySelectorAll('.tree-item:not([draggable])').forEach(item => { item.draggable = true; });
  }).observe(container, { childList: true, subtree: true });

  // Canvas drop handler
  const canvas = document.getElementById('infinite-canvas');
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    // If card already exists, focus it
    const existing = cardElements.get(id);
    if (existing) {
      setFocusedItem(id, existing);
      return;
    }
    // Create card at drop position (accounting for canvas transform)
    const nd = nodeById(id);
    if (!nd) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - (currentTransform.x || 0)) / (currentTransform.k || 1);
    const y = (e.clientY - rect.top - (currentTransform.y || 0)) / (currentTransform.k || 1);
    const meta = cardMeta.get(id);
    const card = createDocCard(nd, meta?.content || '', { x, y });
    document.getElementById('world').appendChild(card);
    cardElements.set(id, card);
    setFocusedItem(id, card);
    trackRecentFile(id, nd.label || id.split('/').pop());
  });
}

function countChildren(item) {
  return item.children ? item.children.length : 0;
}

function renderTree(items, depth) {
  return items.map(item => {
    const indent = `padding-left:${8+depth*14}px`;
    if (item.type === 'folder') {
      const kids = item.children ? renderTree(item.children, depth+1) : '';
      const count = countChildren(item);
      const countHtml = count > 0 ? `<span class="sb-count">${count}</span>` : '';
      return `<div class="tree-item folder" style="${indent}" data-id="${item.id || ''}"><span class="tree-icon">+</span><span class="tree-label">${item.name}</span>${countHtml}</div>
              <div class="tree-children${depth===0?' open':''}">${kids}</div>`;
    }
    return `<div class="tree-item file" style="${indent}" data-id="${item.id}"><span class="tree-icon">~</span>${item.title||item.name}</div>`;
  }).join('');
}

// --- Other views (files, tag cloud, health, search) ---
let filesTreeData = null;
let filesMode = 'tree'; // 'tree' or 'tiles'
let filesTilePath = []; // breadcrumb path for tile navigation
let filesSortBy = 'name'; // 'name', 'modified', 'added'

let filesInitialized = false;

function sortItems(items) {
  const sorted = [...items];
  if (filesSortBy === 'modified') sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (filesSortBy === 'added') sorted.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
  else sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return sorted;
}

async function refreshFileTree() {
  debugLog('[View] refreshFileTree called');
  // Refresh sidebar tree
  const treeData = await api.fetchTree();
  const sidebarContainer = document.getElementById('sidebar-tree');
  if (sidebarContainer) {
    sidebarContainer.innerHTML = renderTree(treeData.children || [], 0);
  }
  // Refresh Files view data
  filesTreeData = treeData;
  if (filesInitialized) {
    if (filesMode === 'tree') renderFilesTree();
    else renderFilesTiles();
  }
  // Refresh graph data and re-render canvas
  graphData = await api.fetchGraph();
  _rebuildNodeMap();
  const newIds = graphData.nodes.map(n => n.data.id).filter(id => !cardMeta.has(id));
  if (newIds.length > 0 && !isVMTarget()) {
    try {
      const bulk = await authFetch('/api/pages/bulk', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(newIds),
      }).then(r => r.json());
      for (const [id, data] of Object.entries(bulk)) {
        if (data) cardMeta.set(id, { frontmatter: data.frontmatter, content: data.content });
      }
    } catch {}
  }
  // Always re-render to reflect visibility changes
  renderCurrentLevel();
}

async function initFilesView() {
  const isVM = isVMTarget();
  if (filesInitialized && !isVM) return;
  try {
    filesTreeData = await api.fetchTree();
  } catch (err) {
    document.getElementById('files-tree').innerHTML = `<div class="empty-state">${isVM ? 'VM' : ''} Error: ${err.message}</div>`;
    return;
  }
  if (isVM) filesTilePath = [];

  document.getElementById('files-mode-tree').onclick = () => setFilesMode('tree');
  document.getElementById('files-mode-tiles').onclick = () => setFilesMode('tiles');
  document.getElementById('files-sort').onchange = (e) => {
    filesSortBy = e.target.value;
    if (filesMode === 'tree') renderFilesTree();
    else renderFilesTiles();
  };

  setFilesMode(filesMode);
  filesInitialized = true;
}

function setFilesMode(mode) {
  filesMode = mode;
  document.getElementById('files-mode-tree').classList.toggle('active', mode === 'tree');
  document.getElementById('files-mode-tiles').classList.toggle('active', mode === 'tiles');
  document.getElementById('files-tree').style.display = mode === 'tree' ? '' : 'none';
  document.getElementById('files-tiles').style.display = mode === 'tiles' ? '' : 'none';

  if (mode === 'tree') renderFilesTree();
  else renderFilesTiles();
}

async function renderFilesTree() {
  const container = document.getElementById('files-tree');
  container.innerHTML = '';
  if (!filesTreeData) return;

  // Navigate to current path, lazy-loading if needed
  let currentItems = filesTreeData.children || [];
  let currentPath = '';
  for (const pathSegment of filesTilePath) {
    currentPath = currentPath ? currentPath + '/' + pathSegment : pathSegment;
    const folder = currentItems.find(i => i.name === pathSegment && i.type === 'folder');
    if (folder) {
      if (!folder.children?.length) {
        // Lazy-load children
        try {
          const showInternals = localStorage.getItem('loom-show-internals') === 'true';
          const resp = await fetch(`/api/children/${currentPath}?show_internals=${showInternals}`);
          const data = await resp.json();
          folder.children = (data.children || []).map(c => ({
            id: c.data.id, name: c.data.label, title: c.data.label,
            type: c.data.is_folder ? 'folder' : 'file',
            children: [], category: c.data.category,
          }));
        } catch {}
      }
      currentItems = folder.children || [];
    } else break;
  }

  renderTreeItems(container, sortItems(currentItems), 0);
  updateBreadcrumbs();
}

function renderTreeItems(container, items, depth) {
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `ftree-item ${item.type}`;
    row.style.paddingLeft = (12 + depth * 16) + 'px';

    const icon = document.createElement('span');
    icon.className = 'ftree-icon';
    icon.textContent = item.type === 'folder' ? '▶' : fileIconText(item.name);
    row.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = item.title || item.name;
    row.appendChild(label);

    container.appendChild(row);

    if (item.type === 'folder') {
      const childContainer = document.createElement('div');
      childContainer.className = 'ftree-children';
      if (item.children?.length) {
        renderTreeItems(childContainer, sortItems(item.children), depth + 1);
      }
      container.appendChild(childContainer);

      let lastClickTime = 0;
      let childrenLoaded = !!item.children?.length;
      row.onclick = (e) => {
        e.stopPropagation();
        if (item.id) setFocusedItem(item.id, row);
        const now = Date.now();
        if (now - lastClickTime < 300) {
          // Fast double click — enter folder
          if (e.metaKey || e.ctrlKey) { openExternal(item.id); return; }
          filesTilePath = item.id.split('/');
          renderFilesTree();
          updateBreadcrumbs();
        } else {
          // Single click — expand/collapse
          childContainer.classList.toggle('open');
          icon.textContent = childContainer.classList.contains('open') ? '▼' : '▶';
          // Lazy-load children if needed
          if (childContainer.classList.contains('open') && !childrenLoaded && item.id) {
            childrenLoaded = true;
            const showInternals = localStorage.getItem('loom-show-internals') === 'true';
            fetch(`/api/children/${item.id}?show_internals=${showInternals}`)
              .then(r => r.json())
              .then(data => {
                if (data.children) {
                  const kids = data.children.map(c => ({
                    id: c.data.id, name: c.data.label, title: c.data.label,
                    type: c.data.is_folder ? 'folder' : 'file',
                    children: [], category: c.data.category,
                  }));
                  renderTreeItems(childContainer, sortItems(kids), depth + 1);
                }
              }).catch(() => {});
          }
        }
        lastClickTime = now;
      };
      row.ondblclick = (e) => e.stopPropagation(); // Suppress native dblclick
    } else {
      row.onclick = () => { if (item.id) setFocusedItem(item.id, row); };
      row.ondblclick = (e) => openFileItem(item, e.metaKey || e.ctrlKey);
    }
  }
}

async function renderFilesTiles() {
  const container = document.getElementById('files-tiles');
  container.innerHTML = '';
  if (!filesTreeData) return;

  // Navigate to current breadcrumb path, lazy-loading if needed
  let currentItems = filesTreeData.children || [];
  let currentPath = '';
  for (const pathSegment of filesTilePath) {
    currentPath = currentPath ? currentPath + '/' + pathSegment : pathSegment;
    const folder = currentItems.find(i => i.name === pathSegment && i.type === 'folder');
    if (folder) {
      if (!folder.children?.length) {
        try {
          const showInternals = localStorage.getItem('loom-show-internals') === 'true';
          const resp = await fetch(`/api/children/${currentPath}?show_internals=${showInternals}`);
          const data = await resp.json();
          folder.children = (data.children || []).map(c => ({
            id: c.data.id, name: c.data.label, title: c.data.label,
            type: c.data.is_folder ? 'folder' : 'file',
            children: [], category: c.data.category,
          }));
        } catch {}
      }
      currentItems = folder.children || [];
    } else break;
  }

  // Update breadcrumbs
  updateBreadcrumbs();

  // Render tiles — folders first, then files, both sorted
  const folders = sortItems(currentItems.filter(i => i.type === 'folder'));
  const files = sortItems(currentItems.filter(i => i.type !== 'folder'));

  for (const item of [...folders, ...files]) {
    const tile = document.createElement('div');
    tile.className = 'file-tile';

    const iconEl = document.createElement('div');
    iconEl.className = 'file-tile-icon';
    iconEl.innerHTML = item.type === 'folder' ? _fileIcons.folder : fileIcon(item.name);

    const nameEl = document.createElement('div');
    nameEl.className = 'file-tile-name' + (item.type === 'folder' ? ' folder-name' : '');
    nameEl.textContent = item.title || item.name;

    tile.appendChild(iconEl);
    tile.appendChild(nameEl);

    tile.onclick = () => { if (item.id) setFocusedItem(item.id, tile); };
    if (item.type === 'folder') {
      tile.ondblclick = () => {
        filesTilePath.push(item.name);
        renderFilesTiles();
      };
    } else {
      tile.ondblclick = (e) => openFileItem(item, e.metaKey || e.ctrlKey);
    }

    container.appendChild(tile);
  }
}

function updateBreadcrumbs() {
  const bc = document.getElementById('files-breadcrumbs');
  bc.innerHTML = '';

  // Root
  const root = document.createElement('span');
  root.className = 'breadcrumb-item';
  root.textContent = 'loom';
  root.onclick = () => { filesTilePath = []; filesMode === 'tiles' ? renderFilesTiles() : renderFilesTree(); };
  bc.appendChild(root);

  // Path segments
  for (let i = 0; i < filesTilePath.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = ' / ';
    bc.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item';
    crumb.textContent = filesTilePath[i];
    const depth = i;
    crumb.onclick = () => { filesTilePath = filesTilePath.slice(0, depth + 1); filesMode === 'tiles' ? renderFilesTiles() : renderFilesTree(); };
    bc.appendChild(crumb);
  }
}

// SVG file icons (Lucide-inspired, monochrome)
const _fileIcons = {
  folder: `<svg width="48" height="44" viewBox="0 6 52 46" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="fback" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b94d4"/><stop offset="100%" stop-color="#2574b0"/></linearGradient><linearGradient id="ffront" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#92d8fc"/><stop offset="40%" stop-color="#72ccf4"/><stop offset="100%" stop-color="#5cb8e8"/></linearGradient></defs><path d="M4 11.5 C4 10 5.5 9 7 9 L17 9 C17 9 18 9 18.6 9.6 L20 11 C20.8 11.8 22 12.2 22 12.2 L44.5 12.2 C46 12.2 47.5 13.5 47.5 15 L47.5 44 C47.5 46 46 47.5 44.5 47.5 L7 47.5 C5.5 47.5 4 46 4 44 Z" fill="url(#fback)"/><rect x="4" y="16.5" width="44" height="31.5" rx="3.5" fill="#1a6aa8" opacity="0.12"/><rect x="4" y="15.5" width="44" height="32" rx="3.5" fill="url(#ffront)"/><rect x="4" y="15.5" width="44" height="32" rx="3.5" stroke="#4a9ac8" stroke-width="0.4" fill="none"/><rect x="9" y="44" width="34" height="1.2" rx="0.6" fill="#3888b8" opacity="0.25"/></svg>`,
  md: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="6" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">MD</text></svg>`,
  py: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="6" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">PY</text></svg>`,
  js: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="6" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">JS</text></svg>`,
  tex: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">TEX</text></svg>`,
  pdf: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">PDF</text></svg>`,
  json: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">{  }</text></svg>`,
  yaml: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">YML</text></svg>`,
  bib: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">BIB</text></svg>`,
  toml: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="4" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">TOML</text></svg>`,
  csv: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">CSV</text></svg>`,
  ipynb: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">NB</text></svg>`,
  r: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="7" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">R</text></svg>`,
  sql: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">SQL</text></svg>`,
  txt: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">TXT</text></svg>`,
  xml: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">XML</text></svg>`,
  c: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="7" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">C</text></svg>`,
  cpp: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">C++</text></svg>`,
  rs: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="6" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">RS</text></svg>`,
  go: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="6" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">GO</text></svg>`,
  sh: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="6" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">SH</text></svg>`,
  css: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="5" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">CSS</text></svg>`,
  html: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/><text x="12" y="18" font-size="4" fill="currentColor" opacity="0.6" stroke="none" font-family="sans-serif" text-anchor="middle">HTML</text></svg>`,
  img: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  default: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="white" fill-opacity="0.08"/><polyline points="14 2 14 8 20 8"/></svg>`,
};

function fileIcon(name) {
  if (!name) return _fileIcons.default;
  const ext = name.split('.').pop()?.toLowerCase();
  const map = { md: 'md', py: 'py', js: 'js', ts: 'js', jsx: 'js', tsx: 'js', json: 'json', yaml: 'yaml', yml: 'yaml', tex: 'tex', bib: 'bib', pdf: 'pdf', png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', svg: 'img', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', html: 'html', htm: 'html', toml: 'toml', csv: 'csv', ipynb: 'ipynb', r: 'r', sql: 'sql', txt: 'txt', xml: 'xml', c: 'c', cpp: 'cpp', h: 'c', rs: 'rs', go: 'go' };
  return _fileIcons[map[ext]] || _fileIcons.default;
}

function fileIconText(name) {
  if (!name) return '○';
  const ext = name.split('.').pop()?.toLowerCase();
  const icons = { md: '◇', py: '◆', js: '◆', ts: '◆', json: '{ }', yaml: '≡', yml: '≡', tex: '∑', pdf: '▤', png: '▣', jpg: '▣' };
  return icons[ext] || '○';
}

function openExternal(path) {
  authFetch('/api/open-external', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(e => console.error('External open failed:', e));
}

function openFileItem(item, external = false) {
  setFocusedItem(item.id, null);
  if (external) { openExternal(item.id); return; }
  fullpageReturnView = 'files';
  const card = cardElements.get(item.id);
  if (card) expandCardFullPage(card);
  else {
    const fakeCard = document.createElement('div');
    fakeCard.dataset.path = item.id;
    const nd = nodeById(item.id);
    fakeCard.innerHTML = `<span class="doc-title">${nd?.label || item.title || item.name}</span>`;
    expandCardFullPage(fakeCard);
  }
}

async function initTagCloud() {
  const c = document.getElementById('tag-cloud'); c.innerHTML='';
  const counts = {};
  for (const [,meta] of cardMeta) for (const tag of meta.frontmatter?.tags||[]) counts[tag]=(counts[tag]||0)+1;
  for (const [tag,count] of Object.entries(counts).sort((a,b)=>b[1]-a[1])) {
    const pill = document.createElement('span'); pill.className='tag-pill';
    pill.style.fontSize = Math.min(22,12+count*2)+'px';
    pill.innerHTML = `${tag}<span class="tag-count">${count}</span>`;
    pill.onclick = () => { switchView('graph'); applyTagFilterQuick(tag); };
    c.appendChild(pill);
  }
}
function applyTagFilterQuick(tag) {
  for (const [p,card] of cardElements) {
    const t = cardMeta.get(p)?.frontmatter?.tags||[];
    card.style.display = t.includes(tag)?'':'none';
  }
  scheduleEdgeUpdate();
}
async function initHealth() {
  const c = document.getElementById('health-dashboard'); c.innerHTML='<div class="empty-state">Loading...</div>';
  try {
    const [h,bl,orph,st] = await Promise.all([api.health(),api.brokenLinks(),api.orphans(),api.stale()]);
    c.innerHTML='';
    for (const {title,count,items} of [
      {title:'Broken Links',count:h.broken_links,items:bl.map(b=>`${b.page} → [[${b.link}]]`)},
      {title:'Stale Pages',count:h.stale_pages,items:st.map(s=>`${s.page} (${s.source})`)},
      {title:'Orphan Pages',count:h.orphans,items:orph},
      {title:'Missing Concepts',count:h.missing_concepts,items:[]},
    ]) {
      const el=document.createElement('div'); el.className=`health-card ${count===0?'ok':count<=3?'warn':'error'}`;
      el.innerHTML=`<h3>${title}</h3><div class="count">${count}</div>${items.length?`<ul>${items.map(i=>`<li>${i}</li>`).join('')}</ul>`:''}`;
      c.appendChild(el);
    }
  } catch(e) { c.innerHTML=`<div class="empty-state">Error: ${e.message}</div>`; }
}
let searchScopeGlobal = false; // false = auto (current folder), true = all
let searchContent = true;
let searchName = true;
let searchLines = false; // false = group by file, true = show each line

async function doSearch(query) {
  if (!query.trim()) return;
  switchView('search');
  const c = document.getElementById('search-results');

  // Determine scope
  let scope = 'all';
  if (!searchScopeGlobal) {
    const level = currentLevel();
    if (level.parentPath) scope = level.parentPath;
  }

  const scopeLabel = scope === 'all' ? 'loom' : scope.split('/').pop();
  c.innerHTML = '';

  // Search options bar — always rendered first
  const opts = document.createElement('div');
  opts.className = 'search-options';
  const inFolder = currentLevel().parentPath;
  const q = query.replace(/'/g, "\\'");
  const scopeHtml = `<label class="search-check"><input type="checkbox" ${searchScopeGlobal?'checked':''} onchange="searchScopeGlobal=this.checked;doSearch('${q}')"> Global</label>`;
  opts.innerHTML = `<label class="search-check"><input type="checkbox" ${searchContent?'checked':''} onchange="searchContent=this.checked;doSearch('${q}')"> Content</label><label class="search-check"><input type="checkbox" ${searchName?'checked':''} onchange="searchName=this.checked;doSearch('${q}')"> Name</label>${scopeHtml}<label class="search-check"><input type="checkbox" ${searchLines?'checked':''} onchange="searchLines=this.checked;doSearch('${q}')"> Lines</label>`;
  c.appendChild(opts);

  // Determine mode
  let mode = 'both';
  if (searchContent && !searchName) mode = 'content';
  else if (!searchContent && searchName) mode = 'name';
  else if (!searchContent && !searchName) {
    c.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'Select at least one search mode' }));
    return;
  }

  const vmLabel = isVMTarget() ? currentTarget.label : null;
  c.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: `Searching ${vmLabel || scopeLabel}...` }));
  try {
    const results = await api.fetchSearch(query, scope, mode);
    // Remove "Searching..." but keep options bar
    c.querySelectorAll('.empty-state').forEach(e => e.remove());

    if (!results.length) {
      c.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No results' }));
      return;
    }

    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const openResult = (path) => {
      const card = cardElements.get(path);
      const target = card || (() => {
        const fakeCard = document.createElement('div');
        fakeCard.dataset.path = path;
        const nd = nodeById(path);
        fakeCard.innerHTML = `<span class="doc-title">${nd?.label || path.split('/').pop()}</span>`;
        return fakeCard;
      })();
      switchView('graph');
      expandCardFullPage(target, query);
    };

    if (searchLines) {
      // Show each matching line
      for (const r of results) {
        const div = document.createElement('div'); div.className = 'search-result';
        const lineInfo = r.line ? `:${r.line}` : '';
        div.innerHTML = `<div class="result-path">${r.path}${lineInfo}</div><div class="result-context">${r.context.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>')}</div>`;
        div.onclick = () => openResult(r.path);
        c.appendChild(div);
      }
    } else {
      // Group by file
      const grouped = new Map();
      for (const r of results) {
        if (!grouped.has(r.path)) grouped.set(r.path, []);
        grouped.get(r.path).push(r);
      }
      for (const [path, matches] of grouped) {
        const div = document.createElement('div'); div.className = 'search-result';
        const preview = matches[0].context.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
        const countLabel = matches.length > 1 ? ` <span class="result-count">(${matches.length} matches)</span>` : '';
        div.innerHTML = `<div class="result-path">${path}${countLabel}</div><div class="result-context">${preview}</div>`;
        div.onclick = () => openResult(path);
        c.appendChild(div);
      }
    }
  } catch(e) { c.innerHTML=`<div class="empty-state">Error: ${e.message}</div>`; }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.view-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  document.querySelector(`.view-tab[data-view="${name}"]`)?.classList.add('active');
  if (name==='files') {
    if (!isVMTarget()) {
      // Sync tile path to current canvas level
      const level = currentLevel();
      filesTilePath = level.parentPath ? level.parentPath.split('/') : [];
      if (filesInitialized && filesMode === 'tiles') renderFilesTiles();
    }
    initFilesView();
  }
  if (name==='graph') {
    if (isVMTarget()) {
      initGraphView();
    } else if (filesTilePath.length > 0) {
      // Sync canvas to the folder we were browsing in Files view
      const tilePath = filesTilePath.join('/');
      if (tilePath && currentLevel().parentPath !== tilePath) {
        const nd = nodeById(tilePath);
        if (nd) {
          canvasStack = [{ parentPath: null, label: 'Root' }];
          const parts = tilePath.split('/');
          let path = '';
          for (const part of parts) {
            path = path ? path + '/' + part : part;
            const n = nodeById(path);
            if (n) canvasStack.push({ parentPath: path, label: n.label || part });
          }
          saveCanvasStack();
          renderCurrentLevel();
        }
      }
    }
  }
  if (name==='tags' && !isVMTarget()) initTagCloud();
  if (name==='health' && !isVMTarget()) initHealth();
}

// ========================================
// Chat Panel
// ========================================
// ========================================
// ChatPanel — encapsulates all per-chat state
// ========================================
class ChatPanel {
  constructor(container, options = {}) {
    this.container = container;
    this.ws = null;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.generating = false;
    this.messageQueue = [];
    this.assistantEl = null;
    this.thinkingEl = null;
    this.thinkingWrapper = null;
    this.contextLevel = options.contextLevel || getSmartContextDefault();
    this.contextPath = options.contextPath || null; // Custom context path
    this.messages = options.messages ? [...options.messages] : [];
    this.isTemporary = false;
    this.startTime = null;
    this.tokenCount = 0;
    this.timerInterval = null;
    this.activityGroup = null;
    this.subagents = new Map();
    this.responseText = '';
    this.pendingAgentPrompt = null;
    this.checkpointMode = false;
    this.redirectSnapshot = new Map();
    this.redirectCheckpoints = new Map();
    this.wasUserInterrupt = false;
    this.lastResultUsage = null;
    this.lastResultCost = null;
    this.activePlanPath = null;
    this.activePlanContent = '';
    this.editedFiles = new Set();
    this.readFiles = new Set();
    this.model = null;
    this.messagesContainer = null; // DOM element for this panel's messages
  }
}

// Panel registry and active panel proxy
const chatPanels = new Map(); // panelId → ChatPanel
let activePanel = new ChatPanel(null); // set properly in initChat()
chatPanels.set('main', activePanel);

// ── Background Agents ──
// When a user backgrounds a running agent, we stash its WS + state here.
// The WS keeps receiving events silently. On completion, a toast notification fires.
const backgroundAgents = []; // { id, label, ws, messages, responseText, done, result }

function showToast(text, onclick) {
  const toast = document.createElement('div');
  toast.className = 'loom-toast';
  toast.textContent = text;
  if (onclick) { toast.style.cursor = 'pointer'; toast.onclick = () => { toast.remove(); onclick(); }; }
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 5000);
}

function backgroundCurrentAgent(panelId) {
  const panel = chatPanels.get(panelId);
  if (!panel || !panel.generating || !panel.ws || panel.ws.readyState !== WebSocket.OPEN) return;

  const label = panel.container?.querySelector('.panel-label')?.textContent
    || document.querySelector('#chat-header .panel-label')?.textContent
    || 'Chat';
  const bgId = 'bg-' + Date.now();
  const bgAgent = {
    id: bgId, label, ws: panel.ws,
    messages: [...panel.messages],
    responseText: panel.responseText || '',
    done: false, result: null,
  };

  // Intercept remaining events on the stashed WS
  const origOnmessage = bgAgent.ws.onmessage;
  bgAgent.ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'text_delta' || msg.type === 'text') {
      bgAgent.responseText += msg.text || msg.content || '';
    } else if (msg.type === 'done' || msg.type === 'stopped') {
      bgAgent.done = true;
      bgAgent.result = msg;
      if (bgAgent.responseText) {
        bgAgent.messages.push({ role: 'assistant', content: bgAgent.responseText });
      }
      showToast(`✓ ${bgAgent.label} finished`, () => viewBackgroundAgent(bgAgent));
      updateBackgroundBadge();
    }
  };

  backgroundAgents.push(bgAgent);
  updateBackgroundBadge();

  // Reset the panel for a fresh session — detach the old WS
  panel.ws = null;
  panel.generating = false;
  panel.sessionId = crypto.randomUUID();
  panel.responseText = '';
  panel.assistantEl = null;
  panel.thinkingEl = null;
  panel.thinkingWrapper = null;
  panel.activityGroup = null;
  panel.subagents = new Map();
  panel.startTime = null;
  panel.tokenCount = 0;
  clearInterval(panel.timerInterval);
  panel.timerInterval = null;

  // Clear messages display and array — keep the conversation fresh
  const msgContainer = panel.container?.querySelector('.fcp-messages')
    || document.getElementById('chat-messages');
  if (msgContainer) msgContainer.innerHTML = '';
  panel.messages = [];

  // Sync globals if this was the active panel
  if (panel === activePanel || chatPanels.get(panelId) === activePanel) {
    syncFromPanel(panel);
    const isMainPanel = panelId === 'main';
    if (isMainPanel) {
      document.getElementById('chat-send').style.display = '';
      document.getElementById('chat-stop').style.display = 'none';
      document.getElementById('chat-redirect').style.display = 'none';
    }
  }

  // Update status dot
  const statusDot = panel.container?.querySelector('.panel-status')
    || document.querySelector('#chat-header .panel-status');
  if (statusDot) statusDot.className = 'panel-status';

  showToast(`Backgrounded "${label}" — keep chatting`);
}

function viewBackgroundAgent(bgAgent) {
  // Open a new floating panel showing the background agent's conversation
  const fp = createFloatingPanel({ label: `${bgAgent.label} (done)` });
  if (!fp) return;
  fp.messages = bgAgent.messages;
  const msgContainer = fp.container?.querySelector('.fcp-messages');
  if (msgContainer) {
    for (const msg of bgAgent.messages) {
      const el = document.createElement('div');
      if (msg.role === 'user') {
        el.className = 'chat-msg chat-msg-user';
        el.textContent = msg.content || '';
      } else {
        el.className = 'chat-msg chat-msg-assistant';
        el.innerHTML = marked.parse(msg.content || '');
      }
      msgContainer.appendChild(el);
    }
  }
  // Remove from background list
  const idx = backgroundAgents.indexOf(bgAgent);
  if (idx !== -1) backgroundAgents.splice(idx, 1);
  updateBackgroundBadge();
}

function updateBackgroundBadge() {
  let badge = document.getElementById('bg-agents-badge');
  const running = backgroundAgents.filter(a => !a.done).length;
  const finished = backgroundAgents.filter(a => a.done).length;
  if (!badge && (running + finished) > 0) {
    badge = document.createElement('div');
    badge.id = 'bg-agents-badge';
    badge.title = 'Background agents';
    badge.onclick = () => showBackgroundAgentsList();
    document.body.appendChild(badge);
  }
  if (badge) {
    if (running + finished === 0) {
      badge.remove();
    } else {
      badge.textContent = running > 0 ? `⟳ ${running}` : `✓ ${finished}`;
      badge.className = running > 0 ? 'bg-badge running' : 'bg-badge done';
    }
  }
}

function showBackgroundAgentsList() {
  let list = document.getElementById('bg-agents-list');
  if (list) { list.remove(); return; }
  list = document.createElement('div');
  list.id = 'bg-agents-list';
  for (const agent of backgroundAgents) {
    const row = document.createElement('div');
    row.className = 'bg-agent-row' + (agent.done ? ' done' : '');
    row.innerHTML = `<span>${agent.done ? '✓' : '⟳'} ${agent.label}</span>`;
    row.onclick = () => { list.remove(); if (agent.done) viewBackgroundAgent(agent); };
    list.appendChild(row);
  }
  if (backgroundAgents.length === 0) {
    list.innerHTML = '<div class="bg-agent-row">No background agents</div>';
  }
  document.body.appendChild(list);
  setTimeout(() => document.addEventListener('click', function dismissBgList(e) {
    if (!e.target.closest('#bg-agents-list') && !e.target.closest('#bg-agents-badge')) {
      list.remove(); document.removeEventListener('click', dismissBgList);
    }
  }), 0);
}

// Global proxy — all existing code reads/writes these, which proxy to activePanel.
// This lets us swap activePanel to operate on any panel without changing 400+ lines.
const _proxy = (prop) => ({
  get() { return activePanel[prop]; },
  set(v) { activePanel[prop] = v; },
  configurable: true,
});
// We can't use Object.defineProperty on `let` vars, so we keep them as real vars
// but sync them. Instead, we use a simpler approach: a function that syncs
// globals FROM activePanel before any chat operation, and TO activePanel after.

let chatWs, chatSessionId, chatGenerating, messageQueue, currentAssistantEl;
let currentThinkingEl, currentThinkingWrapper, chatContextLevel, chatMessages;
let chatIsTemporary, chatStartTime, chatTokenCount, chatTimerInterval;
let currentActivityGroup, activeSubagents, currentResponseText, pendingAgentPrompt;
let checkpointMode, redirectSnapshot, redirectCheckpoints, wasUserInterrupt;
let lastResultUsage, lastResultCost, activePlanPath, activePlanContent, sessionEditedFiles, sessionReadFiles;
let chatMessagesContainer = null; // Current panel's messages DOM element
let selectedCards = new Set();

function syncFromPanel(panel) {
  if (!panel) panel = activePanel;
  chatWs = panel.ws; chatSessionId = panel.sessionId;
  chatGenerating = panel.generating; messageQueue = panel.messageQueue;
  currentAssistantEl = panel.assistantEl; currentThinkingEl = panel.thinkingEl;
  currentThinkingWrapper = panel.thinkingWrapper; chatContextLevel = panel.contextLevel;
  chatMessages = panel.messages; chatIsTemporary = panel.isTemporary;
  chatStartTime = panel.startTime; chatTokenCount = panel.tokenCount;
  chatTimerInterval = panel.timerInterval; currentActivityGroup = panel.activityGroup;
  activeSubagents = panel.subagents; currentResponseText = panel.responseText;
  pendingAgentPrompt = panel.pendingAgentPrompt; checkpointMode = panel.checkpointMode;
  redirectSnapshot = panel.redirectSnapshot; redirectCheckpoints = panel.redirectCheckpoints;
  wasUserInterrupt = panel.wasUserInterrupt; lastResultUsage = panel.lastResultUsage;
  lastResultCost = panel.lastResultCost; activePlanPath = panel.activePlanPath;
  activePlanContent = panel.activePlanContent; sessionEditedFiles = panel.editedFiles;
  sessionReadFiles = panel.readFiles;
  chatMessagesContainer = panel.messagesContainer;
}

function syncToPanel(panel) {
  if (!panel) panel = activePanel;
  panel.ws = chatWs; panel.sessionId = chatSessionId;
  panel.generating = chatGenerating; panel.messageQueue = messageQueue;
  panel.assistantEl = currentAssistantEl; panel.thinkingEl = currentThinkingEl;
  panel.thinkingWrapper = currentThinkingWrapper; panel.contextLevel = chatContextLevel;
  panel.messages = chatMessages; panel.isTemporary = chatIsTemporary;
  panel.startTime = chatStartTime; panel.tokenCount = chatTokenCount;
  panel.timerInterval = chatTimerInterval; panel.activityGroup = currentActivityGroup;
  panel.subagents = activeSubagents; panel.responseText = currentResponseText;
  panel.pendingAgentPrompt = pendingAgentPrompt; panel.checkpointMode = checkpointMode;
  panel.redirectSnapshot = redirectSnapshot; panel.redirectCheckpoints = redirectCheckpoints;
  panel.wasUserInterrupt = wasUserInterrupt; panel.lastResultUsage = lastResultUsage;
  panel.lastResultCost = lastResultCost; panel.activePlanPath = activePlanPath;
  panel.activePlanContent = activePlanContent; panel.editedFiles = sessionEditedFiles;
  panel.readFiles = sessionReadFiles;
  panel.messagesContainer = chatMessagesContainer;
}

// Initialize globals from the default panel
syncFromPanel(activePanel);

// --- Panel management ---
let panelCounter = 0;
let chatFocusHistory = ['main']; // Ordered by recency of focus
let chatCycleIndex = -1;
let _cyclingFocus = false; // suppress focus history updates during Cmd+J/Cmd+/ cycling

function getAlivePanels() {
  // Returns IDs of panels that are actually open/visible (not collapsed/minimized)
  const result = [];
  for (const [id, p] of chatPanels) {
    if (id === 'main') {
      const cp = document.getElementById('chat-panel');
      const isOpen = cp.classList.contains('chat-bottom') || cp.classList.contains('chat-right') || cp.classList.contains('chat-float');
      if (isOpen) result.push(id);
    } else if (p.container && !p.container.classList.contains('minimized')) {
      result.push(id);
    }
  }
  const ordered = [...new Set([...chatFocusHistory.filter(id => result.includes(id)), ...result])];
  return ordered;
}

function reopenAnyPanel() {
  // Try to reopen any closed/minimized panel, preferring focus history order
  // First check focus history
  for (const id of chatFocusHistory) {
    if (!chatPanels.has(id)) continue;
    if (id === 'main') {
      const cp = document.getElementById('chat-panel');
      const isClosed = cp.classList.contains('chat-collapsed') || cp.classList.contains('chat-collapsed-right') || cp.classList.contains('chat-collapsed-float');
      if (isClosed) { focusChatPanel('main'); return true; }
    } else {
      const p = chatPanels.get(id);
      if (p?.container?.classList.contains('minimized')) { focusChatPanel(id); return true; }
    }
  }
  // Fallback: main is always there, just uncollapse it
  const cp = document.getElementById('chat-panel');
  if (cp) { focusChatPanel('main'); return true; }
  return false;
}
let chatSoloCycleIndex = -1;

// ========================================
// Action Menu
// ========================================

function closeActionMenu() {
  document.getElementById('action-menu')?.classList.remove('open');
}

async function createNewFile() {
  const name = prompt('File name (e.g. notes.md):');
  if (!name) return;
  // Determine parent path from current context
  const level = currentLevel();
  const parent = level.parentPath || 'wiki';
  const path = `${parent}/${name}`;
  try {
    await fetch(`/api/page/${path}`, {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ frontmatter: {}, content: `# ${name.replace(/\.\w+$/, '')}\n\n` }),
    });
    await refreshFileTree();
  } catch (e) { console.error('Create file failed:', e); }
}

async function createNewFolder() {
  const name = prompt('Folder name:');
  if (!name) return;
  const level = currentLevel();
  const parent = level.parentPath || '';
  const path = parent ? `${parent}/${name}` : name;
  try {
    await authFetch('/api/mkdir', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path }),
    });
    await refreshFileTree();
  } catch (e) { console.error('Create folder failed:', e); }
}

async function deleteCurrentFile() {
  // Collect paths to delete: multi-selected cards > fullpage > last focused
  let paths = [];
  if (selectedCards.size > 0) {
    paths = [...selectedCards].map(c => c.dataset.path).filter(Boolean);
  }
  if (paths.length === 0 && expandedCard?.dataset.path) {
    paths = [expandedCard.dataset.path];
  }
  if (paths.length === 0 && lastFocusedPath) {
    paths = [lastFocusedPath];
  }
  if (paths.length === 0) { alert('No file or folder selected'); return; }

  const msg = paths.length === 1
    ? `Delete "${paths[0]}"?`
    : `Delete ${paths.length} items?\n${paths.join('\n')}`;
  if (!confirm(msg)) return;

  for (const path of paths) {
    try {
      await authFetch('/api/delete', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path }),
      });
    } catch (e) { console.error('Delete failed:', path, e); }
  }
  if (expandedCard) collapseFullPage();
  selectedCards.clear();
  setFocusedItem(null, null);
  await refreshFileTree();
}

function openNewChat() {
  // If main panel is hidden, reopen it
  const cp = document.getElementById('chat-panel');
  if (cp.style.display === 'none') {
    cp.style.display = '';
    cp.classList.add('chat-bottom');
    connectChat();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
    return;
  }
  // Otherwise create a floating panel
  createFloatingPanel();
}

function focusChatPanel(panelId, fromCycle = false) {
  if (!fromCycle) { chatCycleIndex = -1; chatSoloCycleIndex = -1; }
  if (fromCycle) _cyclingFocus = true;
  if (panelId === 'main') {
    const cp = document.getElementById('chat-panel');
    // Uncollapse if collapsed
    if (cp.classList.contains('chat-collapsed') || cp.classList.contains('chat-collapsed-right') || cp.classList.contains('chat-collapsed-float')) {
      const ph = document.querySelector('#chat-header .panel-header');
      if (ph) ph.click();
    }
    if (cp.classList.contains('chat-float')) bringToFront(cp);
    setTimeout(() => { document.getElementById('chat-input')?.focus(); _cyclingFocus = false; }, 100);
  } else {
    const p = chatPanels.get(panelId);
    if (p?.container) {
      p.container.classList.remove('minimized');
      bringToFront(p.container);
      setTimeout(() => { p.container.querySelector('.fcp-input')?.focus(); _cyclingFocus = false; }, 100);
    }
  }
}

function dockPanel(panelId, action) {
  const panel = chatPanels.get(panelId);
  const chatPanelEl = document.getElementById('chat-panel');
  const allStates = ['chat-bottom','chat-right','chat-float','chat-collapsed','chat-collapsed-right','chat-collapsed-float'];

  if (panelId !== 'main') {
    const mainP = chatPanels.get('main');
    syncToPanel(activePanel);

    // Pop out current main as floating (if it has content)
    // DON'T create a new WebSocket — close the popped panel's auto-created one
    // and transfer the main panel's existing WebSocket
    if (mainP.messages.length > 0) {
      const mainLabel = document.querySelector('#chat-header .panel-label')?.textContent || 'Chat';
      const poppedPanel = createFloatingPanel({ fork: false, label: mainLabel });
      if (poppedPanel) {
        // Close the auto-created WebSocket (createFloatingPanel opened one)
        if (poppedPanel.ws && poppedPanel.ws !== mainP.ws) {
          poppedPanel.ws.onclose = null; // Prevent cleanup
          poppedPanel.ws.close();
        }
        // Transfer main's state
        poppedPanel.messages = [...mainP.messages];
        poppedPanel.ws = mainP.ws;
        poppedPanel.sessionId = mainP.sessionId;
        poppedPanel.model = mainP.model;
        poppedPanel.contextLevel = mainP.contextLevel;
        poppedPanel.contextPath = mainP.contextPath;
        // Re-render
        const poppedMsgs = poppedPanel.container?.querySelector('.fcp-messages');
        if (poppedMsgs) {
          poppedMsgs.innerHTML = '';
          for (const msg of poppedPanel.messages) {
            if (msg.role === 'user' || msg.role === 'assistant') {
              const el = document.createElement('div');
              el.className = `chat-msg chat-msg-${msg.role}`;
              el.textContent = msg.content?.slice(0, 200) || '';
              poppedMsgs.appendChild(el);
            }
          }
        }
      }
    }

    // Transfer docking panel's state + label to main
    mainP.ws = panel.ws;
    mainP.sessionId = panel.sessionId;
    sessionStorage.setItem('loom-chat-session', panel.sessionId);
    mainP.messages = [...panel.messages];
    mainP.model = panel.model;
    mainP.contextLevel = panel.contextLevel;
    mainP.contextPath = panel.contextPath;
    const dockingLabel = panel.container?.querySelector('.panel-label')?.textContent;
    const mainLabelEl = document.querySelector('#chat-header .panel-label');
    if (dockingLabel && mainLabelEl) mainLabelEl.textContent = dockingLabel;

    // Re-render main messages
    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML = '';
    for (const msg of panel.messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const el = document.createElement('div');
        el.className = `chat-msg chat-msg-${msg.role}`;
        if (msg.role === 'assistant') el.innerHTML = marked.parse(msg.content || '');
        else el.textContent = msg.content || '';
        messagesEl.appendChild(el);
      }
    }

    // Remove ONLY the docking panel (not others)
    chatPanels.delete(panelId);
    if (panel.container) panel.container.remove();

    activePanel = mainP;
    syncFromPanel(mainP);
  }

  // Set dock mode
  allStates.forEach(c => chatPanelEl.classList.remove(c));
  chatPanelEl.removeAttribute('style');
  if (action === 'dock-right') chatPanelEl.classList.add('chat-right');
  else if (action === 'dock-bottom') chatPanelEl.classList.add('chat-bottom');
  else {
    chatPanelEl.classList.add('chat-float');
    bringToFront(chatPanelEl);
  }

  const _computed = getComputedStyle(chatPanelEl);
  debugLog('[dockPanel] action:', action, 'expandedCard:', !!expandedCard, 'topZIndex:', topZIndex,
    'inline-z:', chatPanelEl.style.getPropertyValue('z-index'),
    'computed-z:', _computed.zIndex, 'position:', _computed.position,
    'w:', chatPanelEl.offsetWidth, 'h:', chatPanelEl.offsetHeight);

  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) connectChat();
}

function createPanelHeader(panelId, label = 'Chat') {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';

  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = `
    <span class="panel-label" contenteditable="true">${label}</span>
    <span class="panel-status"></span>
    <span style="flex:1"></span>
    <button class="panel-menu-btn" title="Options">⋯</button>
    <button class="panel-minimize" title="Minimize">─</button>
    <button class="panel-close" title="Close">✕</button>
  `;

  const menu = document.createElement('div');
  menu.className = 'panel-menu';

  function renderMenu() {
    const panel = chatPanels.get(panelId) || activePanel;
    const model = panel.model || 'sonnet';
    const ctx = panel.contextLevel || 'page';
    const isTemp = panel.isTemporary;

    const customCtx = panel.contextPath || '';
    const ctxLabel = customCtx ? customCtx.split('/').slice(-2).join('/') : '';

    const agent = panel.agentType || 'claude-code';
    const builtinLabels = {'claude-code': 'Claude Code', 'codex': 'Codex', 'generic-cli': 'Custom CLI'};
    const customAgents = JSON.parse(localStorage.getItem('loom-custom-agents') || '[]');
    const agentLabel = builtinLabels[agent] || customAgents.find(a => a.id === agent)?.name || agent;
    const customItems = customAgents.map(a =>
      `<div class="panel-menu-item${agent===a.id?' active':''}" data-action="agent" data-value="${a.id}">${a.name}</div>`
    ).join('');
    menu.innerHTML = `
      <div class="panel-menu-section">
        <div class="panel-menu-label" data-toggle="agent-body">Agent: ${agentLabel}</div>
        <div class="panel-menu-body collapsed" data-id="agent-body">
          <div class="panel-menu-item${agent==='claude-code'?' active':''}" data-action="agent" data-value="claude-code">Claude Code</div>
          <div class="panel-menu-item${agent==='codex'?' active':''}" data-action="agent" data-value="codex">Codex</div>
          ${customItems}
          <div class="panel-menu-item${agent==='generic-cli'?' active':''}" data-action="agent" data-value="generic-cli">Custom CLI</div>
        </div>
      </div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-section">
        <div class="panel-menu-label" data-toggle="model-body">Model: ${model}</div>
        <div class="panel-menu-body collapsed" data-id="model-body">
          <div class="panel-menu-item${model==='sonnet'?' active':''}" data-action="model" data-value="sonnet">Sonnet</div>
          <div class="panel-menu-item${model==='opus'?' active':''}" data-action="model" data-value="opus">Opus</div>
          <div class="panel-menu-item${model==='haiku'?' active':''}" data-action="model" data-value="haiku">Haiku</div>
        </div>
      </div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-section">
        <div class="panel-menu-label" data-toggle="context-body">Context: ${customCtx ? ctxLabel : ctx}</div>
        <div class="panel-menu-body collapsed" data-id="context-body">
          <div class="panel-menu-item${ctx==='page'&&!customCtx?' active':''}" data-action="context" data-value="page">Page</div>
          <div class="panel-menu-item${ctx==='folder'&&!customCtx?' active':''}" data-action="context" data-value="folder">Folder</div>
          <div class="panel-menu-item${ctx==='global'&&!customCtx?' active':''}" data-action="context" data-value="global">Global</div>
          <div class="panel-menu-item${customCtx?' active':''}" data-action="browse">Browse...</div>
        </div>
      </div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-item" data-action="new">+ New Chat</div>
      <div class="panel-menu-item" data-action="fork">⑂ Fork Conversation</div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-item" data-action="temp">${isTemp ? '☑' : '☐'} Temporary</div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-item" data-action="dock-right">Dock Right →</div>
      <div class="panel-menu-item" data-action="dock-bottom">Dock Bottom ↓</div>
      <div class="panel-menu-item" data-action="float">Float ◻</div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-item" data-action="background">⏎ Background Agent</div>
      <div class="panel-menu-sep"></div>
      <div class="panel-menu-item" data-action="clear">Clear Conversation</div>
    `;

    // Wire collapsible section labels
    menu.querySelectorAll('.panel-menu-label[data-toggle]').forEach(label => {
      label.onclick = (e) => {
        e.stopPropagation();
        const body = menu.querySelector(`[data-id="${label.dataset.toggle}"]`);
        if (body) body.classList.toggle('collapsed');
      };
    });
  }

  // Toggle menu
  header.querySelector('.panel-menu-btn').onclick = (e) => {
    e.stopPropagation();
    renderMenu();
    menu.classList.toggle('open');
  };

  // Close menu on click outside
  document.addEventListener('click', () => menu.classList.remove('open'));

  // Handle menu actions
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    e.stopPropagation();
    const action = item.dataset.action;
    const value = item.dataset.value;
    const panel = chatPanels.get(panelId) || activePanel;

    let closeMenu = true;

    if (action === 'agent') {
      // Check auth before switching
      checkAgentAuth(value);
      panel.agentType = value;
      updateInputPlaceholder(panelId);
      // Disconnect current WS so next message creates a fresh adapter
      if (panel.ws && panel.ws.readyState === WebSocket.OPEN) {
        panel.ws.close();
        panel.ws = null;
      }
      panel.sessionId = crypto.randomUUID();
      renderMenu();
      closeMenu = false;
    } else if (action === 'model') {
      panel.model = value;
      if (panel.ws && panel.ws.readyState === WebSocket.OPEN) {
        panel.ws.send(JSON.stringify({ type: 'set_model', model: value }));
      }
      renderMenu(); // Re-render to show new active state
      closeMenu = false;
    } else if (action === 'context') {
      panel.contextLevel = value;
      panel.contextPath = null; // Clear custom path when selecting preset
      syncFromPanel(panel);
      renderMenu();
      closeMenu = false;
    } else if (action === 'browse') {
      // Show a prompt for custom path (simple for now, tree picker later)
      const path = prompt('Enter loom path for context (e.g., wiki/pages/attention):');
      if (path) {
        panel.contextPath = path;
        panel.contextLevel = 'page'; // Will use the custom path
        syncFromPanel(panel);
      }
      renderMenu();
      closeMenu = false;
    } else if (action === 'new') {
      createFloatingPanel();
    } else if (action === 'fork') {
      syncToPanel(activePanel);
      const prev = activePanel;
      activePanel = panel;
      syncFromPanel(panel);
      createFloatingPanel({ fork: true });
      activePanel = prev;
      syncFromPanel(prev);
    } else if (action === 'temp') {
      panel.isTemporary = !panel.isTemporary;
      renderMenu();
      closeMenu = false;
    } else if (action === 'dock-right' || action === 'dock-bottom' || action === 'float') {
      dockPanel(panelId, action);
    } else if (action === 'background') {
      backgroundCurrentAgent(panelId);
    } else if (action === 'clear') {
      syncToPanel(activePanel);
      activePanel = panel;
      syncFromPanel(panel);
      saveChatTranscript();
      const msgContainer = panel.container?.querySelector('.fcp-messages') || document.getElementById('chat-messages');
      if (msgContainer) msgContainer.innerHTML = '';
      chatMessages = [];
      chatSessionId = crypto.randomUUID();
      panel.sessionId = chatSessionId;
      syncToPanel(panel);
    }

    if (closeMenu) menu.classList.remove('open');
  });

  // Label editing
  const labelEl = header.querySelector('.panel-label');
  labelEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); labelEl.blur(); } });
  labelEl.addEventListener('focus', () => { labelEl.style.cursor = 'text'; });


  // Minimize button + header click both toggle minimize
  function toggleMinimize() {
    const panel = chatPanels.get(panelId);
    if (panelId === 'main') {
      const cp = document.getElementById('chat-panel');
      const before = { classes: [...cp.classList], style: cp.style.cssText, size: `${cp.offsetWidth}x${cp.offsetHeight}` };
      const isOpen = cp.classList.contains('chat-bottom') || cp.classList.contains('chat-right') || cp.classList.contains('chat-float');
      // Detect mode from both open AND collapsed classes
      let mode = 'bottom';
      if (cp.classList.contains('chat-right') || cp.classList.contains('chat-collapsed-right')) mode = 'right';
      else if (cp.classList.contains('chat-float') || cp.classList.contains('chat-collapsed-float')) mode = 'float';

      if (isOpen) {
        // Collapsing — save position and z-index for float, clear size styles
        const pos = mode === 'float' ? { left: cp.style.left, top: cp.style.top } : null;
        const savedZ = cp.style.getPropertyValue('z-index');
        const savedZPriority = cp.style.getPropertyPriority('z-index');
        cp.removeAttribute('style');
        if (pos) { cp.style.left = pos.left; cp.style.top = pos.top; }
        if (savedZ) cp.style.setProperty('z-index', savedZ, savedZPriority);

        ['chat-bottom','chat-right','chat-float'].forEach(c => cp.classList.remove(c));
        const collapsed = mode === 'right' ? 'chat-collapsed-right' : mode === 'float' ? 'chat-collapsed-float' : 'chat-collapsed';
        cp.classList.add(collapsed);
      } else {
        // Expanding — save position for float, clear everything
        const pos = mode === 'float' ? { left: cp.style.left, top: cp.style.top } : null;
        cp.removeAttribute('style');
        if (pos) { cp.style.left = pos.left; cp.style.top = pos.top; }

        ['chat-collapsed','chat-collapsed-right','chat-collapsed-float'].forEach(c => cp.classList.remove(c));
        cp.classList.add('chat-' + mode);
        connectChat();
        setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
      }
    } else {
      const card = panel?.container;
      if (card) card.classList.toggle('minimized');
    }
  }

  header.querySelector('.panel-minimize').onclick = (e) => { e.stopPropagation(); toggleMinimize(); };

  // Header click toggles minimize, with delay to allow dblclick to cancel
  let _headerDragged = false;
  let _clickTimer = null;
  header._setDragged = () => { _headerDragged = true; };
  header._cancelClick = () => { if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; } };
  header.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.panel-menu') || e.target.closest('[contenteditable]')) return;
    if (_headerDragged) { _headerDragged = false; return; }
    if (_clickTimer) return; // Already waiting
    e.stopPropagation();
    _clickTimer = setTimeout(() => { _clickTimer = null; toggleMinimize(); }, 150);
  });

  // Double-click header to maximize/restore (floating panels)
  let _floatMaximized = false;
  let _floatPreMaxState = null;
  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('.panel-menu') || e.target.closest('[contenteditable]')) return;
    if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }

    if (panelId === 'main') return; // Let it propagate to initChat's dblclick handler
    e.stopPropagation();

    const card = chatPanels.get(panelId)?.container;
    if (!card) return;

    if (_floatMaximized) {
      card.style.left = _floatPreMaxState.left;
      card.style.top = _floatPreMaxState.top;
      card.style.width = _floatPreMaxState.width;
      card.style.height = _floatPreMaxState.height;
      _floatMaximized = false;
    } else {
      _floatPreMaxState = { left: card.style.left, top: card.style.top, width: card.style.width, height: card.style.height };
      card.style.left = '0'; card.style.top = '0';
      card.style.width = '100%'; card.style.height = '100%';
      _floatMaximized = true;
    }
  });

  // Close button
  header.querySelector('.panel-close').onclick = (e) => {
    e.stopPropagation();
    const panel = chatPanels.get(panelId);

    if (panelId === 'main') {
      // Close main: sync state first, then save, then hide
      const mainP = chatPanels.get('main');
      syncFromPanel(mainP);
      if (chatMessages.length > 0 && !chatIsTemporary) {
        saveChatTranscript();
      }
      const cp = document.getElementById('chat-panel');
      cp.removeAttribute('style');
      ['chat-bottom','chat-right','chat-float','chat-collapsed','chat-collapsed-right','chat-collapsed-float'].forEach(c => cp.classList.remove(c));
      cp.style.display = 'none';
      document.getElementById('chat-messages').innerHTML = '';
      if (mainP?.ws) { mainP.ws.close(); mainP.ws = null; }
      chatMessages = [];
      chatWs = null;
      chatSessionId = crypto.randomUUID();
      syncToPanel(mainP);
    } else {
      // Floating panel: save transcript, close and remove
      if (panel && panel.messages.length > 0 && !panel.isTemporary) {
        // Only save NEW messages (not the forked history that was injected)
        const newMsgs = panel._forkedHistory
          ? panel.messages.slice(panel._forkedHistory.length)
          : panel.messages;
        if (newMsgs.length > 0) {
          if (panel._continuedFromPath) {
            // Append to original file
            authFetch('/api/chat/append', {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ path: panel._continuedFromPath, session_id: panel.sessionId, messages: newMsgs }),
            }).then(() => refreshFileTree()).catch(() => {});
          } else {
            const panelTitle = panel._generatedTitle || null;
            authFetch('/api/chat/save', {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ session_id: panel.sessionId, messages: newMsgs, title: panelTitle, context_path: panel.contextPath || null }),
            }).then(r => r.json()).then(data => {
              refreshFileTree();
              if (!panelTitle && data.ok && data.path && newMsgs.some(m => m.role === 'user')) {
                generateAndUpdateTitle(data.path, newMsgs);
              }
            }).catch(() => {});
          }
        }
      }
      if (panel?.ws) panel.ws.close();
      chatPanels.delete(panelId);
      chatFocusHistory = chatFocusHistory.filter(id => id !== panelId);
      panel?.container?.remove();
    }
  };

  wrapper.appendChild(header);
  wrapper.appendChild(menu);
  return { wrapper, header, menu, statusEl: header.querySelector('.panel-status'), labelEl };
}

function createFloatingPanel(options = {}) {
  if (chatPanels.size >= 6) { alert('Max 6 chat panels'); return null; }
  const panelId = 'panel-' + (++panelCounter);
  const ctxName = options.contextPath ? options.contextPath.split('/').pop() : '';
  const label = options.label || (options.contextPath ? `Chat: ${ctxName}` : (options.fork ? `Fork ${panelCounter}` : `Chat ${panelCounter}`));
  // Fork from the last focused panel, not necessarily the main panel
  const sourceId = chatFocusHistory[0] || 'main';
  const sourcePanel = chatPanels.get(sourceId) || activePanel;
  const panel = new ChatPanel(null, {
    sessionId: crypto.randomUUID(),
    messages: options.fork ? [...sourcePanel.messages] : [],
    contextLevel: options.contextPath ? 'page' : sourcePanel.contextLevel,
    contextPath: options.contextPath || null,
  });

  // Create floating card
  const card = document.createElement('div');
  card.className = 'floating-chat-panel';
  card.dataset.panelId = panelId;

  // Resize handles
  for (const dir of ['right', 'bottom', 'left', 'top', 'corner']) {
    const handle = document.createElement('div');
    handle.className = `fcp-resize fcp-resize-${dir}`;
    handle.addEventListener('pointerdown', (re) => {
      re.preventDefault(); re.stopPropagation();
      const rect = card.getBoundingClientRect();
      const startX = re.clientX, startY = re.clientY;
      const startW = rect.width, startH = rect.height;
      const startL = rect.left, startT = rect.top;
      function onMove(me) {
        const dx = me.clientX - startX, dy = me.clientY - startY;
        if (dir === 'right' || dir === 'corner') card.style.width = Math.max(280, startW + dx) + 'px';
        if (dir === 'bottom' || dir === 'corner') card.style.height = Math.max(200, startH + dy) + 'px';
        if (dir === 'left') { card.style.width = Math.max(280, startW - dx) + 'px'; card.style.left = Math.max(0, startL + dx) + 'px'; }
        if (dir === 'top') { card.style.height = Math.max(200, startH - dy) + 'px'; card.style.top = Math.max(0, startT + dy) + 'px'; }
      }
      function onUp() { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    card.appendChild(handle);
  }

  // Universal header
  const { wrapper: headerWrapper, header: headerEl } = createPanelHeader(panelId, label);
  card.appendChild(headerWrapper);

  // Messages area
  const messagesEl = document.createElement('div');
  messagesEl.className = 'fcp-messages';
  card.appendChild(messagesEl);

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'fcp-input-area';
  const input = document.createElement('textarea');
  input.className = 'fcp-input';
  input.placeholder = 'Message Claude\u2026';
  input.rows = 1;
  const sendBtn = document.createElement('button');
  sendBtn.className = 'fcp-send';
  sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 12V4M4 7L8 3L12 7"/></svg>';
  sendBtn.title = 'Send (Enter)';
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  const attachBar = document.createElement('div');
  attachBar.className = 'chat-attachments';
  attachBar.style.display = 'none';

  // Pills row with context chip (matching main panel structure)
  const pillsRow = document.createElement('div');
  pillsRow.className = 'chat-input-pills';
  const ctxChip = document.createElement('span');
  ctxChip.className = 'chat-context-chip';
  ctxChip.title = 'Click to cycle context level';
  ctxChip.innerHTML = `<svg class="ctx-icon" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6" cy="6" r="4"/><path d="M6 3V6L8 7.5"/></svg>
    <span class="ctx-label">ctx:</span>
    <span class="ctx-scope">${panel.contextLevel || 'page'}</span>
    <span class="ctx-sep">&middot;</span>
    <span class="ctx-tokens">~1K</span>
    <span class="ctx-sep">/</span>
    <span class="ctx-max">200K</span>
    <span class="ctx-bar"><span class="ctx-bar-fill" style="width:0%"></span></span>`;
  ctxChip.onclick = (e) => {
    e.stopPropagation();
    openContextPopover(ctxChip, panel);
  };
  pillsRow.appendChild(ctxChip);
  // Fetch real token count on creation
  updateChipTokens(ctxChip, panel);

  inputArea.appendChild(attachBar);
  inputArea.appendChild(pillsRow);
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);
  inputArea.appendChild(inputRow);
  card.appendChild(inputArea);

  card.style.left = (150 + panelCounter * 30) + 'px';
  card.style.top = (100 + panelCounter * 30) + 'px';

  document.getElementById('canvas-container').appendChild(card);
  bringToFront(card);
  // If fullpage is open, elevate above it
  panel.container = card;
  panel.messagesContainer = messagesEl;
  chatPanels.set(panelId, panel);

  // Pre-fill input with quoted text and auto-resize
  if (options.prefill) {
    input.value = options.prefill;
    // Trigger auto-resize after the element is in the DOM
    requestAnimationFrame(() => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      input.focus();
      input.selectionStart = input.selectionEnd = input.value.length;
    });
  }

  // Render forked messages with full content
  if (options.fork && panel.messages.length) {
    for (const msg of panel.messages) {
      if (msg.role === 'user') {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-user';
        el.textContent = msg.content || '';
        messagesEl.appendChild(el);
      } else if (msg.role === 'assistant') {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-assistant';
        el.innerHTML = marked.parse(msg.content || '');
        messagesEl.appendChild(el);
      }
    }
    // Add a visual separator
    const sep = document.createElement('div');
    sep.className = 'chat-fork-separator';
    sep.textContent = '— forked from here —';
    messagesEl.appendChild(sep);
    // Store history for first message context injection
    panel._forkedHistory = panel.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  }

  // Message queue for floating panel
  panel._messageQueue = [];

  function sendFloatingMessage(text) {
    // If forked, prepend conversation history to first message
    let sendText = text;
    if (panel._forkedHistory) {
      const historyStr = panel._forkedHistory.map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');
      sendText = `This is a forked conversation. Here is the prior conversation history:\n\n${historyStr}\n\n---\n\nNow continuing from here:\n\n${text}`;
      panel._forkedHistory = null;
    }

    panel.ws.send(JSON.stringify({
      type: 'message', text: sendText,
      context_level: panel.contextLevel,
      context: { page_path: panel.contextPath || currentLevel().parentPath || '' },
    }));

    panel.generating = true;
    panel.startTime = Date.now();
    const statusDot = panel.container?.querySelector('.panel-status');
    if (statusDot) statusDot.className = 'panel-status generating';
  }

  // Send handler — uses panel directly, never touches activePanel/globals
  sendBtn.onclick = () => {
    let text = input.value.trim();
    // Append image paths if any
    if (panel._pendingImages && panel._pendingImages.length > 0) {
      const imagePaths = panel._pendingImages.map(i => i.path);
      text += (text ? '\n\n' : '') + imagePaths.map(p => `[Pasted image: ${p}]`).join('\n');
      card.querySelectorAll('.chat-image-preview').forEach(el => el.remove());
      panel._pendingImages.length = 0;
    }
    if (!text) return;

    if (!panel.ws || panel.ws.readyState !== WebSocket.OPEN) {
      connectPanelChat(panel, messagesEl);
      setTimeout(() => sendBtn.click(), 500);
      return;
    }

    const userEl = document.createElement('div');
    userEl.className = 'chat-msg chat-msg-user';
    userEl.textContent = text;
    // Show sent images inline in user message
    const sentImgs = panel._pendingImages ? [...panel._pendingImages] : [];
    if (sentImgs.length > 0) {
      const imgRow = document.createElement('div');
      imgRow.className = 'chat-msg-images';
      sentImgs.forEach(i => {
        const img = document.createElement('img');
        img.src = i.url;
        img.alt = 'Image';
        img.style.cursor = 'pointer';
        img.onclick = () => showImageLightbox(i.url);
        imgRow.appendChild(img);
      });
      userEl.appendChild(imgRow);
    }
    messagesEl.appendChild(userEl);
    panel.messages.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto';

    if (panel.generating) {
      // Queue it — show as queued
      userEl.classList.add('chat-msg-queued');
      panel._messageQueue.push({ text, el: userEl });
      return;
    }

    sendFloatingMessage(text);
    panel.tokenCount = 0;

    const assistantEl = document.createElement('div');
    assistantEl.className = 'chat-msg chat-msg-assistant';
    const fpModel = panel.model || 'sonnet';
    assistantEl.dataset.model = fpModel;
    const sb = document.createElement('div');
    sb.className = 'chat-status-bar chat-active-status';
    sb.innerHTML = `<span class="pondering">${randomPonderingWord()}...</span> <span class="chat-elapsed">0.0s</span> <span class="chat-tokens">0 tokens</span><span class="model-pill" data-model="${fpModel}"><span class="dot"></span>${fpModel}</span>`;
    assistantEl.appendChild(sb);
    messagesEl.appendChild(assistantEl);
    panel.assistantEl = assistantEl;

    // Timer for this panel
    if (panel.timerInterval) clearInterval(panel.timerInterval);
    panel.timerInterval = setInterval(() => {
      const el = assistantEl.querySelector('.chat-elapsed');
      if (el && panel.startTime) el.textContent = ((Date.now() - panel.startTime) / 1000).toFixed(1) + 's';
      const tokEl = assistantEl.querySelector('.chat-tokens');
      if (tokEl) tokEl.textContent = panel.tokenCount + ' tokens';
    }, 100);
  };

  input.addEventListener('focus', () => {
    if (_cyclingFocus) return;
    chatFocusHistory = chatFocusHistory.filter(id => id !== panelId);
    chatFocusHistory.unshift(panelId);
  });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  };

  // Image paste support for floating panel
  panel._pendingImages = [];
  setupImagePaste(input, () => attachBar, () => panel._pendingImages);

  // Draggable header with dead zone to distinguish from click
  let dragReady = false, dragging = false, startX, startY, dx, dy;
  card.addEventListener('pointerdown', () => bringToFront(card), true);
  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('.panel-menu') || e.target.closest('[contenteditable]')) return;
    dragReady = true; dragging = false;
    startX = e.clientX; startY = e.clientY;
    dx = e.clientX - card.offsetLeft;
    dy = e.clientY - card.offsetTop;
    headerEl.setPointerCapture(e.pointerId);
  });
  headerEl.addEventListener('pointermove', (e) => {
    if (!dragReady) return;
    if (!dragging && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) return;
    dragging = true;
    headerEl._setDragged();
    card.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 100)) + 'px';
    card.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 50)) + 'px';
  });
  headerEl.addEventListener('pointerup', (e) => {
    if (dragging) {
      // Proximity dock: snap if dragged near edges
      const vw = window.innerWidth, vh = window.innerHeight;
      if (e.clientX > vw - 40) {
        dockPanel(panelId, 'dock-right');
      } else if (e.clientY > vh - 120) {
        dockPanel(panelId, 'dock-bottom');
      }
    }
    dragReady = false; dragging = false;
  });

  // Connect WebSocket
  connectPanelChat(panel, messagesEl);

  // Focus input
  setTimeout(() => input.focus(), 100);

  return panel;
}

function connectPanelChat(panel, messagesEl) {
  const tokenParam = getTokenParam();
  const wsUrl = `${getWsUrl()}/ws/chat${tokenParam ? '?' + tokenParam : ''}`;
  try {
    panel.ws = new WebSocket(wsUrl);
  } catch (e) { return; }

  const thisWs = panel.ws;

  thisWs.onopen = () => {
    thisWs.send(JSON.stringify({
      type: 'init',
      session_id: panel.sessionId,
      page_path: panel.contextPath || (isVMTarget() ? `vm:${currentTarget.id}` : currentLevel().parentPath) || '',
      agent: resolveAgentType(panel.agentType),
      agent_command: resolveAgentCommand(panel.agentType),
    }));
    thisWs.send(JSON.stringify({ type: 'set_permissions', rules: getPermissionRules() }));
  };

  // Queue events and process without corrupting main panel's globals
  const eventQueue = [];
  let processing = false;

  function processQueue() {
    if (processing || eventQueue.length === 0) return;
    processing = true;
    const msg = eventQueue.shift();

    // Save main panel's globals, swap in this panel's state
    const saved = {
      ws: chatWs, sessionId: chatSessionId, generating: chatGenerating,
      assistantEl: currentAssistantEl, thinkingEl: currentThinkingEl,
      thinkingWrapper: currentThinkingWrapper, activityGroup: currentActivityGroup,
      subagents: activeSubagents, responseText: currentResponseText,
      messages: chatMessages, tokenCount: chatTokenCount, startTime: chatStartTime,
      timerInterval: chatTimerInterval, msgContainer: chatMessagesContainer,
      pendingAgentPrompt: pendingAgentPrompt, editedFiles: sessionEditedFiles,
      lastResultUsage: lastResultUsage, lastResultCost: lastResultCost,
      messageQueue: messageQueue, wasUserInterrupt: wasUserInterrupt,
      contextLevel: chatContextLevel, isTemporary: chatIsTemporary,
    };

    // Load this panel's state into globals
    chatWs = panel.ws; chatSessionId = panel.sessionId;
    chatGenerating = panel.generating; currentAssistantEl = panel.assistantEl;
    currentThinkingEl = panel.thinkingEl; currentThinkingWrapper = panel.thinkingWrapper;
    currentActivityGroup = panel.activityGroup; activeSubagents = panel.subagents;
    currentResponseText = panel.responseText; chatMessages = panel.messages;
    chatTokenCount = panel.tokenCount; chatStartTime = panel.startTime;
    chatTimerInterval = panel.timerInterval; chatMessagesContainer = panel.messagesContainer;
    pendingAgentPrompt = panel.pendingAgentPrompt; sessionEditedFiles = panel.editedFiles;
    lastResultUsage = panel.lastResultUsage; lastResultCost = panel.lastResultCost;
    // Don't swap messageQueue — floating panel queue is panel._messageQueue, drained by processQueue.
    // Just null it so handleChatEvent's main-panel queue drain doesn't fire.
    messageQueue = []; wasUserInterrupt = panel.wasUserInterrupt || false;
    chatContextLevel = panel.contextLevel; chatIsTemporary = panel.isTemporary;

    handleChatEvent(msg);

    // Generate title and drain queue after done event
    if (msg.type === 'done' || msg.type === 'stopped') {
      // Update status dot and notify if panel was backgrounded (minimized while generating)
      const statusDot = panel.container?.querySelector('.panel-status');
      if (statusDot) statusDot.className = 'panel-status connected';
      if (panel.container?.classList.contains('minimized')) {
        const panelLabel = panel.container.querySelector('.panel-label')?.textContent || 'Chat';
        showToast(`${panelLabel} finished`, () => {
          panel.container.classList.remove('minimized');
          bringToFront(panel.container);
        });
      }
      maybeGenerateChatTitle(panel);
      // Process queued messages for this floating panel
      if (panel._messageQueue && panel._messageQueue.length > 0) {
        // Combine all queued messages into one
        const queued = panel._messageQueue.splice(0);
        const combined = queued.map(q => q.text).join('\n\n');
        queued.forEach(q => { if (q.el) q.el.classList.remove('chat-msg-queued'); });
        if (panel.ws?.readyState === WebSocket.OPEN) {
          panel.ws.send(JSON.stringify({
            type: 'message', text: combined,
            context_level: panel.contextLevel,
            context: { page_path: panel.contextPath || currentLevel().parentPath || '' },
          }));
          panel.generating = true;
          panel.startTime = Date.now();
          panel.tokenCount = 0;
        }
      }
    }

    // Save this panel's state back (but NOT ws — it's managed separately)
    panel.sessionId = chatSessionId;
    panel.generating = chatGenerating; panel.assistantEl = currentAssistantEl;
    panel.thinkingEl = currentThinkingEl; panel.thinkingWrapper = currentThinkingWrapper;
    panel.activityGroup = currentActivityGroup; panel.subagents = activeSubagents;
    panel.responseText = currentResponseText; panel.messages = chatMessages;
    panel.tokenCount = chatTokenCount; panel.startTime = chatStartTime;
    panel.timerInterval = chatTimerInterval; panel.editedFiles = sessionEditedFiles;
    panel.lastResultUsage = lastResultUsage; panel.lastResultCost = lastResultCost;
    // Don't save messageQueue back — floating panel queue is panel._messageQueue, managed separately.
    panel.wasUserInterrupt = wasUserInterrupt;
    panel.contextLevel = chatContextLevel; panel.isTemporary = chatIsTemporary;

    // Restore main panel's globals
    chatWs = saved.ws; chatSessionId = saved.sessionId;
    chatGenerating = saved.generating; currentAssistantEl = saved.assistantEl;
    currentThinkingEl = saved.thinkingEl; currentThinkingWrapper = saved.thinkingWrapper;
    currentActivityGroup = saved.activityGroup; activeSubagents = saved.subagents;
    currentResponseText = saved.responseText; chatMessages = saved.messages;
    chatTokenCount = saved.tokenCount; chatStartTime = saved.startTime;
    chatTimerInterval = saved.timerInterval; chatMessagesContainer = saved.msgContainer;
    pendingAgentPrompt = saved.pendingAgentPrompt; sessionEditedFiles = saved.editedFiles;
    lastResultUsage = saved.lastResultUsage; lastResultCost = saved.lastResultCost;
    messageQueue = saved.messageQueue; wasUserInterrupt = saved.wasUserInterrupt;
    chatContextLevel = saved.contextLevel; chatIsTemporary = saved.isTemporary;

    processing = false;
    if (eventQueue.length > 0) setTimeout(processQueue, 0);
  }

  thisWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const panelKey = [...chatPanels.entries()].find(([k, p]) => p === panel)?.[0] || 'orphaned';
    eventQueue.push(msg);
    processQueue();
  };

  thisWs.onclose = () => { if (panel.ws === thisWs) panel.ws = null; };
}

// ========================================
// Terminal Panels
// ========================================
let terminalCounter = 0;

const _activeTerminals = new Set();

function updateAllTerminalThemes() {
  const theme = getTerminalTheme();
  for (const term of _activeTerminals) {
    try { term.options.theme = theme; } catch {}
  }
}
window.updateAllTerminalThemes = updateAllTerminalThemes;

function closeAllDropdowns() {
  document.getElementById('settings-dropdown')?.classList.add('hidden');
  document.getElementById('target-dropdown')?.classList.add('hidden');
  document.getElementById('action-menu')?.classList.remove('open');
  document.getElementById('toolbar-menu')?.classList.remove('open');
  document.querySelectorAll('.palette').forEach(p => p.classList.add('hidden'));
}

function getTerminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (prop, fallback) => cs.getPropertyValue(prop).trim() || fallback;
  return {
    background: get('--bg', '#1a1b26'),
    foreground: get('--text', '#c0caf5'),
    cursor: get('--text-bright', '#c0caf5'),
    selectionBackground: get('--accent-soft', '#33467c'),
    black: get('--bg-sunken', '#15161e'),
    red: get('--red', '#f7768e'),
    green: get('--green', '#9ece6a'),
    yellow: get('--yellow', '#e0af68'),
    blue: get('--accent', '#7aa2f7'),
    magenta: get('--accent2', '#bb9af7'),
    cyan: get('--cyan', '#7dcfff'),
    white: get('--text', '#a9b1d6'),
  };
}

function createTerminalPanel() {
  const id = ++terminalCounter;
  const card = document.createElement('div');
  card.className = 'floating-chat-panel floating-terminal';
  card.style.width = '500px';
  card.style.height = '350px';
  card.style.left = (120 + id * 30) + 'px';
  card.style.top = (80 + id * 30) + 'px';

  // Header
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.innerHTML = `
    <span class="panel-label" contenteditable="true">Terminal ${id}</span>
    <span style="flex:1"></span>
    <button class="panel-minimize" title="Minimize">─</button>
    <button class="panel-close" title="Close">✕</button>
  `;
  card.appendChild(header);

  // Terminal container
  const termContainer = document.createElement('div');
  termContainer.className = 'terminal-container';
  card.appendChild(termContainer);

  // Resize handles
  for (const dir of ['right', 'bottom', 'left', 'top', 'corner']) {
    const handle = document.createElement('div');
    handle.className = `fcp-resize fcp-resize-${dir}`;
    handle.addEventListener('pointerdown', (re) => {
      re.preventDefault(); re.stopPropagation();
      const rect = card.getBoundingClientRect();
      const startX = re.clientX, startY = re.clientY;
      const startW = rect.width, startH = rect.height;
      const startL = rect.left, startT = rect.top;
      function onMove(me) {
        const dx = me.clientX - startX, dy = me.clientY - startY;
        if (dir === 'right' || dir === 'corner') card.style.width = Math.max(300, startW + dx) + 'px';
        if (dir === 'bottom' || dir === 'corner') card.style.height = Math.max(200, startH + dy) + 'px';
        if (dir === 'left') { card.style.width = Math.max(300, startW - dx) + 'px'; card.style.left = Math.max(0, startL + dx) + 'px'; }
        if (dir === 'top') { card.style.height = Math.max(200, startH - dy) + 'px'; card.style.top = Math.max(0, startT + dy) + 'px'; }
        if (fitAddon) fitAddon.fit();
      }
      function onUp() { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    card.appendChild(handle);
  }

  document.getElementById('canvas-container').appendChild(card);
  card.addEventListener('pointerdown', () => bringToFront(card), true);
  bringToFront(card);

  // Draggable
  let dragging = false, dragReady = false, startX, startY, dx, dy;
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('[contenteditable]')) return;
    dragReady = true; dragging = false;
    startX = e.clientX; startY = e.clientY;
    dx = e.clientX - card.offsetLeft; dy = e.clientY - card.offsetTop;
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener('pointermove', (e) => {
    if (!dragReady) return;
    if (!dragging && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) return;
    dragging = true;
    card.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 100)) + 'px';
    card.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 50)) + 'px';
  });
  header.addEventListener('pointerup', () => { dragReady = false; });
  // Reset dragging flag after click event fires (click fires after pointerup)
  header.addEventListener('pointerup', () => { setTimeout(() => { dragging = false; }, 0); });

  // Close / minimize
  header.querySelector('.panel-close').onclick = (e) => { e.stopPropagation(); if (ws) ws.close(); _activeTerminals.delete(term); card.remove(); };
  header.querySelector('.panel-minimize').onclick = (e) => { e.stopPropagation(); card.classList.toggle('minimized'); };

  // Header click toggles minimize (with drag guard)
  header.addEventListener('click', (e) => {
    if (dragging) return;
    if (e.target.closest('button') || e.target.closest('[contenteditable]')) return;
    const now = Date.now();
    if (now - _termLastClick < 300) {
      // Double click — ignore (could add fullscreen later)
    } else {
      card.classList.toggle('minimized');
      if (!card.classList.contains('minimized') && typeof fitAddon?.fit === 'function') {
        requestAnimationFrame(() => fitAddon.fit());
      }
    }
    _termLastClick = now;
  });

  // xterm.js loaded via script tags
  const XTerm = window.Terminal;
  const XFitAddon = window.FitAddon?.FitAddon || window.FitAddon;
  if (!XTerm) { console.error('xterm.js not loaded'); return; }

  const term = new XTerm({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: getTerminalTheme(),
  });
  const fitAddon = XFitAddon ? new XFitAddon() : null;
  if (fitAddon) term.loadAddon(fitAddon);
  term.open(termContainer);
  _activeTerminals.add(term);
  if (fitAddon) fitAddon.fit();

  // WebSocket to backend PTY
  debugLog('[TERM] connecting to ws/terminal');
  const ws = new WebSocket(`${getWsUrl()}/ws/terminal?${getTokenParam()}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    debugLog('[TERM] ws connected');
    ws.send(`RESIZE:${term.cols}:${term.rows}`);
  };
  ws.onerror = (e) => { console.error('[TERM] ws error:', e); };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(e.data));
    } else {
      term.write(e.data);
    }
  };

  ws.onclose = (e) => { debugLog('[TERM] ws closed, code:', e.code, 'reason:', e.reason); term.write('\r\n[Session ended]\r\n'); };

  term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(`RESIZE:${cols}:${rows}`); });

  // Refit on window resize
  const resizeObs = new ResizeObserver(() => fitAddon.fit());
  resizeObs.observe(termContainer);
}

// Claude Code's actual 187 pondering words — one random word per call
const ponderingWords = ["Accomplishing","Actioning","Actualizing","Architecting","Baking","Beaming","Beboppin'","Befuddling","Billowing","Blanching","Bloviating","Boogieing","Boondoggling","Booping","Bootstrapping","Brewing","Bunning","Burrowing","Calculating","Canoodling","Caramelizing","Cascading","Catapulting","Cerebrating","Channeling","Channelling","Choreographing","Churning","Clauding","Coalescing","Cogitating","Combobulating","Composing","Computing","Concocting","Considering","Contemplating","Cooking","Crafting","Creating","Crunching","Crystallizing","Cultivating","Deciphering","Deliberating","Determining","Dilly-dallying","Discombobulating","Doing","Doodling","Drizzling","Ebbing","Effecting","Elucidating","Embellishing","Enchanting","Envisioning","Evaporating","Fermenting","Fiddle-faddling","Finagling","Flambéing","Flibbertigibbeting","Flowing","Flummoxing","Fluttering","Forging","Forming","Frolicking","Frosting","Gallivanting","Galloping","Garnishing","Generating","Gesticulating","Germinating","Gitifying","Grooving","Gusting","Harmonizing","Hashing","Hatching","Herding","Honking","Hullaballooing","Hyperspacing","Ideating","Imagining","Improvising","Incubating","Inferring","Infusing","Ionizing","Jitterbugging","Julienning","Kneading","Leavening","Levitating","Lollygagging","Manifesting","Marinating","Meandering","Metamorphosing","Misting","Moonwalking","Moseying","Mulling","Mustering","Musing","Nebulizing","Nesting","Newspapering","Noodling","Nucleating","Orbiting","Orchestrating","Osmosing","Perambulating","Percolating","Perusing","Philosophising","Photosynthesizing","Pollinating","Pondering","Pontificating","Pouncing","Precipitating","Prestidigitating","Processing","Proofing","Propagating","Puttering","Puzzling","Quantumizing","Razzle-dazzling","Razzmatazzing","Recombobulating","Reticulating","Roosting","Ruminating","Sautéing","Scampering","Schlepping","Scurrying","Seasoning","Shenaniganing","Shimmying","Simmering","Skedaddling","Sketching","Slithering","Smooshing","Sock-hopping","Spelunking","Spinning","Sprouting","Stewing","Sublimating","Swirling","Swooping","Symbioting","Synthesizing","Tempering","Thinking","Thundering","Tinkering","Tomfoolering","Topsy-turvying","Transfiguring","Transmuting","Twisting","Undulating","Unfurling","Unravelling","Vibing","Waddling","Wandering","Warping","Whatchamacalliting","Whirlpooling","Whirring","Whisking","Wibbling","Working","Wrangling","Zesting","Zigzagging"];

function randomPonderingWord() {
  return ponderingWords[Math.floor(Math.random() * ponderingWords.length)];
}

function initChat() {
  const panel = document.getElementById('chat-panel');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');

  // Bring main chat to front on any interaction when floating
  panel.addEventListener('pointerdown', () => {
    if (panel.classList.contains('chat-float')) bringToFront(panel);
  }, true);

  // Inject universal header into main chat panel
  const mainHeaderContainer = document.getElementById('chat-header');
  const { wrapper: headerWrapper, statusEl: mainStatusEl } = createPanelHeader('main', 'Chat');
  mainHeaderContainer.appendChild(headerWrapper);
  mainHeaderContainer._statusEl = mainStatusEl;

  // Set the main panel's messages container
  activePanel.messagesContainer = document.getElementById('chat-messages');
  chatMessagesContainer = activePanel.messagesContainer;

  // Context chip — click to open popover (uses shared function)
  const ctxChip = document.getElementById('chat-context-chip');
  if (ctxChip) {
    ctxChip.onclick = (e) => {
      e.stopPropagation();
      openContextPopover(ctxChip, activePanel);
    };
    updateContextChip();
  }

  // Chat search — Cmd+F within chat
  const chatSearchBar = document.getElementById('chat-search-bar');
  const chatSearchInput = document.getElementById('chat-search-input');
  const chatSearchCount = document.getElementById('chat-search-count');
  let chatSearchMatches = [];
  let chatSearchIdx = -1;

  function openChatSearch() {
    chatSearchBar.style.display = 'flex';
    chatSearchInput.focus();
    chatSearchInput.select();
  }
  function closeChatSearch() {
    chatSearchBar.style.display = 'none';
    chatSearchInput.value = '';
    clearChatHighlights();
    chatSearchMatches = [];
    chatSearchIdx = -1;
    chatSearchCount.textContent = '';
  }
  function clearChatHighlights() {
    document.querySelectorAll('#chat-messages .chat-search-hl').forEach(el => {
      el.replaceWith(document.createTextNode(el.textContent));
    });
    // Normalize text nodes
    document.getElementById('chat-messages').normalize();
  }
  function doChatSearch(query) {
    clearChatHighlights();
    chatSearchMatches = [];
    chatSearchIdx = -1;
    if (!query) { chatSearchCount.textContent = ''; return; }
    const msgs = document.getElementById('chat-messages');
    const walker = document.createTreeWalker(msgs, NodeFilter.SHOW_TEXT);
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.textContent;
      const matches = [...text.matchAll(regex)];
      if (matches.length === 0) continue;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      for (const m of matches) {
        if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        const hl = document.createElement('mark');
        hl.className = 'chat-search-hl';
        hl.textContent = m[0];
        frag.appendChild(hl);
        chatSearchMatches.push(hl);
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      node.parentNode.replaceChild(frag, node);
    }
    chatSearchCount.textContent = chatSearchMatches.length > 0 ? `${chatSearchMatches.length} found` : 'No matches';
    if (chatSearchMatches.length > 0) navigateChatMatch(0);
  }
  function navigateChatMatch(idx) {
    if (chatSearchMatches.length === 0) return;
    chatSearchMatches.forEach(m => m.classList.remove('current'));
    chatSearchIdx = ((idx % chatSearchMatches.length) + chatSearchMatches.length) % chatSearchMatches.length;
    const current = chatSearchMatches[chatSearchIdx];
    current.classList.add('current');
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    chatSearchCount.textContent = `${chatSearchIdx + 1} / ${chatSearchMatches.length}`;
  }

  chatSearchInput.addEventListener('input', () => doChatSearch(chatSearchInput.value));
  chatSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigateChatMatch(chatSearchIdx + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); closeChatSearch(); }
  });
  document.getElementById('chat-search-next').onclick = () => navigateChatMatch(chatSearchIdx + 1);
  document.getElementById('chat-search-prev').onclick = () => navigateChatMatch(chatSearchIdx - 1);
  document.getElementById('chat-search-close').onclick = closeChatSearch;

  // Cmd+F in chat panel opens chat search instead of toolbar search
  document.getElementById('chat-panel').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openChatSearch();
    }
  });

  const allChatClasses = ['chat-collapsed', 'chat-collapsed-right', 'chat-collapsed-float',
    'chat-bottom', 'chat-right', 'chat-float'];
  let chatDockMode = 'bottom'; // 'bottom', 'right', 'float'

  function clearChatClasses() {
    allChatClasses.forEach(c => panel.classList.remove(c));
  }

  function setChatMode(mode, collapsed) {
    clearChatClasses();
    chatDockMode = mode;
    if (collapsed) {
      if (mode === 'bottom') panel.classList.add('chat-collapsed');
      else if (mode === 'right') panel.classList.add('chat-collapsed-right');
      else panel.classList.add('chat-collapsed-float');
    } else {
      panel.classList.add('chat-' + mode);
      connectChat();
    }
    if (mode !== 'float') { panel.style.left = ''; panel.style.top = ''; panel.style.right = ''; panel.style.bottom = ''; }
  }

  function isChatOpen() {
    return panel.classList.contains('chat-bottom') || panel.classList.contains('chat-right') || panel.classList.contains('chat-float');
  }

  function toggleChat() {
    if (isChatOpen()) {
      setChatMode(chatDockMode, true);
    } else {
      setChatMode(chatDockMode, false);
    }
  }

  // Header click is handled by universal panel header (toggleMinimize)
  // Keep dblclick for maximize and drag state tracking
  let chatDragOccurred = false;

  let chatMaximized = false;
  let chatPreMaxState = null; // {dockMode, left, top, width, height}

  document.getElementById('chat-header').addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('.panel-menu') || e.target.closest('[contenteditable]')) return;
    e.stopPropagation();
    // Cancel the pending single-click minimize
    const panelHeader = document.querySelector('#chat-header .panel-header');
    if (panelHeader?._cancelClick) panelHeader._cancelClick();

    if (chatMaximized) {
      // Restore previous state
      clearChatClasses();
      chatDockMode = chatPreMaxState.dockMode;
      panel.classList.add('chat-' + chatDockMode);
      panel.style.left = chatPreMaxState.left;
      panel.style.top = chatPreMaxState.top;
      panel.style.width = chatPreMaxState.width;
      panel.style.height = chatPreMaxState.height;
      panel.style.right = ''; panel.style.bottom = '';
      chatMaximized = false;
    } else {
      // Save current state and maximize
      chatPreMaxState = {
        dockMode: chatDockMode,
        left: panel.style.left, top: panel.style.top,
        width: panel.style.width, height: panel.style.height,
      };
      clearChatClasses();
      panel.classList.add('chat-float');
      chatDockMode = 'float';
      const sidebar = document.getElementById('sidebar');
      const sidebarW = sidebar ? sidebar.offsetWidth : 0;
      panel.style.left = sidebarW + 'px'; panel.style.top = '36px';
      panel.style.right = '0'; panel.style.bottom = '0';
      panel.style.width = `calc(100vw - ${sidebarW}px)`; panel.style.height = 'calc(100vh - 36px)';
      chatMaximized = true;
    }
    connectChat();
  });

  // Drag header: in float mode → move; from bottom/right → detach to float
  const chatHeader = document.getElementById('chat-header');
  chatHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('.panel-menu') || e.target.closest('[contenteditable]')) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const rect = panel.getBoundingClientRect();
    const origX = rect.left, origY = rect.top;

    function onMove(e) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 4) return; // Dead zone
      dragging = true;
      chatDragOccurred = true;
      const hdr = document.querySelector('#chat-header .panel-header');
      if (hdr?._setDragged) hdr._setDragged();

      // Detach to float if not already floating
      if (!panel.classList.contains('chat-float') && !panel.classList.contains('chat-collapsed-float')) {
        clearChatClasses();
        panel.classList.add('chat-float');
        chatDockMode = 'float';
      }

      panel.style.left = (origX + dx) + 'px';
      panel.style.top = (origY + dy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    }

    function onUp(e) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);

      if (!dragging) return; // Was a click, not a drag — let click handler deal with it

      // Snap to dock zones
      const endX = e.clientX, endY = e.clientY;
      const winW = window.innerWidth, winH = window.innerHeight;

      if (endY > winH - 80) {
        // Dragged to bottom → dock bottom
        setChatMode('bottom', false);
      } else if (endX > winW - 60) {
        // Dragged to right edge → dock right
        setChatMode('right', false);
      }
      // Otherwise stays floating at current position
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  // Track focus for Cmd+J cycling
  input.addEventListener('focus', () => {
    if (_cyclingFocus) return;
    chatFocusHistory = chatFocusHistory.filter(id => id !== 'main');
    chatFocusHistory.unshift('main');
  });

  // Send message
  sendBtn.onclick = () => sendChatMessage();
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  };

  // Image paste support
  setupImagePaste(input, () => document.getElementById('chat-attachments'), () => mainPendingImages);

  // Context and model are now in the universal panel menu (⋯)

  // Chat panel resize handles
  panel.querySelectorAll('.chat-resize').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const dir = handle.dataset.dir;
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startW = rect.width, startH = rect.height;
      const startL = rect.left, startT = rect.top;

      function onMove(e) {
        const dx = e.clientX - startX, dy = e.clientY - startY;

        if (panel.classList.contains('chat-bottom')) {
          // Bottom dock: only resize height from top edge
          if (dir === 'top') {
            panel.style.height = Math.max(60, startH - dy) + 'px';
          }
        } else if (panel.classList.contains('chat-right')) {
          // Right dock: only resize width from left edge
          if (dir === 'left') {
            panel.style.width = Math.max(200, startW - dx) + 'px';
          }
        } else if (panel.classList.contains('chat-float')) {
          // Float: resize from any edge
          if (dir === 'right' || dir === 'corner') panel.style.width = Math.max(280, startW + dx) + 'px';
          if (dir === 'bottom' || dir === 'corner') panel.style.height = Math.max(200, startH + dy) + 'px';
          if (dir === 'left') {
            const newW = Math.max(280, startW - dx);
            panel.style.width = newW + 'px';
            panel.style.left = (startL + startW - newW) + 'px';
          }
          if (dir === 'top') {
            const newH = Math.max(200, startH - dy);
            panel.style.height = newH + 'px';
            panel.style.top = (startT + startH - newH) + 'px';
          }
        }
      }

      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  });

  // Temp, new, fork, clear are now in the universal panel menu (⋯)

  // Auto-grow input
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  stopBtn.onclick = () => {
    if (chatWs && chatGenerating) {
      chatWs.send(JSON.stringify({ type: 'stop' }));
    }
  };

  // Global redirect button
  const redirectBtn = document.getElementById('chat-redirect');
  redirectBtn.onclick = () => {
    // Snapshot subagents BEFORE stop clears them
    redirectSnapshot = new Map(activeSubagents);
    pendingSelection = null;

    // Stop generation and immediately reset state
    // (Don't wait for 'stopped' event — user needs to send redirect NOW)
    if (chatWs && chatGenerating) chatWs.send(JSON.stringify({ type: 'stop' }));
    chatGenerating = false;
    clearInterval(chatTimerInterval);
    document.getElementById('chat-send').style.display = '';
    document.getElementById('chat-stop').style.display = 'none';
    document.getElementById('chat-redirect').style.display = 'none';

    // Enter checkpoint mode
    checkpointMode = true;
    redirectCheckpoints.clear();
    document.getElementById('chat-messages').classList.add('checkpoint-mode');

    // Wire checkpoint markers on all tool entries
    document.querySelectorAll('.chat-tool-entry .checkpoint-marker').forEach(marker => {
      marker.onclick = (e) => {
        e.stopPropagation();
        const entry = marker.closest('.chat-tool-entry');
        const subagent = marker.closest('.chat-subagent');
        const agentId = subagent?.dataset?.taskId || 'parent';

        // Toggle selection
        if (marker.classList.contains('selected')) {
          marker.classList.remove('selected');
          redirectCheckpoints.delete(agentId);
        } else {
          // Deselect previous checkpoint for this agent
          if (subagent) subagent.querySelectorAll('.checkpoint-marker.selected').forEach(m => m.classList.remove('selected'));
          else document.querySelectorAll('.chat-activity-group .checkpoint-marker.selected').forEach(m => m.classList.remove('selected'));
          marker.classList.add('selected');
          redirectCheckpoints.set(agentId, parseInt(entry.dataset.msgIndex) || 0);
        }
        updateRedirectInputArea();
      };
    });

    updateRedirectInputArea();
  };

  function updateRedirectInputArea() {
    const preview = document.getElementById('chat-context-preview');
    const numCheckpoints = redirectCheckpoints.size;

    if (numCheckpoints === 0) {
      preview.innerHTML = `<span class="ctx-text">Choose breakpoints by clicking on tool calls above</span><span class="ctx-remove" title="Cancel">✕</span>`;
    } else {
      const agents = [];
      for (const [tid] of redirectCheckpoints) {
        const sub = redirectSnapshot.get(tid);
        const desc = sub?.header?.querySelector('.chat-subagent-desc')?.textContent || 'Agent';
        agents.push(desc.length > 25 ? desc.slice(0, 25) + '...' : desc);
      }
      preview.innerHTML = `<span class="ctx-text">Redirecting: ${agents.join(', ')}</span><span class="ctx-remove" title="Cancel">✕</span>`;
    }
    preview.style.display = 'flex';
    preview.querySelector('.ctx-remove').onclick = () => exitCheckpointMode();

    const input = document.getElementById('chat-input');
    input.placeholder = numCheckpoints > 0
      ? 'Type redirect instructions...'
      : 'Choose breakpoints above, then type here...';
  }

  // Connect WebSocket eagerly so first message works immediately
  connectChat();
}

function exitCheckpointMode() {
  checkpointMode = false;
  redirectCheckpoints.clear();
  redirectSnapshot.clear();
  document.getElementById('chat-messages').classList.remove('checkpoint-mode');
  document.querySelectorAll('.checkpoint-marker.selected').forEach(m => m.classList.remove('selected'));
  document.getElementById('chat-context-preview').style.display = 'none';
  document.getElementById('chat-input').placeholder = 'Message Claude\u2026';
  pendingSelection = null;
}

function connectChat() {
  const mainP = chatPanels.get('main');

  const statusEl = document.querySelector('#chat-header .panel-status');
  if (statusEl) statusEl.className = 'panel-status';

  const tokenParam = getTokenParam();
  const wsUrl = `${getWsUrl()}/ws/chat${tokenParam ? '?' + tokenParam : ''}`;
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    return;
  }

  // Store directly on main panel AND the global
  mainP.ws = ws;
  chatWs = ws;

  ws.onopen = () => {
    mainP.sessionId = sessionStorage.getItem('loom-chat-session') || crypto.randomUUID();
    sessionStorage.setItem('loom-chat-session', mainP.sessionId);
    chatSessionId = mainP.sessionId;

    const level = currentLevel();
    ws.send(JSON.stringify({
      type: 'init',
      session_id: mainP.sessionId,
      page_path: isVMTarget() ? `vm:${currentTarget.id}` : (level.parentPath || ''),
      agent: resolveAgentType(mainP.agentType),
      agent_command: resolveAgentCommand(mainP.agentType),
    }));
    // Send permission rules
    const rules = getPermissionRules();
    if (Object.keys(rules).length > 0) {
      ws.send(JSON.stringify({ type: 'set_permissions', rules }));
    }
  };

  // Main panel's onmessage — always operates on the main panel's state
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { console.error('Chat parse error:', err); return; }
    if (msg.type === 'init') {
      if (statusEl) statusEl.className = 'panel-status connected';
    }
    // Always sync main panel — don't search by WS (it may have been swapped during dock)
    syncFromPanel(mainP);
    handleChatEvent(msg);
    syncToPanel(mainP);
  };

  ws.onclose = () => {
    if (statusEl) statusEl.className = 'panel-status';
    if (mainP.ws === ws) mainP.ws = null;
    if (chatWs === ws) chatWs = null;
  };

  ws.onerror = () => {
    if (statusEl) statusEl.className = 'panel-status';
    if (mainP.ws === ws) mainP.ws = null;
    if (chatWs === ws) chatWs = null;
  };
}

function sendChatMessage() {
  const mainP = chatPanels.get('main');
  syncFromPanel(mainP);
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text && !checkpointMode) return;
  if (!mainP.ws || mainP.ws.readyState !== WebSocket.OPEN) {
    // Queue the message and connect — send after WS opens
    connectChat();
    const waitForOpen = () => {
      if (mainP.ws && mainP.ws.readyState === WebSocket.OPEN) {
        sendChatMessage();
      } else if (mainP.ws && mainP.ws.readyState === WebSocket.CONNECTING) {
        setTimeout(waitForOpen, 100);
      }
    };
    setTimeout(waitForOpen, 200);
    syncToPanel(mainP);
    return;
  }
  chatWs = mainP.ws;

  // If currently generating, queue the message
  if (chatGenerating) {
    if (text) {
      const queuedEl = appendChatMessage('user', text, 'queued');
      messageQueue.push({ text, el: queuedEl });
      input.value = '';
    }
    return;
  }

  // Build the actual message — might include redirect context
  let fullText = text;
  let isRedirect = false;

  if (checkpointMode) {
    fullText = buildRedirectMessage(text);
    exitCheckpointMode();
    if (!fullText) return;
    isRedirect = true;
  } else if (!text && !pendingSelection?.text && mainPendingImages.length === 0) {
    return;
  }

  // Append image paths to prompt so Claude can read them
  const sentImages = [];
  if (mainPendingImages.length > 0) {
    const imagePaths = mainPendingImages.map(i => i.path);
    fullText += '\n\n' + imagePaths.map(p => `[Pasted image: ${p}]`).join('\n');
    sentImages.push(...mainPendingImages);
    // Clear attachment bar
    const bar = document.getElementById('chat-attachments');
    bar.innerHTML = '';
    bar.style.display = 'none';
    mainPendingImages.length = 0;
  }

  chatMessages.push({ role: 'user', content: fullText });
  currentResponseText = '';
  const userMsgEl = appendChatMessage('user', text || '', isRedirect ? 'redirect' : null);
  // Show sent images inline in the message
  if (sentImages.length > 0) {
    const imgRow = document.createElement('div');
    imgRow.className = 'chat-msg-images';
    sentImages.forEach(i => {
      const img = document.createElement('img');
      img.src = i.url;
      img.alt = 'Image';
      img.style.cursor = 'pointer';
      img.onclick = () => showImageLightbox(i.url);
      imgRow.appendChild(img);
    });
    userMsgEl.appendChild(imgRow);
  }
  input.value = '';

  const level = currentLevel();
  const contextLevel = chatContextLevel;
  const contextPath = activePanel.contextPath || level.parentPath || '';

  chatWs.send(JSON.stringify({
    type: 'message',
    text: fullText,
    context_level: contextLevel,
    context: {
      page_path: contextPath,
      selection: pendingSelection?.text || null,
      selection_file: pendingSelection?.file || null,
    },
  }));

  pendingSelection = null;
  document.getElementById('chat-context-preview').style.display = 'none';

  // Show stop button + start timer
  chatGenerating = true;
  chatStartTime = Date.now();
  chatTokenCount = 0;
  const mainStatusDot = document.querySelector('#chat-header .panel-status');
  if (mainStatusDot) mainStatusDot.className = 'panel-status generating';
  document.getElementById('chat-send').style.display = 'none';
  document.getElementById('chat-stop').style.display = 'none'; // Hidden — Redirect handles stopping
  document.getElementById('chat-redirect').style.display = '';

  // Show pondering + timer + tokens + model pill immediately at dispatch time
  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'chat-msg chat-msg-assistant';
  const currentModel = activePanel.model || 'sonnet';
  currentAssistantEl.dataset.model = currentModel;
  const statusBar = document.createElement('div');
  statusBar.className = 'chat-status-bar';
  statusBar.className = 'chat-status-bar chat-active-status';
  statusBar.innerHTML = `<span class="pondering">${randomPonderingWord()}...</span> <span class="chat-elapsed">0.0s</span> <span class="chat-tokens">0 tokens</span><span class="model-pill" data-model="${currentModel}"><span class="dot"></span>${currentModel}</span>`;
  currentAssistantEl.appendChild(statusBar);
  (chatMessagesContainer || document.getElementById('chat-messages')).appendChild(currentAssistantEl);
  currentThinkingEl = null;
  currentThinkingWrapper = null;

  // Timer updates once started
  clearInterval(chatTimerInterval);
  chatTimerInterval = setInterval(() => {
    const el = currentAssistantEl?.querySelector('.chat-elapsed');
    if (el && chatStartTime) {
      el.textContent = ((Date.now() - chatStartTime) / 1000).toFixed(1) + 's';
    }
    const tokEl = currentAssistantEl?.querySelector('.chat-tokens');
    if (tokEl) tokEl.textContent = chatTokenCount + ' tokens';
  }, 100);
  syncToPanel(chatPanels.get('main'));
}

function getSmartContextDefault() {
  // Fullscreen file → page, root canvas → global, subfolder → folder
  if (expandedCard) return 'page';
  const level = typeof currentLevel === 'function' ? currentLevel() : null;
  if (!level || !level.parentPath) return 'global';
  const depth = (level.parentPath || '').split('/').filter(Boolean).length;
  if (depth === 0) return 'global';
  return 'folder';
}

// Shared: fetch real token count and update any context chip element
function updateChipTokens(chip, panel) {
  if (!chip || !panel) return;
  const level = panel.contextLevel || 'page';
  chip.querySelector('.ctx-scope').textContent = level;
  const ctxPath = panel.contextPath || currentLevel()?.parentPath || '';
  const sessionId = panel.sessionId || chatSessionId || '';
  authFetch(`${getBaseUrl()}/api/context-info?session_id=${encodeURIComponent(sessionId)}&level=${level}&path=${encodeURIComponent(ctxPath)}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      const tokens = data.total_tokens || 0;
      const maxTokens = data.max_tokens || 200000;
      const label = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}K` : `~${tokens}`;
      chip.querySelector('.ctx-tokens').textContent = label;
      chip.querySelector('.ctx-max').textContent = `${Math.round(maxTokens / 1000)}K`;
      const pct = Math.min(100, (tokens / maxTokens) * 100);
      const fill = chip.querySelector('.ctx-bar-fill');
      if (fill) fill.style.width = pct + '%';
      chip.dataset.usage = pct > 60 ? 'high' : pct > 30 ? 'mid' : '';
    })
    .catch(() => {
      chip.querySelector('.ctx-tokens').textContent = '--';
    });
}

// Shared: open context popover on any chip for any panel
function openContextPopover(chip, panel) {
  // Close existing popover
  const existing = document.getElementById('ctx-popover');
  if (existing) { existing.remove(); return; }

  const popover = document.createElement('div');
  popover.id = 'ctx-popover';
  popover.className = 'ctx-popover';

  const current = panel.contextLevel || 'page';
  const levels = [
    { val: 'page', label: 'Page' },
    { val: 'folder', label: 'Folder' },
    { val: 'global', label: 'Global' },
  ];

  popover.innerHTML = `
    <div class="ctx-popover-section">
      <div class="ctx-popover-label">Scope <span style="font-weight:400;text-transform:none;letter-spacing:0">(applies to next new chat)</span></div>
      <div class="seg ctx-scope-seg">
        ${levels.map(l => `<button data-val="${l.val}"${l.val === current ? ' class="on"' : ''}>${l.label}</button>`).join('')}
      </div>
    </div>
    <div class="ctx-popover-section ctx-popover-scroll">
      <div class="ctx-popover-label">Context sent to agent</div>
      <div class="ctx-breakdown"><span style="color:var(--text-dim)">Loading...</span></div>
    </div>
    <div class="ctx-popover-footer">
      <div class="ctx-usage-bar"><div class="ctx-usage-fill"></div></div>
      <span class="ctx-usage-text"></span>
      <button class="fs-btn ctx-view-full" style="font-size:9px;padding:2px 6px;margin-left:auto">View prompt</button>
    </div>
  `;
  chip.parentElement.appendChild(popover);

  // "View prompt" button
  popover.querySelector('.ctx-view-full').onclick = (ev) => {
    ev.stopPropagation();
    const ctxPath = panel.contextPath || document.getElementById('fullpage-overlay')?.dataset?.path || currentLevel()?.parentPath || '';
    const sessionId = panel.sessionId || chatSessionId || '';
    const level = panel.contextLevel || 'page';
    authFetch(`${getBaseUrl()}/api/context-info?session_id=${encodeURIComponent(sessionId)}&level=${level}&path=${encodeURIComponent(ctxPath)}&include_prompt=true`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.prompt) return;
        let promptText = data.prompt
          .replace(/__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/g, '── dynamic context below ──')
          .replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const modal = document.createElement('div');
        modal.className = 'fs-panel';
        modal.innerHTML = `<div class="fs-card" style="width:min(800px,92vw);height:min(600px,85vh);grid-template-columns:1fr">
          <div class="fs-content" style="overflow:hidden;display:flex;flex-direction:column">
            <div class="fs-content-header">
              <div><div class="fs-content-eyebrow">System Prompt</div><h2 class="fs-content-title">Full Context Sent to Agent</h2>
              <p class="fs-content-desc">This is the exact system prompt assembled for the current scope.</p></div>
              <button class="fs-close" onclick="this.closest('.fs-panel').remove()">✕</button>
            </div>
            <div class="fs-content-body" style="flex:1;overflow-y:auto;padding:16px 24px">
              <pre style="white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:12px;line-height:1.6;color:var(--text)">${promptText}</pre>
            </div>
          </div>
        </div>`;
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);
      })
      .catch(() => {});
  };

  // Wire scope buttons — locked after first message
  const hasMessages = (panel.messages?.length || 0) > 0;
  popover.querySelectorAll('.ctx-scope-seg button').forEach(btn => {
    if (hasMessages) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        popover.querySelectorAll('.ctx-scope-seg button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        panel.contextLevel = btn.dataset.val;
        if (panel === activePanel) syncFromPanel(panel);
        updateChipTokens(chip, panel);
        loadBreakdown(btn.dataset.val);
      };
    }
  });
  if (hasMessages) {
    popover.querySelector('.ctx-popover-label').innerHTML = 'Scope <span style="font-weight:400;text-transform:none;letter-spacing:0">(locked for this session)</span>';
  }

  // Load context breakdown
  function loadBreakdown(level) {
    const sessionId = panel.sessionId || chatSessionId || '';
    const ctxPath = panel.contextPath || document.getElementById('fullpage-overlay')?.dataset?.path || currentLevel()?.parentPath || '';
    authFetch(`${getBaseUrl()}/api/context-info?session_id=${encodeURIComponent(sessionId)}&level=${level}&path=${encodeURIComponent(ctxPath)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) { popover.querySelector('.ctx-breakdown').innerHTML = '<span style="color:var(--text-dim)">Unavailable</span>'; return; }
        const bd = popover.querySelector('.ctx-breakdown');
        let html = '';
        for (const block of (data.blocks || [])) {
          const est = block.estimated ? ' <span style="opacity:.5">est.</span>' : '';
          html += `<div class="ctx-block-row"><span>${block.name}</span><span class="ctx-block-tokens">~${block.tokens.toLocaleString()} tokens${est}</span></div>`;
        }
        if (data.files?.length > 0) {
          html += '<div class="ctx-popover-label" style="margin-top:6px">Injected at start</div>';
          for (const f of data.files) {
            const note = f.note ? `<div style="font-size:9px;color:var(--text-dim);padding-left:8px">${f.note}</div>` : '';
            html += `<div class="ctx-block-row ctx-file-row"><span class="ctx-file-path">${f.path}</span><span class="ctx-block-tokens">~${f.tokens}</span></div>${note}`;
          }
        }
        const readFiles = [...(sessionReadFiles || [])];
        if (readFiles.length > 0) {
          html += '<div class="ctx-popover-label" style="margin-top:6px">Read during chat</div>';
          for (const path of readFiles.slice(0, 30)) {
            html += `<div class="ctx-block-row ctx-file-row"><span class="ctx-file-path">${path}</span></div>`;
          }
          if (readFiles.length > 30) html += `<div style="font-size:9px;color:var(--text-dim);padding:2px 8px">+${readFiles.length - 30} more</div>`;
        }
        bd.innerHTML = html;
        const pct = Math.min(100, (data.total_tokens / data.max_tokens) * 100);
        const fill = popover.querySelector('.ctx-usage-fill');
        const text = popover.querySelector('.ctx-usage-text');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `~${(data.total_tokens / 1000).toFixed(1)}K / ${(data.max_tokens / 1000).toFixed(0)}K tokens`;
      })
      .catch(() => {
        popover.querySelector('.ctx-breakdown').innerHTML = '<span style="color:var(--text-dim)">Error loading</span>';
      });
  }
  loadBreakdown(current);

  // Close on outside click
  const closeHandler = (e) => {
    if (!e.target.closest('#ctx-popover') && !e.target.closest('.chat-context-chip')) {
      popover.remove();
      document.removeEventListener('mousedown', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
}

function updateContextChip() {
  const chip = document.getElementById('chat-context-chip');
  if (!chip) return;
  updateChipTokens(chip, activePanel);
}

function sendQueuedMessage(text) {
  const mainP = chatPanels.get('main');
  syncFromPanel(mainP);
  if (!mainP.ws || mainP.ws.readyState !== WebSocket.OPEN) { syncToPanel(mainP); return; }
  chatWs = mainP.ws;
  if (chatGenerating) { messageQueue.push({ text, el: null }); syncToPanel(mainP); return; }

  chatMessages.push({ role: 'user', content: text });
  currentResponseText = '';
  // User message element already exists from queue time — don't create another

  const level = currentLevel();
  chatWs.send(JSON.stringify({
    type: 'message',
    text,
    context_level: chatContextLevel,
    context: { page_path: level.parentPath || '' },
  }));

  chatGenerating = true;
  chatStartTime = Date.now();
  chatTokenCount = 0;
  document.getElementById('chat-send').style.display = 'none';
  document.getElementById('chat-stop').style.display = 'none';
  document.getElementById('chat-redirect').style.display = '';

  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'chat-msg chat-msg-assistant';
  const mdl = activePanel.model || 'sonnet';
  currentAssistantEl.dataset.model = mdl;
  const statusBar = document.createElement('div');
  statusBar.className = 'chat-status-bar';
  statusBar.className = 'chat-status-bar chat-active-status';
  statusBar.innerHTML = `<span class="pondering">${randomPonderingWord()}...</span> <span class="chat-elapsed">0.0s</span> <span class="chat-tokens">0 tokens</span><span class="model-pill" data-model="${mdl}"><span class="dot"></span>${mdl}</span>`;
  currentAssistantEl.appendChild(statusBar);
  (chatMessagesContainer || document.getElementById('chat-messages')).appendChild(currentAssistantEl);
  currentThinkingEl = null;
  currentThinkingWrapper = null;

  clearInterval(chatTimerInterval);
  chatTimerInterval = setInterval(() => {
    const el = currentAssistantEl?.querySelector('.chat-elapsed');
    if (el && chatStartTime) el.textContent = ((Date.now() - chatStartTime) / 1000).toFixed(1) + 's';
    const tokEl = currentAssistantEl?.querySelector('.chat-tokens');
    if (tokEl) tokEl.textContent = chatTokenCount + ' tokens';
  }, 100);
  syncToPanel(chatPanels.get('main'));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatToolDesc(tool, input) {
  // Format like Claude Code terminal output
  const i = input || {};
  switch (tool) {
    case 'Read':            return i.file_path || i.path || 'file';
    case 'Write':           return i.file_path || i.path || 'file';
    case 'Edit':            return `${i.file_path || i.path || 'file'}`;
    case 'Grep':            return `"${i.pattern || ''}"${i.path ? ' in ' + i.path : ''}`;
    case 'Glob':            return i.pattern || '*';
    case 'Bash':            return i.command || '';
    case 'WebSearch':       return i.query || '';
    case 'WebFetch':        return i.url || '';
    case 'ripgrep_search':  return `"${i.query || ''}"${i.scope ? ' in ' + i.scope : ''}`;
    case 'read_wiki_page':  return i.path || '';
    case 'write_wiki_page': return i.path || '';
    case 'read_source':     return i.path || '';
    case 'ingest_url':      return i.url || '';
    case 'ingest_text':     return i.title || '';
    case 'auto_commit':     return i.message ? `"${i.message.slice(0, 40)}"` : '';
    case 'validate_links':  return 'checking wiki links';
    case 'generate_health_report': return 'running health checks';
    case 'get_changed_sources': return 'scanning for changes';
    case 'update_master_index': return 'rebuilding index';
    default:
      const vals = Object.values(i).filter(v => typeof v === 'string' && v.length > 0);
      return vals[0] ? vals[0].slice(0, 60) : '';
  }
}

function toolIcon(tool) {
  const svgs = {
    'Read':  '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 1.5H9L11 3.5V12.5H3Z"/><path d="M9 1.5V3.5H11"/></svg>',
    'Write': '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 1.5H9L11 3.5V12.5H3Z"/><path d="M5 8H9"/></svg>',
    'Edit':  '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2.5L11.5 6L6 11.5H2.5V8Z"/></svg>',
    'Grep':  '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6" cy="6" r="4"/><path d="M9 9L12.5 12.5"/></svg>',
    'Glob':  '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 4L4 2H8L9 3.5H12.5V12H1.5Z"/></svg>',
    'Bash':  '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2" width="11" height="10" rx="1.5"/><path d="M4 6L6 7.5L4 9"/><path d="M7.5 9H10"/></svg>',
    'WebSearch': '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5.5"/><path d="M1.5 7H12.5"/><ellipse cx="7" cy="7" rx="2.5" ry="5.5"/></svg>',
    'WebFetch': '<svg class="tool-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5.5"/><path d="M1.5 7H12.5"/><ellipse cx="7" cy="7" rx="2.5" ry="5.5"/></svg>',
  };
  // Also map MCP tool names
  const aliases = {
    'ripgrep_search': 'Grep', 'read_wiki_page': 'Read', 'write_wiki_page': 'Write',
    'validate_links': 'Grep', 'generate_health_report': 'Read',
    'ingest_url': 'WebFetch', 'ingest_text': 'Write', 'auto_commit': 'Bash',
  };
  return svgs[tool] || svgs[aliases[tool]] || svgs['Bash'];
}

// ========================================
// Plan Panel
// ========================================

function openPlanPanel(path, content) {
  activePlanPath = path;
  activePlanContent = content;

  const pane = document.getElementById('plan-pane');
  const divider = document.getElementById('plan-divider');
  const planContent = document.getElementById('plan-content');
  const planEditor = document.getElementById('plan-editor');

  // Render markdown with interactive checkboxes
  planContent.innerHTML = renderPlanMarkdown(content);
  wireCheckboxes(planContent);
  planEditor.value = content;

  pane.style.display = '';
  divider.style.display = '';
  planEditor.style.display = 'none';
  planContent.style.display = '';

  // Log plan in chat
  chatMessages.push({ role: 'plan', content, status: 'proposed' });

  // Wire buttons
  document.getElementById('plan-approve').onclick = approvePlan;
  document.getElementById('plan-changes').onclick = requestPlanChanges;
  document.getElementById('plan-edit-toggle').onclick = togglePlanEdit;
  document.getElementById('plan-close').onclick = closePlanPanel;
  document.getElementById('plan-split-toggle').onclick = () => {
    document.getElementById('chat-body').classList.toggle('split-horizontal');
  };
}

function renderPlanMarkdown(md) {
  // Convert checkbox markdown to interactive HTML before parsing
  const withCheckboxes = md.replace(/^(\s*)- \[ \] (.+)$/gm, '$1- <label><input type="checkbox" data-line="$2"> $2</label>')
    .replace(/^(\s*)- \[x\] (.+)$/gm, '$1- <label><input type="checkbox" checked data-line="$2"> $2</label>');
  return marked.parse(withCheckboxes);
}

function wireCheckboxes(container) {
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const lineText = cb.dataset.line;
      if (!lineText || !activePlanContent) return;
      // Toggle in raw markdown
      const unchecked = `- [ ] ${lineText}`;
      const checked = `- [x] ${lineText}`;
      if (cb.checked) {
        activePlanContent = activePlanContent.replace(unchecked, checked);
      } else {
        activePlanContent = activePlanContent.replace(checked, unchecked);
      }
      // Save to server
      savePlanContent(activePlanContent);
    });
  });
}

async function savePlanContent(content) {
  if (!activePlanPath) return;
  try {
    await authFetch('/api/plan', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: activePlanPath, content }),
    });
  } catch (e) { console.error('Plan save failed:', e); }
}

function togglePlanEdit() {
  const planContent = document.getElementById('plan-content');
  const planEditor = document.getElementById('plan-editor');
  const btn = document.getElementById('plan-edit-toggle');

  if (planEditor.style.display === 'none') {
    // Switch to edit mode
    planEditor.value = activePlanContent;
    planEditor.style.display = '';
    planContent.style.display = 'none';
    btn.textContent = 'Preview';
  } else {
    // Switch to preview mode — save edits
    activePlanContent = planEditor.value;
    planContent.innerHTML = renderPlanMarkdown(activePlanContent);
    wireCheckboxes(planContent);
    planEditor.style.display = 'none';
    planContent.style.display = '';
    btn.textContent = 'Edit';
    savePlanContent(activePlanContent);
  }
}

async function approvePlan() {
  // Log final plan state in chat
  chatMessages.push({ role: 'plan', content: activePlanContent, status: 'approved' });

  // Send approval message to agent
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    const input = document.getElementById('chat-input');
    input.value = 'Plan approved. Proceed with implementation.';
    sendChatMessage();
  }

  // Delete plan file
  if (activePlanPath) {
    try {
      await authFetch('/api/plan', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activePlanPath }),
      });
    } catch (e) { console.error('Plan delete failed:', e); }
  }

  closePlanPanel();
}

function requestPlanChanges() {
  const input = document.getElementById('chat-input');
  input.placeholder = 'What changes to the plan?';
  input.focus();
}

function closePlanPanel() {
  document.getElementById('plan-pane').style.display = 'none';
  document.getElementById('plan-divider').style.display = 'none';
  document.getElementById('chat-body').classList.remove('split-horizontal');
  activePlanPath = null;
  activePlanContent = '';
}

async function checkForPlanFile(filePath) {
  // Called when we detect a Write/Edit to a plan file
  // Fetch the plan content and open the panel
  try {
    const resp = await authFetch('/api/plan');
    const data = await resp.json();
    if (data.ok) {
      openPlanPanel(data.path, data.content);
    }
  } catch (e) { console.error('Plan fetch failed:', e); }
}

function summarizeTools(tools) {
  // tools is array of {name, file} objects
  // For file-based tools, count unique files; for others, count invocations
  const fileTools = new Set(['Read', 'Write', 'Edit']);
  const groups = {};
  tools.forEach(t => {
    const name = typeof t === 'string' ? t : t.name;
    if (!groups[name]) groups[name] = { count: 0, files: new Set() };
    groups[name].count++;
    const file = typeof t === 'object' ? t.file : null;
    if (file && fileTools.has(name)) groups[name].files.add(file);
  });
  const friendly = {
    Read: ['Read', 'file'], Bash: ['Ran', 'command'], Grep: ['Searched', 'pattern'],
    Glob: ['Found', 'pattern'], Edit: ['Edited', 'file'], Write: ['Wrote', 'file'],
    Agent: ['Spawned', 'agent'],
  };
  return Object.entries(groups).map(([tool, g]) => {
    const f = friendly[tool];
    const n = fileTools.has(tool) && g.files.size > 0 ? g.files.size : g.count;
    if (f) return `${f[0]} ${n} ${f[1]}${n > 1 ? 's' : ''}`;
    return n > 1 ? `${tool} x${n}` : tool;
  }).join(', ');
}

function finalizeActivityGroup(ag) {
  if (!ag) return;
  const hdr = ag.querySelector('.chat-activity-header');
  if (hdr) {
    const latest = hdr.querySelector('.activity-latest');
    if (latest) {
      const elapsed = ((Date.now() - (ag._startTime || Date.now())) / 1000).toFixed(1);
      latest.classList.remove('pondering');
      latest.textContent = `${summarizeTools(ag._tools || [])} (${elapsed}s)`;
    }
  }
  // Don't collapse — let the user keep reading expanded details
}

// Get the target container for an event — subagent body or parent assistant
function getEventTarget(msg) {
  const subId = msg.subagent_id;
  if (subId && activeSubagents.has(subId)) {
    return activeSubagents.get(subId);
  }
  return null; // Use parent (currentAssistantEl)
}

function buildRedirectMessage(generalText) {
  // Build redirect context with truncated progress per checkpoint
  let msg = 'All subagents were interrupted. Please restart them with the following instructions.\n\n';

  for (const [tid, sub] of (checkpointMode ? redirectSnapshot : activeSubagents)) {
    const desc = sub.header?.querySelector('.chat-subagent-desc')?.textContent || tid;
    const prompt = sub.el?.dataset?.prompt || '';
    const checkpointIdx = redirectCheckpoints.get(tid);
    const hasCheckpoint = checkpointIdx !== undefined;

    // Get this agent's messages, truncated to checkpoint if set
    const agentMsgs = chatMessages.filter(m => m.subagent_id === tid);
    let progress;
    if (hasCheckpoint) {
      // Include only messages up to and including the checkpoint index
      progress = agentMsgs.filter(m => {
        const idx = chatMessages.indexOf(m);
        return idx <= checkpointIdx;
      });
    } else {
      progress = agentMsgs;
    }

    const progressText = progress.map(m => {
      if (m.role === 'thinking') return `[Thinking]: ${m.content}`;
      if (m.role === 'tool') return `[Tool]: ${m.content}`;
      if (m.role === 'tool_result') return `[Result]: ${m.content}`;
      return '';
    }).filter(Boolean).join('\n');

    msg += `--- Agent: "${desc}" ---\n`;
    msg += `Original prompt: ${prompt}\n`;
    if (progressText) msg += `Progress:\n${progressText}\n`;

    if (hasCheckpoint) {
      msg += `REDIRECT: Apply the user's instructions below from this point.\n`;
    } else {
      msg += `ACTION: Continue exactly where this agent left off.\n`;
    }
    msg += '\n';
  }

  if (generalText) msg += `Additional instructions: ${generalText}\n`;

  return msg;
}


function handleChatEvent(msg) {
  const messages = chatMessagesContainer || document.getElementById('chat-messages');

  if (msg.type !== 'text') debugLog('Chat event:', msg.type, msg);

  // Status bar is created at dispatch time in sendChatMessage() — no swap needed here

  switch (msg.type) {
    case 'thinking': {
      const sub = getEventTarget(msg);
      // Get the right thinking wrapper (subagent's or parent's)
      let tw = sub ? sub.thinkingWrapper : currentThinkingWrapper;
      let te = sub ? sub.thinkingEl : currentThinkingEl;
      const container = sub ? sub.body : currentAssistantEl;

      if (!tw) {
        tw = document.createElement('div');
        tw.className = 'chat-thinking-wrapper';
        tw._startTime = Date.now();
        tw._tokens = 0;
        const header = document.createElement('div');
        header.className = 'chat-thinking-header';
        header.innerHTML = `<span class="chat-thinking-toggle">▶</span> <span class="pondering">${randomPonderingWord()}...</span> <span class="thinking-time"></span>`;
        te = document.createElement('div');
        te.className = 'chat-thinking-body';
        const thinkBody = te;
        header.addEventListener('click', (e) => {
          e.stopPropagation();
          thinkBody.classList.toggle('open');
          header.querySelector('.chat-thinking-toggle').classList.toggle('open');
        });
        tw.appendChild(header);
        tw.appendChild(te);
        container.appendChild(tw);
        if (sub) { sub.thinkingWrapper = tw; sub.thinkingEl = te; }
        else { currentThinkingWrapper = tw; currentThinkingEl = te; }
      }
      if (msg.content) {
        te.textContent += msg.content;
        tw._tokens += Math.ceil(msg.content.length / 4);
        chatTokenCount += Math.ceil(msg.content.length / 4);
        const elapsed = ((Date.now() - tw._startTime) / 1000).toFixed(1);
        tw.querySelector('.thinking-time').textContent = `${elapsed}s, ~${tw._tokens} tokens`;
        chatMessages.push({ role: 'thinking', content: msg.content, subagent_id: msg.subagent_id || null });
      }
      break;
    }

    case 'text':
      // Finalize any open activity group
      if (currentActivityGroup) {
        finalizeActivityGroup(currentActivityGroup);
        currentActivityGroup = null;
      }
      // Finalize any open thinking block (but allow new ones later)
      if (currentThinkingWrapper) {
        const hdr = currentThinkingWrapper.querySelector('.chat-thinking-header');
        const el = ((Date.now() - currentThinkingWrapper._startTime) / 1000).toFixed(1);
        if (hdr) {
          const pond = hdr.querySelector('.pondering');
          if (pond) { pond.textContent = `Thought (${el}s)`; pond.classList.remove('pondering'); }
        }
        currentThinkingWrapper = null;
        currentThinkingEl = null;
      }
      if (msg.content) {
        // Route text to subagent body or parent
        const sub = msg.subagent_id ? activeSubagents.get(msg.subagent_id) : null;
        const container = sub ? sub.body : currentAssistantEl;
        if (!container) break;

        chatTokenCount += Math.ceil(msg.content.length / 4);
        currentResponseText += msg.content;
        // Track subagent text for saving (parent text captured at 'done')
        if (msg.subagent_id) {
          chatMessages.push({ role: 'text', content: msg.content, subagent_id: msg.subagent_id });
        }
        // Get or create .chat-text in the right container
        let textEl = container._currentTextEl;
        if (!textEl || !container.contains(textEl)) {
          textEl = document.createElement('div');
          textEl.className = 'chat-text';
          container.appendChild(textEl);
          container._currentTextEl = textEl;
        }
        textEl._rawText = (textEl._rawText || '') + msg.content;
        textEl.innerHTML = marked.parse(textEl._rawText);
        renderLatex(textEl);
        textEl.querySelectorAll('.wiki-link').forEach(el => {
          el.onclick = () => focusCardByTitle(el.dataset.target);
        });
      }
      break;

    case 'tool_use': {
      const sub = getEventTarget(msg);
      const container = sub ? sub.body : currentAssistantEl;
      if (!container) break;

      const toolName = msg.tool || 'tool';
      if (!toolName || toolName === 'unknown') break;
      const toolDesc = formatToolDesc(toolName, msg.input || {});

      // Track files accessed during this session
      const toolInput = msg.input || {};
      if (toolInput.file_path) sessionReadFiles.add(toolInput.file_path);
      if (toolInput.path) sessionReadFiles.add(toolInput.path);
      if (toolName === 'Glob' && toolInput.pattern) sessionReadFiles.add(toolInput.pattern);

      // Finalize thinking (for the right context)
      const tw2 = sub ? sub.thinkingWrapper : currentThinkingWrapper;
      if (tw2) {
        const hdr2 = tw2.querySelector('.chat-thinking-header');
        const el2 = ((Date.now() - tw2._startTime) / 1000).toFixed(1);
        if (hdr2) { const p = hdr2.querySelector('.pondering'); if (p) { p.textContent = `Thought (${el2}s)`; p.classList.remove('pondering'); } }
        if (sub) { sub.thinkingWrapper = null; sub.thinkingEl = null; }
        else { currentThinkingWrapper = null; currentThinkingEl = null; }
      }

      // Reset text element so text after tools goes below
      if (!sub && currentAssistantEl) currentAssistantEl._currentTextEl = null;

      // Get or create activity group (per-subagent or parent)
      let ag = sub ? sub.activityGroup : currentActivityGroup;
      if (!ag) {
        ag = document.createElement('div');
        ag.className = 'chat-activity-group';
        ag._tools = [];
        ag._lastToolName = null;
        ag._lastToolGroup = null;
        ag._startTime = Date.now();
        const groupHeader = document.createElement('div');
        groupHeader.className = 'chat-activity-header';
        groupHeader.innerHTML = `<span class="chat-thinking-toggle">▶</span> <span class="activity-latest pondering"></span>`;
        const groupBody = document.createElement('div');
        groupBody.className = 'chat-activity-body';
        groupHeader.addEventListener('click', (e) => {
          e.stopPropagation();
          groupBody.classList.toggle('open');
          groupHeader.querySelector('.chat-thinking-toggle').classList.toggle('open');
        });
        ag.appendChild(groupHeader);
        ag.appendChild(groupBody);
        container.appendChild(ag);
        if (sub) sub.activityGroup = ag;
        else currentActivityGroup = ag;
      }

      // Update inner header with running summary + latest tool
      const toolFile = (msg.input || {}).file_path || (msg.input || {}).path || null;
      ag._tools.push({ name: toolName, file: toolFile });
      const latestEl = ag.querySelector('.activity-latest');
      if (latestEl) {
        const summary = summarizeTools(ag._tools);
        const elapsed = ((Date.now() - ag._startTime) / 1000).toFixed(1);
        latestEl.innerHTML = `${summary} (${elapsed}s)`;
      }

      // Update outer subagent header with aggregated summary (if inside a subagent)
      if (sub) {
        const outerDesc = sub.header?.querySelector('.chat-subagent-desc');
        if (outerDesc) outerDesc.textContent = `${sub._description || ''} — ${summarizeTools(ag._tools)}`;
      }

      // Same-tool grouping: if same tool, add sub-entry to existing group
      const agBody = ag.querySelector('.chat-activity-body');
      if (ag._lastToolName === toolName && ag._lastToolGroup) {
        // Add sub-entry for this call
        ag._lastToolGroup._count = (ag._lastToolGroup._count || 1) + 1;
        const subEntry = document.createElement('div');
        subEntry.className = 'chat-tool-subentry';
        subEntry.textContent = toolDesc;
        subEntry._startTime = Date.now();
        subEntry._toolInput = msg.input || {};
        const subResult = document.createElement('div');
        subResult.className = 'chat-tool-result';
        subEntry.addEventListener('click', (e) => { e.stopPropagation(); subResult.classList.toggle('open'); });
        ag._lastToolGroup._subList.appendChild(subEntry);
        ag._lastToolGroup._subList.appendChild(subResult);
      } else {
        // New tool group — title is not clickable, all calls go in subList
        const toolEntry = document.createElement('div');
        toolEntry.className = 'chat-tool-entry';
        toolEntry._startTime = Date.now();
        toolEntry._count = 1;
        toolEntry.innerHTML = `${toolIcon(toolName)} <span class="tool-name">${escapeHtml(toolName)}</span> <span class="tool-desc">${escapeHtml(toolDesc)}</span> <span class="tool-time pondering"></span> <span class="checkpoint-marker" title="Set redirect breakpoint here"></span>`;
        toolEntry._toolInput = msg.input || {};
        toolEntry.dataset.msgIndex = chatMessages.length - 1;
        const subList = document.createElement('div');
        subList.className = 'chat-tool-sublist';
        subList.style.display = 'none';
        toolEntry._subList = subList;
        // First call also goes into subList as a sub-entry
        const firstSub = document.createElement('div');
        firstSub.className = 'chat-tool-subentry';
        firstSub.textContent = toolDesc;
        firstSub._startTime = Date.now();
        firstSub._toolInput = msg.input || {};
        const firstSubResult = document.createElement('div');
        firstSubResult.className = 'chat-tool-result';
        firstSub.addEventListener('click', (e) => { e.stopPropagation(); firstSubResult.classList.toggle('open'); });
        subList.appendChild(firstSub);
        subList.appendChild(firstSubResult);
        // Click title to toggle subList visibility
        toolEntry.addEventListener('click', (e) => {
          e.stopPropagation();
          subList.style.display = subList.style.display === 'none' ? '' : 'none';
        });
        agBody.appendChild(toolEntry);
        agBody.appendChild(subList);
        ag._lastToolName = toolName;
        ag._lastToolGroup = toolEntry;
      }

      chatMessages.push({ role: 'tool', content: `${toolName}: ${toolDesc}`, subagent_id: msg.subagent_id || null });

      // Capture Agent tool prompt for the upcoming subagent
      if (toolName === 'Agent' && msg.input) {
        pendingAgentPrompt = msg.input.prompt || msg.input.description || null;
      }

      // Track file edits + detect plan file writes
      if ((toolName === 'Write' || toolName === 'Edit') && msg.input) {
        const fp = msg.input.file_path || msg.input.path || '';
        if (fp) sessionEditedFiles.add(fp);
        if (fp.includes('.claude/plans/') && fp.endsWith('.md')) {
          setTimeout(() => checkForPlanFile(fp), 500);
        }
      }
      break;
    }

    case 'tool_result': {
      const sub3 = getEventTarget(msg);
      const ag3 = sub3 ? sub3.activityGroup : currentActivityGroup;
      if (ag3) {
        // Find the next tool entry/subentry that hasn't received a result yet
        const lastGroup = ag3._lastToolGroup;
        if (lastGroup) {
          // All results go to sub-entries in order
          if (!lastGroup._resultCount) lastGroup._resultCount = 0;
          const resultIdx = lastGroup._resultCount;
          lastGroup._resultCount++;

          const subList = lastGroup._subList;
          const subEntries = subList ? Array.from(subList.querySelectorAll('.chat-tool-subentry')) : [];

          let targetEntry;
          let targetResult;
          if (resultIdx < subEntries.length) {
            targetEntry = subEntries[resultIdx];
            targetResult = targetEntry.nextElementSibling;
            if (!targetResult?.classList?.contains('chat-tool-result')) targetResult = null;
          }

          if (targetResult?.classList?.contains('chat-tool-result')) {
            // Show input details + output — use the target entry's input, not the group parent
            const toolInput = targetEntry._toolInput || lastGroup._toolInput || {};
            let detailHtml = '';
            const tName = ag3._lastToolName || '';
            if (tName === 'Edit' && (toolInput.old_string || toolInput.new_string)) {
              if (toolInput.old_string) detailHtml += `<div class="tool-detail-section diff-old"><span class="tool-detail-label">removed</span><pre>${escapeHtml(toolInput.old_string)}</pre></div>`;
              if (toolInput.new_string) detailHtml += `<div class="tool-detail-section diff-new"><span class="tool-detail-label">added</span><pre>${escapeHtml(toolInput.new_string)}</pre></div>`;
            } else if (tName === 'Bash' && toolInput.command) {
              detailHtml += `<div class="tool-detail-section diff-cmd"><pre>$ ${escapeHtml(toolInput.command)}</pre></div>`;
              if (msg.output) detailHtml += `<div class="tool-detail-output"><pre>${escapeHtml(msg.output)}</pre></div>`;
            } else if (tName === 'Write') {
              if (toolInput.content) detailHtml += `<div class="tool-detail-section diff-new"><span class="tool-detail-label">content</span><pre>${escapeHtml(toolInput.content)}</pre></div>`;
            } else if (tName === 'Read' && toolInput.file_path) {
              if (msg.output) detailHtml += `<div class="tool-detail-output"><pre>${escapeHtml((msg.output || '').slice(0, 500))}</pre></div>`;
            } else if (tName === 'Grep') {
              detailHtml += `<div class="tool-detail-section diff-cmd"><pre>${escapeHtml(toolInput.pattern || '')} ${toolInput.path ? 'in ' + toolInput.path : ''}</pre></div>`;
              if (msg.output) detailHtml += `<div class="tool-detail-output"><pre>${escapeHtml((msg.output || '').slice(0, 500))}</pre></div>`;
            }
            if (!detailHtml && msg.output) {
              detailHtml = `<div class="tool-detail-output"><pre>${escapeHtml(msg.output)}</pre></div>`;
            }
            targetResult.innerHTML = detailHtml;
          }
          const elapsed = ((Date.now() - (targetEntry._startTime || Date.now())) / 1000).toFixed(1);
          const timeEl = lastGroup.querySelector('.tool-time');
          if (timeEl) timeEl.textContent = elapsed + 's';
          const pond = lastGroup.querySelector('.pondering');
          if (pond) pond.classList.remove('pondering');
        }
      }
      chatMessages.push({ role: 'tool_result', content: (msg.output || '').slice(0, 1000), subagent_id: msg.subagent_id || null });
      break;
    }

    case 'subagent_started': {
      if (!currentAssistantEl) break;
      const taskId = msg.task_id || '';
      const subEl = document.createElement('div');
      subEl.className = 'chat-subagent';
      subEl.dataset.taskId = taskId;

      const subHeader = document.createElement('div');
      subHeader.className = 'chat-subagent-header';
      const subDesc = escapeHtml(msg.description || msg.task_type || 'Subagent');
      const agentPrompt = pendingAgentPrompt || '';
      pendingAgentPrompt = null;

      subHeader.innerHTML = `<span class="chat-thinking-toggle">▶</span> <span class="pondering">Agent</span> <span class="chat-subagent-desc">${subDesc}</span> <span class="chat-subagent-status">running</span>`;

      subEl.dataset.prompt = agentPrompt;

      const subBody = document.createElement('div');
      subBody.className = 'chat-subagent-body';

      if (agentPrompt) {
        const promptEl = document.createElement('div');
        promptEl.className = 'chat-subagent-prompt';
        promptEl.innerHTML = `<span class="prompt-label">Prompt:</span> <span class="prompt-text">${escapeHtml(agentPrompt.slice(0, 100))}${agentPrompt.length > 100 ? '...' : ''}</span>`;
        promptEl.title = agentPrompt;
        const fullPrompt = document.createElement('div');
        fullPrompt.className = 'chat-subagent-prompt-full';
        fullPrompt.textContent = agentPrompt;
        promptEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = fullPrompt.classList.toggle('open');
          // Hide partial prompt when full is visible, show when collapsed
          promptEl.querySelector('.prompt-text').style.display = isOpen ? 'none' : '';
        });
        subBody.appendChild(promptEl);
        subBody.appendChild(fullPrompt);
      }

      subHeader.addEventListener('click', (e) => {
        if (e.target.closest('.subagent-redirect')) return;
        e.stopPropagation();
        subBody.classList.toggle('open');
        subHeader.querySelector('.chat-thinking-toggle').classList.toggle('open');
      });

      subEl.appendChild(subHeader);
      subEl.appendChild(subBody);
      currentAssistantEl.appendChild(subEl);
      activeSubagents.set(taskId, {
        el: subEl, body: subBody, header: subHeader,
        activityGroup: null, thinkingWrapper: null, thinkingEl: null,
        _description: msg.description || msg.task_type || 'Subagent',
      });
      chatMessages.push({ role: 'subagent', content: `Started: ${msg.description || msg.task_type || 'Subagent'}` });
      break;
    }

    case 'subagent_progress': {
      const sub = activeSubagents.get(msg.task_id);
      if (sub) {
        // Only update status text, don't overwrite desc (activity summary handles that)
        const status = sub.header.querySelector('.chat-subagent-status');
        if (status) status.textContent = 'working';
      }
      break;
    }

    case 'subagent_done': {
      const sub2 = activeSubagents.get(msg.task_id);
      if (sub2) {
        // Finalize subagent's own activity group and set outer header summary
        const agTools = sub2.activityGroup?._tools || [];
        const agElapsed = sub2.activityGroup ? ((Date.now() - sub2.activityGroup._startTime) / 1000).toFixed(1) : '0';
        if (sub2.activityGroup) {
          finalizeActivityGroup(sub2.activityGroup);
          sub2.activityGroup = null;
        }
        // Set outer header with final activity summary
        const outerDesc = sub2.header.querySelector('.chat-subagent-desc');
        if (outerDesc && agTools.length) {
          outerDesc.textContent = `${sub2._description || ''} — ${summarizeTools(agTools)} (${agElapsed}s)`;
        }
        const status2 = sub2.header.querySelector('.chat-subagent-status');
        if (status2) {
          status2.textContent = msg.status || 'done';
          status2.className = 'chat-subagent-status ' + (msg.status === 'completed' ? 'status-ok' : msg.status === 'failed' ? 'status-err' : '');
        }
        const pond = sub2.header.querySelector('.pondering');
        if (pond) pond.classList.remove('pondering');

        // Show summary
        if (msg.summary) {
          const summaryEl = document.createElement('div');
          summaryEl.className = 'chat-subagent-summary';
          summaryEl.textContent = msg.summary.slice(0, 200);
          sub2.el.appendChild(summaryEl);
        }

        // Collapse the body by default after completion
        // Already collapsed by default — no action needed

        activeSubagents.delete(msg.task_id);
      }
      chatMessages.push({ role: 'subagent', content: `Done (${msg.status}): ${msg.summary || ''}` });
      break;
    }

    case 'done':
    case 'stopped': {
      const wasStopped = msg.type === 'stopped';
      // Finalize any open thinking/activity
      if (currentThinkingWrapper) {
        const tw = currentThinkingWrapper;
        const hdr = tw.querySelector('.chat-thinking-header');
        if (hdr) { const p = hdr.querySelector('.pondering'); if (p) { p.textContent = `Thought`; p.classList.remove('pondering'); } }
        currentThinkingWrapper = null; currentThinkingEl = null;
      }
      if (currentActivityGroup) {
        finalizeActivityGroup(currentActivityGroup);
        currentActivityGroup = null;
      }
      // Track assistant response + append inline model pill
      if (currentResponseText) {
        chatMessages.push({ role: 'assistant', content: currentResponseText });
        currentResponseText = '';
        if (currentAssistantEl) {
          const model = activePanel?.model || 'sonnet';
          const pill = document.createElement('span');
          pill.className = 'model-pill model-pill-inline';
          pill.dataset.model = model;
          pill.innerHTML = `<span class="dot"></span>${model}`;
          currentAssistantEl.appendChild(pill);
        }
      }
      chatGenerating = false;
      clearInterval(chatTimerInterval);
        // Only toggle main panel buttons when processing main panel events
      const isMainPanel = chatMessagesContainer === chatPanels.get('main')?.messagesContainer
        || chatMessagesContainer === null;
      if (isMainPanel) {
        document.getElementById('chat-send').style.display = '';
        document.getElementById('chat-stop').style.display = 'none';
        document.getElementById('chat-redirect').style.display = 'none';
        const msd = document.querySelector('#chat-header .panel-status');
        if (msd) msd.className = 'panel-status connected';
      }

      // Show interrupt prompt if user pressed Escape
      if (wasStopped && wasUserInterrupt) {
        wasUserInterrupt = false;
        const interruptEl = document.createElement('div');
        interruptEl.className = 'chat-interrupted';
        interruptEl.textContent = 'Interrupted \u00b7 What should Claude do instead?';
        if (currentAssistantEl) {
          currentAssistantEl.appendChild(interruptEl);
        } else {
          messages.appendChild(interruptEl);
        }
        // Focus the right input — floating panel or main
        const panelInput = chatMessagesContainer?.closest('.chat-panel')?.querySelector('textarea');
        (panelInput || document.getElementById('chat-input')).focus();
      }
      // Show file edit notification if agent modified files
      if (sessionEditedFiles.size > 0 && !wasStopped) {
        const files = [...sessionEditedFiles];
        const short = files.map(f => f.split('/').slice(-2).join('/'));
        const summary = short.length <= 3
          ? short.join(', ')
          : `${short.slice(0, 2).join(', ')} +${short.length - 2} more`;
        const notif = document.createElement('div');
        notif.className = 'chat-file-notification';
        notif.textContent = `Modified ${files.length} file${files.length > 1 ? 's' : ''}: ${summary}`;
        notif.title = files.join('\n');
        if (currentAssistantEl) currentAssistantEl.appendChild(notif);
        else messages.appendChild(notif);
        sessionEditedFiles.clear();
        refreshFileTree();
      }

      // Finalize status bar with real usage if available
      const activeStatus = currentAssistantEl?.querySelector('.chat-active-status');
      if (activeStatus && chatStartTime) {
        const elapsed = ((Date.now() - chatStartTime) / 1000).toFixed(1);
        let statusParts = [`${elapsed}s`];
        if (lastResultUsage) {
          const inp = lastResultUsage.input_tokens || lastResultUsage.inputTokens || 0;
          const out = lastResultUsage.output_tokens || lastResultUsage.outputTokens || 0;
          if (inp || out) statusParts.push(`${inp + out} tokens`);
        } else {
          statusParts.push(`~${chatTokenCount} tokens`);
        }
        // Cost available but not shown — user prefers token count only
        activeStatus.innerHTML = statusParts.map(s => `<span>${s}</span>`).join(' ');
        activeStatus.classList.remove('chat-active-status');
      }
      lastResultUsage = null;
      lastResultCost = null;
      currentAssistantEl = null;
      currentThinkingEl = null;
      currentThinkingWrapper = null;
      currentActivityGroup = null;
      activeSubagents.clear();
      chatStartTime = null;

      // Generate LLM title after first exchange
      maybeGenerateChatTitle(activePanel);

      // Process queued messages — combine all into one
      // Sync globals to panel first so sendQueuedMessage's syncFromPanel
      // sees chatGenerating=false (we just set it above on the global)
      if (messageQueue.length > 0) {
        syncToPanel(activePanel);
        const all = messageQueue.splice(0);
        const combined = all.map(q => q.text).join('\n\n');
        all.forEach(q => { if (q.el) q.el.classList.remove('chat-msg-queued'); });
        sendQueuedMessage(combined);
      }
      break;
    }

    case 'result':
      // Store usage info for status bar
      if (msg.usage) {
        lastResultUsage = msg.usage;
        // Update context chip with real input token count (= context window size)
        const inputTokens = msg.usage.input_tokens || msg.usage.inputTokens || 0;
        if (inputTokens > 0) {
          const chip = document.getElementById('chat-context-chip');
          if (chip) {
            const label = inputTokens >= 1000 ? `~${(inputTokens / 1000).toFixed(1)}K` : `~${inputTokens}`;
            chip.querySelector('.ctx-tokens').textContent = label;
            const pct = Math.min(100, (inputTokens / 200000) * 100);
            const fill = chip.querySelector('.ctx-bar-fill');
            if (fill) fill.style.width = pct + '%';
            chip.dataset.usage = pct > 60 ? 'high' : pct > 30 ? 'mid' : '';
          }
        }
      }
      if (msg.cost_usd) lastResultCost = msg.cost_usd;
      // Use result as authoritative text if we missed streaming
      if (msg.content && !currentResponseText) {
        currentResponseText = msg.content;
      }
      // Only render if we haven't already streamed the text
      if (currentAssistantEl && msg.content) {
        let textEl = currentAssistantEl.querySelector('.chat-text');
        if (!textEl) {
          textEl = document.createElement('div');
          textEl.className = 'chat-text';
          currentAssistantEl.appendChild(textEl);
          textEl.innerHTML = marked.parse(msg.content);
          renderLatex(textEl);
          textEl.querySelectorAll('.wiki-link').forEach(el => {
            el.onclick = () => focusCardByTitle(el.dataset.target);
          });
        }
      }
      break;

    case 'error':
      appendChatMessage('system', `Error: ${escapeHtml(msg.message || 'Unknown error')}`);
      chatGenerating = false;
      clearInterval(chatTimerInterval);
      document.getElementById('chat-send').style.display = '';
      document.getElementById('chat-stop').style.display = 'none';
      document.getElementById('chat-redirect').style.display = 'none';
      currentAssistantEl = null;
      currentThinkingEl = null;
      currentThinkingWrapper = null;
      currentActivityGroup = null;
      activeSubagents.clear();
      chatStartTime = null;
      currentResponseText = '';
      pendingSelection = null;
      pendingAgentPrompt = null;
      if (checkpointMode) exitCheckpointMode();
      break;

    case 'permission_request': {
      // Agent is asking for permission to use a tool
      const promptEl = document.createElement('div');
      promptEl.className = 'chat-permission-prompt';
      const toolName = msg.tool || 'unknown';
      const permId = msg.perm_id || '';
      const inputSummary = Object.entries(msg.input || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      promptEl.innerHTML = `
        <div class="perm-label">Claude wants to use: <strong>${escapeHtml(toolName)}</strong></div>
        <div class="perm-detail">${escapeHtml(inputSummary).slice(0, 300)}</div>
        <div class="perm-actions">
          <button class="perm-allow" data-decision="allow">Allow</button>
          <button class="perm-deny" data-decision="deny">Deny</button>
        </div>`;
      // Insert into current activity group if available, otherwise chat container
      const sub = getEventTarget(msg);
      const ag = sub ? sub.activityGroup : currentActivityGroup;
      const agBody = ag?.querySelector('.chat-activity-body');
      if (agBody) {
        // Make sure the activity body is visible so the user sees the prompt
        agBody.classList.add('open');
        const toggle = ag.querySelector('.chat-thinking-toggle');
        if (toggle) toggle.classList.add('open');
        agBody.appendChild(promptEl);
      } else {
        const container = chatMessagesContainer || document.getElementById('chat-messages');
        container.appendChild(promptEl);
      }
      const scrollTarget = chatMessagesContainer || document.getElementById('chat-messages');
      scrollTarget.scrollTop = scrollTarget.scrollHeight;

      // Focus Allow button so Enter confirms
      const allowBtn = promptEl.querySelector('.perm-allow');
      allowBtn?.focus();

      function resolvePermission(decision) {
        const ws = activePanel?.ws || chatWs;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'permission_response', decision, perm_id: permId }));
        }
        // Replace with compact tool-entry-style line
        const label = decision === 'allow' ? 'Allowed' : 'Denied';
        const color = decision === 'allow' ? 'var(--green, #9ece6a)' : 'var(--red, #f7768e)';
        const icon = decision === 'allow' ? '🔓' : '🚫';
        promptEl.className = 'chat-tool-entry perm-resolved';
        promptEl.style.cssText = '';
        const shortDesc = (msg.input?.command || msg.input?.file_path || inputSummary).slice(0, 120);
        promptEl.innerHTML = `${icon} <span class="tool-name" style="color:${color}">${label}</span> <span class="tool-desc">${escapeHtml(shortDesc)}</span>`;
        // Click to expand full details
        const detailEl = document.createElement('div');
        detailEl.className = 'chat-tool-result';
        detailEl.innerHTML = `<div class="tool-detail-output"><pre>${escapeHtml(inputSummary)}</pre></div>`;
        promptEl.after(detailEl);
        promptEl.style.cursor = 'pointer';
        promptEl.onclick = () => detailEl.classList.toggle('open');
        promptEl.removeEventListener('keydown', onKey);
      }

      promptEl.querySelectorAll('.perm-actions button').forEach(btn => {
        btn.onclick = () => resolvePermission(btn.dataset.decision);
      });

      // Enter = allow, Escape = deny while prompt is active
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); resolvePermission('allow'); }
        if (e.key === 'Escape') { e.preventDefault(); resolvePermission('deny'); }
      }
      promptEl.addEventListener('keydown', onKey);
      break;
    }
  }

}

function buildDetailsElement(html) {
  // Parse <details><summary>Title</summary>content</details> into live-chat DOM
  const summaryMatch = html.match(/<summary>([\s\S]*?)<\/summary>/);
  const summary = summaryMatch ? summaryMatch[1].trim() : 'Activity';
  const content = html.replace(/<details>/, '').replace(/<\/details>/, '').replace(/<summary>[\s\S]*?<\/summary>/, '').trim();

  const isThinking = /^Thought/i.test(summary);

  if (isThinking) {
    // Build .chat-thinking-wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-thinking-wrapper';
    const header = document.createElement('div');
    header.className = 'chat-thinking-header';
    header.innerHTML = `<span class="chat-thinking-toggle">▶</span> <span class="pondering">${escapeHtml(summary)}</span>`;
    const body = document.createElement('div');
    body.className = 'chat-thinking-body';
    body.textContent = content;
    header.addEventListener('click', () => {
      body.classList.toggle('open');
      header.querySelector('.chat-thinking-toggle').classList.toggle('open');
    });
    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
  } else {
    // Build .chat-activity-group matching live chat DOM structure
    const group = document.createElement('div');
    group.className = 'chat-activity-group';
    const header = document.createElement('div');
    header.className = 'chat-activity-header';
    header.innerHTML = `<span class="chat-thinking-toggle">▶</span> ${escapeHtml(summary)}`;
    const body = document.createElement('div');
    body.className = 'chat-activity-body';

    // Parse saved markdown: tool entries, blockquotes (thinking), plain text, dicts
    const lines = content.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }

      // Skip raw Python dict lines (subagent results already handled by tool_result)
      if (line.match(/^[-*]?\s*\{'type':\s*'text'/)) { i++; continue; }

      // Blockquote = subagent thinking (old format: > text)
      if (line.startsWith('>')) {
        const thinkText = line.replace(/^>\s*/, '');
        const thinkEl = document.createElement('div');
        thinkEl.className = 'chat-thinking-content';
        thinkEl.style.cssText = 'font-size:12px;color:var(--text-muted);font-style:italic;padding:4px 8px;border-left:2px solid var(--border);margin:4px 0';
        thinkEl.textContent = thinkText;
        body.appendChild(thinkEl);
        i++; continue;
      }

      // HTML blockquote = subagent thinking (new format: <blockquote>text</blockquote>)
      if (line.startsWith('<blockquote>')) {
        const thinkText = line.replace(/<\/?blockquote>/g, '');
        const thinkEl = document.createElement('div');
        thinkEl.className = 'chat-thinking-content';
        thinkEl.style.cssText = 'font-size:12px;color:var(--text-muted);font-style:italic;padding:4px 8px;border-left:2px solid var(--border);margin:4px 0';
        thinkEl.textContent = thinkText;
        body.appendChild(thinkEl);
        i++; continue;
      }

      // Tool entry: - **ToolName** — description
      const toolMatch = line.match(/^[-*]\s*\*\*(\w+)\*\*\s*[—–-]\s*(.*)/);
      if (toolMatch) {
        const tName = toolMatch[1];
        const tDesc = toolMatch[2];
        const toolEntry = document.createElement('div');
        toolEntry.className = 'chat-tool-entry';
        toolEntry.innerHTML = `${toolIcon(tName)} <span class="tool-name">${escapeHtml(tName)}</span> <span class="tool-desc">${escapeHtml(tDesc)}</span>`;
        const toolResult = document.createElement('div');
        toolResult.className = 'chat-tool-result';

        // Collect result lines until next tool entry, blockquote, or blank gap before tool
        let resultLines = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          const nextTrimmed = next.trim();
          if (nextTrimmed.match(/^[-*]\s*\*\*\w+\*\*\s*[—–-]/)) break;
          if (nextTrimmed.match(/^[-*]?\s*\{'type'/)) break;
          if (nextTrimmed.startsWith('>') || nextTrimmed.startsWith('<blockquote>')) break;
          if (nextTrimmed === '' && i + 2 < lines.length && lines[i + 2].trim().match(/^[-*]\s*\*\*\w+\*\*/)) break;
          i++;
          resultLines.push(next.replace(/^\s{0,4}[-*]?\s*/, ''));
        }
        const resultText = resultLines.join('\n').trim();
        if (resultText) {
          const pre = document.createElement('pre');
          pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.4;margin:0;color:var(--text-muted)';
          pre.textContent = resultText.length > 500 ? resultText.slice(0, 500) + '\n...' : resultText;
          toolResult.appendChild(pre);
        }

        toolEntry.addEventListener('click', (e) => {
          e.stopPropagation();
          toolResult.classList.toggle('open');
        });
        body.appendChild(toolEntry);
        body.appendChild(toolResult);
        i++; continue;
      }

      // Plain text (subagent text output) — render as markdown
      if (!line.startsWith('-') && !line.startsWith('*') && !line.startsWith('<')) {
        const textEl = document.createElement('div');
        textEl.className = 'chat-text';
        textEl.innerHTML = marked.parse(line);
        body.appendChild(textEl);
      }
      i++;
    }

    header.addEventListener('click', () => {
      body.classList.toggle('open');
      header.querySelector('.chat-thinking-toggle').classList.toggle('open');
    });
    group.appendChild(header);
    group.appendChild(body);
    return group;
  }
}

async function continueSavedChat(path, content) {
  if (!content.trim()) return;

  // Extract title from first line (# Title)
  const titleMatch = content.match(/^# (.+)/m);
  const label = titleMatch ? titleMatch[1] : path.split('/').pop();

  // Check for precompact files in frontmatter
  let precompactSummary = null;
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const fmText = frontmatterMatch[1];
    const pcMatch = fmText.match(/precompact_files:\s*\n((?:\s*-\s*.+\n?)*)/);
    if (pcMatch) {
      const files = pcMatch[1].match(/-\s*(.+)/g)?.map(l => l.replace(/^-\s*/, '').trim()) || [];
      if (files.length > 0) {
        debugLog('[Continue] Summarizing', files.length, 'precompact chunks...');
        try {
          const resp = await authFetch('/api/chat/summarize-precompact', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ precompact_files: files }),
          });
          const data = await resp.json();
          if (data.ok && data.summary) {
            precompactSummary = data.summary;
            debugLog('[Continue] Summary generated:', precompactSummary.length, 'chars');
          }
        } catch (e) {
          console.warn('[Continue] Failed to summarize precompact:', e);
        }
      }
    }
  }

  // Create floating panel
  const panel = createFloatingPanel({ label: `${label} (continued)` });
  if (!panel) return;

  const messagesEl = panel.messagesContainer;

  // Split on ## You/Claude/User/Assistant headers and render each as a live-chat-style bubble.
  // Show full details (thinking, tools, subagents) visually, but _forkedHistory only has user+assistant text.
  const sections = content.split(/^(?=## (?:You|Claude|User|Assistant)\b)/m);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const userMatch = trimmed.match(/^## (?:You|User)\b/);
    const assistantMatch = trimmed.match(/^## (?:Claude|Assistant)\b/);

    if (userMatch) {
      const body = trimmed.replace(/^## (?:You|User)\s*/, '').trim();
      if (!body) continue;
      // Extract user text (strip <details> and raw dicts)
      let userText = body.replace(/<details>[\s\S]*?<\/details>/g, '');
      userText = userText.split('\n').filter(line =>
        !line.match(/^\s*[-*]?\s*\{'type':\s*'text'/)
      ).join('\n').trim();
      if (userText) {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-user';
        el.textContent = userText;
        messagesEl.appendChild(el);
      }
      // Render <details> blocks as live-chat-style activity
      const detailsBlocks = body.match(/<details>[\s\S]*?<\/details>/g) || [];
      for (const block of detailsBlocks) {
        messagesEl.appendChild(buildDetailsElement(block));
      }
    } else if (assistantMatch) {
      const body = trimmed.replace(/^## (?:Claude|Assistant)\s*/, '').trim();
      if (!body) continue;
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-assistant';

      // Split on <details> blocks to render activity inline
      const parts = body.split(/(<details>[\s\S]*?<\/details>)/g);
      for (const part of parts) {
        if (part.startsWith('<details>')) {
          el.appendChild(buildDetailsElement(part));
        } else if (part.trim()) {
          // Strip raw Python dict lines
          const cleaned = part.split('\n').filter(line =>
            !line.match(/^\s*[-*]?\s*\{'type':\s*'text'/)
          ).join('\n').trim();
          if (cleaned) {
            const textEl = document.createElement('div');
            textEl.innerHTML = marked.parse(cleaned);
            renderLatex(textEl);
            while (textEl.firstChild) el.appendChild(textEl.firstChild);
          }
        }
      }
      messagesEl.appendChild(el);
    }
    // Skip preamble (# title, Session: line)
  }

  // Add separator
  const sep = document.createElement('div');
  sep.className = 'chat-fork-separator';
  sep.textContent = '— continued from saved chat —';
  messagesEl.appendChild(sep);

  // Inject context for the first message
  if (precompactSummary) {
    // Compacted chat: inject summary of older messages + recent transcript
    // Strip frontmatter from content for the recent part
    const recentContent = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    panel._forkedHistory = [
      { role: 'user', content: 'Summary of our earlier conversation (before context compaction):\n\n' + precompactSummary },
      { role: 'assistant', content: 'I have the context from our earlier conversation. Here is the recent part:' },
      { role: 'user', content: recentContent },
    ];
  } else {
    // No compaction: inject full transcript
    panel._forkedHistory = [
      { role: 'user', content: 'Here is our previous conversation transcript:' },
      { role: 'assistant', content: content },
    ];
  }

  // Track source file so on close we append instead of creating a new file
  panel._continuedFromPath = path;

  // Collapse fullpage
  collapseFullPage();
}

async function maybeGenerateChatTitle(panel) {
  // Generate title after first user+assistant exchange, but only once
  if (!panel || panel._titleGenerated || panel._titlePending) return;
  const userMsgs = panel.messages.filter(m => m.role === 'user');
  if (userMsgs.length < 3) return;

  panel._titlePending = true;
  try {
    const resp = await authFetch('/api/chat/generate-title', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ messages: panel.messages.slice(0, 6) }),
    });
    const data = await resp.json();
    if (data.ok && data.title) {
      panel._titleGenerated = true;
      panel._generatedTitle = data.title;
      panel._generatedSlug = data.slug;
      // Update panel label in header
      const panelId = [...chatPanels.entries()].find(([, p]) => p === panel)?.[0];
      if (panelId) {
        const labelEl = panel.container?.querySelector('.panel-label');
        if (labelEl) labelEl.textContent = data.title;
      }
      // Update main chat header if this is the main panel
      if (panel === activePanel) {
        const mainLabel = document.querySelector('#chat-header .panel-label');
        if (mainLabel) mainLabel.textContent = data.title;
      }
    }
  } catch (e) { /* silent — title generation is best-effort */ }
  panel._titlePending = false;
}

async function saveChatTranscript() {
  if (chatIsTemporary || chatMessages.length === 0 || !chatSessionId) return;
  try {
    const title = activePanel?._generatedTitle || null;
    const resp = await authFetch('/api/chat/save', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ session_id: chatSessionId, messages: chatMessages, title, context_path: activePanel?.contextPath || null }),
    });
    const data = await resp.json();
    debugLog('Chat saved:', data);
    refreshFileTree();

    // If title wasn't generated yet, trigger async generation and update the file
    if (!title && data.ok && data.path && chatMessages.some(m => m.role === 'user')) {
      generateAndUpdateTitle(data.path, chatMessages);
    }
  } catch (e) { console.error('Chat save failed:', e); }
}

async function generateAndUpdateTitle(savedPath, messages) {
  try {
    const resp = await authFetch('/api/chat/generate-title', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ messages: messages.slice(0, 6) }),
    });
    const data = await resp.json();
    if (data.ok && data.title) {
      await authFetch('/api/chat/update-title', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path: savedPath, title: data.title }),
      });
      refreshFileTree();
    }
  } catch (e) { /* silent — best effort */ }
}

function saveChatBeacon() {
  // For beforeunload — sendBeacon is the only reliable method
  if (chatIsTemporary || chatMessages.length === 0 || !chatSessionId) return;
  const blob = new Blob([JSON.stringify({
    session_id: chatSessionId, messages: chatMessages, title: activePanel?._generatedTitle || null, context_path: activePanel?.contextPath || null,
  })], { type: 'application/json' });
  navigator.sendBeacon('/api/chat/save', blob);
}

// marked is now bundled with marked-katex-extension — $...$ and $$...$$ are
// rendered as KaTeX during marked.parse(). No manual protection needed.

function renderLatex(el) {
  if (typeof renderMathInElement === 'function' && el) {
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch {}
  }
}

// ========================================
// Image Paste Support
// ========================================

function setupImagePaste(inputEl, getAttachmentBar, getPendingImages) {
  // getAttachmentBar returns the DOM element for the attachment preview area
  // getPendingImages returns the array to push images onto (panel-specific)
  // Listen on the container so image paste works even if textarea doesn't
  // propagate clipboard image items on all platforms
  const listenEl = inputEl.closest('#chat-input-area, .fcp-input-area') || inputEl;
  listenEl.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(i => i.type.startsWith('image/'));
    if (!imageItem) return;

    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;

      try {
        const resp = await authFetch('/api/chat/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data_url: dataUrl, filename: file.name || '' }),
        });
        if (!resp.ok) throw new Error('Upload failed');
        const { path, url } = await resp.json();

        const bar = getAttachmentBar();
        bar.style.display = 'flex';

        const thumb = document.createElement('div');
        thumb.className = 'chat-attachment-thumb';
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Pasted image';
        img.style.cursor = 'pointer';
        img.onclick = (e) => { e.stopPropagation(); showImageLightbox(url); };
        const removeBtn = document.createElement('button');
        removeBtn.className = 'chat-attachment-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => {
          thumb.remove();
          const arr = getPendingImages();
          const idx = arr.findIndex(i => i.path === path);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) bar.style.display = 'none';
        };
        thumb.appendChild(img);
        thumb.appendChild(removeBtn);
        bar.appendChild(thumb);

        getPendingImages().push({ path, url });
      } catch (err) {
        console.error('Image upload failed:', err);
        console.error('Image upload failed:', err);
      }
    };
    reader.readAsDataURL(file);
  });
}

function showImageLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// Global pending images for main panel
let mainPendingImages = [];

function appendChatMessage(role, text, tag) {
  const messages = chatMessagesContainer || document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = `chat-msg chat-msg-${role}`;
  if (tag === 'redirect') {
    const label = document.createElement('span');
    label.className = 'chat-redirect-label';
    label.textContent = '↻ Redirect';
    el.appendChild(label);
    if (text) {
      const span = document.createElement('span');
      span.textContent = ' ' + text;
      el.appendChild(span);
    }
  } else if (tag === 'queued') {
    el.classList.add('chat-msg-queued');
    el.textContent = text;
  } else {
    el.textContent = text;
  }
  messages.appendChild(el);
  return el;
}

// ========================================
// Text Selection → Ask Claude
// ========================================
let pendingSelection = null;

function initSelectionTooltip() {
  const tooltip = document.getElementById('selection-tooltip');
  const askBtn = document.getElementById('selection-ask-btn');

  document.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length < 5) {
      tooltip.style.display = 'none';
      return;
    }

    // Only show on doc-body, fullpage-content, or pdf-text-layer
    const anchor = sel.anchorNode?.parentElement;
    if (!anchor) { tooltip.style.display = 'none'; return; }
    const inContent = anchor.closest('.doc-body') || anchor.closest('.fullpage-content') || anchor.closest('.pdf-text-layer') || anchor.closest('.chat-msg-assistant') || anchor.closest('.chat-thinking-body');
    if (!inContent) { tooltip.style.display = 'none'; return; }

    // Find the file path
    const card = anchor.closest('.doc-card');
    const fullpage = anchor.closest('#fullpage-overlay');
    const filePath = card?.dataset.path || fullpage?.dataset.path || '';

    // Position tooltip near selection
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    tooltip.style.left = (rect.left + rect.width / 2 - 40) + 'px';
    tooltip.style.top = (rect.bottom + 4) + 'px';
    tooltip.style.display = '';

    pendingSelection = { text: sel.toString(), file: filePath };
  });

  askBtn.onclick = () => {
    tooltip.style.display = 'none';
    if (!pendingSelection?.text) return;

    // Build the quoted text
    const fileName = pendingSelection.file ? pendingSelection.file.split('/').pop() : '';
    const prefix = fileName ? `From \`${fileName}\`:\n` : '';
    const quoted = pendingSelection.text.split('\n').map(l => `> ${l}`).join('\n');
    const insertion = `${prefix}${quoted}\n\n`;

    // Open a new floating panel with the quoted text pre-filled
    const newPanel = createFloatingPanel({
      contextPath: pendingSelection.file || null,
      prefill: insertion,
    });
    pendingSelection = null;
  };

  // Hide tooltip on click elsewhere
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#selection-tooltip')) {
      tooltip.style.display = 'none';
    }
  });
}

// ========================================
// PDF Rendering (lazy-loaded pdf.js)
// ========================================
let pdfjsLib = null;

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('/static/vendor/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.mjs';
  return pdfjsLib;
}

async function renderPdfInElement(container, pdfUrl) {
  container.innerHTML = '<em>Loading PDF...</em>';
  try {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument(pdfUrl).promise;
    container.innerHTML = '';
    container.className = 'pdf-container';

    const containerWidth = container.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;

    const numPages = Math.min(pdf.numPages, 50); // Cap at 50 pages for performance
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      // Scale to fit container width with padding
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min((containerWidth - 32) / baseViewport.width, 2);
      const viewport = page.getViewport({ scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.style.width = viewport.width + 'px';
      wrapper.style.height = viewport.height + 'px';

      // Canvas for rendering — render at device pixel ratio for retina sharpness
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      wrapper.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Text layer for selection
      const textContent = await page.getTextContent();
      const textLayer = document.createElement('div');
      textLayer.className = 'pdf-text-layer';
      textLayer.style.width = viewport.width + 'px';
      textLayer.style.height = viewport.height + 'px';

      for (const item of textContent.items) {
        const span = document.createElement('span');
        const tx = item.transform;
        span.textContent = item.str;
        span.style.left = tx[4] + 'px';
        span.style.top = (viewport.height - tx[5] - item.height) + 'px';
        span.style.fontSize = item.height + 'px';
        textLayer.appendChild(span);
      }

      wrapper.appendChild(textLayer);
      container.appendChild(wrapper);
    }
  } catch (e) {
    container.innerHTML = `<em>Failed to load PDF: ${e.message}</em>`;
  }
}

// ========================================
// CodeMirror 6 (lazy-loaded for code editing)
// ========================================
let cm6Module = null;

async function loadCodeMirror() {
  if (cm6Module) return cm6Module;
  cm6Module = await import('/static/vendor/codemirror6.min.js');
  return cm6Module;
}

function getLanguageExt(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = { py: 'python', js: 'javascript', ts: 'javascript', jsx: 'javascript', tsx: 'javascript', html: 'html', htm: 'html', css: 'css', json: 'json', md: 'markdown', tex: 'latex', bib: 'latex', sh: 'javascript', bash: 'javascript', yaml: 'markdown', yml: 'markdown' };
  return map[ext] || null;
}

async function createCodeEditor(container, content, filename, options = {}) {
  const cm = await loadCodeMirror();
  const langName = getLanguageExt(filename);
  const isDark = document.documentElement.dataset.theme === 'dark';
  const extensions = [cm.basicSetup];
  if (isDark) {
    extensions.push(cm.oneDark);
  } else {
    extensions.push(cm.syntaxHighlighting(cm.classHighlighter));
  }
  extensions.push(cm.EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-gutters': { backgroundColor: 'transparent' } }));

  if (langName === 'python') extensions.push(cm.python());
  else if (langName === 'javascript') extensions.push(cm.javascript());
  else if (langName === 'html') extensions.push(cm.html());
  else if (langName === 'css') extensions.push(cm.css());
  else if (langName === 'json') extensions.push(cm.json());
  else if (langName === 'markdown') extensions.push(cm.markdown());
  else if (langName === 'latex') extensions.push(cm.StreamLanguage.define(cm.stex));

  if (options.readOnly) {
    extensions.push(cm.EditorState.readOnly.of(true));
  }

  const state = cm.EditorState.create({ doc: content, extensions });
  const view = new cm.EditorView({ state, parent: container });
  return view;
}

function isCodeFile(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ['py', 'js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'json', 'yaml', 'yml', 'sh', 'bash', 'tex', 'bib', 'toml', 'cfg', 'ini', 'sql', 'r', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(ext);
}

// ========================================
// Settings
// ========================================
function initActionMenu() {
  const btn = document.getElementById('btn-action-menu');
  const menu = document.getElementById('action-menu');
  if (!btn || !menu) return;
  // Move to body so it's not trapped in toolbar's stacking context
  document.body.appendChild(menu);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) menu.classList.add('open');
    // Update context-dependent items
    const ctxItems = document.getElementById('action-context-items');
    ctxItems.innerHTML = '';
    // Compile TeX if viewing a .tex file
    const viewingPath = expandedCard?.dataset.path || '';
    if (viewingPath.endsWith('.tex')) {
      const item = document.createElement('div');
      item.className = 'action-item';
      item.textContent = 'Compile TeX';
      item.onclick = () => { closeActionMenu(); /* compileTeX() */ };
      ctxItems.appendChild(document.createElement('hr'));
      ctxItems.appendChild(item);
    }
    // Continue Chat if viewing a saved chat
    if (viewingPath.startsWith('raw/chats/')) {
      const item = document.createElement('div');
      item.className = 'action-item';
      item.textContent = 'Continue Chat';
      item.onclick = () => { closeActionMenu(); continueSavedChat(viewingPath, cardMeta.get(viewingPath)?.content || ''); };
      ctxItems.appendChild(document.createElement('hr'));
      ctxItems.appendChild(item);
    }
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => menu.classList.remove('open'));
}

function initSettings() {
  // Filter button — opens the filter dropdown (canvas-specific)
  const filterBtn = document.getElementById('btn-filters');
  const toolbarMenu = document.getElementById('toolbar-menu');

  if (filterBtn && toolbarMenu) {
    // Move to body so it's not trapped in toolbar's stacking context
    document.body.appendChild(toolbarMenu);
    filterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = toolbarMenu.classList.contains('open');
      closeAllDropdowns();
      if (!wasOpen) toolbarMenu.classList.add('open');
      updateFilterDot();
    });
    toolbarMenu.addEventListener('click', (e) => e.stopPropagation());
    toolbarMenu.addEventListener('change', (e) => e.stopPropagation());
    document.addEventListener('click', () => toolbarMenu.classList.remove('open'));
  }

  // Settings dropdown — load settings when opened
  const settingsDD = document.getElementById('settings-dropdown');
  if (settingsDD) {
    const observer = new MutationObserver(() => {
      if (!settingsDD.classList.contains('hidden')) {
        authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
          const rootEl = document.getElementById('settings-loom-root');
          const authEl = document.getElementById('settings-auth-status');
          if (rootEl) rootEl.value = resp.loom_root || '';
          if (authEl) {
            authEl.textContent = resp.claude_authenticated ? 'Logged in' : 'Not logged in';
            authEl.style.color = resp.claude_authenticated ? 'var(--green)' : 'var(--red)';
          }
        }).catch(() => {});
      }
    });
    observer.observe(settingsDD, { attributes: true, attributeFilter: ['class'] });
  }

  // Save loom root
  document.getElementById('settings-save-root').addEventListener('click', async () => {
    const newRoot = document.getElementById('settings-loom-root').value.trim();
    if (!newRoot) return;
    const btn = document.getElementById('settings-save-root');
    btn.textContent = 'Saving...';
    const result = await authFetch('/api/settings', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ loom_root: newRoot }),
    }).then(r => r.json());
    if (result.ok) {
      btn.textContent = 'Restarting...';
      await restartServer();
    } else {
      btn.textContent = 'Save & Restart';
      alert(result.error || 'Failed to save settings');
    }
  });

  // Claude login
  document.getElementById('settings-login').addEventListener('click', async () => {
    document.getElementById('settings-login').textContent = 'Starting...';
    const result = await authFetch('/api/claude-auth', { method: 'POST' }).then(r => r.json());
    document.getElementById('settings-auth-status').textContent = result.message || result.error || '';
    document.getElementById('settings-login').textContent = 'Login';
  });

  // Code font size slider — restore saved value on load
  const slider = document.getElementById('settings-code-font');
  const valDisplay = document.getElementById('settings-code-font-val');
  const savedCodeFont = localStorage.getItem('loom-code-font-size') || '13';
  slider.value = savedCodeFont;
  valDisplay.textContent = savedCodeFont + 'px';
  document.documentElement.style.setProperty('--code-font-size', savedCodeFont + 'px');
  slider.addEventListener('input', () => {
    const size = slider.value + 'px';
    valDisplay.textContent = size;
    localStorage.setItem('loom-code-font-size', slider.value);
    document.documentElement.style.setProperty('--code-font-size', size);
  });

  // Keybinding editor
  renderKeybindingEditor();
}

async function restartServer() {
  // Save all active chats before restarting
  document.title = 'Saving chats...';
  document.body.style.opacity = '0.5';
  try { await saveChatTranscript(); } catch {}
  for (const [id, panel] of chatPanels) {
    if (id !== 'main' && panel.messages.length > 0 && !panel.isTemporary) {
      try {
        await authFetch('/api/chat/save', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ session_id: panel.sessionId, messages: panel.messages, title: panel._generatedTitle || null, context_path: panel.contextPath || null }),
        });
      } catch {}
    }
  }
  // Clear browser caches before restart
  document.title = 'Clearing caches...';
  try {
    // Unregister service worker so stale cache is gone
    const regs = await navigator.serviceWorker?.getRegistrations();
    for (const reg of (regs || [])) await reg.unregister();
    // Clear all SW caches
    const cacheNames = await caches?.keys();
    for (const name of (cacheNames || [])) await caches.delete(name);
  } catch {}

  // Restart — server will os.execv itself, so wait for it to come back
  document.title = 'Restarting...';
  try {
    await authFetch('/api/restart', { method: 'POST' });
  } catch {}
  // Poll until server is fully ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await fetch('/api/ping', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        await new Promise(r => setTimeout(r, 500));
        break;
      }
    } catch {}
  }
  window.location.href = window.location.pathname + '?_=' + Date.now();
}

const DEFAULT_PERMISSION_RULES = {
  file_read: 'allow',
  file_write: 'allow',
  shell: 'allow',
  destructive_git: 'ask',
  mcp_tools: 'allow',
};

function getPermissionRules() {
  const saved = JSON.parse(localStorage.getItem('loom-permissions') || '{}');
  return { ...DEFAULT_PERMISSION_RULES, ...saved };
}

function sendPermissionsToBackend(rules) {
  // Send to main panel
  const mainPanel = chatPanels.get('main');
  if (mainPanel?.ws?.readyState === WebSocket.OPEN) {
    mainPanel.ws.send(JSON.stringify({ type: 'set_permissions', rules }));
  }
  // Send to floating panels
  for (const [id, panel] of chatPanels) {
    if (id !== 'main' && panel.ws?.readyState === WebSocket.OPEN) {
      panel.ws.send(JSON.stringify({ type: 'set_permissions', rules }));
    }
  }
}

function showAccountInfo() {
  const existing = document.getElementById('account-info-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'account-info-panel';
  panel.className = 'keybinding-panel';
  panel.innerHTML = `
    <div class="keybinding-panel-header">
      <span>Account</span>
      <span style="flex:1"></span>
      <button onclick="document.getElementById('account-info-panel').remove()" title="Close">✕</button>
    </div>
    <div class="keybinding-panel-body" style="padding:14px">
      <div style="font-size:var(--fs-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Claude Code</div>
      <div id="account-auth-status" style="margin-bottom:12px;font-size:var(--fs-sm)">Checking...</div>
      <div id="account-actions" style="display:flex;gap:8px;margin-bottom:16px"></div>
      <div style="font-size:var(--fs-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Codex (OpenAI)</div>
      <div id="account-codex-status" style="margin-bottom:8px;font-size:var(--fs-sm)">Checking...</div>
      <div id="account-codex-actions" style="display:flex;gap:8px;margin-bottom:8px"></div>
    </div>
  `;
  document.getElementById('canvas-container').appendChild(panel);

  function refreshAuthStatus() {
    authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
      const statusEl = document.getElementById('account-auth-status');
      const actions = document.getElementById('account-actions');
      if (statusEl) {
        statusEl.textContent = resp.claude_authenticated ? '✓ Logged in' : '✗ Not logged in';
        statusEl.style.color = resp.claude_authenticated ? 'var(--green)' : 'var(--red)';
      }
      if (actions) {
        if (resp.claude_authenticated) {
          actions.innerHTML = '<button class="fs-btn" id="account-reauth-btn">Re-authenticate</button><button class="fs-btn" id="account-logout-btn">Logout</button>';
        } else {
          actions.innerHTML = '<button class="fs-btn primary" id="account-login-btn">Login</button>';
        }
        wireAuthButtons();
      }
      // Codex status
      const codexStatus = document.getElementById('account-codex-status');
      const codexActions = document.getElementById('account-codex-actions');
      if (codexStatus) {
        if (resp.codex_available) {
          codexStatus.textContent = '✓ Codex CLI installed';
          codexStatus.style.color = 'var(--green)';
          if (codexActions) codexActions.innerHTML = '<button class="fs-btn" id="account-codex-login">Login with OpenAI</button>';
        } else {
          codexStatus.textContent = '✗ Not installed';
          codexStatus.style.color = 'var(--red)';
          if (codexActions) codexActions.innerHTML = '<span style="font-size:var(--fs-xs);color:var(--text-dim)">npm install -g @openai/codex</span>';
        }
        const codexLoginBtn = document.getElementById('account-codex-login');
        if (codexLoginBtn) codexLoginBtn.onclick = async () => {
          codexLoginBtn.textContent = 'Opening browser...';
          try {
            const result = await authFetch('/api/codex-auth', { method: 'POST' }).then(r => r.json());
            codexStatus.textContent = result.message || result.error || '';
          } catch {}
          codexLoginBtn.textContent = 'Login with OpenAI';
        };
      }
      const badge = document.getElementById('sm-auth-badge');
      if (badge) {
        badge.textContent = resp.claude_authenticated ? '✓' : '';
        badge.style.color = 'var(--green)';
      }
    }).catch(() => {
      const el = document.getElementById('account-auth-status');
      if (el) { el.textContent = 'Could not reach server'; el.style.color = 'var(--red)'; }
    });
  }

  function wireAuthButtons() {
    const loginBtn = document.getElementById('account-login-btn');
    const reauthBtn = document.getElementById('account-reauth-btn');
    const logoutBtn = document.getElementById('account-logout-btn');
    if (loginBtn) loginBtn.onclick = doLogin;
    if (reauthBtn) reauthBtn.onclick = doLogin;
    if (logoutBtn) logoutBtn.onclick = doLogout;
  }

  async function doLogin() {
    const statusEl = document.getElementById('account-auth-status');
    if (statusEl) statusEl.textContent = 'Opening browser...';
    try {
      const result = await authFetch('/api/claude-auth', { method: 'POST' }).then(r => r.json());
      if (statusEl) statusEl.textContent = result.message || result.error || '';
      setTimeout(refreshAuthStatus, 3000);
    } catch { }
  }

  async function doLogout() {
    const statusEl = document.getElementById('account-auth-status');
    if (statusEl) { statusEl.textContent = 'Logging out...'; statusEl.style.color = 'var(--text-muted)'; }
    try {
      const result = await authFetch('/api/claude-logout', { method: 'POST' }).then(r => r.json());
      if (statusEl) statusEl.textContent = result.message || result.error || '';
      refreshAuthStatus();
    } catch { }
  }

  refreshAuthStatus();

  function onKey(e) {
    if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

function showWorkspaceInfo() {
  const existing = document.getElementById('workspace-info-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'workspace-info-panel';
  panel.className = 'keybinding-panel';
  panel.innerHTML = `
    <div class="keybinding-panel-header">
      <span>Workspace</span>
      <span style="flex:1"></span>
      <button onclick="document.getElementById('workspace-info-panel').remove()" title="Close">✕</button>
    </div>
    <div class="keybinding-panel-body" style="padding:14px">
      <div style="margin-bottom:6px;font-size:var(--fs-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Loom Root</div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <input type="text" id="ws-loom-root" class="fs-input" style="flex:1" placeholder="/path/to/loom">
        <button id="ws-browse-btn" class="fs-btn" title="Browse">Browse</button>
      </div>
      <div id="ws-browser" style="display:none;margin-bottom:10px;max-height:240px;overflow-y:auto;background:var(--bg-sunken);border:1px solid var(--border-soft);border-radius:var(--r-sm);padding:4px 0"></div>
      <div style="display:flex;gap:8px">
        <button id="ws-save-btn" class="fs-btn primary">Save & Restart</button>
        <button id="ws-restart-btn" class="fs-btn">Restart Server</button>
      </div>
    </div>
  `;
  document.getElementById('canvas-container').appendChild(panel);

  authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
    const rootEl = document.getElementById('ws-loom-root');
    if (rootEl) rootEl.value = resp.loom_root || '';
  }).catch(() => {});

  // Directory browser
  const browserEl = document.getElementById('ws-browser');
  const rootInput = document.getElementById('ws-loom-root');
  document.getElementById('ws-browse-btn').onclick = () => {
    browserEl.style.display = browserEl.style.display === 'none' ? '' : 'none';
    if (browserEl.style.display !== 'none') {
      browseTo(rootInput.value || '~');
    }
  };

  function browseTo(path) {
    authFetch(`${getBaseUrl()}/api/browse?path=${encodeURIComponent(path)}`).then(r => {
      if (!r.ok) throw new Error('Not found — restart server to enable browsing');
      return r.json();
    }).then(data => {
      if (!data.path) throw new Error(data.error || data.detail || 'Invalid response');
      let html = '';
      // Parent navigation
      if (data.parent && data.parent !== data.path) {
        html += `<div class="ws-browse-item ws-browse-parent" data-path="${data.parent}">\u2191 ..</div>`;
      }
      // Current path display
      html += `<div class="ws-browse-current">${data.path}</div>`;
      // Entries
      for (const entry of (data.entries || [])) {
        const loomBadge = entry.is_loom ? '<span class="ws-loom-badge">loom</span>' : '';
        html += `<div class="ws-browse-item${entry.is_loom ? ' ws-is-loom' : ''}" data-path="${entry.path}">${entry.name} ${loomBadge}</div>`;
      }
      if ((data.entries || []).length === 0) {
        html += `<div style="padding:4px 12px;color:var(--text-dim);font-size:var(--fs-xs)">Empty directory</div>`;
      }
      browserEl.innerHTML = html;

      // Wire click handlers
      browserEl.querySelectorAll('.ws-browse-item').forEach(item => {
        item.onclick = () => browseTo(item.dataset.path);
        item.ondblclick = () => {
          rootInput.value = item.dataset.path;
          browserEl.style.display = 'none';
        };
      });
    }).catch(err => { browserEl.innerHTML = `<div style="padding:8px 12px;color:var(--red);font-size:var(--fs-xs)">${err.message || 'Could not browse'}</div>`; });
  }

  document.getElementById('ws-save-btn').onclick = async () => {
    const newRoot = document.getElementById('ws-loom-root').value.trim();
    if (!newRoot) return;
    const btn = document.getElementById('ws-save-btn');
    btn.textContent = 'Saving...';
    const result = await authFetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loom_root: newRoot }),
    }).then(r => r.json());
    if (result.ok) {
      btn.textContent = 'Restarting...';
      await restartServer();
    } else {
      btn.textContent = 'Save & Restart';
      alert(result.error || 'Failed to save settings');
    }
  };

  document.getElementById('ws-restart-btn').onclick = async () => {
    const btn = document.getElementById('ws-restart-btn');
    btn.textContent = 'Restarting...';
    await restartServer();
  };

  function onKey(e) {
    if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

function showAboutPanel() {
  const existing = document.getElementById('about-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'about-panel';
  panel.className = 'keybinding-panel';
  panel.style.maxWidth = '340px';
  panel.innerHTML = `
    <div class="keybinding-panel-header">
      <span>About Loom</span>
      <span style="flex:1"></span>
      <button onclick="document.getElementById('about-panel').remove()" title="Close">✕</button>
    </div>
    <div class="keybinding-panel-body" style="padding:18px;text-align:center">
      <div style="font-size:28px;margin-bottom:4px">✦</div>
      <div style="font-weight:600;font-size:var(--fs-lg);margin-bottom:2px">Loom</div>
      <div style="color:var(--text-muted);font-size:var(--fs-sm);margin-bottom:12px">v0.1 · Knowledge base on an infinite canvas</div>
      <div style="color:var(--text-dim);font-size:var(--fs-xs);line-height:1.5">
        Local-first workspace with Claude Code as the built-in agent.<br>
        Markdown on disk, git-versioned.
      </div>
    </div>
  `;
  document.getElementById('canvas-container').appendChild(panel);

  function onKey(e) {
    if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

function openFullSettings(initialTab) {
  const existing = document.getElementById('full-settings-panel');
  if (existing) { existing.remove(); return; }

  const sections = [
    { id: 'account', label: 'Account' },
    { id: 'workspace', label: 'Workspace' },
    { id: 'storage', label: 'Storage & sync' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'model', label: 'Model & agent' },
    { id: 'permissions', label: 'Tools & permissions' },
    { id: 'memory', label: 'Memory' },
    { id: 'indexing', label: 'Indexing' },
    { id: 'keyboard', label: 'Keyboard' },
    { id: 'integrations', label: 'Integrations' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'about', label: 'About' },
  ];

  const overlay = document.createElement('div');
  overlay.id = 'full-settings-panel';
  overlay.className = 'fs-panel';
  overlay.innerHTML = `
    <div class="fs-card">
      <nav class="fs-nav">
        <div class="fs-nav-title">SETTINGS</div>
        ${sections.map(s => `<button class="fs-nav-item" data-tab="${s.id}">${s.label}</button>`).join('')}
      </nav>
      <div class="fs-content">
        <div class="fs-content-header">
          <div>
            <div class="fs-content-eyebrow">Settings</div>
            <h2 class="fs-content-title" id="fs-title">Appearance</h2>
            <p class="fs-content-desc" id="fs-desc"></p>
          </div>
          <button class="fs-close" onclick="document.getElementById('full-settings-panel').remove()" title="Close">✕</button>
        </div>
        <div class="fs-content-body" id="fs-body"></div>
      </div>
    </div>
  `;
  // Click overlay background to close
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  const panel = overlay;

  const body = panel.querySelector('#fs-body');
  const title = panel.querySelector('#fs-title');
  const desc = panel.querySelector('#fs-desc');

  const sectionDescriptions = {
    account: 'Claude Code authentication status.',
    workspace: 'Loom root directory and server controls.',
    storage: 'VM sync, transcript saving, and backup.',
    appearance: 'Set-and-forget visual preferences. For in-session overlays, use the Appearance palette (\u2318\u21E7A) or keyboard shortcuts.',
    model: 'Active model, agent backend, and inference parameters.',
    permissions: 'Control what the agent can do without asking.',
    memory: 'Memory injection and context pipeline configuration.',
    indexing: 'Wiki page stats and search configuration.',
    keyboard: 'Rebind shortcuts to your preference.',
    integrations: 'Endpoint switcher, VM targets, and notifications.',
    privacy: 'Control what data is sent and stored.',
    about: '',
  };

  function switchTab(tabId) {
    panel.querySelectorAll('.fs-nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tabId));
    title.textContent = sections.find(s => s.id === tabId)?.label || '';
    desc.textContent = sectionDescriptions[tabId] || '';
    body.innerHTML = '';

    if (tabId === 'account') {
      body.innerHTML = `
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Claude Code</div><div class="fs-row-desc">Authentication status for the built-in agent.</div></div>
          <div class="fs-row-ctrl"><span id="fs-auth-status" style="color:var(--text-muted)">Checking...</span></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Re-authenticate</div><div class="fs-row-desc">Run the Claude Code login flow.</div></div>
          <div class="fs-row-ctrl"><button id="fs-login-btn" class="fs-btn">Login</button></div>
        </div>
      `;
      authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
        const el = document.getElementById('fs-auth-status');
        if (el) {
          el.textContent = resp.claude_authenticated ? '✓ Logged in' : '✗ Not logged in';
          el.style.color = resp.claude_authenticated ? 'var(--green)' : 'var(--red)';
        }
      }).catch(() => {
        const el = document.getElementById('fs-auth-status');
        if (el) { el.textContent = 'Server unreachable'; el.style.color = 'var(--red)'; }
      });
      const loginBtn = document.getElementById('fs-login-btn');
      if (loginBtn) loginBtn.onclick = async () => {
        loginBtn.textContent = 'Starting...';
        try {
          const result = await authFetch('/api/claude-auth', { method: 'POST' }).then(r => r.json());
          const el = document.getElementById('fs-auth-status');
          if (el) el.textContent = result.message || result.error || '';
        } catch {}
        loginBtn.textContent = 'Login';
      };

    } else if (tabId === 'workspace') {
      body.innerHTML = `
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Loom root</div><div class="fs-row-desc">Base directory for wiki, raw, projects, and outputs.</div></div>
          <div class="fs-row-ctrl" style="flex:1;max-width:340px">
            <input type="text" id="fs-loom-root" class="fs-input" placeholder="/path/to/loom">
          </div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Save & restart</div><div class="fs-row-desc">Apply the new root and restart the server.</div></div>
          <div class="fs-row-ctrl"><button id="fs-save-root" class="fs-btn">Save & Restart</button></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Restart server</div><div class="fs-row-desc">Restart without changing settings.</div></div>
          <div class="fs-row-ctrl"><button id="fs-restart-btn" class="fs-btn">Restart</button></div>
        </div>
      `;
      authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
        const el = document.getElementById('fs-loom-root');
        if (el) el.value = resp.loom_root || '';
      }).catch(() => {});
      document.getElementById('fs-save-root').onclick = async () => {
        const newRoot = document.getElementById('fs-loom-root').value.trim();
        if (!newRoot) return;
        const btn = document.getElementById('fs-save-root');
        btn.textContent = 'Saving...';
        const result = await authFetch('/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loom_root: newRoot }),
        }).then(r => r.json());
        if (result.ok) { btn.textContent = 'Restarting...'; await restartServer(); }
        else { btn.textContent = 'Save & Restart'; alert(result.error || 'Failed'); }
      };
      document.getElementById('fs-restart-btn').onclick = async () => {
        const btn = document.getElementById('fs-restart-btn');
        btn.textContent = 'Restarting...';
        await restartServer();
      };

    } else if (tabId === 'appearance') {
      const settings = [
        { key: 'theme', label: 'Theme', desc: 'Base surface colors. System follows OS appearance.', opts: ['dark','light','paper'] },
        { key: 'palette', label: 'Palette', desc: 'Neutral family underneath the accent.', opts: ['blue','slate'] },
        { key: 'typography', label: 'Typography', desc: 'Content stack — switch to all-mono for a more terminal feel.', opts: ['mixed','mono'] },
        { key: 'density', label: 'Density', desc: 'Vertical rhythm across cards and lists.', opts: ['compact','standard','roomy'] },
        { key: 'accent', label: 'Card accent', desc: 'Visual indicator on the left edge of cards.', opts: ['border','dot','flat'] },
        { key: 'canvas', label: 'Canvas background', desc: 'Pattern drawn behind the infinite canvas.', opts: ['dots','grid','paper','constellation'] },
        { key: 'threads', label: 'Loom threads', desc: 'Faint lines from chat to focused card.', opts: ['off','on'] },
        { key: 'font-size', label: 'Font size', desc: 'Scales the entire type scale — content, sidebar, chat.', type: 'slider', min: 11, max: 18, prop: '--fs-base', suffix: 'px' },
        { key: 'code-font-size', label: 'Code font size', desc: 'Size of code blocks in wiki cards.', type: 'slider', min: 10, max: 18, prop: '--code-font-size', suffix: 'px' },
        { key: 'font-ui', label: 'UI font', desc: 'Toolbar, sidebar, labels, settings.', type: 'font', prop: '--font-ui',
          fonts: [
            { val: 'inter', label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
            { val: 'system', label: 'System', stack: "system-ui, -apple-system, sans-serif" },
            { val: 'mono', label: 'Mono', stack: "var(--font-mono)" },
          ]},
        { key: 'font-read', label: 'Reading font', desc: 'Card body text, long-form content.', type: 'font', prop: '--font-read',
          fonts: [
            { val: 'inter', label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
            { val: 'newsreader', label: 'Newsreader', stack: "'Newsreader', Georgia, serif" },
            { val: 'system', label: 'System', stack: "system-ui, -apple-system, sans-serif" },
            { val: 'mono', label: 'Mono', stack: "var(--font-mono)" },
          ]},
        { key: 'font-code', label: 'Code font', desc: 'Code blocks, terminal output, mono elements.', type: 'font', prop: '--font-mono',
          fonts: [
            { val: 'jetbrains', label: 'JetBrains', stack: "'JetBrains Mono', 'Fira Code', monospace" },
            { val: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', 'Menlo', monospace" },
            { val: 'fira', label: 'Fira Code', stack: "'Fira Code', monospace" },
            { val: 'system', label: 'System', stack: "monospace" },
          ]},
      ];
      renderSettingsRows(body, settings);

    } else if (tabId === 'model') {
      const settings = [
        { key: 'model', label: 'Active model', desc: 'Which Claude model to use for chat.', opts: ['sonnet','haiku','opus'], action: 'model' },
        { key: 'agent', label: 'Agent', desc: 'Backend agent for code generation. Takes effect on next session.', opts: ['claude-code','codex'], action: 'agent' },
        { key: 'temperature', label: 'Temperature', desc: 'Sampling temperature (0 = deterministic, 1 = creative).', type: 'slider', min: 0, max: 100, divisor: 100 },
        { key: 'reasoning', label: 'Reasoning depth', desc: 'How deeply the model should reason before answering.', opts: ['low','med','high'] },
        { key: 'stream', label: 'Stream tokens', desc: 'Show tokens as they arrive vs. all at once.', opts: ['on','off'] },
      ];
      renderSettingsRows(body, settings);

    } else if (tabId === 'permissions') {
      const categories = [
        { cat: 'file_read', label: 'File read', desc: 'Allow agent to read files from disk.' },
        { cat: 'file_write', label: 'File write', desc: 'Allow agent to create and modify files.' },
        { cat: 'shell', label: 'Shell commands', desc: 'Allow agent to run shell commands.' },
        { cat: 'destructive_git', label: 'Destructive git', desc: 'Force push, hard reset, branch delete.' },
        { cat: 'mcp_tools', label: 'MCP tools', desc: 'Allow agent to call MCP server tools.' },
      ];
      const saved = getPermissionRules();
      const values = ['allow', 'ask', 'deny'];
      for (const { cat, label, desc: d } of categories) {
        const current = saved[cat] || (cat === 'destructive_git' ? 'ask' : 'allow');
        const row = document.createElement('div');
        row.className = 'fs-row';
        row.innerHTML = `
          <div class="fs-row-text"><div class="fs-row-label">${label}</div><div class="fs-row-desc">${d}</div></div>
          <div class="fs-row-ctrl"></div>
        `;
        const seg = document.createElement('div');
        seg.className = 'seg';
        values.forEach(v => {
          const btn = document.createElement('button');
          btn.textContent = v.charAt(0).toUpperCase() + v.slice(1);
          btn.dataset.val = v;
          btn.classList.toggle('on', v === current);
          btn.onclick = () => {
            seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
            const rules = {};
            body.querySelectorAll('.seg').forEach((s, i) => {
              const active = s.querySelector('button.on');
              if (active) rules[categories[i].cat] = active.dataset.val;
            });
            localStorage.setItem('loom-permissions', JSON.stringify(rules));
            sendPermissionsToBackend(rules);
          };
          seg.appendChild(btn);
        });
        row.querySelector('.fs-row-ctrl').appendChild(seg);
        body.appendChild(row);
      }

    } else if (tabId === 'storage') {
      // Remote access + QR code section
      body.innerHTML = `
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Remote access</div><div class="fs-row-desc">Allow connections from other devices on the network. Requires restart.</div></div>
          <div class="fs-row-ctrl"><button class="fs-btn" id="fs-remote-toggle">Checking...</button></div>
        </div>
        <div id="fs-remote-info" style="display:none">
          <div class="fs-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <div class="fs-row-text"><div class="fs-row-label">Connect from phone</div><div class="fs-row-desc">Scan this QR code to open Loom on your phone. Same WiFi required.</div></div>
            <div style="display:flex;gap:16px;align-items:center;width:100%">
              <canvas id="fs-qr-canvas" width="160" height="160" style="border-radius:var(--r-sm);background:#fff;padding:8px;flex-shrink:0"></canvas>
              <div style="flex:1">
                <div id="fs-remote-url" style="font-family:var(--font-mono);font-size:11px;color:var(--text);word-break:break-all;margin-bottom:8px"></div>
                <button class="fs-btn" id="fs-copy-url" style="font-size:10px">Copy URL</button>
              </div>
            </div>
          </div>
        </div>
      `;

      // Check remote status
      authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
        const toggleBtn = document.getElementById('fs-remote-toggle');
        const info = document.getElementById('fs-remote-info');
        if (resp.remote_enabled) {
          toggleBtn.textContent = 'Disable';
          toggleBtn.onclick = () => toggleRemote(false);
          info.style.display = '';
          // Fetch QR code from backend
          authFetch(`${getBaseUrl()}/api/qr-code`).then(r => r.ok ? r.json() : null).then(qr => {
            if (!qr) return;
            const url = qr.url;
            document.getElementById('fs-remote-url').textContent = url;
            document.getElementById('fs-copy-url').onclick = () => {
              navigator.clipboard.writeText(url);
              document.getElementById('fs-copy-url').textContent = 'Copied!';
              setTimeout(() => { document.getElementById('fs-copy-url').textContent = 'Copy URL'; }, 1500);
            };
            if (qr.qr_data_url) {
              const canvas = document.getElementById('fs-qr-canvas');
              const img = new Image();
              img.onload = () => {
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
              };
              img.src = qr.qr_data_url;
            }
          }).catch(() => {});
        } else {
          toggleBtn.textContent = 'Enable';
          toggleBtn.onclick = () => toggleRemote(true);
        }
      }).catch(() => {});

      async function toggleRemote(enable) {
        const btn = document.getElementById('fs-remote-toggle');
        btn.textContent = enable ? 'Enabling...' : 'Disabling...';
        try {
          await authFetch('/api/remote-access', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enable }),
          });
          btn.textContent = 'Restarting...';
          // Remember to reopen settings after restart
          sessionStorage.setItem('loom-reopen-settings', 'storage');
          await restartServer();
        } catch { btn.textContent = 'Failed'; }
      }

      // Remaining storage settings below
      const storageBody = document.createElement('div');
      body.appendChild(storageBody);
      const storageSettings = [
        { key: 'vm-sync', label: 'VM sync', desc: 'Automatically rsync wiki, memory, and transcripts to a remote VM.', opts: ['off', 'on'] },
        { key: 'sync-interval', label: 'Sync interval', desc: 'Seconds between automatic syncs.', type: 'slider', min: 30, max: 300, suffix: 's' },
        { key: 'transcript-autosave', label: 'Auto-save transcripts', desc: 'Save chat transcripts to raw/ when a session ends.', opts: ['on', 'off'] },
      ];
      renderSettingsRows(storageBody, storageSettings);

    } else if (tabId === 'memory') {
      const memSettings = [
        { key: 'memory-injection', label: 'Inject memories at session start', desc: 'Include memory index one-liners in the system prompt.', opts: ['on', 'off'] },
        { key: 'memory-cap', label: 'Memory cap', desc: 'Maximum number of memory entries injected.', type: 'slider', min: 5, max: 50 },
        { key: 'page-content-limit', label: 'Page content limit', desc: 'Max characters of page content included in context.', type: 'slider', min: 500, max: 10000, suffix: ' chars' },
      ];
      renderSettingsRows(body, memSettings);

    } else if (tabId === 'indexing') {
      body.innerHTML = `
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Wiki pages</div><div class="fs-row-desc">Total compiled wiki pages.</div></div>
          <div class="fs-row-ctrl"><span class="fs-stat" id="fs-wiki-count">...</span></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Raw sources</div><div class="fs-row-desc">Ingested documents in raw/.</div></div>
          <div class="fs-row-ctrl"><span class="fs-stat" id="fs-raw-count">...</span></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Search scope default</div><div class="fs-row-desc">Default scope for search queries.</div></div>
          <div class="fs-row-ctrl"></div>
        </div>
      `;
      const searchSeg = document.createElement('div');
      searchSeg.className = 'seg';
      ['wiki', 'all'].forEach(v => {
        const btn = document.createElement('button');
        btn.textContent = v.charAt(0).toUpperCase() + v.slice(1);
        btn.dataset.val = v;
        btn.classList.toggle('on', v === (localStorage.getItem('loom-search-scope') || 'all'));
        btn.onclick = () => {
          searchSeg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
          btn.classList.add('on');
          localStorage.setItem('loom-search-scope', v);
        };
        searchSeg.appendChild(btn);
      });
      body.querySelector('.fs-row:last-child .fs-row-ctrl').appendChild(searchSeg);
      // Fetch stats
      authFetch(`${getBaseUrl()}/api/tree`).then(r => r.json()).then(data => {
        const count = data.children ? data.children.length : 0;
        const el = document.getElementById('fs-wiki-count');
        if (el) el.textContent = count + ' pages';
      }).catch(() => {});
      authFetch(`${getBaseUrl()}/api/raw-sources`).then(r => r.json()).then(data => {
        const el = document.getElementById('fs-raw-count');
        if (el) el.textContent = (data.sources?.length || 0) + ' sources';
      }).catch(() => {
        const el = document.getElementById('fs-raw-count');
        if (el) el.textContent = '—';
      });

    } else if (tabId === 'integrations') {
      body.innerHTML = `
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Backends</div><div class="fs-row-desc">Endpoint switcher — tries backends in order. Edit the list in localStorage.</div></div>
          <div class="fs-row-ctrl"><span class="fs-stat" id="fs-backend-count"></span></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Ntfy topic</div><div class="fs-row-desc">Push notifications for agent done, job done, sync complete.</div></div>
          <div class="fs-row-ctrl"><input type="text" class="fs-input" id="fs-ntfy-topic" style="width:160px" placeholder="my-loom-topic"></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Ntfy server</div><div class="fs-row-desc">Default: ntfy.sh</div></div>
          <div class="fs-row-ctrl"><input type="text" class="fs-input" id="fs-ntfy-server" style="width:160px" placeholder="https://ntfy.sh"></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">MCP server</div><div class="fs-row-desc">Local MCP server status.</div></div>
          <div class="fs-row-ctrl"><span class="fs-stat" id="fs-mcp-status">Checking...</span></div>
        </div>
      `;
      // Populate
      const backends = getBackends();
      const bcEl = document.getElementById('fs-backend-count');
      if (bcEl) bcEl.textContent = backends.length + ' configured' + (activeBackend ? ' · active: ' + activeBackend.label : ' · using same-origin');
      const ntfyTopic = document.getElementById('fs-ntfy-topic');
      const ntfyServer = document.getElementById('fs-ntfy-server');
      if (ntfyTopic) { ntfyTopic.value = localStorage.getItem('loom-ntfy-topic') || ''; ntfyTopic.onchange = () => localStorage.setItem('loom-ntfy-topic', ntfyTopic.value); }
      if (ntfyServer) { ntfyServer.value = localStorage.getItem('loom-ntfy-server') || 'https://ntfy.sh'; ntfyServer.onchange = () => localStorage.setItem('loom-ntfy-server', ntfyServer.value); }
      authFetch(`${getBaseUrl()}/api/tree`).then(() => {
        const el = document.getElementById('fs-mcp-status');
        if (el) { el.textContent = 'Connected'; el.style.color = 'var(--green)'; }
      }).catch(() => {
        const el = document.getElementById('fs-mcp-status');
        if (el) { el.textContent = 'Unreachable'; el.style.color = 'var(--red)'; }
      });

      // Custom agents section
      const agentSection = document.createElement('div');
      agentSection.innerHTML = `
        <div class="fs-row" style="border-top:1px solid var(--border-soft);margin-top:4px">
          <div class="fs-row-text"><div class="fs-row-label">Custom Agents</div><div class="fs-row-desc">Add CLI agents. They appear in the agent picker alongside Claude Code and Codex.</div></div>
          <div class="fs-row-ctrl"><button class="fs-btn" id="fs-add-agent">+ Add</button></div>
        </div>
        <div id="fs-agent-list"></div>
      `;
      body.appendChild(agentSection);

      function getCustomAgents() {
        return JSON.parse(localStorage.getItem('loom-custom-agents') || '[]');
      }
      function saveCustomAgents(agents) {
        localStorage.setItem('loom-custom-agents', JSON.stringify(agents));
      }
      function renderAgentList() {
        const list = document.getElementById('fs-agent-list');
        const agents = getCustomAgents();
        list.innerHTML = agents.map((a, i) => `
          <div class="fs-row" style="padding:8px 32px">
            <div class="fs-row-text" style="gap:2px">
              <div style="font-weight:500;font-size:var(--fs-sm)">${a.name}</div>
              <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">${a.command}</div>
            </div>
            <div class="fs-row-ctrl">
              <button class="fs-btn" data-del="${i}" style="font-size:10px;padding:2px 8px;color:var(--red)">Remove</button>
            </div>
          </div>
        `).join('');
        list.querySelectorAll('[data-del]').forEach(btn => {
          btn.onclick = () => {
            const agents = getCustomAgents();
            agents.splice(parseInt(btn.dataset.del), 1);
            saveCustomAgents(agents);
            renderAgentList();
          };
        });
      }
      renderAgentList();

      document.getElementById('fs-add-agent').onclick = () => {
        const name = prompt('Agent name (e.g., "My Agent"):');
        if (!name) return;
        const command = prompt('Command to run (e.g., "my-agent" or "/path/to/agent"):');
        if (!command) return;
        const agents = getCustomAgents();
        agents.push({ name, command, id: 'custom-' + name.toLowerCase().replace(/\s+/g, '-') });
        saveCustomAgents(agents);
        renderAgentList();
      };

    } else if (tabId === 'privacy') {
      body.innerHTML = `
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Context sent to Claude</div><div class="fs-row-desc">System prompt includes: permissions, memory index, location context, page content.</div></div>
          <div class="fs-row-ctrl"><span class="fs-stat">All local</span></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Transcript storage</div><div class="fs-row-desc">Chat transcripts are saved to raw/ in your loom directory.</div></div>
          <div class="fs-row-ctrl"><span class="fs-stat">On disk</span></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Clear chat history</div><div class="fs-row-desc">Remove all saved chat sessions from this browser.</div></div>
          <div class="fs-row-ctrl"><button class="fs-btn" id="fs-clear-chats">Clear</button></div>
        </div>
        <div class="fs-row">
          <div class="fs-row-text"><div class="fs-row-label">Reset all settings</div><div class="fs-row-desc">Clear all localStorage preferences and reload.</div></div>
          <div class="fs-row-ctrl"><button class="fs-btn" id="fs-clear-storage" style="color:var(--red)">Reset</button></div>
        </div>
      `;
      document.getElementById('fs-clear-chats').onclick = () => {
        if (confirm('Clear all saved chat sessions?')) {
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith('loom-chat-')) keys.push(k);
          }
          keys.forEach(k => localStorage.removeItem(k));
          document.getElementById('fs-clear-chats').textContent = 'Cleared ' + keys.length;
        }
      };
      document.getElementById('fs-clear-storage').onclick = () => {
        if (confirm('Reset ALL Loom settings to defaults? This will reload the page.')) {
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith('loom-')) keys.push(k);
          }
          keys.forEach(k => localStorage.removeItem(k));
          window.location.reload();
        }
      };

    } else if (tabId === 'keyboard') {
      renderKeybindingEditor(body);

    } else if (tabId === 'about') {
      body.innerHTML = `
        <div style="padding:30px 0;text-align:center">
          <div style="font-size:36px;margin-bottom:6px">✦</div>
          <div style="font-weight:600;font-size:var(--fs-xl);margin-bottom:4px">Loom</div>
          <div style="color:var(--text-muted);font-size:var(--fs-md);margin-bottom:16px">v0.1</div>
          <div style="color:var(--text-dim);font-size:var(--fs-sm);line-height:1.6;max-width:320px;margin:0 auto">
            A local-first knowledge base and workspace on an infinite canvas.<br><br>
            Claude Code as the built-in agent via the Agent SDK.<br>
            Markdown on disk, git-versioned.
          </div>
        </div>
      `;
    }
  }

  // Render rows for appearance/model tabs
  function renderSettingsRows(container, settings) {
    for (const s of settings) {
      const row = document.createElement('div');
      row.className = 'fs-row';
      row.innerHTML = `<div class="fs-row-text"><div class="fs-row-label">${s.label}</div><div class="fs-row-desc">${s.desc}</div></div><div class="fs-row-ctrl"></div>`;
      const ctrl = row.querySelector('.fs-row-ctrl');

      if (s.type === 'slider') {
        const saved = localStorage.getItem('loom-' + s.key) || String(s.key === 'font-size' ? 13 : s.key === 'code-font-size' ? 13 : s.key === 'temperature' ? 40 : s.min);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = s.min;
        slider.max = s.max;
        slider.value = saved;
        slider.style.cssText = 'width:180px;accent-color:var(--accent)';
        const valLabel = document.createElement('span');
        valLabel.style.cssText = 'font-size:var(--fs-xs);color:var(--text-muted);margin-left:8px;min-width:32px';
        valLabel.textContent = s.divisor ? (parseInt(saved) / s.divisor).toFixed(1) : saved + (s.suffix || '');
        slider.oninput = () => {
          localStorage.setItem('loom-' + s.key, slider.value);
          valLabel.textContent = s.divisor ? (parseInt(slider.value) / s.divisor).toFixed(1) : slider.value + (s.suffix || '');
          if (s.prop) document.documentElement.style.setProperty(s.prop, slider.value + (s.suffix || ''));
          // Sync original sliders
          const origSlider = s.key === 'font-size' ? document.getElementById('global-font-size')
            : s.key === 'temperature' ? document.getElementById('temperature-slider') : null;
          if (origSlider) { origSlider.value = slider.value; origSlider.dispatchEvent(new Event('input')); }
        };
        ctrl.appendChild(slider);
        ctrl.appendChild(valLabel);
      } else if (s.type === 'font') {
        // Font picker — segmented with font-family preview
        const seg = document.createElement('div');
        seg.className = 'seg';
        const saved = localStorage.getItem('loom-' + s.key);
        for (const f of s.fonts) {
          const btn = document.createElement('button');
          btn.textContent = f.label;
          btn.dataset.val = f.val;
          btn.style.fontFamily = f.stack.replace("var(--font-mono)", "'JetBrains Mono', monospace");
          btn.classList.toggle('on', f.val === saved || (!saved && f === s.fonts[0]));
          btn.onclick = () => {
            seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
            localStorage.setItem('loom-' + s.key, f.val);
            document.documentElement.style.setProperty(s.prop, f.stack);
          };
          seg.appendChild(btn);
        }
        ctrl.appendChild(seg);
      } else {
        // Segmented control
        const seg = document.createElement('div');
        seg.className = 'seg';
        const attr = s.key;
        const saved = localStorage.getItem('loom-' + attr) || (s.key === 'theme' ? (document.documentElement.getAttribute('data-theme') || 'dark') : null);
        for (const opt of s.opts) {
          const btn = document.createElement('button');
          btn.textContent = opt.charAt(0).toUpperCase() + opt.slice(1).replace('-', ' ');
          btn.dataset.val = opt;
          btn.classList.toggle('on', opt === saved);
          btn.onclick = () => {
            seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
            localStorage.setItem('loom-' + attr, opt);
            document.documentElement.setAttribute('data-' + attr, opt);
            if (s.key === 'theme') applyTheme(opt);
            if (s.action === 'model') applyModelSetting(opt);
            if (s.action === 'agent') applyAgentSetting(opt);
            // Sync the palette segmented controls
            document.querySelectorAll(`.palette .seg[data-setting="${attr}"] button`).forEach(b => {
              b.classList.toggle('on', b.dataset.val === opt);
            });
          };
          seg.appendChild(btn);
        }
        ctrl.appendChild(seg);
      }
      container.appendChild(row);
    }
  }

  // Nav click handlers
  panel.querySelectorAll('.fs-nav-item').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  switchTab(initialTab || 'appearance');

  function onKey(e) {
    if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

function applyModelSetting(model) {
  // Update active panel model and send to WebSocket
  const panel = chatPanels.get(chatFocusHistory[0] || 'main');
  if (panel) {
    panel.model = model;
    if (panel.ws && panel.ws.readyState === WebSocket.OPEN) {
      panel.ws.send(JSON.stringify({ type: 'set_model', model }));
    }
  }
}

function checkAgentAuth(agent) {
  authFetch(`${getBaseUrl()}/api/settings`).then(r => r.json()).then(resp => {
    if (agent === 'claude-code' && !resp.claude_authenticated) {
      if (confirm('Claude Code is not authenticated. Open login?')) showAccountInfo();
    } else if (agent === 'codex' && !resp.codex_available) {
      alert('Codex CLI is not installed. Run: npm install -g @openai/codex');
    }
  }).catch(() => {});
}

const AGENT_LABELS = {
  'claude-code': 'Claude',
  'codex': 'Codex',
  'generic-cli': 'Agent',
};

function resolveAgentType(agentId) {
  if (!agentId || agentId === 'claude-code' || agentId === 'codex' || agentId === 'generic-cli') return agentId || 'claude-code';
  // Custom agents use the generic-cli adapter
  return 'generic-cli';
}

function resolveAgentCommand(agentId) {
  if (!agentId || agentId === 'claude-code' || agentId === 'codex' || agentId === 'generic-cli') return undefined;
  const custom = JSON.parse(localStorage.getItem('loom-custom-agents') || '[]');
  const found = custom.find(a => a.id === agentId);
  return found?.command || undefined;
}

function getAgentLabel(agentId) {
  if (AGENT_LABELS[agentId]) return AGENT_LABELS[agentId];
  const custom = JSON.parse(localStorage.getItem('loom-custom-agents') || '[]');
  const found = custom.find(a => a.id === agentId);
  return found ? found.name : 'Agent';
}

function updateInputPlaceholder(panelId) {
  const panel = chatPanels.get(panelId) || activePanel;
  const agent = panel?.agentType || 'claude-code';
  const label = getAgentLabel(agent);
  if (panelId === 'main' || !panelId) {
    const input = document.getElementById('chat-input');
    if (input) input.placeholder = `Message ${label}\u2026`;
  } else if (panel?.container) {
    const input = panel.container.querySelector('.fcp-input');
    if (input) input.placeholder = `Message ${label}\u2026`;
  }
}

function applyAgentSetting(agent) {
  checkAgentAuth(agent);
  const panel = chatPanels.get(chatFocusHistory[0] || 'main');
  if (panel) {
    panel.agentType = agent;
    updateInputPlaceholder(chatFocusHistory[0] || 'main');
  }
}

function openPermissionsPanel() {
  document.getElementById('permissions-panel')?.remove();

  const categories = [
    { cat: 'file_read', label: 'File Read' },
    { cat: 'file_write', label: 'File Write' },
    { cat: 'shell', label: 'Shell Commands' },
    { cat: 'destructive_git', label: 'Destructive Git' },
    { cat: 'mcp_tools', label: 'MCP Tools' },
  ];

  const saved = getPermissionRules();

  const panel = document.createElement('div');
  panel.id = 'permissions-panel';
  panel.className = 'keybinding-panel'; // reuse same styling
  panel.innerHTML = `
    <div class="keybinding-panel-header">
      <span>Agent Permissions</span>
      <span style="flex:1"></span>
      <button onclick="document.getElementById('permissions-panel').remove()" title="Close">✕</button>
    </div>
    <div class="keybinding-panel-body" id="permissions-panel-body"></div>
  `;
  document.getElementById('canvas-container').appendChild(panel);

  const values = ['allow', 'ask', 'deny'];
  const body = panel.querySelector('#permissions-panel-body');
  for (const { cat, label } of categories) {
    const row = document.createElement('div');
    row.className = 'keybind-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'keybind-label';
    labelEl.textContent = label;
    const current = saved[cat] || (cat === 'destructive_git' ? 'ask' : 'allow');
    const btn = document.createElement('button');
    btn.className = 'keybind-key perm-toggle';
    btn.dataset.cat = cat;
    btn.dataset.value = current;
    btn.textContent = current.charAt(0).toUpperCase() + current.slice(1);
    btn.onclick = () => {
      const idx = (values.indexOf(btn.dataset.value) + 1) % values.length;
      btn.dataset.value = values[idx];
      btn.textContent = values[idx].charAt(0).toUpperCase() + values[idx].slice(1);
      const rules = {};
      body.querySelectorAll('.perm-toggle').forEach(b => { rules[b.dataset.cat] = b.dataset.value; });
      localStorage.setItem('loom-permissions', JSON.stringify(rules));
      sendPermissionsToBackend(rules);
    };
    row.appendChild(labelEl);
    row.appendChild(btn);
    body.appendChild(row);
  }

  function onKey(e) {
    if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

function openKeybindingPanel() {
  // Remove existing panel if open
  document.getElementById('keybinding-panel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'keybinding-panel';
  panel.className = 'keybinding-panel';
  panel.innerHTML = `
    <div class="keybinding-panel-header">
      <span>Keyboard Shortcuts</span>
      <span style="flex:1"></span>
      <button onclick="document.getElementById('keybinding-panel').remove()" title="Close">✕</button>
    </div>
    <div class="keybinding-panel-body" id="keybinding-panel-body"></div>
  `;
  document.getElementById('canvas-container').appendChild(panel);
  renderKeybindingEditor(panel.querySelector('#keybinding-panel-body'));

  // Close on Escape
  function onKey(e) {
    if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

function renderKeybindingEditor(container) {
  const editor = container || document.getElementById('keybinding-editor');
  if (!editor) return;
  editor.innerHTML = '';
  for (const [action, binding] of Object.entries(keyBindings)) {
    const row = document.createElement('div');
    row.className = 'keybind-row';
    const label = document.createElement('span');
    label.className = 'keybind-label';
    label.textContent = binding.label || action;
    const key = document.createElement('button');
    key.className = 'keybind-key';
    key.textContent = bindingToString(binding);
    key.title = 'Click to rebind';
    key.onclick = (e) => {
      e.stopPropagation();
      key.textContent = 'Press keys...';
      key.classList.add('listening');
      function onKey(ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.key === 'Escape') { key.textContent = bindingToString(binding); key.classList.remove('listening'); document.removeEventListener('keydown', onKey, true); return; }
        if (['Shift','Control','Alt','Meta'].includes(ev.key)) return;
        keyBindings[action] = { ...binding, key: ev.key, mod: ev.ctrlKey || ev.metaKey, alt: ev.altKey, shift: ev.shiftKey };
        saveKeyBindings();
        key.textContent = bindingToString(keyBindings[action]);
        key.classList.remove('listening');
        document.removeEventListener('keydown', onKey, true);
      }
      document.addEventListener('keydown', onKey, true);
    };
    const reset = document.createElement('button');
    reset.className = 'keybind-reset';
    reset.textContent = '↺';
    reset.title = 'Reset to default';
    reset.onclick = (e) => {
      e.stopPropagation();
      keyBindings[action] = { ...DEFAULT_KEYBINDINGS[action] };
      saveKeyBindings();
      key.textContent = bindingToString(keyBindings[action]);
    };
    row.appendChild(label);
    row.appendChild(key);
    row.appendChild(reset);
    editor.appendChild(row);
  }
}

// --- Main init ---
// ========================================
// Mobile UI (v2)
// ========================================
function isMobile() { return window.innerWidth <= 768 || window.matchMedia('(max-width: 768px)').matches; }
var _mobileActive = false;
var _mobileTab = 'canvas';

function initMobile() {
  if (typeof _mdbg !== 'undefined') _mdbg.push('initMobile called, isMobile=' + isMobile());
  if (!isMobile()) return;
  _mobileActive = true;
  document.documentElement.setAttribute('data-mobile', '');

  // Build mobile shell: [content area] + [tab bar]
  const shell = document.createElement('div');
  shell.className = 'mobile-shell';
  shell.id = 'mobile-shell';

  const content = document.createElement('div');
  content.className = 'mobile-content';
  content.id = 'mobile-content';

  // Move canvas-container into the shell
  const canvas = document.getElementById('canvas-container');
  if (canvas) content.appendChild(canvas);

  // Canvas floating controls
  const floatControls = document.createElement('div');
  floatControls.className = 'mobile-float-controls';
  floatControls.innerHTML = `
    <button class="mobile-float-btn" onclick="fitView()"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>
    <button class="mobile-float-btn" onclick="autoLayout()"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>`;
  if (canvas) canvas.appendChild(floatControls);

  // Mobile breadcrumb — inside canvas so it respects canvas top offset
  const bc = document.createElement('div');
  bc.className = 'mobile-breadcrumb';
  bc.id = 'mobile-breadcrumb';
  if (canvas) canvas.appendChild(bc);

  // Tab bar
  const tabBar = document.createElement('nav');
  tabBar.className = 'mobile-tab-bar';
  const tabs = [
    { id: 'canvas', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', label: 'Canvas' },
    { id: 'files', icon: '<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>', label: 'Files' },
    { id: 'chat', icon: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>', label: 'Chat' },
    { id: 'more', icon: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>', label: 'More' },
  ];
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.className = 'mobile-tab' + (t.id === 'canvas' ? ' active' : '');
    btn.dataset.tab = t.id;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5">${t.icon}</svg><span>${t.label}</span>`;
    btn.addEventListener('click', () => switchMobileTab(t.id));
    tabBar.appendChild(btn);
  }

  shell.appendChild(content);
  shell.appendChild(tabBar);
  document.body.appendChild(shell);
  if (typeof _mdbg !== 'undefined') _mdbg.push('shell created, tabs=' + tabBar.children.length);

  // VisualViewport handler for iOS keyboard — hide tabs when keyboard opens
  if (window.visualViewport) {
    const _vvBar = tabBar;
    const _vvShell = shell;
    window.visualViewport.addEventListener('resize', () => {
      const vvh = window.visualViewport.height;
      const ih = window.innerHeight;
      const keyboardUp = vvh < ih * 0.8;
      if (typeof _mdbg !== 'undefined') _mdbg.push(`vv: ${Math.round(vvh)}/${ih} kb=${keyboardUp}`);
      document.documentElement.style.setProperty('--vvh', `${vvh}px`);
      _vvBar.style.display = keyboardUp ? 'none' : 'flex';
      _vvShell.style.height = keyboardUp ? `${vvh}px` : '';
    });
  }

  // Left edge swipe to go back
  let _swipeStartX = 0, _swipeStartY = 0, _swiping = false;
  shell.addEventListener('touchstart', (e) => {
    const x = e.touches[0].clientX;
    if (x < 25) { // 25px from left edge
      _swipeStartX = x;
      _swipeStartY = e.touches[0].clientY;
      _swiping = true;
    }
  }, { passive: true });
  shell.addEventListener('touchmove', (e) => {
    if (!_swiping) return;
    const dy = Math.abs(e.touches[0].clientY - _swipeStartY);
    if (dy > 30) _swiping = false; // vertical scroll, cancel swipe
  }, { passive: true });
  shell.addEventListener('touchend', (e) => {
    if (!_swiping) return;
    _swiping = false;
    const dx = e.changedTouches[0].clientX - _swipeStartX;
    if (dx > 80) mobileGoBack(); // swipe right > 80px = back
  }, { passive: true });

  // matchMedia listener for orientation/resize changes
  window.matchMedia('(max-width: 768px)').addEventListener('change', (e) => {
    if (!e.matches && _mobileActive) {
      _mobileActive = false;
      document.documentElement.removeAttribute('data-mobile');
      // Restore desktop layout — move canvas back
      const c = document.getElementById('canvas-container');
      if (c) document.body.insertBefore(c, document.getElementById('mobile-shell'));
      document.getElementById('mobile-shell')?.remove();
    }
  });
}

// --- Mobile back navigation ---
function mobileGoBack() {
  // Priority: fullscreen file → folder in files → canvas drill-down
  if (expandedCard) {
    collapseFullPage();
    return;
  }
  if (_mobileTab === 'files' && _mobileFilePath.length > 0) {
    _mobileFilePath.pop();
    switchMobileTab('files');
    return;
  }
  if (_mobileTab === 'canvas' && canvasStack.length > 1) {
    navigateToLevel(canvasStack.length - 2);
    return;
  }
}

// --- Mobile view switching ---
var _mobileFilePath = [];
var _mobileChatPanel = null;

function switchMobileTab(tab) {
  _mobileTab = tab;
  document.querySelectorAll('.mobile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

  const content = document.getElementById('mobile-content');
  if (!content) return;

  // Remove any existing mobile view (except canvas-container which stays)
  content.querySelectorAll('.mobile-view').forEach(v => v.remove());

  // Show/hide canvas + float controls
  const canvas = document.getElementById('canvas-container');
  if (canvas) canvas.style.display = tab === 'canvas' ? '' : 'none';
  const floats = content.querySelector('.mobile-float-controls');
  if (floats) floats.style.display = tab === 'canvas' ? 'flex' : 'none';
  const mbc = document.getElementById('mobile-breadcrumb');
  if (mbc) mbc.style.display = tab === 'canvas' && currentLevel().parentPath ? 'flex' : 'none';

  if (tab === 'canvas') {
    // Ensure the desktop graph view is active (may have been switched by tags/health)
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-graph')?.classList.add('active');
    updateMobileBreadcrumb();
    try { fitView(); } catch {}
  } else if (tab === 'files') {
    const view = document.createElement('div');
    view.className = 'mobile-view mobile-files';
    content.appendChild(view);
    renderMobileFiles(view);
  } else if (tab === 'chat') {
    const view = document.createElement('div');
    view.className = 'mobile-view mobile-chat';
    content.appendChild(view);
    renderMobileChat(view);
  } else if (tab === 'more') {
    const view = document.createElement('div');
    view.className = 'mobile-view mobile-more';
    content.appendChild(view);
    renderMobileMore(view);
  }
}

function updateMobileBreadcrumb() {
  const bc = document.getElementById('mobile-breadcrumb');
  if (!bc) return;
  const level = currentLevel();
  if (!level.parentPath) { bc.style.display = 'none'; return; }
  bc.style.display = 'flex';
  bc.innerHTML = `<button class="mobile-back-btn" onclick="navigateToLevel(canvasStack.length-2)">\u2190</button>
    <span class="mobile-crumb-label">${level.label || level.parentPath.split('/').pop()}</span>`;
}

// --- Mobile Files ---
function renderMobileFiles(container) {
  if (!filesTreeData) {
    container.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading...</div>';
    api.fetchTree().then(data => { filesTreeData = data; renderMobileFiles(container); }).catch(e => {
      container.innerHTML = `<div style="padding:20px;color:var(--red)">${e.message}</div>`;
    });
    return;
  }
  let node = filesTreeData;
  for (const seg of _mobileFilePath) {
    const child = (node.children || []).find(c => c.name === seg);
    if (child) node = child; else break;
  }
  const folderName = _mobileFilePath.length > 0 ? _mobileFilePath[_mobileFilePath.length - 1] : 'Files';
  const folderIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';
  const fileIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

  let html = '<div class="mf-header">';
  if (_mobileFilePath.length > 0) html += `<button class="mf-back" onclick="_mobileFilePath.pop();switchMobileTab('files')">\u2190</button>`;
  html += `<span class="mf-title">${folderName}</span></div><div class="mf-list">`;
  for (const child of (node.children || [])) {
    const isDir = child.type === 'folder';
    const esc = child.name.replace(/'/g, "\\'");
    const size = child.size ? (child.size > 1024 ? `${(child.size/1024).toFixed(0)} KB` : `${child.size} B`) : '';
    if (isDir) {
      const count = (child.children || []).length;
      const meta = count ? `<span class="mf-size">${count} items</span>` : '';
      html += `<div class="mf-item" onclick="_mobileFilePath.push('${esc}');switchMobileTab('files')">
        <span class="mf-icon">${folderIcon}</span><span class="mf-name">${child.name}</span>${meta}<span class="mf-chevron">\u203A</span></div>`;
    } else {
      const path = [..._mobileFilePath, child.name].join('/');
      const meta = size ? `<span class="mf-size">${size}</span>` : '';
      html += `<div class="mf-item" onclick="expandCard(null,'${path.replace(/'/g, "\\'")}')">
        <span class="mf-icon">${fileIcon}</span><span class="mf-name">${child.name}</span>${meta}</div>`;
    }
  }
  if (!(node.children || []).length) html += '<div class="mf-empty">Empty folder</div>';
  html += '</div>';
  container.innerHTML = html;
}

// --- Mobile Chat ---
var _mcWs = null;
var _mcSessionId = null;
var _mcResponseEl = null;
var _mcResponseText = '';

function renderMobileChat(container) {
  const scopeLevel = getSmartContextDefault();
  container.innerHTML = `
    <div class="mc-header">
      <span class="mc-header-title">Chat</span>
      <span class="mc-scope-chip" id="mc-scope-chip">
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6" cy="6" r="4"/><path d="M6 3V6L8 7.5"/></svg>
        ${scopeLevel}
      </span>
    </div>
    <div class="mc-messages" id="mc-messages"></div>
    <div class="mc-input-bar" id="mc-input-bar">
      <textarea class="mc-input" id="mc-input" placeholder="Message..." rows="1" autocomplete="off" autocorrect="on" autocapitalize="sentences"></textarea>
      <button class="mc-send" id="mc-send">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>`;

  const input = container.querySelector('#mc-input');
  const sendBtn = container.querySelector('#mc-send');
  const msgsEl = container.querySelector('#mc-messages');

  // Auto-grow textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Connect WebSocket for mobile chat
  if (!_mcWs || _mcWs.readyState !== WebSocket.OPEN) {
    _mcSessionId = crypto.randomUUID();
    const tokenParam = getTokenParam();
    const mcWsUrl = `${getWsUrl()}/ws/chat${tokenParam ? '?' + tokenParam : ''}`;
    if (typeof _mdbg !== 'undefined') _mdbg.push('WS url: ' + mcWsUrl);
    _mcWs = new WebSocket(mcWsUrl);
    _mcWs.onopen = () => {
      _mcWs.send(JSON.stringify({ type: 'init', session_id: _mcSessionId }));
      if (typeof _mdbg !== 'undefined') _mdbg.push('WS open, init sent');
    };
    _mcWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // Find current messages element dynamically (survives tab switches)
        const currentMsgs = document.getElementById('mc-messages');
        if (currentMsgs) handleMobileChatMessage(msg, currentMsgs);
        if (typeof _mdbg !== 'undefined' && msg.type !== 'text') _mdbg.push('ws:' + msg.type);
      } catch {}
    };
    _mcWs.onerror = () => {
      if (typeof _mdbg !== 'undefined') _mdbg.push('WS error');
    };
    _mcWs.onclose = () => {
      if (typeof _mdbg !== 'undefined') _mdbg.push('WS closed');
      _mcWs = null;
    };
  }

  sendBtn.onclick = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';

    // Show user message
    const userEl = document.createElement('div');
    userEl.className = 'chat-msg chat-msg-user';
    userEl.textContent = text;
    msgsEl.appendChild(userEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    // Send via WebSocket
    if (_mcWs && _mcWs.readyState === WebSocket.OPEN) {
      const level = currentLevel();
      if (typeof _mdbg !== 'undefined') _mdbg.push('send: ' + text.slice(0, 30));
      _mcWs.send(JSON.stringify({
        type: 'message',
        text,
        context_level: scopeLevel,
        context: { page_path: level.parentPath || '' },
      }));
      // Show thinking indicator
      _mcResponseEl = document.createElement('div');
      _mcResponseEl.className = 'chat-msg chat-msg-assistant';
      _mcResponseEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px">Thinking...</span>';
      msgsEl.appendChild(_mcResponseEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      _mcResponseText = '';
    }
  };

  // Enter = new line on mobile (send via button only)
}

function handleMobileChatMessage(msg, msgsEl) {
  if (!msgsEl) return;
  switch (msg.type) {
    case 'text':
      if (_mcResponseEl) {
        _mcResponseText += msg.content || '';
        _mcResponseEl.innerHTML = typeof marked !== 'undefined' ? marked.parse(_mcResponseText) : _mcResponseText.replace(/\n/g, '<br>');
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
      break;
    case 'thinking':
      // Update thinking indicator
      if (_mcResponseEl && _mcResponseText === '') {
        _mcResponseEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px;font-style:italic">Thinking...</span>';
      }
      break;
    case 'result':
      if (msg.content && _mcResponseEl) {
        _mcResponseEl.innerHTML = typeof marked !== 'undefined' ? marked.parse(msg.content) : msg.content.replace(/\n/g, '<br>');
      }
      _mcResponseEl = null;
      _mcResponseText = '';
      msgsEl.scrollTop = msgsEl.scrollHeight;
      break;
    case 'done':
    case 'stopped':
      _mcResponseEl = null;
      _mcResponseText = '';
      break;
    case 'error':
      if (_mcResponseEl) {
        _mcResponseEl.innerHTML = `<span style="color:var(--red)">${msg.message || 'Error'}</span>`;
      }
      _mcResponseEl = null;
      _mcResponseText = '';
      break;
  }
}

// --- Mobile More ---
function renderMobileMore(container) {
  const isVM = isVMTarget();
  const items = [
    { label: 'Search', icon: 'search', action: () => openMobileSearch() },
    ...(!isVM ? [{ label: 'Tags', icon: 'tag', action: () => openMobileSubview(container, 'Tags', () => { initTagCloud(); const tc = document.getElementById('view-tags'); return tc ? tc.innerHTML : 'No tags'; }) }] : []),
    ...(!isVM ? [{ label: 'Health', icon: 'activity', action: () => openMobileSubview(container, 'Health', () => { initHealth(); const hv = document.getElementById('view-health'); return hv ? hv.innerHTML : 'No data'; }) }] : []),
    { label: 'Settings', icon: 'settings', action: () => openFullSettings() },
    { label: 'Appearance', icon: 'palette', action: () => openFullSettings('appearance') },
  ];
  const iconSvg = {
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    palette: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>',
  };
  container.innerHTML = '<div class="mm-list">' + items.map((item, i) =>
    `<div class="mm-item" data-idx="${i}">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5">${iconSvg[item.icon] || ''}</svg>
      <span>${item.label}</span>
      <span class="mm-chevron">\u203A</span>
    </div>`
  ).join('') + '</div>';
  container.querySelectorAll('.mm-item').forEach((el, i) => {
    el.onclick = () => items[i].action();
  });
}

// --- Mobile subview (Tags, Health — renders inside More tab) ---
function openMobileSubview(parentContainer, title, renderFn) {
  const html = typeof renderFn === 'function' ? renderFn() : '';
  parentContainer.innerHTML = `
    <div class="mf-header">
      <button class="mf-back" onclick="switchMobileTab('more')">\u2190</button>
      <span class="mf-title">${title}</span>
    </div>
    <div style="padding:16px;overflow-y:auto;flex:1">${html}</div>`;
}

// --- Mobile Search (bottom sheet) ---
function openMobileSearch() {
  const content = document.createElement('div');
  content.style.padding = '16px';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search...';
  input.className = 'mc-input';
  input.style.cssText = 'width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:16px;box-sizing:border-box;';
  const results = document.createElement('div');
  results.style.cssText = 'margin-top:12px;max-height:50vh;overflow-y:auto;overscroll-behavior:contain';
  content.appendChild(input);
  content.appendChild(results);
  openBottomSheet(content);
  setTimeout(() => input.focus(), 100);
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      try {
        const data = await api.fetchSearch(q, 'all', 'both');
        if (!data.length) { results.innerHTML = '<div style="color:var(--text-muted);padding:8px">No results</div>'; return; }
        results.innerHTML = data.slice(0, 30).map(r =>
          `<div class="mf-item" style="padding:10px 0" data-path="${r.path}">
            <span style="font-size:13px;color:var(--text)">${r.path}</span>
            ${r.context ? `<span style="font-size:11px;color:var(--text-muted);display:block;margin-top:2px">${escapeHtml(r.context).slice(0, 80)}</span>` : ''}
          </div>`
        ).join('');
        results.querySelectorAll('.mf-item').forEach(el => {
          el.onclick = () => { closeBottomSheet(); expandCard(null, el.dataset.path); };
        });
      } catch (e) {
        results.innerHTML = `<div style="color:var(--red);padding:8px">${e.message}</div>`;
      }
    }, 300);
  };
}

// --- Bottom sheet ---
var _bottomSheetEl = null;
var _bottomSheetScrim = null;

function openBottomSheet(content) {
  closeBottomSheet();
  _bottomSheetScrim = document.createElement('div');
  _bottomSheetScrim.className = 'bs-scrim';
  _bottomSheetScrim.onclick = closeBottomSheet;

  _bottomSheetEl = document.createElement('div');
  _bottomSheetEl.className = 'bs-sheet';
  _bottomSheetEl.innerHTML = '<div class="bs-handle"></div>';
  _bottomSheetEl.appendChild(typeof content === 'string' ? Object.assign(document.createElement('div'), { innerHTML: content }) : content);

  document.body.appendChild(_bottomSheetScrim);
  document.body.appendChild(_bottomSheetEl);
  requestAnimationFrame(() => {
    _bottomSheetScrim.classList.add('visible');
    _bottomSheetEl.classList.add('open');
  });
}

function closeBottomSheet() {
  if (!_bottomSheetEl) return;
  _bottomSheetEl.classList.remove('open');
  _bottomSheetScrim?.classList.remove('visible');
  setTimeout(() => {
    _bottomSheetEl?.remove(); _bottomSheetScrim?.remove();
    _bottomSheetEl = null; _bottomSheetScrim = null;
  }, 300);
}

async function init() {
  // Mobile shell must be created first — before any async calls
  initMobile();

  // Try to select backend if multiple are configured
  const backends = getBackends();
  if (backends.length > 0) {
    const ok = await selectBackend();
    if (!ok) { showOfflineOverlay(); return; }
  }

  initCanvas();
  initFilterDropdowns();
  if (!_mobileActive) initChat(); // Desktop chat panel — mobile has its own
  initSelectionTooltip();

  document.querySelectorAll('.view-tab').forEach(tab => tab.onclick = () => switchView(tab.dataset.view));

  const searchInput = document.getElementById('search-input');
  let st; searchInput.oninput = () => { clearTimeout(st); if(!searchInput.value.trim()) { switchView('graph'); return; } st=setTimeout(()=>doSearch(searchInput.value),300); };
  searchInput.onkeydown = e => { if(e.key==='Enter') doSearch(searchInput.value); };

  document.getElementById('btn-auto-layout').onclick = autoLayout;
  document.getElementById('btn-fit').onclick = fitView;
  document.getElementById('sidebar-toggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  };

  // Sidebar resize handle — placed as sibling after sidebar so it isn't clipped
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'sidebar-resize';
  sidebar.parentNode.insertBefore(resizeHandle, sidebar.nextSibling);
  const savedWidth = localStorage.getItem('loom-sidebar-width');
  if (savedWidth) sidebar.style.width = savedWidth + 'px';

  let resizing = false;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizing = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const w = Math.max(140, Math.min(480, e.clientX));
    sidebar.style.width = w + 'px';
    sidebar.style.transition = 'none';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    sidebar.style.transition = '';
    localStorage.setItem('loom-sidebar-width', parseInt(sidebar.style.width));
  });
  resizeHandle.addEventListener('dblclick', () => {
    sidebar.style.width = '200px';
    localStorage.removeItem('loom-sidebar-width');
  });
  initSettings();
  initTargetSelector();
  initActionMenu();

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Don't intercept when typing in input/textarea
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if (e.key === 'Escape') {
      // Stop the most recently focused panel's generation
      const focusedId = chatFocusHistory[0] || 'main';
      const focusedPanel = chatPanels.get(focusedId);
      if (focusedId === 'main') {
        if (chatGenerating && chatWs && chatWs.readyState === WebSocket.OPEN) {
          wasUserInterrupt = true;
          chatWs.send(JSON.stringify({ type: 'stop' }));
          return;
        }
      } else if (focusedPanel?.generating && focusedPanel.ws?.readyState === WebSocket.OPEN) {
        focusedPanel.wasUserInterrupt = true;
        focusedPanel.ws.send(JSON.stringify({ type: 'stop' }));
        return;
      }
      if (checkpointMode) { exitCheckpointMode(); return; }
      // If the focused chat panel is above fullpage, send it back behind
      const focusedChatId = chatFocusHistory[0] || 'main';
      const focusedEl = focusedChatId === 'main' ? document.getElementById('chat-panel') : chatPanels.get(focusedChatId)?.container;
      if (focusedEl && parseInt(focusedEl.style.zIndex) > Z_LAYERS.fullpage) {
        focusedEl.style.setProperty('z-index', String(Z_LAYERS.floatingPanel), 'important');
        return;
      }
      if (expandedCard) { collapseFullPage(); return; }
      if (canvasStack.length > 1) { navigateToLevel(canvasStack.length - 2); return; }
    }
    // Rebindable shortcuts
    if (matchesBinding(e, 'search')) { e.preventDefault(); searchInput.focus(); return; }
    if (matchesBinding(e, 'toggle-tools') && !inInput) {
      e.preventDefault();
      const bodies = document.querySelectorAll('.chat-activity-body, .chat-thinking-body');
      const anyOpen = [...bodies].some(b => b.classList.contains('open'));
      bodies.forEach(b => { anyOpen ? b.classList.remove('open') : b.classList.add('open'); });
      document.querySelectorAll('.chat-thinking-toggle').forEach(t => { anyOpen ? t.classList.remove('open') : t.classList.add('open'); });
      return;
    }
    if (matchesBinding(e, 'cycle-model')) {
      e.preventDefault();
      const models = ['sonnet', 'opus', 'haiku'];
      const current = activePanel.model || 'sonnet';
      const next = models[(models.indexOf(current) + 1) % models.length];
      activePanel.model = next;
      if (chatWs && chatWs.readyState === WebSocket.OPEN) chatWs.send(JSON.stringify({ type: 'set_model', model: next }));
      return;
    }
    if (matchesBinding(e, 'view-canvas')) { e.preventDefault(); switchView('graph'); return; }
    if (matchesBinding(e, 'view-files')) { e.preventDefault(); switchView('files'); return; }
    if (matchesBinding(e, 'view-tags')) { e.preventDefault(); switchView('tags'); return; }
    if (matchesBinding(e, 'view-health')) { e.preventDefault(); switchView('health'); return; }
    if (matchesBinding(e, 'toggle-tree-tile') && !inInput) { e.preventDefault(); if (filesInitialized) setFilesMode(filesMode === 'tree' ? 'tiles' : 'tree'); return; }
    if (matchesBinding(e, 'toggle-sidebar') && !inInput) { e.preventDefault(); document.getElementById('sidebar').classList.toggle('collapsed'); return; }
    if (matchesBinding(e, 'new-chat') && !inInput) { e.preventDefault(); createFloatingPanel(); return; }
    if (matchesBinding(e, 'fork-chat')) { e.preventDefault(); createFloatingPanel({ fork: true }); return; }
    if (matchesBinding(e, 'background-agent')) { e.preventDefault(); backgroundCurrentAgent(chatFocusHistory[0] || 'main'); return; }
    if (matchesBinding(e, 'settings')) { e.preventDefault(); openFullSettings(); return; }
    if (matchesBinding(e, 'show-shortcuts')) { e.preventDefault(); openKeybindingPanel(); return; }
    if (matchesBinding(e, 'new-terminal')) { e.preventDefault(); createTerminalPanel(); return; }
    if (matchesBinding(e, 'restart-server')) { e.preventDefault(); restartServer(); return; }
    if (matchesBinding(e, 'delete-file') && !inInput) { e.preventDefault(); deleteCurrentFile(); return; }
    // Cmd+J: cycle focus between all chats (un-minimizes target, doesn't minimize others)
    if (matchesBinding(e, 'cycle-chat-focus')) {
      e.preventDefault();
      const allIds = [];
      for (const [id] of chatPanels) allIds.push(id);
      const ordered = [...new Set([...chatFocusHistory.filter(id => allIds.includes(id)), ...allIds])];
      debugLog('[Cmd+J] all panels:', ordered, 'cycleIndex:', chatCycleIndex);

      if (ordered.length === 0) {
        reopenAnyPanel();
        return;
      }
      if (ordered.length === 1) { focusChatPanel(ordered[0], true); return; }

      chatCycleIndex = ((chatCycleIndex < 0 ? 0 : chatCycleIndex) + 1) % ordered.length;
      focusChatPanel(ordered[chatCycleIndex], true);
      return;
    }
    // Cmd+/: solo cycle — focus one, minimize/close others
    if (matchesBinding(e, 'cycle-chat-solo')) {
      e.preventDefault();
      // Get ALL panels (including minimized) for cycling, ordered by focus history
      const allIds = [];
      for (const [id] of chatPanels) allIds.push(id);
      const ordered = [...new Set([...chatFocusHistory.filter(id => allIds.includes(id)), ...allIds])];
      debugLog('[Cmd+/] all panels:', ordered, 'soloCycleIndex:', chatSoloCycleIndex);

      if (ordered.length === 0) {
        reopenAnyPanel();
        return;
      }

      chatSoloCycleIndex = ((chatSoloCycleIndex < 0 ? 0 : chatSoloCycleIndex) + 1) % ordered.length;
      const targetId = ordered[chatSoloCycleIndex];

      // Minimize all others, un-minimize the target
      for (const id of ordered) {
        if (id === targetId) continue;
        if (id === 'main') {
          const cp = document.getElementById('chat-panel');
          const isOpen = cp.classList.contains('chat-bottom') || cp.classList.contains('chat-right') || cp.classList.contains('chat-float');
          if (isOpen) {
            const ph = document.querySelector('#chat-header .panel-header');
            if (ph) ph.click();
          }
        } else {
          const p = chatPanels.get(id);
          if (p?.container) p.container.classList.add('minimized');
        }
      }

      focusChatPanel(targetId, true);
      return;
    }
    if (matchesBinding(e, 'fit-view') && !inInput) { e.preventDefault(); fitView(); return; }
    if (matchesBinding(e, 'auto-layout') && !inInput) { e.preventDefault(); autoLayout(); return; }
    if (matchesBinding(e, 'toggle-edit') && expandedCard) { e.preventDefault(); toggleFullPageEdit(expandedCard, expandedCard.dataset.path); return; }
    if (matchesBinding(e, 'save-edit') && expandedCard?.dataset.mode === 'edit') { e.preventDefault(); toggleFullPageEdit(expandedCard, expandedCard.dataset.path); return; }

    // Canvas shortcuts (only when not typing)
    if (!inInput) {
      // Cmd+= / Cmd+- zoom
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const container = document.getElementById('infinite-canvas');
        zoomSelection.transition().duration(200).call(zoomBehavior.scaleBy, 1.3);
        return;
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        zoomSelection.transition().duration(200).call(zoomBehavior.scaleBy, 0.7);
        return;
      }
      // Cmd+W close current pane (PDF in split view)
      if (mod && e.key === 'w') {
        if (splitOverlay) { e.preventDefault(); e.stopPropagation(); closeSplitView(); return; }
      }
      // Cmd+[ go back
      if (mod && e.key === '[') {
        e.preventDefault(); e.stopPropagation();
        if (splitOverlay) { splitOverlay.remove(); splitOverlay = null; return; }
        if (expandedCard) { collapseFullPage(); return; }
        // Files view: navigate breadcrumbs back
        if (filesTilePath.length > 0) {
          filesTilePath.pop();
          if (filesMode === 'tiles') renderFilesTiles();
          else renderFilesTree();
          return;
        }
        if (canvasStack.length > 1) navigateToLevel(canvasStack.length - 2);
        return;
      }
      // Cmd+] drill into focused card
      if (mod && e.key === ']') {
        e.preventDefault();
        const focused = document.querySelector('.doc-card.focused') || document.querySelector('.doc-card.selected');
        if (focused && focused.dataset.isFolder === 'true') drillInto(focused.dataset.path);
        return;
      }
      // Enter drills into focused card
      if (e.key === 'Enter') {
        const focused = document.querySelector('.doc-card.focused') || document.querySelector('.doc-card.selected');
        if (focused && focused.dataset.isFolder === 'true') { drillInto(focused.dataset.path); return; }
      }
    }
  });

  // Save chat on page close
  window.addEventListener('beforeunload', () => saveChatBeacon());

  await Promise.all([initGraphView(), initSidebar()]);
  populateTagFilter();

  // On mobile, auto-fit canvas after graph loads so cards are visible
  if (_mobileActive) {
    setTimeout(() => { try { fitView(); } catch {} }, 300);
  }

  // Reopen settings panel if flagged (e.g. after remote access restart)
  const reopenTab = sessionStorage.getItem('loom-reopen-settings');
  if (reopenTab) {
    sessionStorage.removeItem('loom-reopen-settings');
    setTimeout(() => openFullSettings(reopenTab), 500);
  }
}

window.navigateToLevel = navigateToLevel;

init().catch(e => console.error('[init] FATAL:', e));
