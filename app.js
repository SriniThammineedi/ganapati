'use strict';

const COLORS = [
  { name: 'Black', value: '#111827' },
  { name: 'White', value: '#ffffff' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#facc15' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
];

const DRAWINGS = [
  { name: 'Ganapati Cartoon', file: 'ganapati-cartoon-style.svg' },
  { name: 'Ganapati Before Sun', file: 'ganapati-sat-behind-sun.svg' },
  { name: 'Ganapati Four Arms', file: 'ganapati-sat-behind-sun-two-hands.svg' },
  { name: 'Ganapati on Lotus', file: 'ganapati-saton-lotus.svg' },
  { name: 'Ganapati Standing', file: 'ganapati-stand-with-two-hands.svg' },
];

// The artwork is a vector mosaic: thousands of closed, filled paths and no
// strokes, where one body part is built from dozens of neighbouring shades.
//
// Colour alone is not enough: the same skin tone covers the face, the ears
// and the feet. Splitting those into connected clusters does not help either,
// because the tiles physically touch — face meets trunk meets belly meets
// arm — so any adjacency rule chains the whole body into one region.
//
// Instead a tap grows outward from the path actually touched, absorbing
// touching neighbours of a similar colour and stopping at the drawing's
// linework. That is a flood fill over the mosaic rather than over pixels,
// so it respects the drawn boundaries the artist put there.

// How far apart two tiles may sit and still count as touching, as a fraction
// of the drawing size. Tiles in this artwork abut almost exactly, so this
// only has to bridge hairline anti-aliasing gaps.
const NEIGHBOUR_GAP = 0.004;

// How different two tiles' colours may be and still be treated as the same
// surface, as a 0..1 distance in RGB. Tuned against the artwork: above ~0.05
// the flood escapes along shading gradients and swallows the whole figure,
// while much below this it stops inside a single shaded area.
const COLOUR_TOLERANCE = 0.03;

// A flood must not swallow the whole figure if the tolerances are too loose.
const MAX_FLOOD = 4000;

// Paths whose colour is near-black are the drawing's linework. They stay
// black in outline view and are never fillable.
const INK_LUMINANCE = 0.22;

// Most shapes in this artwork are defined by colour alone, not by a drawn
// edge — the sun behind Ganapati is one flat disc with no outline of its
// own. Painting those flat white for colouring would erase them, so in
// outline view a fillable shape is given a thin stroke so its silhouette
// still reads on a white page.
//
// Only shapes big enough to be part of the drawing get one. The artwork is
// mostly tiny shading fragments — the median path covers ~0.01% of the
// canvas — and outlining those turns the figure into grey noise. Real
// features (the sun disc, an ear, a garment panel) run from ~0.3% upwards.
const OUTLINE_MIN_AREA = 0.003;
const REGION_STROKE = '#c8ced8';
const REGION_STROKE_WIDTH = 0.5;

const state = {
  currentColor: COLORS[2].value,
  currentTool: 'bucket',
  currentDrawingIndex: 0,
  outlineMode: true,
  // Every fillable path, plus the spatial index a flood needs.
  tiles: [],
  grid: new Map(),
  cell: 1,
  gap: 1,
  // Saved fills per drawing (tile index -> colour), so switching away and
  // back keeps the work.
  fills: {},
  history: [],
};

window.addEventListener('DOMContentLoaded', initApp);

function initApp() {
  renderPalette();
  renderThumbnails();
  bindToolbar();
  // Mirror the initial outlineMode onto the DOM so the stage and the toggle
  // button agree with state before the first drawing lands.
  const stage = document.querySelector('.stage-card');
  if (stage) stage.classList.toggle('outline-mode', state.outlineMode);
  const outlineBtn = document.getElementById('outlineBtn');
  if (outlineBtn) outlineBtn.classList.toggle('active', state.outlineMode);
  loadDrawing(DRAWINGS[state.currentDrawingIndex].file);
}

/* ---------------------------------------------------------------- palette */

function renderPalette() {
  const palette = document.getElementById('palette');
  palette.innerHTML = COLORS.map((color) => {
    const activeClass = color.value === state.currentColor ? 'active' : '';
    return `
      <button
        class="color ${activeClass}"
        data-color="${color.value}"
        title="${color.name}"
        aria-label="${color.name}"
        style="background:${color.value};"
      ></button>
    `;
  }).join('');

  palette.querySelectorAll('.color').forEach((button) => {
    button.addEventListener('click', () => {
      state.currentColor = button.dataset.color;
      setTool('bucket');
      syncSelectedColor();
      palette.querySelectorAll('.color').forEach((item) => {
        item.classList.toggle('active', item.dataset.color === state.currentColor);
      });
    });
  });

  syncSelectedColor();
}

function syncSelectedColor() {
  const selected = document.getElementById('selectedColor');
  if (selected) selected.style.background = state.currentColor;
}

/* ------------------------------------------------------------ thumbnails */

function renderThumbnails() {
  const thumbStrip = document.getElementById('thumbStrip');
  thumbStrip.innerHTML = DRAWINGS.map((drawing, index) => {
    const activeClass = index === state.currentDrawingIndex ? 'active' : '';
    return `
      <button class="thumb-btn ${activeClass}" data-index="${index}" title="${drawing.name}">
        <img src="svgs/${drawing.file}" alt="${drawing.name}" loading="lazy" />
      </button>
    `;
  }).join('');

  thumbStrip.querySelectorAll('.thumb-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      if (index === state.currentDrawingIndex) return;
      state.currentDrawingIndex = index;
      thumbStrip.querySelectorAll('.thumb-btn').forEach((item, i) => {
        item.classList.toggle('active', i === index);
      });
      loadDrawing(DRAWINGS[index].file);
    });
  });
}

