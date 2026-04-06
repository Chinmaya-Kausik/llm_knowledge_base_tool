// === Vault Knowledge Base UI v3 ===
// Canvas stack with drill-in sub-canvases, edge aggregation, border resizing

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
};

let keyBindings = { ...DEFAULT_KEYBINDINGS };

// Load saved overrides
try {
  const saved = JSON.parse(localStorage.getItem('vault-keybindings') || '{}');
  for (const [action, binding] of Object.entries(saved)) {
    if (keyBindings[action]) keyBindings[action] = { ...keyBindings[action], ...binding };
  }
} catch {}

function matchesBinding(e, action) {
  const b = keyBindings[action];
  if (!b) return false;
  if (b.mod && !(e.ctrlKey || e.metaKey)) return false;
  if (b.alt && !e.altKey) return false;
  if (b.shift && !e.shiftKey) return false;
  if (!b.shift && e.shiftKey && !b.mod) return false;
  return e.key === b.key || e.key.toLowerCase() === b.key.toLowerCase();
}

function bindingToString(b) {
  const parts = [];
  if (b.mod) parts.push('⌘');
  if (b.alt) parts.push('⌥');
  if (b.shift) parts.push('⇧');
  parts.push(b.key === '\\' ? '\\' : b.key === ' ' ? 'Space' : b.key.toUpperCase());
  return parts.join('');
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
  localStorage.setItem('vault-keybindings', JSON.stringify(overrides));
}

