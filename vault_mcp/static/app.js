// === Vault Knowledge Base UI v3 ===
// Canvas stack with drill-in sub-canvases, edge aggregation, border resizing

// --- API ---
const api = {
  graph:       () => fetch('/api/graph').then(r => r.json()),
  page:        (p) => fetch(`/api/page/${p}`).then(r => r.json()),
  tree:        () => fetch('/api/tree').then(r => r.json()),
  search:      (q, s='wiki') => fetch(`/api/search?q=${encodeURIComponent(q)}&scope=${s}`).then(r => r.json()),
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
  return graphData.nodes.filter(n => n.data.parent === parentPath).map(n => n.data.id);
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
  card.className = 'doc-card' + (options.pinned ? ' pinned-parent' : '');
  card.dataset.path = nodeData.id;
  card.dataset.type = nodeData.type || 'unknown';
  card.style.left = pos.x + 'px';
  card.style.top = pos.y + 'px';

  const childCount = (nodeData.children || []).length;
  const typeBadge = nodeData.type ? `<span class="badge badge-${nodeData.type}">${nodeData.type}</span>` : '';
  const confBadge = nodeData.confidence ? `<span class="badge badge-${nodeData.confidence}">${nodeData.confidence}</span>` : '';
  const childBadge = childCount > 0 ? `<button class="btn-children" title="Drill into subpages">${childCount} sub</button>` : '';

  card.innerHTML = `
    <div class="doc-handle">
      <span class="doc-title">${nodeData.label}</span>
      <span class="doc-badges">${typeBadge}${confBadge}</span>
      <div class="doc-controls">
        ${childBadge}
        <button class="btn-edit" title="Edit">E</button>
        <button class="btn-collapse" title="Collapse">-</button>
      </div>
    </div>
    <div class="doc-body">${content ? marked.parse(content) : '<em>Loading...</em>'}</div>
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

  // Double-click title → full page
  card.querySelector('.doc-handle').addEventListener('dblclick', (e) => {
    e.stopPropagation(); e.preventDefault(); expandCardFullPage(card);
  });

  // Collapse
  card.querySelector('.btn-collapse').addEventListener('click', (e) => {
    e.stopPropagation();
    const body = card.querySelector('.doc-body');
    const btn = e.currentTarget;
    body.style.display = body.style.display === 'none' ? '' : 'none';
    btn.textContent = body.style.display === 'none' ? '+' : '-';
    scheduleEdgeUpdate();
  });

  // Edit
  card.querySelector('.btn-edit').addEventListener('click', (e) => {
    e.stopPropagation(); toggleEdit(card, path);
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

async function toggleEdit(card, path) {
  const body = card.querySelector('.doc-body');
  const btn = card.querySelector('.btn-edit');
  if (card.dataset.editing === 'true') {
    const textarea = body.querySelector('.doc-edit-area');
    const meta = cardMeta.get(path);
    if (meta && textarea) {
      try {
        await api.savePage(path, meta.frontmatter, textarea.value);
        meta.content = textarea.value;
        body.innerHTML = marked.parse(textarea.value);
        wireWikiLinks(card);
      } catch (err) { body.innerHTML = `<p style="color:var(--red)">Save failed</p>`; return; }
    }
    card.dataset.editing = 'false'; btn.textContent = 'E';
  } else {
    const meta = cardMeta.get(path);
    body.innerHTML = `<textarea class="doc-edit-area">${(meta?.content||'').replace(/</g,'&lt;')}</textarea>`;
    card.dataset.editing = 'true'; btn.textContent = 'S';
    body.querySelector('.doc-edit-area')?.focus();
  }
}

// ========================================
// Card Drag
// ========================================
function wireCardDrag(card, pinned) {
  if (pinned) return; // Pinned parent cards can't be dragged
  const handle = card.querySelector('.doc-handle');
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.doc-controls')) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origX = parseInt(card.style.left)||0, origY = parseInt(card.style.top)||0;
    const k = currentTransform.k;
    function onMove(e) {
      card.style.left = (origX + (e.clientX - startX)/k) + 'px';
      card.style.top = (origY + (e.clientY - startY)/k) + 'px';
      scheduleEdgeUpdate();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      layoutData[card.dataset.path] = { x: parseInt(card.style.left), y: parseInt(card.style.top) };
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
  const EDGE = 8; // px from border to trigger resize
  let resizeAxis = null; // 'e', 's', 'se', or null

  card.addEventListener('pointermove', (e) => {
    if (card.dataset.resizing) return;
    const rect = card.getBoundingClientRect();
    const dx = rect.right - e.clientX;
    const dy = rect.bottom - e.clientY;
    const nearRight = dx >= 0 && dx < EDGE;
    const nearBottom = dy >= 0 && dy < EDGE;
    if (nearRight && nearBottom) { card.style.cursor = 'nwse-resize'; resizeAxis = 'se'; }
    else if (nearRight) { card.style.cursor = 'ew-resize'; resizeAxis = 'e'; }
    else if (nearBottom) { card.style.cursor = 'ns-resize'; resizeAxis = 's'; }
    else { card.style.cursor = ''; resizeAxis = null; }
  });

  card.addEventListener('pointerdown', (e) => {
    if (!resizeAxis) return;
    if (e.target.closest('.doc-handle') || e.target.closest('.doc-body') || e.target.closest('.doc-controls')) return;
    e.preventDefault(); e.stopPropagation();
    card.dataset.resizing = 'true';
    const startX = e.clientX, startY = e.clientY;
    const startW = card.offsetWidth, startH = card.offsetHeight;
    const axis = resizeAxis;
    const k = currentTransform.k;

    function onMove(e) {
      if (axis === 'e' || axis === 'se') card.style.width = Math.max(200, startW + (e.clientX-startX)/k) + 'px';
      if (axis === 's' || axis === 'se') {
        const body = card.querySelector('.doc-body');
        if (body) body.style.maxHeight = Math.max(60, body.offsetHeight + (e.clientY-startY)/k) + 'px';
      }
      scheduleEdgeUpdate();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      delete card.dataset.resizing;
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
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
    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)"/>
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
  const cardW = 400, cardH = 380, gap = 40;
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
// Layout
// ========================================
function computeLayout(nodes, saved) {
  const positions = {};
  const folders = {};
  for (const node of nodes) {
    const folder = node.data.folder || 'wiki';
    if (!folders[folder]) folders[folder] = [];
    folders[folder].push(node.data.id);
  }
  let col = 0;
  const cardW = 420, cardH = 400, gap = 40;
  for (const [, ids] of Object.entries(folders).sort()) {
    let row = 0;
    for (const id of ids) {
      positions[id] = saved[id] || { x: col, y: row * (cardH + gap) };
      row++;
    }
    col += cardW + gap * 2;
  }
  return positions;
}

function autoLayout() {
  const topCards = [...cardElements.entries()].filter(([,c]) => c.style.left);
  const n = topCards.length; if (n === 0) return;
  const cols = Math.ceil(Math.sqrt(n));
  const cardW = 420, cardH = 400, gap = 60;
  topCards.forEach(([path, card], i) => {
    const x = (i % cols) * (cardW + gap), y = Math.floor(i / cols) * (cardH + gap);
    card.style.left = x + 'px'; card.style.top = y + 'px';
    layoutData[path] = { x, y };
  });
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
    if (targetNode.data.parent) {
      drillInto(targetNode.data.parent);
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

function expandCardFullPage(card) {
  if (expandedCard) collapseFullPage();
  const path = card.dataset.path;
  const meta = cardMeta.get(path);
  const title = card.querySelector('.doc-title')?.textContent || path;
  const content = meta ? marked.parse(meta.content) : '';
  const overlay = document.createElement('div');
  overlay.id = 'fullpage-overlay';
  overlay.innerHTML = `
    <div class="fullpage-header">
      <button class="fullpage-back" title="Back (Escape)">← Back</button>
      <span class="fullpage-title">${title}</span>
      <span class="fullpage-path">${path}</span>
    </div>
    <div class="fullpage-content">${content}</div>
  `;
  document.getElementById('canvas-container').appendChild(overlay);
  expandedCard = overlay;
  overlay.querySelector('.fullpage-back').onclick = collapseFullPage;
  overlay.querySelectorAll('.wiki-link').forEach(el => {
    el.addEventListener('click', () => { collapseFullPage(); focusCardByTitle(el.dataset.target); });
  });
}

function collapseFullPage() { if (expandedCard) { expandedCard.remove(); expandedCard = null; } }

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
function applyFilters() {
  const types = getActiveTypes(), tags = getActiveTags();
  const typeBtn = document.getElementById('filter-type-btn');
  const allT = document.querySelectorAll('#filter-type-menu input[type="checkbox"]');
  const checkedT = [...allT].filter(c=>c.checked);
  typeBtn.textContent = checkedT.length===allT.length?'Type: All':checkedT.length===0?'Type: None':`Type: ${checkedT.length}`;
  document.getElementById('filter-tag-btn').textContent = tags===null?'Tags: All':`Tags: ${tags.size}`;

  for (const [path,card] of cardElements) {
    const type = card.dataset.type||'unknown';
    const meta = cardMeta.get(path);
    const t = meta?.frontmatter?.tags||[];
    card.style.display = (types.has(type) && (tags===null||t.some(x=>tags.has(x)))) ? '' : 'none';
  }
  // Sidebar
  document.querySelectorAll('#sidebar-tree .tree-item.file').forEach(item => {
    const meta = cardMeta.get(item.dataset.id);
    if (!meta) return;
    const type = meta.frontmatter?.type||'unknown';
    const t = meta.frontmatter?.tags||[];
    item.style.opacity = (types.has(type) && (tags===null||t.some(x=>tags.has(x)))) ? '' : '0.3';
  });
  scheduleEdgeUpdate();
}

function initFilterDropdowns() {
  const typeBtn = document.getElementById('filter-type-btn');
  const typeMenu = document.getElementById('filter-type-menu');
  const tagBtn = document.getElementById('filter-tag-btn');
  const tagMenu = document.getElementById('filter-tag-menu');

  typeBtn.onclick = (e) => { e.stopPropagation(); typeMenu.classList.toggle('open'); tagMenu.classList.remove('open'); };
  tagBtn.onclick = (e) => { e.stopPropagation(); tagMenu.classList.toggle('open'); typeMenu.classList.remove('open'); };
  document.addEventListener('click', () => { typeMenu.classList.remove('open'); tagMenu.classList.remove('open'); });

  typeMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.onchange = applyFilters);
  document.getElementById('filter-select-all').onclick = () => { typeMenu.querySelectorAll('input').forEach(c=>c.checked=true); applyFilters(); };
  document.getElementById('filter-clear-all').onclick = () => { typeMenu.querySelectorAll('input').forEach(c=>c.checked=false); applyFilters(); };
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

// --- Other views (tag cloud, health, search, tree expanded) ---
async function initTreeView() {
  const treeData = await api.tree();
  const c = document.getElementById('tree-expanded'); c.innerHTML = '';
  for (const folder of (treeData.children||[]).filter(c=>c.type==='folder')) {
    const files = folder.children?.filter(c=>c.type==='file')||[];
    if (!files.length) continue;
    const s = document.createElement('div'); s.className='tree-folder-section';
    s.innerHTML = `<h3>${folder.name} (${files.length})</h3>`;
    for (const f of files) {
      const item = document.createElement('div'); item.className='tree-file-item'; item.textContent=f.title||f.name;
      item.onclick = () => { switchView('graph'); const card = cardElements.get(f.id); if(card) expandCardFullPage(card); };
      s.appendChild(item);
    }
    c.appendChild(s);
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
async function doSearch(query) {
  if (!query.trim()) return;
  switchView('search');
  const c = document.getElementById('search-results'); c.innerHTML='<div class="empty-state">Searching...</div>';
  try {
    const results = await api.search(query);
    if (!results.length) { c.innerHTML='<div class="empty-state">No results</div>'; return; }
    c.innerHTML='';
    for (const r of results) {
      const div=document.createElement('div'); div.className='search-result';
      const esc=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      div.innerHTML=`<div class="result-path">${r.path}:${r.line}</div><div class="result-context">${r.context.replace(new RegExp(`(${esc})`,'gi'),'<mark>$1</mark>')}</div>`;
      div.onclick=()=>{ switchView('graph'); const card=cardElements.get(r.path); if(card) focusCard(card); };
      c.appendChild(div);
    }
  } catch(e) { c.innerHTML=`<div class="empty-state">Error: ${e.message}</div>`; }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.view-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  document.querySelector(`.view-tab[data-view="${name}"]`)?.classList.add('active');
  if (name==='tree') initTreeView();
  if (name==='tags') initTagCloud();
  if (name==='health') initHealth();
}

// --- Main init ---
async function init() {
  initCanvas();
  initFilterDropdowns();
  document.querySelectorAll('.view-tab').forEach(tab => tab.onclick = () => switchView(tab.dataset.view));

  const searchInput = document.getElementById('search-input');
  let st; searchInput.oninput = () => { clearTimeout(st); st=setTimeout(()=>doSearch(searchInput.value),300); };
  searchInput.onkeydown = e => { if(e.key==='Enter') doSearch(searchInput.value); };

  document.getElementById('btn-auto-layout').onclick = autoLayout;
  document.getElementById('btn-fit').onclick = fitView;

  document.addEventListener('keydown', (e) => {
    if (e.key==='Escape') { if(expandedCard){collapseFullPage();return;} if(canvasStack.length>1){navigateToLevel(canvasStack.length-2);return;} }
    if ((e.ctrlKey||e.metaKey) && e.key==='f') { e.preventDefault(); searchInput.focus(); }
  });

  await Promise.all([initGraphView(), initSidebar()]);
  populateTagFilter();
}

// Make navigateToLevel accessible from inline onclick
window.navigateToLevel = navigateToLevel;

init();