/* --------------------------------------------------------------- toolbar */

function bindToolbar() {
  const map = {
    bucketTool: () => setTool('bucket'),
    eraserTool: () => setTool('eraser'),
    clearBtn: clearAllFills,
    undoBtn: undoLastFill,
    outlineBtn: toggleOutlineMode,
  };
  Object.entries(map).forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  });
}

function setTool(tool) {
  state.currentTool = tool;
  document.querySelectorAll('.tool').forEach((item) => {
    item.classList.toggle('active', item.id === `${tool}Tool`);
  });
}

// Outline view hides the original artwork colours so the user colours from
// blank. Turning it off reveals the artwork again as a reference.
function toggleOutlineMode() {
  state.outlineMode = !state.outlineMode;
  const btn = document.getElementById('outlineBtn');
  if (btn) btn.classList.toggle('active', state.outlineMode);
  const stage = document.querySelector('.stage-card');
  if (stage) stage.classList.toggle('outline-mode', state.outlineMode);
  repaintAll();
}

/* ------------------------------------------------------------- rendering */

async function loadDrawing(file) {
  const host = document.getElementById('coloringSvg');
  const stage = document.querySelector('.stage-card');
  if (stage) stage.classList.add('loading');

  host.innerHTML = '';
  state.tiles = [];
  state.grid = new Map();
  state.history = [];

  try {
    const response = await fetch(`svgs/${file}`);
    if (!response.ok) throw new Error(`${file} -> HTTP ${response.status}`);
    buildDrawing(await response.text(), file);
  } catch (error) {
    console.error(error);
    showLoadError(host, file);
  } finally {
    if (stage) stage.classList.remove('loading');
  }
}

function showLoadError(host, file) {
  host.setAttribute('viewBox', '0 0 800 800');
  host.innerHTML = `
    <text x="400" y="380" text-anchor="middle" font-size="26" fill="#9ca3af">
      Could not load the drawing
    </text>
    <text x="400" y="418" text-anchor="middle" font-size="16" fill="#c3c9d4">
      svgs/${file}
    </text>
    <text x="400" y="452" text-anchor="middle" font-size="14" fill="#c3c9d4">
      Open the app over http:// — file:// blocks loading.
    </text>`;
}