// --- API ---
const api = {
  graph:       () => fetch('/api/graph').then(r => r.json()),
  page:        (p) => fetch(`/api/page/${p}`).then(r => r.json()),
  tree:        () => fetch('/api/tree').then(r => r.json()),
  search:      (q, s='all', mode='both') => fetch(`/api/search?q=${encodeURIComponent(q)}&scope=${s}&mode=${mode}`).then(r => r.json()),
  health:      () => fetch('/api/health').then(r => r.json()),
  brokenLinks: () => fetch('/api/broken-links').then(r => r.json()),
  orphans:     () => fetch('/api/orphans').then(r => r.json()),
  stale:       () => fetch('/api/stale').then(r => r.json()),
  getLayout:   () => fetch('/api/layout').then(r => r.json()).catch(() => ({})),
  saveLayout:  (d) => fetch('/api/layout', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}),
  savePage:    (p, fm, c) => fetch(`/api/page/${p}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({frontmatter:fm, content:c})}),
};

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
let graphData = null;       // Full graph from API
let layoutData = {};        // Saved card positions
let currentTransform = { x:0, y:0, k:1 };
let cardElements = new Map();
let cardMeta = new Map();
let saveLayoutTimer = null;
let expandedCard = null;
let edgeRAF = null;         // rAF handle for edge debouncing

// Canvas stack for drill-in navigation
let canvasStack = [];  // [{parentPath: null|string, label: string}]
function currentLevel() { return canvasStack[canvasStack.length - 1] || { parentPath: null, label: 'Root' }; }

// --- Node helpers ---
function nodeById(id) { return graphData?.nodes.find(n => n.data.id === id)?.data; }

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

  // Click outside any card → dismiss active edit
  // Use capture phase to catch before other handlers
  document.addEventListener('pointerdown', (e) => {
    if (!activeEditCard) return;
    const clickedCard = e.target.closest('.doc-card');
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
  const catBadge = !isFolder ? `<span class="badge badge-cat-${category}">${category}</span>` : '';
  const typeBadge = nodeData.type && nodeData.type !== 'folder' && nodeData.type !== category ? `<span class="badge badge-${nodeData.type}">${nodeData.type}</span>` : '';
  const childBadge = childCount > 0 ? `<button class="btn-children" title="Drill into subpages">${childCount} sub</button>` : '';

  // Body content: markdown gets full render, files get summary initially
  let bodyHTML;
  if (isMarkdown && content) {
    bodyHTML = marked.parse(content);
  } else if (!isFolder && !isMarkdown) {
    // File: show summary placeholder (will be replaced on click)
    const summary = nodeData.summary || nodeData.label;
    bodyHTML = `<div class="file-summary">${summary}</div>`;
  } else {
    bodyHTML = content ? marked.parse(content) : '<em>Empty</em>';
  }

  card.innerHTML = `
    <div class="doc-handle">
      <span class="doc-title">${nodeData.label}</span>
      <span class="doc-badges">${catBadge}${typeBadge}</span>
      <div class="doc-controls">
        ${childBadge}
        <button class="btn-collapse" title="Collapse">-</button>
      </div>
    </div>
    <div class="doc-body">${bodyHTML}</div>
  `;

  wireCardDrag(card, options.pinned);
  wireCardBorderResize(card);
  wireCardButtons(card, childCount > 0);
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

  // Single-click title: toggle expand/collapse
  card.querySelector('.doc-handle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (card._wasDragged) { card._wasDragged = false; return; }
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
      const text = body.textContent?.trim() || '';
      summary.textContent = text ? text.slice(0, 80) + (text.length > 80 ? '...' : '') : 'Empty';
      summary.style.display = '';
    }
    scheduleEdgeUpdate();
  });

  // Double-click title: folders → drill into canvas (unless already inside), files → full page
  card.querySelector('.doc-handle').addEventListener('dblclick', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (e.metaKey || e.ctrlKey) { openExternal(path); return; }
    const currentParent = currentLevel().parentPath;
    if (card.dataset.isFolder === 'true' && hasChildren && currentParent !== path) {
      drillInto(path);
    } else {
      expandCardFullPage(card);
    }
  });

  const body = card.querySelector('.doc-body');

  // Double-click body → full page view (for folders: view/edit README)
  body.addEventListener('dblclick', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (card.dataset.editing !== 'true') expandCardFullPage(card);
  });

  // Single click body → expand content (for non-markdown files in summary mode)
  if (!isMarkdown) {
    body.addEventListener('click', (e) => {
      e.stopPropagation();
      if (card.dataset.expanded !== 'true' && card.dataset.editing !== 'true') {
        expandCardContent(card, path);
      }
    });
  }

  // Double-click body → enter edit mode (for any expanded card)
  body.addEventListener('dblclick', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (card.dataset.editing !== 'true' && card.dataset.expanded === 'true') {
      enterCardEdit(card, path);
    }
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
function drillInto(parentPath) {
  const nd = nodeById(parentPath);
  if (!nd) return;
  canvasStack.push({ parentPath, label: nd.label });
  renderCurrentLevel();
}

function navigateToLevel(index) {
  canvasStack = canvasStack.slice(0, index + 1);
  renderCurrentLevel();
}

function renderCurrentLevel() {
  const level = currentLevel();
  updateBreadcrumb();

  const world = document.getElementById('world');
  world.innerHTML = '';
  cardElements.clear();

  if (level.parentPath === null) {
    renderRootCanvas(world);
  } else {
    renderSubCanvas(world, level.parentPath);
  }

  scheduleEdgeUpdate();
  requestAnimationFrame(() => requestAnimationFrame(fitView));
}

function renderRootCanvas(world) {
  const topNodes = graphData.top_nodes || [];
  const positions = computeLayout(topNodes, layoutData);

  for (const node of topNodes) {
    const nd = node.data;
    const pos = positions[nd.id] || { x: 0, y: 0 };
    const meta = cardMeta.get(nd.id);
    const content = meta?.content || '';
    const card = createDocCard(nd, content, pos);
    world.appendChild(card);
    cardElements.set(nd.id, card);
    layoutData[nd.id] = pos;
  }
}

function renderSubCanvas(world, parentPath) {
  const parentNode = nodeById(parentPath);
  if (!parentNode) return;

  const childIds = getChildIds(parentPath);
  const childNodes = childIds.map(id => nodeById(id)).filter(Boolean);

  // Pinned parent at top center
  const parentMeta = cardMeta.get(parentPath);
  const parentCard = createDocCard(parentNode, parentMeta?.content || '', { x: 200, y: 0 }, { pinned: true });
  world.appendChild(parentCard);
  cardElements.set(parentPath, parentCard);

  // Layout children below
  const cardW = 400, cardH = 340, gap = 40;
  const cols = Math.max(1, Math.ceil(Math.sqrt(childNodes.length)));

  childNodes.forEach((nd, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const savedPos = layoutData[nd.id];
    const pos = savedPos || { x: col * (cardW + gap), y: 450 + row * (cardH + gap) };
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
  html += `<span class="crumb${canvasStack.length <= 1 ? ' crumb-current' : ''}" onclick="navigateToLevel(0)">Root</span>`;
  for (let i = 1; i < canvasStack.length; i++) {
    html += `<span class="crumb crumb-sep">/</span>`;
    const isCurrent = i === canvasStack.length - 1;
    html += `<span class="crumb${isCurrent ? ' crumb-current' : ''}" onclick="navigateToLevel(${i})">${canvasStack[i].label}</span>`;
  }
  bar.innerHTML = html;
}

// ========================================
// Layout (WebCoLa — constraint-based with non-overlap)
// ========================================
function computeLayout(nodes, saved) {
  const positions = {};
  const cardW = 400, cardH = 280, pad = 30;

  // Use saved positions where available
  const unsaved = [];
  for (const node of nodes) {
    if (saved[node.data.id]) {
      positions[node.data.id] = saved[node.data.id];
    } else {
      unsaved.push(node.data.id);
    }
  }
  if (unsaved.length === 0) return positions;

  // If WebCoLa not available, fall back to grid
  if (typeof cola === 'undefined') return computeLayoutGrid(nodes, saved);

  // Build CoLa node and edge arrays
  const idToIndex = {};
  const colaNodes = nodes.map((node, i) => {
    idToIndex[node.data.id] = i;
    const s = saved[node.data.id];
    return {
      x: s ? s.x + cardW/2 : (i % 5) * (cardW + pad) + cardW/2,
      y: s ? s.y + cardH/2 : Math.floor(i / 5) * (cardH + pad) + cardH/2,
      width: cardW + pad,
      height: cardH + pad,
      fixed: !!saved[node.data.id],  // Don't move saved nodes
    };
  });

  const edges = (graphData?.top_edges || graphData?.edges || []);
  const nodeSet = new Set(nodes.map(n => n.data.id));
  const colaLinks = [];
  for (const e of edges) {
    const si = idToIndex[e.data.source], ti = idToIndex[e.data.target];
    if (si !== undefined && ti !== undefined) {
      colaLinks.push({ source: si, target: ti });
    }
  }

  // Run CoLa layout (synchronous, fixed iterations)
  try {
    const layout = new cola.Layout()
      .size([nodes.length * (cardW + pad), nodes.length * (cardH + pad)])
      .nodes(colaNodes)
      .links(colaLinks)
      .avoidOverlaps(true)
      .linkDistance(cardW + pad)
      .start(30, 20, 10, 0, false);  // 30 unconstrained, 20 overlap removal, 10 user constraints, no async

    // Extract positions (CoLa gives center coords, we need top-left)
    for (const node of nodes) {
      const i = idToIndex[node.data.id];
      const cn = colaNodes[i];
      positions[node.data.id] = {
        x: Math.round(cn.x - cardW/2),
        y: Math.round(cn.y - cardH/2),
      };
    }
  } catch (e) {
    console.warn('CoLa layout failed, falling back to grid:', e);
    return computeLayoutGrid(nodes, saved);
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
  const nodes = level.parentPath === null ? (graphData?.top_nodes || []) :
    graphData?.nodes.filter(n => n.data.parent_id === level.parentPath) || [];
  if (nodes.length === 0) return;

  const positions = computeLayout(nodes, {}); // Empty saved = layout all

  for (const [path, card] of cardElements) {
    if (positions[path]) {
      card.style.left = positions[path].x + 'px';
      card.style.top = positions[path].y + 'px';
      layoutData[path] = positions[path];
    }
  }
  scheduleEdgeUpdate(); debounceSaveLayout(); setTimeout(fitView, 100);
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

function expandCardFullPage(card, highlightQuery) {
  if (expandedCard) collapseFullPage();
  // Dismiss any canvas edit
  if (activeEditCard) exitCardEdit(activeEditCard);

  const path = card.dataset.path;
  const meta = cardMeta.get(path);
  const title = card.querySelector('.doc-title')?.textContent || path;
  const rawContent = meta?.content || '';
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
      <button class="fullpage-toggle">Edit</button>
    </div>
    <div class="fullpage-content"></div>
  `;
  document.getElementById('canvas-container').appendChild(overlay);
  expandedCard = overlay;
  overlay.querySelector('.fullpage-back').onclick = collapseFullPage;

  const contentEl = overlay.querySelector('.fullpage-content');

  if (isCodeFile(path)) {
    // Render code files with CodeMirror
    overlay.querySelector('.fullpage-toggle').style.display = 'none';
    createCodeEditor(contentEl, rawContent, path).then(view => {
      overlay._cmView = view;
      // TODO: CodeMirror search highlight via SearchCursor
    });
  } else {
    // Render markdown with marked
    contentEl.innerHTML = marked.parse(rawContent);
    overlay.querySelector('.fullpage-toggle').onclick = () => toggleFullPageEdit(overlay, path);
    wireFullPageLinks(overlay);
    // Highlight search matches
    if (highlightQuery) highlightMatches(contentEl, highlightQuery);
  }
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
    contentEl.querySelector('.fullpage-edit-area')?.focus();
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
      const isCode = path.endsWith('.py') || path.endsWith('.js') || path.endsWith('.ts') || path.endsWith('.rs') || path.endsWith('.go') || path.endsWith('.java') || path.endsWith('.c') || path.endsWith('.cpp') || path.endsWith('.sh');
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
    expandedCard.remove();
    expandedCard = null;
    if (fullpageReturnView) {
      switchView(fullpageReturnView);
      fullpageReturnView = null;
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
}

function populateTagFilter() {
  const tagMenu = document.getElementById('filter-tag-menu');
  const counts = {};
  for (const [,meta] of cardMeta) for (const tag of meta.frontmatter?.tags||[]) counts[tag]=(counts[tag]||0)+1;
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
  try {
    [graphData, layoutData] = await Promise.all([api.graph(), api.getLayout()]);
    if (!graphData || graphData.nodes.length === 0) {
      document.getElementById('world').innerHTML = '<div class="empty-state" style="position:absolute;left:50px;top:50px;">No wiki pages yet.</div>';
      return;
    }
    // Fetch all page contents via bulk endpoint (single request)
    try {
      const bulk = await fetch('/api/pages/bulk', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(graphData.nodes.map(n => n.data.id)),
      }).then(r => r.json());
      for (const [id, data] of Object.entries(bulk)) {
        if (data) cardMeta.set(id, { frontmatter: data.frontmatter, content: data.content });
      }
    } catch {
      // Fallback to individual requests
      const pages = await Promise.all(graphData.nodes.map(n => api.page(n.data.id).then(d=>[n.data.id,d]).catch(()=>[n.data.id,null])));
      for (const [id, data] of pages) {
        if (data) cardMeta.set(id, { frontmatter: data.frontmatter, content: data.content });
      }
    }
    // Start at root
    canvasStack = [{ parentPath: null, label: 'Root' }];
    renderCurrentLevel();

    console.log(`Vault: rendered ${cardElements.size} cards`);
  } catch (err) {
    console.error('Vault initGraphView error:', err);
    document.getElementById('world').innerHTML = `<div class="empty-state" style="position:absolute;left:50px;top:50px;">Error: ${err.message}</div>`;
  }
}

