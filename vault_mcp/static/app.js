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

  // Double-click title: folders → drill into canvas, files → full page
  card.querySelector('.doc-handle').addEventListener('dblclick', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (card.dataset.isFolder === 'true' && hasChildren) {
      drillInto(path);
    } else {
      expandCardFullPage(card);
    }
  });

  const body = card.querySelector('.doc-body');

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

    function onMove(e) {
      const dx = (e.clientX - startX) / k;
      const dy = (e.clientY - startY) / k;
      for (const sp of startPositions) {
        sp.card.style.left = (sp.x + dx) + 'px';
        sp.card.style.top = (sp.y + dy) + 'px';
      }
      scheduleEdgeUpdate();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
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

function expandCardFullPage(card) {
  if (expandedCard) collapseFullPage();
  // Dismiss any canvas edit
  if (activeEditCard) exitCardEdit(activeEditCard);

  const path = card.dataset.path;
  const meta = cardMeta.get(path);
  const title = card.querySelector('.doc-title')?.textContent || path;
  const content = meta ? marked.parse(meta.content) : '';
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
    <div class="fullpage-content">${content}</div>
  `;
  document.getElementById('canvas-container').appendChild(overlay);
  expandedCard = overlay;
  overlay.querySelector('.fullpage-back').onclick = collapseFullPage;
  overlay.querySelector('.fullpage-toggle').onclick = () => toggleFullPageEdit(overlay, path);
  wireFullPageLinks(overlay);
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
function getActiveFiletypes() {
  return new Set([...document.querySelectorAll('#filter-filetype-menu input[type="checkbox"]')].filter(c=>c.checked).map(c=>c.value));
}
function applyFilters() {
  const types = getActiveTypes(), tags = getActiveTags(), filetypes = getActiveFiletypes();

  // Update button labels
  const typeBtn = document.getElementById('filter-type-btn');
  const allT = document.querySelectorAll('#filter-type-menu input[type="checkbox"]');
  const checkedT = [...allT].filter(c=>c.checked);
  typeBtn.textContent = checkedT.length===allT.length?'Type: All':checkedT.length===0?'Type: None':`Type: ${checkedT.length}`;
  document.getElementById('filter-tag-btn').textContent = tags===null?'Tags: All':`Tags: ${tags.size}`;
  const ftBtn = document.getElementById('filter-filetype-btn');
  const allFt = document.querySelectorAll('#filter-filetype-menu input[type="checkbox"]');
  const checkedFt = [...allFt].filter(c=>c.checked);
  ftBtn.textContent = checkedFt.length===allFt.length?'Files: All':checkedFt.length===0?'Files: None':`Files: ${checkedFt.length}`;

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

  document.getElementById('filter-type-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('filter-type-menu', e); });
  document.getElementById('filter-tag-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('filter-tag-menu', e); });
  document.getElementById('filter-filetype-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('filter-filetype-menu', e); });
  // Close menus on click outside — but stop menus themselves from closing
  menus.forEach(id => document.getElementById(id)?.addEventListener('click', (e) => e.stopPropagation()));
  document.addEventListener('click', closeAll);

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

// --- Other views (tag cloud, health, search, tree expanded) ---
async function initTreeView() {
  const treeData = await api.tree();
  const c = document.getElementById('tree-expanded'); c.innerHTML = '';

  function renderTreeExpanded(items, depth) {
    for (const item of items) {
      if (item.type === 'folder') {
        const hasContent = item.children && item.children.length > 0;
        if (!hasContent) continue;
        const section = document.createElement('div');
        section.style.marginLeft = (depth * 16) + 'px';
        section.innerHTML = `<h3 style="font-size:${Math.max(11,13-depth)}px;color:var(--text-muted);margin:8px 0 4px;cursor:pointer">${item.title || item.name}</h3>`;
        section.querySelector('h3').onclick = () => {
          switchView('graph');
          const card = cardElements.get(item.id);
          if (card) expandCardFullPage(card);
        };
        c.appendChild(section);
        renderTreeExpanded(item.children, depth + 1);
      } else {
        const el = document.createElement('div');
        el.className = 'tree-file-item';
        el.style.marginLeft = (depth * 16) + 'px';
        el.textContent = item.title || item.name;
        el.onclick = () => {
          switchView('graph');
          const card = cardElements.get(item.id);
          if (card) expandCardFullPage(card);
          else {
            const nd = nodeById(item.id);
            if (nd) {
              const meta = cardMeta.get(item.id);
              if (meta) {
                const fakeCard = document.createElement('div');
                fakeCard.dataset.path = item.id;
                fakeCard.innerHTML = `<span class="doc-title">${nd.label}</span>`;
                expandCardFullPage(fakeCard);
              }
            }
          }
        };
        c.appendChild(el);
      }
    }
  }

  renderTreeExpanded(treeData.children || [], 0);
  if (!c.children.length) c.innerHTML = '<div class="empty-state">No pages yet</div>';
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

// ========================================
// Chat Panel
// ========================================
let chatWs = null;
let chatSessionId = null;
let chatGenerating = false;
let currentAssistantEl = null;
let currentThinkingEl = null;
let currentThinkingWrapper = null;
let chatContextLevel = 'page';
let chatMessages = []; // Track messages for auto-save
let chatIsTemporary = false; // Temporary chats don't get saved
let chatStartTime = null;
let chatTokenCount = 0;
let chatTimerInterval = null;
let currentActivityGroup = null; // Groups consecutive tool uses
let selectedCards = new Set(); // Multi-select with Cmd+click
let activeSubagents = new Map(); // task_id → {el, body, header, activityGroup, thinkingWrapper}
let currentResponseText = ''; // Accumulate assistant text for saving
let pendingAgentPrompt = null; // Captured from Agent tool_use for the next subagent_started

// Claude Code's actual 187 pondering words — one random word per call
const ponderingWords = ["Accomplishing","Actioning","Actualizing","Architecting","Baking","Beaming","Beboppin'","Befuddling","Billowing","Blanching","Bloviating","Boogieing","Boondoggling","Booping","Bootstrapping","Brewing","Bunning","Burrowing","Calculating","Canoodling","Caramelizing","Cascading","Catapulting","Cerebrating","Channeling","Channelling","Choreographing","Churning","Clauding","Coalescing","Cogitating","Combobulating","Composing","Computing","Concocting","Considering","Contemplating","Cooking","Crafting","Creating","Crunching","Crystallizing","Cultivating","Deciphering","Deliberating","Determining","Dilly-dallying","Discombobulating","Doing","Doodling","Drizzling","Ebbing","Effecting","Elucidating","Embellishing","Enchanting","Envisioning","Evaporating","Fermenting","Fiddle-faddling","Finagling","Flambéing","Flibbertigibbeting","Flowing","Flummoxing","Fluttering","Forging","Forming","Frolicking","Frosting","Gallivanting","Galloping","Garnishing","Generating","Gesticulating","Germinating","Gitifying","Grooving","Gusting","Harmonizing","Hashing","Hatching","Herding","Honking","Hullaballooing","Hyperspacing","Ideating","Imagining","Improvising","Incubating","Inferring","Infusing","Ionizing","Jitterbugging","Julienning","Kneading","Leavening","Levitating","Lollygagging","Manifesting","Marinating","Meandering","Metamorphosing","Misting","Moonwalking","Moseying","Mulling","Mustering","Musing","Nebulizing","Nesting","Newspapering","Noodling","Nucleating","Orbiting","Orchestrating","Osmosing","Perambulating","Percolating","Perusing","Philosophising","Photosynthesizing","Pollinating","Pondering","Pontificating","Pouncing","Precipitating","Prestidigitating","Processing","Proofing","Propagating","Puttering","Puzzling","Quantumizing","Razzle-dazzling","Razzmatazzing","Recombobulating","Reticulating","Roosting","Ruminating","Sautéing","Scampering","Schlepping","Scurrying","Seasoning","Shenaniganing","Shimmying","Simmering","Skedaddling","Sketching","Slithering","Smooshing","Sock-hopping","Spelunking","Spinning","Sprouting","Stewing","Sublimating","Swirling","Swooping","Symbioting","Synthesizing","Tempering","Thinking","Thundering","Tinkering","Tomfoolering","Topsy-turvying","Transfiguring","Transmuting","Twisting","Undulating","Unfurling","Unravelling","Vibing","Waddling","Wandering","Warping","Whatchamacalliting","Whirlpooling","Whirring","Whisking","Wibbling","Working","Wrangling","Zesting","Zigzagging"];

function randomPonderingWord() {
  return ponderingWords[Math.floor(Math.random() * ponderingWords.length)];
}

function initChat() {
  const panel = document.getElementById('chat-panel');
  const toggle = document.getElementById('chat-toggle');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');

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

  toggle.onclick = (e) => { e.stopPropagation(); toggleChat(); };

  // Header click/dblclick handling with timer to distinguish
  let chatDragOccurred = false;
  let chatClickTimer = null;

  document.getElementById('chat-header').addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.chat-context-dropdown')) return;
    if (chatDragOccurred) { chatDragOccurred = false; return; }
    // Delay click to allow double-click detection
    if (chatClickTimer) return; // Already waiting
    chatClickTimer = setTimeout(() => {
      chatClickTimer = null;
      toggleChat();
    }, 250);
  });

  let chatMaximized = false;
  let chatPreMaxState = null; // {dockMode, left, top, width, height}

  document.getElementById('chat-header').addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('.chat-context-dropdown')) return;
    if (chatClickTimer) { clearTimeout(chatClickTimer); chatClickTimer = null; }
    e.stopPropagation();

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
      panel.style.left = '0'; panel.style.top = '0';
      panel.style.right = '0'; panel.style.bottom = '0';
      panel.style.width = '100vw'; panel.style.height = '100vh';
      chatMaximized = true;
    }
    connectChat();
  });

  // Dock buttons
  document.getElementById('chat-dock-bottom').onclick = (e) => { e.stopPropagation(); setChatMode('bottom', false); };
  document.getElementById('chat-dock-right').onclick = (e) => { e.stopPropagation(); setChatMode('right', false); };
  document.getElementById('chat-dock-float').onclick = (e) => { e.stopPropagation(); setChatMode('float', false); };

  // Drag header: in float mode → move; from bottom/right → detach to float
  const chatHeader = document.getElementById('chat-header');
  chatHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('.chat-context-dropdown')) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const rect = panel.getBoundingClientRect();
    const origX = rect.left, origY = rect.top;

    function onMove(e) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 4) return; // Dead zone
      dragging = true;
      chatDragOccurred = true;

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

  // Context level dropdown
  const ctxBtn = document.getElementById('chat-context-btn');
  const ctxMenu = document.getElementById('chat-context-menu');
  function positionMenu(btn, menu) {
    const rect = btn.getBoundingClientRect();
    const menuH = 120; // Approximate
    // If there's room below, open downward; otherwise upward
    if (rect.bottom + menuH < window.innerHeight) {
      menu.style.top = rect.bottom + 4 + 'px';
      menu.style.bottom = '';
    } else {
      menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      menu.style.top = '';
    }
    menu.style.left = rect.left + 'px';
  }

  ctxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    modelMenu.classList.remove('open');
    ctxMenu.classList.toggle('open');
    if (ctxMenu.classList.contains('open')) positionMenu(ctxBtn, ctxMenu);
  });
  ctxMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const opt = e.target.closest('.chat-context-opt');
    if (opt) {
      chatContextLevel = opt.dataset.value;
      ctxBtn.textContent = opt.dataset.value.charAt(0).toUpperCase() + opt.dataset.value.slice(1);
      ctxMenu.classList.remove('open');
    }
  });

  // Model selector dropdown
  const modelBtn = document.getElementById('chat-model-btn');
  const modelMenu = document.getElementById('chat-model-menu');
  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctxMenu.classList.remove('open');
    modelMenu.classList.toggle('open');
    if (modelMenu.classList.contains('open')) positionMenu(modelBtn, modelMenu);
  });
  modelMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const opt = e.target.closest('.chat-context-opt');
    if (opt) {
      const model = opt.dataset.value;
      modelBtn.textContent = opt.textContent.split(' ')[0]; // Just the name
      modelMenu.classList.remove('open');
      // Tell server to switch model
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({ type: 'set_model', model }));
      }
    }
  });

  document.addEventListener('click', () => { ctxMenu.classList.remove('open'); modelMenu.classList.remove('open'); });

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

  // Stop generation
  // Temporary toggle
  const tempBtn = document.getElementById('chat-temp');
  tempBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chatIsTemporary = !chatIsTemporary;
    tempBtn.style.opacity = chatIsTemporary ? '1' : '0.6';
    tempBtn.style.color = chatIsTemporary ? 'var(--red)' : '';
    tempBtn.title = chatIsTemporary ? 'Temporary — will not be saved' : 'Toggle temporary (won\'t save)';
  });

  // Clear chat / new conversation — save existing chat first
  document.getElementById('chat-clear').addEventListener('click', async (e) => {
    e.stopPropagation();
    await saveChatTranscript(); // Save before clearing
    document.getElementById('chat-messages').innerHTML = '';
    chatMessages = [];
    chatIsTemporary = false;
    chatSessionId = crypto.randomUUID();
    sessionStorage.setItem('vault-chat-session', chatSessionId);
    currentAssistantEl = null; currentThinkingEl = null; currentThinkingWrapper = null; currentActivityGroup = null;
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'init', session_id: chatSessionId, page_path: currentLevel().parentPath || '' }));
    }
  });

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
}

function connectChat() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;

  const status = document.getElementById('chat-status');
  status.textContent = 'Connecting...';
  status.className = '';

  const wsUrl = `ws://${location.host}/ws/chat`;
  try {
    chatWs = new WebSocket(wsUrl);
  } catch (e) {
    status.textContent = 'Failed to connect';
    return;
  }

  chatWs.onopen = () => {
    chatSessionId = sessionStorage.getItem('vault-chat-session') || crypto.randomUUID();
    sessionStorage.setItem('vault-chat-session', chatSessionId);

    const level = currentLevel();
    chatWs.send(JSON.stringify({
      type: 'init',
      session_id: chatSessionId,
      page_path: level.parentPath || '',
    }));
  };

  chatWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { console.error('Chat parse error:', err); return; }
    // Mark as connected only after successful init response
    if (msg.type === 'init') {
      status.textContent = 'Connected';
      status.className = 'connected';
    }
    handleChatEvent(msg);
  };

  chatWs.onclose = () => {
    status.textContent = 'Disconnected';
    status.className = '';
    chatWs = null;
  };

  chatWs.onerror = () => {
    status.textContent = 'Connection failed';
    status.className = '';
    chatWs = null;
  };
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;

  // Track and display user message
  chatMessages.push({ role: 'user', content: text });
  currentResponseText = '';
  appendChatMessage('user', text);
  input.value = '';

  // Prepare context
  const level = currentLevel();
  const contextLevel = chatContextLevel;

  chatWs.send(JSON.stringify({
    type: 'message',
    text: text,
    context_level: contextLevel,
    context: {
      page_path: level.parentPath || '',
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
  document.getElementById('chat-stop').style.display = '';

  // Prepare assistant message area
  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'chat-msg chat-msg-assistant';
  currentThinkingEl = null;
  currentThinkingWrapper = null;

  // Status bar with elapsed time
  const statusBar = document.createElement('div');
  statusBar.className = 'chat-status-bar';
  statusBar.id = 'chat-active-status';
  const statusWord = randomPonderingWord();
  statusBar.innerHTML = `<span class="pondering">${statusWord}...</span> <span id="chat-elapsed">0.0s</span> <span id="chat-tokens">0 tokens</span>`;
  currentAssistantEl.appendChild(statusBar);

  document.getElementById('chat-messages').appendChild(currentAssistantEl);

  // Update elapsed timer
  clearInterval(chatTimerInterval);
  chatTimerInterval = setInterval(() => {
    const el = document.getElementById('chat-elapsed');
    if (el && chatStartTime) {
      el.textContent = ((Date.now() - chatStartTime) / 1000).toFixed(1) + 's';
    }
    const tokEl = document.getElementById('chat-tokens');
    if (tokEl) tokEl.textContent = chatTokenCount + ' tokens';
  }, 100);
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

// Get the target container for an event — subagent body or parent assistant
function getEventTarget(msg) {
  const subId = msg.subagent_id;
  if (subId && activeSubagents.has(subId)) {
    return activeSubagents.get(subId);
  }
  return null; // Use parent (currentAssistantEl)
}

function chatAutoScroll() {
  // User controls scroll — no auto-scroll
}

function handleChatEvent(msg) {
  const messages = document.getElementById('chat-messages');

  if (msg.type !== 'text') console.log('Chat event:', msg.type, msg);

  // Ensure we have an assistant element for content
  if (!currentAssistantEl && ['thinking', 'text', 'tool_use', 'tool_result', 'result'].includes(msg.type)) {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'chat-msg chat-msg-assistant';
    document.getElementById('chat-messages').appendChild(currentAssistantEl);
  }

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
        const agHdr = currentActivityGroup.querySelector('.chat-activity-header');
        const agElapsed = ((Date.now() - currentActivityGroup._startTime) / 1000).toFixed(1);
        const toolCount = currentActivityGroup._tools.length;
        const unique = [...new Set(currentActivityGroup._tools)];
        if (agHdr) {
          const latest = agHdr.querySelector('.activity-latest');
          if (latest) {
            latest.classList.remove('pondering');
            latest.innerHTML = `${unique.join(', ')} — ${toolCount} call${toolCount > 1 ? 's' : ''} (${agElapsed}s)`;
          }
        }
        // Collapse the body by default after completion
        const agBody = currentActivityGroup.querySelector('.chat-activity-body');
        if (agBody) agBody.classList.remove('open');
        const agToggle = currentActivityGroup.querySelector('.chat-thinking-toggle');
        if (agToggle) agToggle.classList.remove('open');
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
      if (currentAssistantEl && msg.content) {
        chatTokenCount += Math.ceil(msg.content.length / 4);
        currentResponseText += msg.content; // Accumulate for saving
        // Always append text to the LAST .chat-text, or create a new one at the end
        // This ensures text after tool calls appears below them
        let textEl = currentAssistantEl._currentTextEl;
        if (!textEl || !currentAssistantEl.contains(textEl)) {
          textEl = document.createElement('div');
          textEl.className = 'chat-text';
          currentAssistantEl.appendChild(textEl);
          currentAssistantEl._currentTextEl = textEl;
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

      // Update header
      const latestEl = ag.querySelector('.activity-latest');
      if (latestEl) latestEl.innerHTML = `${toolIcon(toolName)} <b>${toolName}</b> ${toolDesc}`;

      // Same-tool grouping: if same tool as last, increment counter
      const agBody = ag.querySelector('.chat-activity-body');
      if (ag._lastToolName === toolName && ag._lastToolGroup) {
        // Increment existing group
        ag._lastToolGroup._count = (ag._lastToolGroup._count || 1) + 1;
        const countEl = ag._lastToolGroup.querySelector('.tool-count');
        if (countEl) countEl.textContent = `(${ag._lastToolGroup._count})`;
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
        toolEntry.innerHTML = `${toolIcon(toolName)} <span class="tool-name">${toolName}</span> <span class="tool-desc">${toolDesc}</span> <span class="tool-count"></span> <span class="tool-time pondering"></span>`;
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

      ag._tools.push(toolName);
      chatMessages.push({ role: 'tool', content: `${toolName}: ${toolDesc}`, subagent_id: msg.subagent_id || null });

      // Capture Agent tool prompt for the upcoming subagent
      if (toolName === 'Agent' && msg.input) {
        pendingAgentPrompt = msg.input.prompt || msg.input.description || null;
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
      chatMessages.push({ role: 'tool_result', content: (msg.output || '').slice(0, 500), subagent_id: msg.subagent_id || null });
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
      const subDesc = msg.description || msg.task_type || 'Subagent';
      const agentPrompt = pendingAgentPrompt || '';
      pendingAgentPrompt = null;

      subHeader.innerHTML = `<span class="chat-thinking-toggle open">▶</span> <span class="pondering">Agent</span> <span class="chat-subagent-desc">${subDesc}</span> <span class="chat-subagent-status">running</span> <button class="subagent-redirect" title="Stop and redirect">Redirect</button>`;

      // Store prompt for display and redirect context
      subEl.dataset.prompt = agentPrompt;

      const subBody = document.createElement('div');
      subBody.className = 'chat-subagent-body';

      // Show prompt if we have it
      if (agentPrompt) {
        const promptEl = document.createElement('div');
        promptEl.className = 'chat-subagent-prompt';
        promptEl.innerHTML = `<span class="prompt-label">Prompt:</span> <span class="prompt-text">${agentPrompt.slice(0, 100)}${agentPrompt.length > 100 ? '...' : ''}</span>`;
        promptEl.title = agentPrompt;
        const fullPrompt = document.createElement('div');
        fullPrompt.className = 'chat-subagent-prompt-full';
        fullPrompt.textContent = agentPrompt;
        promptEl.addEventListener('click', (e) => { e.stopPropagation(); fullPrompt.classList.toggle('open'); });
        subBody.appendChild(promptEl);
        subBody.appendChild(fullPrompt);
      }

      function doRedirect() {
        if (chatWs && chatWs.readyState === WebSocket.OPEN) chatWs.send(JSON.stringify({ type: 'stop' }));

        // Build each subagent's progress from chatMessages
        function getAgentProgress(agentTaskId) {
          const progress = [];
          for (const m of chatMessages) {
            if (m.subagent_id === agentTaskId) {
              if (m.role === 'thinking') progress.push(`[Thinking]: ${m.content}`);
              else if (m.role === 'tool') progress.push(`[Tool]: ${m.content}`);
              else if (m.role === 'tool_result') progress.push(`[Result]: ${m.content}`);
            }
          }
          return progress.join('\n');
        }

        // Build hidden context with full progress for all agents
        let autoContext = 'All subagents were interrupted and need to be restarted. Here is each subagent\'s progress so they can continue exactly where they left off.\n\n';

        for (const [tid, sub] of activeSubagents) {
          const d = sub.header?.querySelector('.chat-subagent-desc')?.textContent || 'unknown';
          const p = sub.el?.dataset?.prompt || '';
          const progress = getAgentProgress(tid);

          if (tid === taskId) {
            autoContext += `--- REDIRECTED AGENT: "${d}" ---\n`;
            autoContext += `Original prompt: ${p}\n`;
            if (progress) autoContext += `Progress before redirect:\n${progress}\n`;
            autoContext += `User's redirect instructions: `;
          } else {
            autoContext += `--- AGENT TO CONTINUE: "${d}" ---\n`;
            autoContext += `Original prompt: ${p}\n`;
            if (progress) autoContext += `Progress (continue from here):\n${progress}\n`;
            autoContext += `Action: Restart this agent to continue exactly where it left off.\n\n`;
          }
        }

        // Show context block (user sees a clean summary, not the full progress)
        const preview = document.getElementById('chat-context-preview');
        const otherCount = activeSubagents.size - 1;
        const otherNote = otherCount > 0 ? ` + ${otherCount} other agent${otherCount > 1 ? 's' : ''} will restart` : '';
        preview.innerHTML = `<span class="ctx-file">Redirecting: ${subDesc}${otherNote}</span><span class="ctx-remove" title="Cancel redirect">✕</span>`;
        preview.style.display = 'flex';
        preview.querySelector('.ctx-remove').onclick = () => { preview.style.display = 'none'; pendingSelection = null; };

        pendingSelection = { text: autoContext, file: '' };

        const input = document.getElementById('chat-input');
        input.value = '';
        input.placeholder = 'Type your redirect instructions for this agent...';
        input.focus();
        input.style.height = 'auto';
      }

      subHeader.querySelector('.subagent-redirect').addEventListener('click', (e) => {
        e.stopPropagation(); doRedirect();
      });

      subHeader.addEventListener('click', (e) => {
        if (e.target.closest('.subagent-redirect')) return;
        e.stopPropagation();
        subBody.classList.toggle('collapsed');
        subHeader.querySelector('.chat-thinking-toggle').classList.toggle('open');
      });

      subEl.appendChild(subHeader);
      subEl.appendChild(subBody);
      currentAssistantEl.appendChild(subEl);
      activeSubagents.set(taskId, {
        el: subEl, body: subBody, header: subHeader,
        activityGroup: null, thinkingWrapper: null, thinkingEl: null,
      });
      chatMessages.push({ role: 'subagent', content: `Started: ${msg.description || msg.task_type || 'Subagent'}` });
      break;
    }

    case 'subagent_progress': {
      const sub = activeSubagents.get(msg.task_id);
      if (sub) {
        // Update the header with latest tool
        const desc = sub.header.querySelector('.chat-subagent-desc');
        if (desc && msg.last_tool) desc.textContent = `${msg.description || ''} — ${formatToolDesc(msg.last_tool, {})}`;
        const status = sub.header.querySelector('.chat-subagent-status');
        if (status) status.textContent = msg.description || 'working';
      }
      break;
    }

    case 'subagent_done': {
      const sub2 = activeSubagents.get(msg.task_id);
      if (sub2) {
        const status2 = sub2.header.querySelector('.chat-subagent-status');
        if (status2) {
          status2.textContent = msg.status || 'done';
          status2.style.color = msg.status === 'completed' ? 'var(--green)' : msg.status === 'failed' ? 'var(--red)' : 'var(--text-muted)';
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
        sub2.body.classList.add('collapsed');
        const toggle = sub2.header.querySelector('.chat-thinking-toggle');
        if (toggle) toggle.classList.remove('open');

        activeSubagents.delete(msg.task_id);
      }
      chatMessages.push({ role: 'subagent', content: `Done (${msg.status}): ${msg.summary || ''}` });
      break;
    }

    case 'done':
    case 'stopped':
      // Track assistant response (from accumulator, not DOM)
      if (currentResponseText) {
        chatMessages.push({ role: 'assistant', content: currentResponseText });
        currentResponseText = '';
      }
      chatGenerating = false;
      clearInterval(chatTimerInterval);
      document.getElementById('chat-send').style.display = '';
      document.getElementById('chat-stop').style.display = 'none';
      // Finalize status bar
      const activeStatus = document.getElementById('chat-active-status');
      if (activeStatus && chatStartTime) {
        const elapsed = ((Date.now() - chatStartTime) / 1000).toFixed(1);
        activeStatus.innerHTML = `<span>${elapsed}s</span> <span>${chatTokenCount} tokens</span>`;
        activeStatus.id = ''; // Remove id so next message gets a fresh one
      }
      currentAssistantEl = null;
      currentThinkingEl = null;
      currentThinkingWrapper = null;
      currentActivityGroup = null;
      activeSubagents.clear();
      chatStartTime = null;
      break;

    case 'result':
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
      appendChatMessage('system', `Error: ${msg.message || 'Unknown error'}`);
      chatGenerating = false;
      clearInterval(chatTimerInterval);
      document.getElementById('chat-send').style.display = '';
      document.getElementById('chat-stop').style.display = 'none';
      currentAssistantEl = null;
      currentThinkingEl = null;
      currentThinkingWrapper = null;
      currentActivityGroup = null;
      chatStartTime = null;
      break;
  }

  chatAutoScroll();
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

function appendChatMessage(role, text) {
  const messages = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = `chat-msg chat-msg-${role}`;
  el.textContent = text;
  messages.appendChild(el);
  chatAutoScroll();
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
// Settings
// ========================================
function initSettings() {
  const btn = document.getElementById('btn-settings');
  const menu = document.getElementById('settings-menu');

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Close other dropdowns
    ['filter-type-menu', 'filter-tag-menu', 'filter-filetype-menu'].forEach(id =>
      document.getElementById(id)?.classList.remove('open'));

    const wasOpen = menu.classList.contains('open');
    menu.classList.toggle('open');

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

  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => menu.classList.remove('open'));

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
  initSettings();

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Don't intercept when typing in input/textarea
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if (e.key === 'Escape') {
      if (expandedCard) { collapseFullPage(); return; }
      if (canvasStack.length > 1) { navigateToLevel(canvasStack.length - 2); return; }
    }
    if (mod && e.key === 'f') { e.preventDefault(); searchInput.focus(); return; }

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
        e.preventDefault();
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