function buildDrawing(svgText, file) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  // DOMParser signals bad XML with a <parsererror> node instead of throwing.
  if (doc.querySelector('parsererror')) throw new Error(`Malformed SVG: ${file}`);

  const source = doc.documentElement;
  const host = document.getElementById('coloringSvg');
  host.setAttribute(
    'viewBox',
    source.getAttribute('viewBox') ||
      `0 0 ${source.getAttribute('width') || 800} ${source.getAttribute('height') || 800}`
  );

  Array.from(source.children).forEach((child) => {
    host.appendChild(document.importNode(child, true));
  });

  groupIntoRegions(host, file);
}

// Index every painted path: record its colour and box, mark the linework,
// and build a spatial grid so a flood can find touching tiles cheaply.
function groupIntoRegions(host, file) {
  const nodes = Array.from(host.querySelectorAll('path, polygon, circle, ellipse, rect'));
  const tiles = [];

  nodes.forEach((node) => {
    const rgb = parseColor(node.getAttribute('fill'));

    // Unfilled/none paths carry no area — skip them entirely.
    if (!rgb) {
      node.setAttribute('pointer-events', 'none');
      return;
    }

    node.dataset.original = rgbToHex(rgb);

    if (luminance(rgb) < INK_LUMINANCE) {
      // Linework: never fillable, and it must sit above the colour it frames.
      node.setAttribute('pointer-events', 'none');
      node.classList.add('ink');
      return;
    }

    const box = node.getBBox();
    node.dataset.tile = String(tiles.length);
    node.setAttribute('pointer-events', 'all');
    node.classList.add('region');
    tiles.push({
      node,
      rgb,
      area: box.width * box.height,
      x0: box.x,
      y0: box.y,
      x1: box.x + box.width,
      y1: box.y + box.height,
    });
  });

  const vb = host.viewBox.baseVal;

  // Mark the shapes large enough to be worth outlining.
  const canvasArea = vb.width * vb.height;
  tiles.forEach((tile) => {
    tile.outlined = tile.area / canvasArea >= OUTLINE_MIN_AREA;
  });

  const size = Math.max(vb.width, vb.height);
  state.tiles = tiles;
  state.gap = size * NEIGHBOUR_GAP;
  state.grid = buildGrid(tiles, Math.max(size * 0.02, 1));
  state.cell = Math.max(size * 0.02, 1);

  host.addEventListener('pointerdown', handleStagePointer);
  repaintAll();
}