async function initSidebar() {
  const treeData = await api.tree();
  const container = document.getElementById('sidebar-tree');
  container.innerHTML = renderTree(treeData.children||[], 0);
  container.addEventListener('click', (e) => {
    const item = e.target.closest('.tree-item');
    if (!item) return;
    if (item.classList.contains('folder')) {
      const ch = item.nextElementSibling; if (ch) ch.classList.toggle('open');
    } else if (item.classList.contains('file')) {
      const card = cardElements.get(item.dataset.id);
      if (card) { switchView('graph'); expandCardFullPage(card); }
      else {
        // Card might not be on current level — try to find it
        const nd = nodeById(item.dataset.id);
        if (nd) {
          switchView('graph');
          // Build a fake card for full page
          const meta = cardMeta.get(item.dataset.id);
          if (meta) {
            const fakeCard = document.createElement('div');
            fakeCard.dataset.path = item.dataset.id;
            fakeCard.innerHTML = `<span class="doc-title">${nd.label}</span>`;
            expandCardFullPage(fakeCard);
          }
        }
      }
    }
  });
}

function renderTree(items, depth) {
  return items.map(item => {
    const indent = `padding-left:${8+depth*14}px`;
    if (item.type === 'folder') {
      const kids = item.children ? renderTree(item.children, depth+1) : '';
      return `<div class="tree-item folder" style="${indent}"><span class="tree-icon">+</span>${item.name}</div>
              <div class="tree-children${depth===0?' open':''}">${kids}</div>`;
    }
    return `<div class="tree-item file" style="${indent}" data-id="${item.id}"><span class="tree-icon">~</span>${item.title||item.name}</div>`;
  }).join('');
}

// --- Other views (files, tag cloud, health, search) ---
let filesTreeData = null;
let filesMode = 'tree'; // 'tree' or 'tiles'
let filesTilePath = []; // breadcrumb path for tile navigation

let filesInitialized = false;

async function initFilesView() {
  // Don't re-render if already initialized (preserves tree expand state)
  if (filesInitialized) return;
  filesTreeData = await api.tree();

  // Wire mode toggles
  document.getElementById('files-mode-tree').onclick = () => setFilesMode('tree');
  document.getElementById('files-mode-tiles').onclick = () => setFilesMode('tiles');

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

function renderFilesTree() {
  const container = document.getElementById('files-tree');
  container.innerHTML = '';
  if (!filesTreeData) return;

  // Navigate to current path
  let currentItems = filesTreeData.children || [];
  for (const pathSegment of filesTilePath) {
    const folder = currentItems.find(i => i.name === pathSegment && i.type === 'folder');
    if (folder) currentItems = folder.children || [];
    else break;
  }

  renderTreeItems(container, currentItems, 0);
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

    if (item.type === 'folder' && item.children?.length) {
      const childContainer = document.createElement('div');
      childContainer.className = 'ftree-children';
      renderTreeItems(childContainer, item.children, depth + 1);
      container.appendChild(childContainer);

      let lastClickTime = 0;
      row.onclick = (e) => {
        e.stopPropagation();
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
        }
        lastClickTime = now;
      };
      row.ondblclick = (e) => e.stopPropagation(); // Suppress native dblclick
    } else {
      row.ondblclick = (e) => openFileItem(item, e.metaKey || e.ctrlKey);
    }
  }
}

function renderFilesTiles() {
  const container = document.getElementById('files-tiles');
  container.innerHTML = '';
  if (!filesTreeData) return;

  // Navigate to current breadcrumb path
  let currentItems = filesTreeData.children || [];
  for (const pathSegment of filesTilePath) {
    const folder = currentItems.find(i => i.name === pathSegment && i.type === 'folder');
    if (folder) currentItems = folder.children || [];
    else break;
  }

  // Update breadcrumbs
  updateBreadcrumbs();

  // Render tiles — folders first, then files
  const folders = currentItems.filter(i => i.type === 'folder');
  const files = currentItems.filter(i => i.type !== 'folder');

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
  root.textContent = 'vault';
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
  fetch('/api/open-external', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(e => console.error('External open failed:', e));
}

function openFileItem(item, external = false) {
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

  const scopeLabel = scope === 'all' ? 'vault' : scope.split('/').pop();
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

  c.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: `Searching ${scopeLabel}...` }));
  try {
    const results = await api.search(query, scope, mode);
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
    // Sync tile path to current canvas level
    const level = currentLevel();
    if (level.parentPath) {
      filesTilePath = level.parentPath.split('/');
    }
    if (filesInitialized && filesMode === 'tiles') renderFilesTiles();
    initFilesView();
  }
  if (name==='graph' && filesMode === 'tiles' && filesTilePath.length > 0) {
    // Sync canvas to the folder we were browsing in Files tile mode
    const tilePath = filesTilePath.join('/');
    if (tilePath && currentLevel().parentPath !== tilePath) {
      // Navigate canvas to match
      const nd = nodeById(tilePath);
      if (nd) {
        canvasStack = [{ parentPath: null, label: 'Root' }];
        // Build stack from root to target
        const parts = tilePath.split('/');
        let path = '';
        for (const part of parts) {
          path = path ? path + '/' + part : part;
          const n = nodeById(path);
          if (n) canvasStack.push({ parentPath: path, label: n.label || part });
        }
        renderCurrentLevel();
      }
    }
  }
  if (name==='tags') initTagCloud();
  if (name==='health') initHealth();
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
    this.contextLevel = options.contextLevel || 'page';
    this.contextPath = null; // Custom context path (Browse...)
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
    this.model = null;
    this.messagesContainer = null; // DOM element for this panel's messages
  }
}