// Bucket tile indices into fixed cells so neighbour lookups stay local.
function buildGrid(tiles, cell) {
  const grid = new Map();
  tiles.forEach((tile, i) => {
    const cx0 = Math.floor(tile.x0 / cell), cx1 = Math.floor(tile.x1 / cell);
    const cy0 = Math.floor(tile.y0 / cell), cy1 = Math.floor(tile.y1 / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = `${cx},${cy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return grid;
}

function neighboursOf(index) {
  const tile = state.tiles[index];
  const cell = state.cell;
  const gap = state.gap;
  const seen = new Set();
  const out = [];

  const cx0 = Math.floor((tile.x0 - gap) / cell), cx1 = Math.floor((tile.x1 + gap) / cell);
  const cy0 = Math.floor((tile.y0 - gap) / cell), cy1 = Math.floor((tile.y1 + gap) / cell);

  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const bucket = state.grid.get(`${cx},${cy}`);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j === index || seen.has(j)) continue;
        seen.add(j);
        const other = state.tiles[j];
        const touching =
          tile.x0 - gap <= other.x1 && other.x0 - gap <= tile.x1 &&
          tile.y0 - gap <= other.y1 && other.y0 - gap <= tile.y1;
        if (touching) out.push(j);
      }
    }
  }
  return out;
}

// Grow from the tapped tile across touching tiles of a similar colour.
// The artwork's dark linework is not in `tiles` at all, so the flood simply
// runs out of neighbours at a drawn edge — the boundaries hold.
function floodFrom(index) {
  const start = state.tiles[index];
  const queue = [index];
  const seen = new Set([index]);
  const result = [];

  while (queue.length && result.length < MAX_FLOOD) {
    const current = queue.pop();
    result.push(current);
    for (const j of neighboursOf(current)) {
      if (seen.has(j)) continue;
      if (colourDistance(state.tiles[j].rgb, start.rgb) > COLOUR_TOLERANCE) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return result;
}

/* ---------------------------------------------------------------- colour */

function parseColor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent' || v.startsWith('url(')) return null;

  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((p) => parseFloat(p));
    if (parts.length >= 3) return [parts[0] | 0, parts[1] | 0, parts[2] | 0];
  }

  // Named colours: only the two that actually appear in this artwork.
  if (v === 'white') return [255, 255, 255];
  if (v === 'black') return [0, 0, 0];
  return null;
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Rec. 709 luminance, 0..1.
function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Normalised RGB distance, 0 (identical) .. 1 (black vs white).
function colourDistance(a, b) {
  const dr = (a[0] - b[0]) / 255;
  const dg = (a[1] - b[1]) / 255;
  const db = (a[2] - b[2]) / 255;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/* ----------------------------------------------------------------- fills */

function handleStagePointer(event) {
  const node = event.target;
  if (!node || !node.dataset || node.dataset.tile === undefined) return;
  event.preventDefault();
  applyFloodAt(Number(node.dataset.tile));
}

function applyFloodAt(index) {
  const patch = floodFrom(index);
  if (!patch.length) return;

  const file = DRAWINGS[state.currentDrawingIndex].file;
  const saved = state.fills[file] || (state.fills[file] = {});
  const next = state.currentTool === 'eraser' ? null : state.currentColor;

  // Record the previous colour of every tile touched so undo restores the
  // whole stroke, not just its seed.
  const undoEntry = [];
  patch.forEach((i) => {
    const previous = saved[i] === undefined ? null : saved[i];
    if (previous === next) return;
    undoEntry.push({ index: i, previous });
    if (next === null) delete saved[i];
    else saved[i] = next;
    paintTile(i, saved[i]);
  });

  if (!undoEntry.length) return;
  state.history.push(undoEntry);
  pulse(state.tiles[index].node);
}

// A tile's shown colour depends on the mode: outline view starts blank and
// only shows user fills; artwork view falls back to the original colour.
function paintTile(index, userFill) {
  const { node } = state.tiles[index];
  const shown = userFill || (state.outlineMode ? '#ffffff' : node.dataset.original);
  node.setAttribute('fill', shown);
  node.classList.toggle('filled', Boolean(userFill));

  // Outline view needs a drawn edge on the shapes that carry the drawing;
  // artwork view does not, because there the colour difference shows them.
  if (state.outlineMode && state.tiles[index].outlined) {
    node.setAttribute('stroke', REGION_STROKE);
    node.setAttribute('stroke-width', REGION_STROKE_WIDTH);
    node.setAttribute('vector-effect', 'non-scaling-stroke');
  } else {
    node.removeAttribute('stroke');
    node.removeAttribute('stroke-width');
    node.removeAttribute('vector-effect');
  }
}

function repaintAll() {
  const saved = state.fills[DRAWINGS[state.currentDrawingIndex].file] || {};
  state.tiles.forEach((_, i) => paintTile(i, saved[i]));
}

function pulse(node) {
  node.classList.remove('just-filled');
  void node.getBoundingClientRect(); // restart the animation on a repeat tap
  node.classList.add('just-filled');
}

function undoLastFill() {
  const last = state.history.pop();
  if (!last) return;

  const file = DRAWINGS[state.currentDrawingIndex].file;
  const saved = state.fills[file] || (state.fills[file] = {});
  last.forEach(({ index, previous }) => {
    if (previous === null) delete saved[index];
    else saved[index] = previous;
    paintTile(index, saved[index]);
  });
}

function clearAllFills() {
  state.history = [];
  state.fills[DRAWINGS[state.currentDrawingIndex].file] = {};
  repaintAll();
}