// Panel registry and active panel proxy
const chatPanels = new Map(); // panelId → ChatPanel
let activePanel = new ChatPanel(null); // set properly in initChat()
chatPanels.set('main', activePanel);

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
let lastResultUsage, lastResultCost, activePlanPath, activePlanContent, sessionEditedFiles;
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
  panel.messagesContainer = chatMessagesContainer;
}

// Initialize globals from the default panel
syncFromPanel(activePanel);

// --- Panel management ---
let panelCounter = 0;

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
  else chatPanelEl.classList.add('chat-float');

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

    menu.innerHTML = `
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

    if (action === 'model') {
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
      const path = prompt('Enter vault path for context (e.g., wiki/concepts/attention):');
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
        // Collapsing — save position for float, clear size styles
        const pos = mode === 'float' ? { left: cp.style.left, top: cp.style.top } : null;
        cp.removeAttribute('style');
        if (pos) { cp.style.left = pos.left; cp.style.top = pos.top; }

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
    _clickTimer = setTimeout(() => { _clickTimer = null; toggleMinimize(); }, 250);
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
      // Main panel: just clear conversation
      saveChatTranscript();
      document.getElementById('chat-messages').innerHTML = '';
      syncFromPanel(activePanel);
      chatMessages = [];
      chatSessionId = crypto.randomUUID();
      syncToPanel(activePanel);
    } else {
      // Floating panel: close and remove
      if (panel?.ws) panel.ws.close();
      chatPanels.delete(panelId);
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
  const label = options.label || (options.fork ? `Fork ${panelCounter}` : `Chat ${panelCounter}`);
  const panel = new ChatPanel(null, {
    sessionId: crypto.randomUUID(),
    messages: options.fork ? [...activePanel.messages] : [],
    contextLevel: activePanel.contextLevel,
  });

  // Create floating card
  const card = document.createElement('div');
  card.className = 'floating-chat-panel';
  card.dataset.panelId = panelId;

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
  input.placeholder = 'Message Claude...';
  input.rows = 1;
  const sendBtn = document.createElement('button');
  sendBtn.className = 'fcp-send';
  sendBtn.textContent = 'Send';
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);
  card.appendChild(inputArea);

  card.style.left = (150 + panelCounter * 30) + 'px';
  card.style.top = (100 + panelCounter * 30) + 'px';

  document.getElementById('canvas-container').appendChild(card);
  panel.container = card;
  panel.messagesContainer = messagesEl;
  chatPanels.set(panelId, panel);

  // Render forked messages
  if (options.fork && panel.messages.length) {
    for (const msg of panel.messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const el = document.createElement('div');
        el.className = `chat-msg chat-msg-${msg.role}`;
        el.textContent = msg.content?.slice(0, 200) || '';
        messagesEl.appendChild(el);
      }
    }
  }

  // Send handler — uses panel directly, never touches activePanel/globals
  sendBtn.onclick = () => {
    const text = input.value.trim();
    if (!text) return;

    if (!panel.ws || panel.ws.readyState !== WebSocket.OPEN) {
      connectPanelChat(panel, messagesEl);
      setTimeout(() => sendBtn.click(), 500);
      return;
    }

    const userEl = document.createElement('div');
    userEl.className = 'chat-msg chat-msg-user';
    userEl.textContent = text;
    messagesEl.appendChild(userEl);
    panel.messages.push({ role: 'user', content: text });
    input.value = '';

    panel.ws.send(JSON.stringify({
      type: 'message', text,
      context_level: panel.contextLevel,
      context: { page_path: panel.contextPath || currentLevel().parentPath || '' },
    }));

    panel.generating = true;
    panel.startTime = Date.now();
    panel.tokenCount = 0;

    const assistantEl = document.createElement('div');
    assistantEl.className = 'chat-msg chat-msg-assistant';
    const sb = document.createElement('div');
    sb.className = 'chat-status-bar chat-active-status';
    sb.innerHTML = `<span class="pondering">${randomPonderingWord()}...</span> <span class="chat-elapsed">0.0s</span> <span class="chat-tokens">0 tokens</span>`;
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

  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  };

  // Draggable header with dead zone to distinguish from click
  let dragReady = false, dragging = false, startX, startY, dx, dy;
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
    card.style.left = (e.clientX - dx) + 'px';
    card.style.top = (e.clientY - dy) + 'px';
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

  return panel;
}

function connectPanelChat(panel, messagesEl) {
  const wsUrl = `ws://${location.host}/ws/chat`;
  try {
    panel.ws = new WebSocket(wsUrl);
  } catch (e) { return; }

  const thisWs = panel.ws;

  thisWs.onopen = () => {
    thisWs.send(JSON.stringify({
      type: 'init',
      session_id: panel.sessionId,
      page_path: currentLevel().parentPath || '',
    }));
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

    handleChatEvent(msg);

    // Save this panel's state back (but NOT ws — it's managed separately)
    panel.sessionId = chatSessionId;
    panel.generating = chatGenerating; panel.assistantEl = currentAssistantEl;
    panel.thinkingEl = currentThinkingEl; panel.thinkingWrapper = currentThinkingWrapper;
    panel.activityGroup = currentActivityGroup; panel.subagents = activeSubagents;
    panel.responseText = currentResponseText; panel.messages = chatMessages;
    panel.tokenCount = chatTokenCount; panel.startTime = chatStartTime;
    panel.timerInterval = chatTimerInterval; panel.editedFiles = sessionEditedFiles;
    panel.lastResultUsage = lastResultUsage; panel.lastResultCost = lastResultCost;

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

  // Inject universal header into main chat panel
  const mainHeaderContainer = document.getElementById('chat-header');
  const { wrapper: headerWrapper, statusEl: mainStatusEl } = createPanelHeader('main', 'Chat');
  mainHeaderContainer.appendChild(headerWrapper);
  mainHeaderContainer._statusEl = mainStatusEl;

  // Set the main panel's messages container
  activePanel.messagesContainer = document.getElementById('chat-messages');
  chatMessagesContainer = activePanel.messagesContainer;

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

  // Send message
  sendBtn.onclick = () => sendChatMessage();
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  };

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

}

function exitCheckpointMode() {
  checkpointMode = false;
  redirectCheckpoints.clear();
  redirectSnapshot.clear();
  document.getElementById('chat-messages').classList.remove('checkpoint-mode');
  document.querySelectorAll('.checkpoint-marker.selected').forEach(m => m.classList.remove('selected'));
  document.getElementById('chat-context-preview').style.display = 'none';
  document.getElementById('chat-input').placeholder = 'Message Claude... (Enter to send)';
  pendingSelection = null;
}

function connectChat() {
  const mainP = chatPanels.get('main');

  const statusEl = document.querySelector('#chat-header .panel-status');
  if (statusEl) statusEl.className = 'panel-status';

  const wsUrl = `ws://${location.host}/ws/chat`;
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
    mainP.sessionId = sessionStorage.getItem('vault-chat-session') || crypto.randomUUID();
    sessionStorage.setItem('vault-chat-session', mainP.sessionId);
    chatSessionId = mainP.sessionId;

    const level = currentLevel();
    ws.send(JSON.stringify({
      type: 'init',
      session_id: mainP.sessionId,
      page_path: level.parentPath || '',
    }));
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
  if (!mainP.ws || mainP.ws.readyState !== WebSocket.OPEN) {
    connectChat();
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
  } else if (!text && !pendingSelection?.text) {
    return;
  }

  chatMessages.push({ role: 'user', content: fullText });
  currentResponseText = '';
  appendChatMessage('user', text || '', isRedirect ? 'redirect' : null);
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
  document.getElementById('chat-send').style.display = 'none';
  document.getElementById('chat-stop').style.display = 'none'; // Hidden — Redirect handles stopping
  document.getElementById('chat-redirect').style.display = '';

  // Show pondering + timer + tokens immediately at dispatch time
  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'chat-msg chat-msg-assistant';
  const statusBar = document.createElement('div');
  statusBar.className = 'chat-status-bar';
  statusBar.className = 'chat-status-bar chat-active-status';
  statusBar.innerHTML = `<span class="pondering">${randomPonderingWord()}...</span> <span class="chat-elapsed">0.0s</span> <span class="chat-tokens">0 tokens</span>`;
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
  const statusBar = document.createElement('div');
  statusBar.className = 'chat-status-bar';
  statusBar.className = 'chat-status-bar chat-active-status';
  statusBar.innerHTML = `<span class="pondering">${randomPonderingWord()}...</span> <span class="chat-elapsed">0.0s</span> <span class="chat-tokens">0 tokens</span>`;
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
    case 'Bash':            return (i.command || '').slice(0, 80);
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
  // Icons matching Claude Code style
  const icons = {
    'Read': '📄', 'Write': '✏️', 'Edit': '✏️', 'Grep': '🔍', 'Glob': '📁',
    'Bash': '⚡', 'WebSearch': '🌐', 'WebFetch': '🌐',
    'ripgrep_search': '🔍', 'read_wiki_page': '📄', 'write_wiki_page': '✏️',
    'validate_links': '🔗', 'generate_health_report': '🏥',
    'ingest_url': '📥', 'ingest_text': '📥', 'auto_commit': '💾',
  };
  return icons[tool] || '⚡';
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
    await fetch('/api/plan', {
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
      await fetch('/api/plan', {
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
    const resp = await fetch('/api/plan');
    const data = await resp.json();
    if (data.ok) {
      openPlanPanel(data.path, data.content);
    }
  } catch (e) { console.error('Plan fetch failed:', e); }
}

function summarizeTools(tools) {
  const counts = {};
  tools.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const friendly = {
    Read: ['Read', 'file'], Bash: ['Ran', 'command'], Grep: ['Searched', 'pattern'],
    Glob: ['Found', 'pattern'], Edit: ['Edited', 'file'], Write: ['Wrote', 'file'],
    Agent: ['Spawned', 'agent'],
  };
  return Object.entries(counts).map(([tool, n]) => {
    const f = friendly[tool];
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
  const body = ag.querySelector('.chat-activity-body');
  if (body) body.classList.remove('open');
  const toggle = ag.querySelector('.chat-thinking-toggle');
  if (toggle) toggle.classList.remove('open');
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

  if (msg.type !== 'text') console.log('Chat event:', msg.type, msg);

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

      // Update inner header with last tool call detail
      ag._tools.push(toolName);
      const latestEl = ag.querySelector('.activity-latest');
      if (latestEl) latestEl.innerHTML = `${toolIcon(toolName)} <b>${escapeHtml(toolName)}</b> ${escapeHtml(toolDesc)}`;

      // Update outer subagent header with aggregated summary (if inside a subagent)
      if (sub) {
        const outerDesc = sub.header?.querySelector('.chat-subagent-desc');
        if (outerDesc) outerDesc.textContent = `${sub._description || ''} — ${summarizeTools(ag._tools)}`;
      }

      // Same-tool grouping: if same tool as last, increment counter
      const agBody = ag.querySelector('.chat-activity-body');
      if (ag._lastToolName === toolName && ag._lastToolGroup) {
        // Increment existing group
        ag._lastToolGroup._count = (ag._lastToolGroup._count || 1) + 1;
        // Add sub-entry
        const subEntry = document.createElement('div');
        subEntry.className = 'chat-tool-subentry';
        subEntry.textContent = toolDesc;
        subEntry._startTime = Date.now();
        const subResult = document.createElement('div');
        subResult.className = 'chat-tool-result';
        subEntry.addEventListener('click', (e) => { e.stopPropagation(); subResult.classList.toggle('open'); });
        ag._lastToolGroup._subList.appendChild(subEntry);
        ag._lastToolGroup._subList.appendChild(subResult);
      } else {
        // New tool entry
        const toolEntry = document.createElement('div');
        toolEntry.className = 'chat-tool-entry';
        toolEntry._startTime = Date.now();
        toolEntry._count = 1;
        toolEntry.innerHTML = `${toolIcon(toolName)} <span class="tool-name">${escapeHtml(toolName)}</span> <span class="tool-desc">${escapeHtml(toolDesc)}</span> <span class="tool-time pondering"></span> <span class="checkpoint-marker" title="Set redirect breakpoint here"></span>`;
        // Store the message index for this tool call (for checkpoint truncation)
        toolEntry.dataset.msgIndex = chatMessages.length - 1;
        const toolResult = document.createElement('div');
        toolResult.className = 'chat-tool-result';
        const subList = document.createElement('div');
        subList.className = 'chat-tool-sublist';
        subList.style.display = 'none';
        toolEntry._subList = subList;
        toolEntry.addEventListener('click', (e) => {
          e.stopPropagation();
          toolResult.classList.toggle('open');
          if (toolEntry._count > 1) subList.style.display = subList.style.display === 'none' ? '' : 'none';
        });
        agBody.appendChild(toolEntry);
        agBody.appendChild(subList);
        agBody.appendChild(toolResult);
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
        // Find the last tool entry or subentry
        const lastGroup = ag3._lastToolGroup;
        if (lastGroup) {
          const subList = lastGroup._subList;
          const subEntries = subList?.querySelectorAll('.chat-tool-subentry');
          let targetEntry = lastGroup;
          let targetResult;
          if (subEntries && subEntries.length > 0) {
            targetEntry = subEntries[subEntries.length - 1];
            targetResult = targetEntry.nextElementSibling;
          } else {
            targetResult = lastGroup.nextElementSibling?.nextElementSibling; // skip subList
            if (!targetResult?.classList?.contains('chat-tool-result')) targetResult = null;
          }
          if (targetResult?.classList?.contains('chat-tool-result')) {
            targetResult.textContent = msg.output || '';
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
      // Track assistant response
      if (currentResponseText) {
        chatMessages.push({ role: 'assistant', content: currentResponseText });
        currentResponseText = '';
      }
      chatGenerating = false;
      clearInterval(chatTimerInterval);
      document.getElementById('chat-send').style.display = '';
      document.getElementById('chat-stop').style.display = 'none';
      document.getElementById('chat-redirect').style.display = 'none';

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
        document.getElementById('chat-input').focus();
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

      // Process queued messages
      if (messageQueue.length > 0) {
        const next = messageQueue.shift();
        // Reuse the queued message element — remove queued styling, dispatch directly
        if (next.el) next.el.classList.remove('chat-msg-queued');
        setTimeout(() => sendQueuedMessage(next.text), 100);
      }
      break;
    }

    case 'result':
      // Store usage info for status bar
      if (msg.usage) lastResultUsage = msg.usage;
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
  }

}

async function saveChatTranscript() {
  if (chatIsTemporary || chatMessages.length === 0 || !chatSessionId) return;
  try {
    const resp = await fetch('/api/chat/save', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ session_id: chatSessionId, messages: chatMessages }),
    });
    const data = await resp.json();
    console.log('Chat saved:', data);
  } catch (e) { console.error('Chat save failed:', e); }
}

function saveChatBeacon() {
  // For beforeunload — sendBeacon is the only reliable method
  if (chatIsTemporary || chatMessages.length === 0 || !chatSessionId) return;
  const blob = new Blob([JSON.stringify({
    session_id: chatSessionId, messages: chatMessages,
  })], { type: 'application/json' });
  navigator.sendBeacon('/api/chat/save', blob);
}

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
    // Open chat panel if closed
    const panel = document.getElementById('chat-panel');
    if (panel.classList.contains('chat-collapsed') || panel.classList.contains('chat-collapsed-right') || panel.classList.contains('chat-collapsed-float')) {
      const allC = ['chat-collapsed','chat-collapsed-right','chat-collapsed-float'];
      allC.forEach(c => panel.classList.remove(c));
      panel.classList.add('chat-bottom');
      connectChat();
    }
    // Show context preview block above input
    if (pendingSelection?.text) {
      const preview = document.getElementById('chat-context-preview');
      const fileName = pendingSelection.file ? pendingSelection.file.split('/').pop() : '';
      const textSnip = pendingSelection.text.slice(0, 80).replace(/\n/g, ' ');
      preview.innerHTML = `<span class="ctx-file">${fileName || 'selection'}</span><span class="ctx-text">"${textSnip}${pendingSelection.text.length > 80 ? '...' : ''}"</span><span class="ctx-remove" title="Remove context">✕</span>`;
      preview.style.display = 'flex';
      preview.querySelector('.ctx-remove').onclick = () => { preview.style.display = 'none'; pendingSelection = null; };
    }
    document.getElementById('chat-input').focus();
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

    const numPages = Math.min(pdf.numPages, 50); // Cap at 50 pages for performance
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const scale = 1.2;
      const viewport = page.getViewport({ scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.style.width = viewport.width + 'px';
      wrapper.style.height = viewport.height + 'px';

      // Canvas for rendering
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrapper.appendChild(canvas);

      const ctx = canvas.getContext('2d');
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
  const extensions = [cm.basicSetup, cm.oneDark, cm.EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-gutters': { backgroundColor: 'transparent' } })];

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
function initSettings() {
  const btn = document.getElementById('btn-toolbar-menu');
  const toolbarMenu = document.getElementById('toolbar-menu');

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasOpen = toolbarMenu.classList.contains('open');
    toolbarMenu.classList.toggle('open');

    // Update filter active dot
    updateFilterDot();

    if (!wasOpen) {
      // Load current settings
      try {
        const resp = await fetch('/api/settings').then(r => r.json());
        document.getElementById('settings-vault-root').value = resp.vault_root || '';
        document.getElementById('settings-auth-status').textContent =
          resp.claude_authenticated ? 'Logged in' : 'Not logged in';
        document.getElementById('settings-auth-status').style.color =
          resp.claude_authenticated ? 'var(--green)' : 'var(--red)';
      } catch { }
    }
  });

  // Keep toolbar menu open when interacting with its contents
  toolbarMenu.addEventListener('click', (e) => e.stopPropagation());
  toolbarMenu.addEventListener('change', (e) => e.stopPropagation());
  document.addEventListener('click', () => toolbarMenu.classList.remove('open'));

  // Save vault root
  document.getElementById('settings-save-root').addEventListener('click', async () => {
    const newRoot = document.getElementById('settings-vault-root').value.trim();
    if (!newRoot) return;
    const result = await fetch('/api/settings', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ vault_root: newRoot }),
    }).then(r => r.json());
    if (result.ok) {
      document.getElementById('settings-save-root').textContent = 'Saved! Restart server.';
      setTimeout(() => document.getElementById('settings-save-root').textContent = 'Save & Restart', 3000);
    }
  });

  // Claude login
  document.getElementById('settings-login').addEventListener('click', async () => {
    document.getElementById('settings-login').textContent = 'Starting...';
    const result = await fetch('/api/claude-auth', { method: 'POST' }).then(r => r.json());
    document.getElementById('settings-auth-status').textContent = result.message || result.error || '';
    document.getElementById('settings-login').textContent = 'Login';
  });

  // Code font size slider
  const slider = document.getElementById('settings-code-font');
  const valDisplay = document.getElementById('settings-code-font-val');
  slider.addEventListener('input', () => {
    const size = slider.value + 'px';
    valDisplay.textContent = size;
    document.documentElement.style.setProperty('--code-font-size', size);
  });

  // Keybinding editor
  renderKeybindingEditor();
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
async function init() {
  initCanvas();
  initFilterDropdowns();
  initChat();
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
  initSettings();

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Don't intercept when typing in input/textarea
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if (e.key === 'Escape') {
      // Stop chat generation first
      if (chatGenerating && chatWs && chatWs.readyState === WebSocket.OPEN) {
        wasUserInterrupt = true;
        chatWs.send(JSON.stringify({ type: 'stop' }));
        return;
      }
      if (checkpointMode) { exitCheckpointMode(); return; }
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
    if (matchesBinding(e, 'toggle-chat')) { e.preventDefault(); const ph = document.querySelector('#chat-header .panel-header'); if (ph) ph.click(); return; }
    if (matchesBinding(e, 'new-chat') && !inInput) { e.preventDefault(); createFloatingPanel(); return; }
    if (matchesBinding(e, 'fork-chat')) { e.preventDefault(); createFloatingPanel({ fork: true }); return; }
    if (matchesBinding(e, 'settings')) { e.preventDefault(); document.getElementById('btn-toolbar-menu')?.click(); return; }
    if (matchesBinding(e, 'show-shortcuts')) { e.preventDefault(); openKeybindingPanel(); return; }
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
      // Cmd+[ go back
      if (mod && e.key === '[') {
        e.preventDefault(); e.stopPropagation();
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
}

window.navigateToLevel = navigateToLevel;

init();
