// =========================
// Timeline Chart
// =========================

// Module-scope state
let svg;                   // d3 selection for the #chart SVG
let width;                 // current chart width (responsive)
let DOT_CENTER_Y;          // vertical centerline for dots
let lastClicked = null;    // last dot clicked (for styling)
let keyEvents = [];        // subset of filteredData with keyEvent=true
let rawData = [];          // all parsed rows from CSV
let filteredData = [];     // rows after filters/search
let currentXScale = null;  // keep a ref for button zoom
let FULL_EXTENT = null;    // [minDate, maxDate] across ALL rows
let ZOOM_LISTENERS_BOUND = false;

// Layout constants control spacing and heights of major bands.
const LAYOUT = {
  top: 8,
  chartHeight: 320, // vertical band for the dots
  axisGap: 20,      // vertical gap between dots and axis
  annoGap: 36,      // gap between axis and first annotation row
  annoRow: 18,      // height of one annotation row
  annoRowsMax: 8,   // maximum annotation rows reserved
  bottom: 16
};



// Legend drawing constants (position and spacing).
const LEGEND = { x: 16, y: Math.max(2, LAYOUT.top - 6), dotR: 8, gapY: 20, gapX: 120 };


// Derived y-positions for axis/annotations; total SVG height budget.
const AXIS_Y  = LAYOUT.top + LAYOUT.chartHeight;
const ANNO_Y0 = AXIS_Y + LAYOUT.annoGap;

// Never let the timeline get narrower than ~30 days
const MIN_SPAN_MS = 1000 * 60 * 60 * 24 * 30;


// Dot radius for event markers.
const radius = 8;

//  “bad” topic tokens to filter out of topic lists.
const BAD_TOPICS = new Set(["na", "n/a", "none", "", "unspecified", "-", "null"]);

// Mobile helpers
const MOBILE_MQ = "(max-width: 640px)";
const isMobile = () => window.matchMedia(MOBILE_MQ).matches;

// Colors
const categoryColors = {
  chemical: "#193a1d",
  biological: "#6cc06f",
  multi: "#555"
};

// Data
const csvUrl = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSavU5klATPLFcSRUkwYtIaZStNUpyQ03tDJrP4110ckYNpkSeEY-X78QWQLFXr4seeYZr0H7mwZ6Fk/pub?gid=0&single=true&output=csv";

// Legend state
let selectedCats = new Set(["biological", "chemical", "multi", "key"]);

// Formatter assigned in init()
let formatDate;

// =============== Utilities ===============

function getTotalHeight() {
  const noAnnoBand   = AXIS_Y + LAYOUT.bottom;
  const withAnnoBand = AXIS_Y + LAYOUT.annoGap + LAYOUT.annoRowsMax * LAYOUT.annoRow + LAYOUT.bottom;
  return isMobile() ? noAnnoBand : withAnnoBand;
}

function clampDomain([start, end], [min, max]) {
  const span = +end - +start;
  const maxSpan = +max - +min;

  // If trying to show more than exists, snap to full extent
  if (span >= maxSpan) return [new Date(min), new Date(max)];

  // Keep inside the bounds while preserving the span
  if (+start < +min) {
    start = new Date(min);
    end   = new Date(min + span);
  }
  if (+end > +max) {
    end   = new Date(max);
    start = new Date(max - span);
  }

  //  safety swap
  if (+end < +start) [start, end] = [end, start];

 // enforce minimum zoom window 
 if ((+end - +start) < MIN_SPAN_MS) {
   const mid = (+start + +end) / 2;
   start = new Date(mid - MIN_SPAN_MS / 2);
   end   = new Date(mid + MIN_SPAN_MS / 2);
   // clamp again to dataset
   if (+start < +min) { start = new Date(min); end = new Date(min + MIN_SPAN_MS); }
   if (+end > +max)   { end   = new Date(max); start = new Date(max - MIN_SPAN_MS); }
 }
  return [start, end];
}


function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function color(d) {
  if (Array.isArray(d.categories) && d.categories.length > 1) return categoryColors.multi;
  const primary = d.categories?.[0];
  return categoryColors[primary] || "#ccc";
}

// Build dropdown (clickable list; items ON by default)
function buildSelectableList(dropdownEl, items) {
  if (!dropdownEl) return;

  if (!dropdownEl.querySelector(".dropdown-actions")) {
    const actions = document.createElement("div");
    actions.className = "dropdown-actions";
    actions.innerHTML = `
      <button type="button" data-action="select">Select all</button>
      <button type="button" data-action="deselect">Deselect all</button>
    `;
    dropdownEl.appendChild(actions);
    actions.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const on = btn.dataset.action === "select";
      dropdownEl.querySelectorAll(".dropdown-option").forEach((opt) => {
        opt.classList.toggle("on", on);
        opt.classList.toggle("off", !on);
      });
      updateChart();
    });
  }

  let list = dropdownEl.querySelector(".dropdown-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "dropdown-list";
    dropdownEl.appendChild(list);
  }

  list.innerHTML = items.map(
    (v) => `
      <div class="dropdown-option on" data-value="${escapeHtml(v)}" tabindex="0">
        ${escapeHtml(v)}
      </div>`
  ).join("");

  // Helper: walk up to an Element, then closest()
  const getOption = (t) => {
    let el = t;
    while (el && el.nodeType !== 1) el = el.parentNode; // climb out of text nodes
    return el?.closest?.(".dropdown-option") || null;
  };

list.addEventListener("click", (e) => {
  e.stopImmediatePropagation();
  let el = e.target;
  while (el && el.nodeType !== 1) el = el.parentNode; // get to an Element
  const opt = el?.closest?.(".dropdown-option");
  if (!opt) return;
  opt.classList.toggle("on");
  opt.classList.toggle("off");
  updateChart();
});

  list.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const opt = getOption(e.target);
    if (!opt) return;
    e.preventDefault();
    opt.classList.toggle("on");
    opt.classList.toggle("off");
    updateChart();
  });
}

function getSelectedValues(dropdownEl) {
  if (!dropdownEl) return [];
  return Array.from(dropdownEl.querySelectorAll(".dropdown-option.on")).map(
    (el) => el.dataset.value
  );
}

function runTutorialWhenReady(startFn) {
  // wait until dots exist, then start the tutorial
  when(() => svg && !svg.selectAll("circle.dot").empty())
    .then(() => {
      // a tiny delay lets layout settle
      setTimeout(() => startFn(), 0);
    })
    .catch((err) => console.warn("Tutorial skipped:", err));
}


// =============== Init & boot ===============

function bindZoomButtons() {
  if (ZOOM_LISTENERS_BOUND) return;
  ZOOM_LISTENERS_BOUND = true;
  document.getElementById("zoomInBtn")?.addEventListener("click", () => zoomBy(1.25));
  document.getElementById("zoomOutBtn")?.addEventListener("click", () => zoomBy(0.8));
}

function init() {
  formatDate = d3.timeFormat("%d %B %Y");

  const container = document.getElementById("container");
  if (!container) {
    console.error("Missing #container");
    return;
  }

  // Ensure there is an <svg id="chart">. If #chart is a <div>, create an <svg> inside it.
  let chartEl = document.getElementById("chart");

  // If #chart does not exist, create the SVG inside #container
  if (!chartEl) {
    chartEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chartEl.setAttribute("id", "chart");
    container.prepend(chartEl);
  } else if (chartEl.tagName.toLowerCase() !== "svg") {
    // If #chart exists but is not an <svg>, create one inside it
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chartEl.appendChild(svgEl);
    chartEl = svgEl; // point to the real <svg>
  }

  // Dimensions
  width = Math.max(320, (container.clientWidth || 0) - 40);
DOT_CENTER_Y = LAYOUT.top + LAYOUT.chartHeight / 2; // LAYOUT.top + LAYOUT.chartHeight / 2 (keep in sync with constants)

  // Create d3 selection
  svg = d3.select(chartEl)
    .attr("viewBox", `0 0 ${width} ${getTotalHeight()}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Load CSV
  d3.csv(csvUrl, (d) => {
    const parsedDate = new Date(d.Date);
    if (isNaN(parsedDate)) return null;

    const displayCategories = (d.Category || "").split(",").map(s => s.trim()).filter(Boolean);
    const displayTopics     = (d.Topic || "").split(",").map(s => s.trim()).filter(Boolean);

    const categories = displayCategories.map(c => c.toLowerCase());
    const topicsNorm = displayTopics.map(t => String(t).trim().toLowerCase());

    const displaySource = (d["Source"] || "").toString().trim();

    return {
      date: parsedDate,
      displayDate: d["Display_Date"] ? String(d["Display_Date"]).trim() : "",
      event: d.Event || "(No event name)",
      notes: d["Source/Notes"] || "",

      displaySource,
      sourceUrl: d["Source_URL"] ? String(d["Source_URL"]).trim() : "",

      categories,
      category: (d.Category || "").trim().toLowerCase(),
      topics: topicsNorm,
      validTopics: topicsNorm.filter(t => !BAD_TOPICS.has(t)),

      displayCategories,
      displayTopics,

      keyEvent: (d["Key Event"] || "").toLowerCase() === "true"
    };
  })
  .then((data) => {
    rawData = data.filter(Boolean);
    FULL_EXTENT = d3.extent(rawData, d => d.date); 
    setupFilters();
    updateChart();
  })
  
  .catch((err) => {
    console.error("CSV load failed:", err?.message || err, err);
    d3.select("#detailContent").html(
      `<p style="color:#b00">⚠️ Data failed to load.<br>
        <small>${(err && (err.message || err.status || err.toString())) || ""}</small>
       </p>`
    );
  });

  // Resize
  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer__);
    window.__resizeTimer__ = setTimeout(resizeChart, 200);
  });

  // Mobile viewBox height updates
  window.matchMedia(MOBILE_MQ).addEventListener("change", () => {
    if (svg) svg.attr("viewBox", `0 0 ${width} ${getTotalHeight()}`);
    updateChart();
  });

  bindZoomButtons();
}

// DOM ready & d3 available
function when(cond, timeout = 10000, every = 25) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (cond()) { clearInterval(id); resolve(); }
      else if (Date.now() - t0 > timeout) { clearInterval(id); reject(new Error("timeout")); }
    }, every);
  });
}
function whenDomReady() {
  return new Promise((res) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => res(), { once: true });
    } else res();
  });
}
whenDomReady()
  .then(() => when(() => window.d3 && d3.csv))
  .then(() => init())
  .catch((e) => console.error("Startup failed:", e));



whenDomReady().then(() => {
  // keep clicks inside menus from closing them
  topicMenu?.addEventListener('click', (e) => e.stopPropagation());
  sourceMenu?.addEventListener('click', (e) => e.stopPropagation());
});


// Enable manual tour start
document.getElementById("helpTourBtn")?.addEventListener("click", () => {
  // if the tour was already shown and closed, allow re-run:
  TOUR_STARTED = false;
  startTour();
});

// =============== Filters UI ===============

function setupFilters() {
  const toTitleCase = (s) =>
    s.replace(/\b([\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*)\b/gu,
              (w) => w.charAt(0).toUpperCase() + w.slice(1));

  // Topics
  const topics = Array.from(new Set(rawData.flatMap(d => d.validTopics).filter(Boolean))).sort();
  const topicDropdown = document.getElementById("topicDropdown");
  if (topicDropdown) {
    const itemsForUI = topics.map(toTitleCase);
    topicDropdown.__valueLookup = new Map(itemsForUI.map((label, i) => [label, topics[i]]));
    buildSelectableList(topicDropdown, itemsForUI);
    
  }

  // Sources
  const sources = Array.from(new Set(rawData.map(d => d.displaySource).filter(Boolean))).sort();
  const sourceDropdown = document.getElementById("sourceDropdown");
  if (sourceDropdown) {
    buildSelectableList(sourceDropdown, sources);
    
  }

  // Other controls
  document.getElementById("keyEventFilter")?.addEventListener("change", updateChart);
  document.getElementById("search")?.addEventListener("input", updateChart);
}

// =============== Core filter + redraw ===============

function updateChart() {
  // --- dropdown nodes ---
  const topicDropdown  = document.getElementById("topicDropdown");
  const sourceDropdown = document.getElementById("sourceDropdown");

  // --- selected labels safely ---
  const topicLabels = getSelectedValues(topicDropdown) || [];
  let selectedTopics = topicLabels;

  // map UI labels (Title Case) -> canonical tokens (lowercase)
  if (topicDropdown && topicDropdown.__valueLookup instanceof Map) {
    selectedTopics = topicLabels
      .map(label => topicDropdown.__valueLookup.get(label) ?? label)
      .filter(Boolean);
  }
  selectedTopics = Array.from(new Set(selectedTopics)); // de-dupe

  let selectedSources = getSelectedValues(sourceDropdown) || [];

  // --- fallbacks if menus are empty/not built ---
  const allTopics  = Array.from(new Set(rawData.flatMap(d => (d.validTopics||[])).filter(Boolean)));
  const allSources = Array.from(new Set(rawData.map(d => d.displaySource).filter(Boolean)));

  const topicListCount  = topicDropdown  ? topicDropdown.querySelectorAll(".dropdown-option").length  : 0;
  const sourceListCount = sourceDropdown ? sourceDropdown.querySelectorAll(".dropdown-option").length : 0;
  const useTopicFilter  = topicListCount  > 0;
  const useSourceFilter = sourceListCount > 0;

  if (!useTopicFilter)  selectedTopics  = allTopics;
  if (!useSourceFilter) selectedSources = allSources;

  // --- toggles & search ---
  const onlyKeyEvents = !!document.getElementById("keyEventFilter")?.checked;
  const searchTerm = (document.getElementById("search")?.value || "").trim().toLowerCase();

  // --- legend categories ---
  const categoryKeys = ["biological", "chemical", "multi"];
  const activeCats   = categoryKeys.filter(k => selectedCats.has(k));

  if (activeCats.length === 0 && !selectedCats.has("key")) {
    filteredData = [];
    keyEvents = [];
    drawChart([]);
    return;
  }

  const isAllTopicsSelected  = useTopicFilter  ? (selectedTopics.length  === topicListCount)  : true;
  const isAllSourcesSelected = useSourceFilter ? (selectedSources.length === sourceListCount) : true;

  // --- main filter ---
  const data = rawData.filter((d) => {
    const isMulti = (d.categories?.length || 0) > 1;

    // 1) category (legend)
    let catMatch = false;
    if (activeCats.length > 0) {
      catMatch = isMulti ? activeCats.includes("multi")
                         : (d.categories || []).some(c => activeCats.includes(c));
    }

    // 2) allow if not key or key is enabled
    const keyOk = selectedCats.has("key") || !d.keyEvent;

    // 3) topic
    let topicMatch = true;
    if (useTopicFilter) {
      if (selectedTopics.length === 0) topicMatch = false;
      else if (!isAllTopicsSelected) {
        const evTopics = d.validTopics || [];
        topicMatch = evTopics.length > 0 && evTopics.some(t => selectedTopics.includes(t));
      }
    }

    // 4) source
    let sourceMatch = true;
    if (useSourceFilter) {
      if (selectedSources.length === 0) sourceMatch = false;
      else if (!isAllSourcesSelected) {
        sourceMatch = !!d.displaySource && selectedSources.includes(d.displaySource);
      }
    }

    // 5) key-only toggle
    const keyMatch = !onlyKeyEvents || d.keyEvent;

    // 6) text search
    const s = searchTerm;
    const searchMatch = !s ||
      (d.event && d.event.toLowerCase().includes(s)) ||
      (d.notes && d.notes.toLowerCase().includes(s));

    return catMatch && keyOk && topicMatch && sourceMatch && keyMatch && searchMatch;
  });

  filteredData = data;
  keyEvents = data.filter(d => d.keyEvent);
  drawChart(data);
}



// --- helpers
const $ = (sel, ctx = document) => ctx.querySelector(sel);

// prevent accidental form submits from #controls
$('#controls')?.addEventListener('submit', (e) => e.preventDefault());

// elements
const topicBtn   = $('#topicDropdownBtn');
const topicMenu  = $('#topicDropdown');
const sourceBtn  = $('#sourceDropdownBtn');
const sourceMenu = $('#sourceDropdown');

const detail     = $('.detail-view');
const detailTgl  = detail?.querySelector('.detail-toggle');

// ensure buttons don't submit forms
topicBtn && (topicBtn.type = 'button');
sourceBtn && (sourceBtn.type = 'button');

// toggle handlers
topicBtn?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  topicMenu?.classList.toggle('show');
  sourceMenu?.classList.remove('show');
  topicBtn.setAttribute('aria-expanded', topicMenu?.classList.contains('show'));
});

sourceBtn?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  sourceMenu?.classList.toggle('show');
  topicMenu?.classList.remove('show');
  sourceBtn.setAttribute('aria-expanded', sourceMenu?.classList.contains('show'));
});

// Close menus only when clicking/tapping OUTSIDE the menus or their buttons
document.addEventListener('click', (e) => {
  const inside = e.target.closest('#topicDropdown, #sourceDropdown, #topicDropdownBtn, #sourceDropdownBtn');
  if (inside) return; // don't close if the tap/click started inside
  topicMenu?.classList.remove('show');
  sourceMenu?.classList.remove('show');
  topicBtn?.setAttribute('aria-expanded', 'false');
  sourceBtn?.setAttribute('aria-expanded', 'false');
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    topicMenu?.classList.remove('show');
    sourceMenu?.classList.remove('show');
    topicBtn?.setAttribute('aria-expanded', 'false');
    sourceBtn?.setAttribute('aria-expanded', 'false');
  }
});
// keep clicks inside menus from closing them
topicMenu?.addEventListener('click', (e) => e.stopPropagation());
sourceMenu?.addEventListener('click', (e) => e.stopPropagation());

// detail view minimize / expand
detailTgl?.addEventListener('click', (e) => {
  e.preventDefault();
  detail?.classList.toggle('collapsed');
});


// =============== Drawing & interactions ===============

// Helper used by wheel/drag to apply new domain and refresh positions
function setDomainAndRedraw(x, xAxisG, dotsGroup, data, start, end, { repack }) {
  // update domain + axis
  x.domain([start, end]);
  currentXScale = x;
  xAxisG.call(d3.axisBottom(x).ticks(6));

  if (repack) {
    // re-run simulation against the new time scale
    const simulation = d3.forceSimulation(data)
      .force("x", d3.forceX(d => x(d.date)).strength(1))
      .force("y", d3.forceY(DOT_CENTER_Y))
      .force("collide", d3.forceCollide(radius + 1))
      .stop();
    for (let i = 0; i < 150; i++) simulation.tick();

    // refresh caches after repack
    data.forEach(d => {
      d.ySim = d.y;
      d.xOffset = (d.x - x(d.date)) || 0;
    });
  }

  // always update screen positions from scale + cached offsets
  dotsGroup.selectAll("circle")
    .attr("cx", d => x(d.date) + (d.xOffset || 0))
    .attr("cy", d => d.ySim ?? d.y);

  // redraw annotations for the new domain
  drawAnnotations(x, data);
}

function enableTouchZoomPan(svg, x, xAxisG, dotsGroup, data) {
  // Track active pointers
  const active = new Map(); // id -> {x,y}
  let baseDomain = null;    // domain snapshot at gesture start
  let panLastX = null;      // last x for 1-finger pan
  let pinchStartDist = null;
  let pinchStartMidX = null;

  const extent = FULL_EXTENT || d3.extent(rawData, d => d.date);
  const min = +extent[0], max = +extent[1];

  const onPointerDown = (e) => {
    svg.node().setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      // 1 finger: start pan
      panLastX = e.clientX;
      baseDomain = x.domain().map(d => +d);
    } else if (active.size === 2) {
      // 2 fingers: start pinch
      const pts = [...active.values()];
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartMidX = (pts[0].x + pts[1].x) / 2;
      baseDomain = x.domain().map(d => +d);
    }
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 2-finger pinch zoom
    if (active.size === 2 && pinchStartDist) {
      const pts = [...active.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (dist <= 0) return;

      const k = pinchStartDist / dist; // >1 means zoom out
      const [d0, d1] = baseDomain;
      const midClientX = (pts[0].x + pts[1].x) / 2;
      const bbox = svg.node().getBoundingClientRect();
      const localX = midClientX - bbox.left;            // svg-local x
      const anchorDate = x.invert(localX);              // date under fingers
      const a = +anchorDate;

      // Compute proposed new domain about the anchor
      let newStart = new Date(a - (a - d0) * k);
      let newEnd   = new Date(a + (d1 - a) * k);

      // Clamp to dataset & apply
      [newStart, newEnd] = clampDomain([newStart, newEnd], [extent[0], extent[1]]);
      const repack = Math.abs((+newEnd - +newStart) - (d1 - d0)) > 5;
      setDomainAndRedraw(x, xAxisG, dotsGroup, data, newStart, newEnd, { repack });
      e.preventDefault();
      return;
    }

    // 1-finger pan
    if (active.size === 1 && panLastX != null) {
      const dxPx = e.clientX - panLastX;
      panLastX = e.clientX;

      // convert pixel delta → time delta using current scale
      const dt = x.invert(0) - x.invert(dxPx);
      const [s0, e0] = x.domain().map(d => +d);
      let newStart = new Date(s0 + dt);
      let newEnd   = new Date(e0 + dt);

      [newStart, newEnd] = clampDomain([newStart, newEnd], [extent[0], extent[1]]);
      setDomainAndRedraw(x, xAxisG, dotsGroup, data, newStart, newEnd, { repack: false });
      e.preventDefault();
    }
  };

  const onPointerUp = (e) => {
    if (svg.node().hasPointerCapture?.(e.pointerId)) {
      svg.node().releasePointerCapture(e.pointerId);
    }
    active.delete(e.pointerId);
    if (active.size < 2) {
      pinchStartDist = null;
      pinchStartMidX = null;
    }
    if (active.size === 0) {
      panLastX = null;
      baseDomain = null;
    }
    e.preventDefault();
  };

  svg
    .on("pointerdown", onPointerDown, { passive: false })
    .on("pointermove", onPointerMove, { passive: false })
    .on("pointerup", onPointerUp, { passive: false })
    .on("pointercancel", onPointerUp, { passive: false })
    .on("pointerleave", onPointerUp, { passive: false });
}



function drawChart(data) {
  // clear dynamic layers
  svg.selectAll(".annotations").remove();
  svg.selectAll(".dots").remove();

  if (!data.length) {
    // keep axis/legend if any
    return;
  }

  // 1) scale + axis
  const x = d3.scaleTime()
    .domain(d3.extent(data, d => d.date))
    .range([40, width - 40]);

  let xAxisG = svg.select(".x-axis");
  currentXScale = x;
  if (xAxisG.empty()) {
    xAxisG = svg.append("g")
      .attr("class", "x-axis")
      .attr("transform", `translate(0,${AXIS_Y})`);
  }
  xAxisG.call(d3.axisBottom(x).ticks(6));

  // 2) pack dots
  const simulation = d3.forceSimulation(data)
    .force("x", d3.forceX(d => x(d.date)).strength(1))
    .force("y", d3.forceY(DOT_CENTER_Y))
    .force("collide", d3.forceCollide(radius + 1))
    .stop();
  for (let i = 0; i < 150; i++) simulation.tick();

  data.forEach(d => { if (d.viewed === undefined) d.viewed = false; });

  // cache per-node offsets from ideal time position & the simulated y
data.forEach(d => {
  d.ySim = d.y;                         // store simulated vertical position
  d.xOffset = (d.x - x(d.date)) || 0;   // horizontal offset from ideal x
});


  // 3) tooltip (singleton)
  let tooltip = d3.select("body").select(".tooltip");
  if (tooltip.empty()) {
    tooltip = d3.select("body").append("div")
      .attr("class", "tooltip")
      .style("opacity", 0);
  }

  // 4) dots
  const dotsGroup = svg.append("g").attr("class", "dots");

  dotsGroup.selectAll("circle")
    .data(data)
    .join("circle")
    .classed("dot", true)
    .attr("cx", d => x(d.date) + (d.xOffset || 0))
    .attr("cy", d => d.ySim ?? d.y)
    .attr("r", radius)
    .attr("fill", d => color(d))
    .attr("opacity", d => (d.viewed ? 0.4 : 0.8))
    .attr("stroke", d => (d.keyEvent ? "red" : "none"))
    .attr("stroke-width", d => (d.keyEvent ? 2 : 0))
    .on("mouseenter touchstart", (event, d) => {
      const noteText = d.notes.length > 200 ? d.notes.slice(0, 200) + "…" : d.notes;
      tooltip
        .style("display", "block")
        .style("opacity", 0.9)
        .html(
          `<strong>${d.event}</strong><br/>
           <p style="max-width:250px;white-space:normal;word-wrap:break-word;margin:0;">${noteText}</p>`
        )
        .style("left", event.pageX + 10 + "px")
        .style("top", event.pageY - 28 + "px");
    })
    .on("mouseleave touchend", () => {
      tooltip.style("opacity", 0).style("display", "none");
    })
    .on("click", (event, d) => {
      if (lastClicked && lastClicked !== d) lastClicked.viewed = true;
      lastClicked = d;

      dotsGroup.selectAll("circle")
        .attr("opacity", c => (c === lastClicked ? 1 : c.viewed ? 0.4 : 0.8))
        .attr("stroke", c => (c.keyEvent ? "red" : "none"))
        .attr("stroke-width", c => (c.keyEvent ? 2 : 0))
        .attr("stroke-dasharray", null);

      d3.select(event.currentTarget)
        .attr("stroke", "black")
        .attr("stroke-width", 3)
        .attr("stroke-dasharray", "4,2")
        .attr("opacity", 1);

      const dateHtml = d.displayDate ? d.displayDate : formatDate(d.date);
      const docLink = d.sourceUrl
        ? `<a href="${d.sourceUrl}" target="_blank" rel="noopener">Documentation</a>`
        : "—";

      d3.select("#detailContent").html(`
        <h3>${d.event}</h3>
        <p><strong>Date:</strong> ${dateHtml}</p>
        <p><strong>Categories:</strong> ${
          Array.isArray(d.displayCategories) && d.displayCategories.length
            ? d.displayCategories.join(", ")
            : "—"
        }</p>
        <p><strong>Topics:</strong> ${
          Array.isArray(d.displayTopics) && d.displayTopics.length
            ? d.displayTopics.join(", ")
            : "—"
        }</p>
        <p><strong>Source:</strong> ${d.displaySource || "—"}</p>
        <p>${docLink}</p>
      `);
    });


  
  
  
  // 5) mouse-wheel zoom (disabled on touch)
  const IS_TOUCH = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  if (!IS_TOUCH) {
    svg.on("wheel", (event) => {
      event.preventDefault();

      const mouseX = d3.pointer(event)[0];
      const anchorDate = x.invert(mouseX);
      const [d0, d1] = x.domain().map(d => +d);
      const extent = FULL_EXTENT || d3.extent(filteredData, d => d.date);
      const min       = +extent[0], max = +extent[1];

      const factor = event.deltaY > 0 ? 1.1 : 0.9;
      const k = Math.max(0.0001, Math.min(1000, factor));

      const a = +anchorDate;
      const newStart = new Date(a - (a - d0) * k);
      const newEnd   = new Date(a + (d1 - a) * k);

      let [start2, end2] = clampDomain([newStart, newEnd], [extent[0], extent[1]]);
      if ((+end2 - +start2) <= MIN_SPAN_MS) {
   // don’t zoom in further
   return;
 }

      const atFullExtent  = d0 === min && d1 === max;
      const wantFullExtent = +start2 === min && +end2 === max;
      if (atFullExtent && wantFullExtent && event.deltaY > 0) return;

      const oldSpan = d1 - d0;
      const newSpan = +end2 - +start2;
      const repack  = Math.abs(newSpan - oldSpan) > 5;

      setDomainAndRedraw(x, xAxisG, dotsGroup, data, start2, end2, { repack });
    });
  } else {
    svg.on("wheel", null);
  }

// 6) drag to pan (keeps dot clicks working)
{
  let lastX = null;

  const dragBehavior = d3.drag()
    // Start a drag unless the pointer began on a dot, legend, or annotation box
    .filter((event) => {
      const t = event.target;
      if (!t || !t.closest) return true;
      // don’t steal click from dots, legend, or anno labels/boxes
      return !t.closest("circle.dot, .legend, .annotation-box, .key-event-label, a");
    })
    .on("start", (event) => {
      lastX = event.x;
      svg.style("cursor", "grabbing");
    })
    .on("drag", (event) => {
      if (lastX == null) return;
      const dxPx = event.x - lastX;
      lastX = event.x;

      // Convert pixel delta to time delta
      const dt = x.invert(0) - x.invert(dxPx);

      // Shift current domain by dt, clamp to FULL_EXTENT (or filtered if not set)
      const [s0, e0] = x.domain().map(d => +d);
      let newStart = new Date(s0 + dt);
      let newEnd   = new Date(e0 + dt);

      const extent = FULL_EXTENT || d3.extent(filteredData, d => d.date);
      [newStart, newEnd] = clampDomain([newStart, newEnd], [extent[0], extent[1]]);

      setDomainAndRedraw(x, xAxisG, svg.select(".dots"), data, newStart, newEnd, { repack: false });
    })
    .on("end", () => {
      lastX = null;
      svg.style("cursor", "grab");
    });

  svg.call(dragBehavior).style("cursor", "grab");
}


  // enable touch pinch + 1-finger pan
if (navigator.maxTouchPoints > 0) {
  enableTouchZoomPan(svg, x, xAxisG, svg.select(".dots"), data);
}
  // 7) annotations & legend
  drawAnnotations(x, data);
  drawLegend();
// --- Start fully zoomed out once ---
if (!drawChart._didInitialFit && FULL_EXTENT) {
  const dotsGroup = svg.select(".dots");      // reuse the group just created
  const xAxisG    = svg.select(".x-axis");
  setDomainAndRedraw(
    x, xAxisG, dotsGroup, data,
    FULL_EXTENT[0],
    FULL_EXTENT[1],
    { repack: false } // keep the initial packing; just stretch the scale
  );
  drawChart._didInitialFit = true;
}



}

function zoomBy(factor, anchorDate) {
  if (!currentXScale || !filteredData.length) return;

  const x = currentXScale;
  const [d0, d1] = x.domain();
  const center = anchorDate ? +anchorDate : (+d0 + +d1) / 2;

  // Proposed new span
  const span = (d1 - d0) / factor;
  let newStart = new Date(center - span / 2);
  let newEnd   = new Date(center + span / 2);

  // Always clamp against the FULL dataset, not the filtered slice
  const extent = FULL_EXTENT || d3.extent(filteredData, d => d.date);
  const min = +extent[0];
  const max = +extent[1];
  const maxSpan = max - min;
  const minZoomSpan = MIN_SPAN_MS; // use the shared constant

  // Don’t allow zoom out beyond the full dataset
  if ((+newEnd - +newStart) > maxSpan) {
    newStart = new Date(min);
    newEnd   = new Date(max);
  }

  // Keep inside bounds
  if (+newStart < min) {
    newStart = new Date(min);
    newEnd   = new Date(min + span);
  }
  if (+newEnd > max) {
    newEnd   = new Date(max);
    newStart = new Date(max - span);
  }

  // Enforce minimum zoom window
  if ((+newEnd - +newStart) < minZoomSpan) return;

  // Apply via the shared helper so dots and annotations update correctly
  const dotsGroup = svg.select(".dots");
  const xAxisG    = svg.select(".x-axis");
  setDomainAndRedraw(x, xAxisG, dotsGroup, filteredData, newStart, newEnd, { repack: true });
}


// =============== Annotations & legend ===============

function drawAnnotations(x, data) {
  svg.selectAll(".annotations").remove();

  const annotationGroup = svg.append("g").attr("class", "annotations");
  const linesGroup = annotationGroup.append("g").attr("class", "annotation-lines");
  const boxesGroup = annotationGroup.append("g").attr("class", "annotation-boxes");

  const labelPadding = 4;
  const placedLabels = [];

  keyEvents
    .sort((a, b) => a.date - b.date)
    .forEach((d) => {
      if (!d.date || isNaN(x(d.date))) return;

      const xPos = x(d.date);
      const labelText  = d.event.length > 50 ? d.event.slice(0, 50) + "…" : d.event;
      const labelWidth = labelText.length * 7;
      const labelX1 = xPos - labelWidth / 2;
      const labelX2 = xPos + labelWidth / 2;

      let level = 0;
      while (placedLabels.some(l => !(labelX2 < l.x1 || labelX1 > l.x2 || level !== l.level))) level++;
      placedLabels.push({ x1: labelX1 - labelPadding, x2: labelX2 + labelPadding, level });

      const yBase = ANNO_Y0 + level * LAYOUT.annoRow;

      const match = data.find(item => item.date.getTime() === d.date.getTime() && item.event === d.event);
      const yStart = match?.y ?? DOT_CENTER_Y;

      const line = linesGroup.append("line")
        .attr("x1", xPos).attr("y1", yStart)
        .attr("x2", xPos).attr("y2", yBase - 10)
        .attr("stroke", "#888").attr("stroke-dasharray", "2,2")
        .attr("stroke-width", 1).style("opacity", 0)
        .classed("annotation-line", true);

      const labelGroup = boxesGroup.append("g")
        .attr("transform", `translate(${xPos},${yBase})`)
        .style("cursor", "pointer");

      let anchor;
      if (xPos < width * 0.33) anchor = "start";
      else if (xPos > width * 0.66) anchor = "end";
      else anchor = "middle";

      const text = labelGroup.append("text")
        .attr("x", 0).attr("y", 0).attr("dy", "0.35em")
        .attr("text-anchor", anchor)
        .attr("class", "key-event-label")
        .text(labelText);
 
      const bbox = text.node().getBBox();
      const rectX = anchor === "start" ? bbox.x - 4 : anchor === "middle" ? -bbox.width / 2 - 4 : -bbox.width - 4;

      const rect = labelGroup.insert("rect", "text")
        .attr("x", rectX).attr("y", bbox.y - 2)
        .attr("width", bbox.width + 8).attr("height", bbox.height + 4)
        .attr("rx", 4).attr("ry", 4)
        .attr("fill", "#f2f2f2").attr("stroke", "#aaa")
        .classed("annotation-box", true);

      labelGroup.on("click", () => {
        svg.selectAll(".annotation-line").attr("stroke", "#888").attr("stroke-width", 1);
        line.attr("stroke", "#555").attr("stroke-width", 3);

        svg.selectAll(".annotation-box").attr("fill", "#f2f2f2").attr("stroke", "#aaa");
        rect.attr("fill", "#e0f7fa").attr("stroke", "#00796b");

        if (match) {
          if (lastClicked && lastClicked !== match) lastClicked.viewed = true;
          lastClicked = match;

          const circles = svg.selectAll("circle.dot")
            .attr("opacity", c => (c === lastClicked ? 1 : c.viewed ? 0.4 : 0.8))
            .attr("stroke", c => (c.keyEvent ? "red" : "none"))
            .attr("stroke-width", c => (c.keyEvent ? 2 : 0))
            .attr("stroke-dasharray", null);

          circles.filter(c => c === match)
            .attr("stroke", "black")
            .attr("stroke-width", 3)
            .attr("stroke-dasharray", "4,2")
            .attr("opacity", 1);
        }

        const dateHtml = d.displayDate ? d.displayDate : formatDate(d.date);
        const docLink = d.sourceUrl
          ? `<a href="${d.sourceUrl}" target="_blank" rel="noopener">Documentation</a>`
          : "—";

        d3.select("#detailContent").html(`
          <h3>${d.event}</h3>
          <p><strong>Date:</strong> ${dateHtml}</p>
          <p><strong>Categories:</strong> ${
            Array.isArray(d.displayCategories) && d.displayCategories.length
              ? d.displayCategories.join(", ")
              : "—"
          }</p>
          <p><strong>Topics:</strong> ${
            Array.isArray(d.displayTopics) && d.displayTopics.length
              ? d.displayTopics.join(", ")
              : "—"
          }</p>
          <p><strong>Key Event:</strong> ${d.keyEvent ? "Yes" : "No"}</p>
          <p><strong>Notes:</strong><br>${d.notes || "—"}</p>
          <p>${docLink}</p>
        `);
      });
    });

  svg.selectAll(".annotation-line").style("opacity", 0);
}

function drawLegend() {
  svg.selectAll(".legend").remove();

  const legendItems = [
    { key: "biological", label: "Biological",    color: categoryColors.biological, type: "dot"  },
    { key: "chemical",   label: "Chemical",      color: categoryColors.chemical,   type: "dot"  },
    { key: "multi",      label: "Both categories", color: categoryColors.multi,    type: "dot"  },
    { key: "key",        label: "Key event",     color: null,                      type: "ring" }
  ];

  const g = svg.append("g")
    .attr("class", "legend")
    .attr("transform", `translate(${LEGEND.x},${LEGEND.y})`);

  const rows = g.selectAll(".legend-row")
    .data(legendItems, d => d.key)
    .join("g")
    .attr("class", "legend-row")
    .attr("transform", (d, i) => `translate(0, ${i * LEGEND.gapY})`)
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      if (selectedCats.has(d.key)) selectedCats.delete(d.key);
      else selectedCats.add(d.key);
      updateLegendStyles();
      updateChart();
    });

  rows.each(function (d) {
    const row = d3.select(this);
    if (d.type === "dot") {
      row.append("circle")
        .attr("class", "legend-dot")
        .attr("cx", LEGEND.dotR).attr("cy", LEGEND.dotR).attr("r", LEGEND.dotR)
        .attr("fill", d.color).attr("stroke", "#999");
    } else {
      row.append("circle")
        .attr("class", "legend-ring")
        .attr("cx", LEGEND.dotR).attr("cy", LEGEND.dotR).attr("r", LEGEND.dotR)
        .attr("fill", "#ddd").attr("stroke", "red").attr("stroke-width", 2);
    }
  });

  rows.append("text")
    .attr("x", LEGEND.dotR * 2 + 8)
    .attr("y", LEGEND.dotR + 4)
    .attr("font-size", 12)
    .attr("fill", "#333")
    .text(d => d.label);

  function updateLegendStyles() {
    rows.classed("off", d => !selectedCats.has(d.key));
    rows.selectAll("circle").attr("opacity", d => (selectedCats.has(d.key) ? 1 : 0.3));
    rows.selectAll("text").attr("fill", d => (selectedCats.has(d.key) ? "#333" : "#999"));
  }
  updateLegendStyles();
}

// =============== Resize ===============
function resizeChart() {
  const container = document.getElementById("container");
  if (!container || !svg) return;
  width = Math.max(320, (container.clientWidth || 0) - 40);
  svg.attr("viewBox", `0 0 ${width} ${getTotalHeight()}`);
  updateChart();
}

// =============== Misc (audit) ===============
function auditZoomClipping() {
  if (!currentXScale) {
    console.warn("No x scale yet.");
    return;
  }
  const [d0, d1] = currentXScale.domain();

  const outside = filteredData.filter(d => d.date < d0 || d.date > d1);
  const inside = filteredData.length - outside.length;

  console.table({
    totalFiltered: filteredData.length,
    visibleInDomain: inside,
    clippedByZoom: outside.length
  });

  return outside;
}

// =============== Detail panel collapse, controls hamburger, tour (unchanged) ===============

// --- Detail View roll-up toggle (robust, delegated) ---
(function () {
  const STORAGE_KEY = "detailViewCollapsed";

  // Apply saved/initial state once the DOM is ready
  const applyInitial = () => {
    const panel = document.getElementById("detailView");
    const btn   = document.getElementById("detailToggleBtn");
    if (!panel || !btn) return;

    const collapsed = localStorage.getItem(STORAGE_KEY) === "true";
    panel.classList.toggle("collapsed", collapsed);
    btn.setAttribute("aria-expanded", String(!collapsed));
    panel.setAttribute("aria-expanded", String(!collapsed));
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyInitial, { once: true });
  } else {
    applyInitial();
  }


})();



// =========================
// Guided Tour
// =========================

// Track whether already shown the tour in this session.
let TOUR_STARTED = false;

/** Waits for a selector to appear (useful for dynamic elements). */
function waitForEl(selector, tries = 20, delay = 150) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (n <= 0) return reject(new Error("Not found: " + selector));
      setTimeout(() => attempt(n - 1), delay);
    };
    attempt(tries);
  });
}

/** Ensures the DOM nodes required for the tour exist (mask, spotlight, popover). */
function ensureTourNodes() {
  let mask = document.getElementById("tourMask");
  if (!mask) {
    mask = document.createElement("div");
    mask.id = "tourMask";
    document.body.appendChild(mask);
  }
  let spot = document.querySelector(".tour-spotlight");
  if (!spot) {
    spot = document.createElement("div");
    spot.className = "tour-spotlight";
    document.body.appendChild(spot);
  }
  let pop = document.getElementById("tourPopover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "tourPopover";
    pop.innerHTML = `
      <h4></h4>
      <p></p>
      <div class="tour-actions">
        <button type="button" data-action="back">Back</button>
        <button type="button" data-action="next">Next</button>
        <button type="button" data-action="skip">Skip tour</button>
      </div>
    `;
    document.body.appendChild(pop);
    pop.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "back") tourPrev();
      if (action === "next") tourNext();
      if (action === "skip") endTour();
    });
  }
  return { mask, spot, pop };
}

/** Ordered steps shown by the tour */
const TOUR_STEPS = [
  {
    title: "Scroll to zoom in",
    text: "Scroll over the timeline with your mouse to zoom in and out.",
    target: "#chart"
  },
  {
    title: "Click for additional information",
    text:
      "Click on a dot to highlight the event and find additional details in the side panel.",
    target: ".dots circle, #chart"
  },
  {
    title: "Filter by topic",
    text: "Use the Topic filter to select or deselect events.",
    target: "#topicDropdownBtn"
  },
  {
    title: "Filter by source",
    text:
      "Use the Source filter to select or deselect events based on their source.",
    target: "#sourceDropdownBtn"
  },
  {
    title: "Search",
    text: "Type here to quickly search the data.",
    target: "#search"
  },
  {
    title: "Legend",
    text:
      "Toggle categories and key events on and off by clicking items in the legend.",
    target: "svg .legend"
  },
  {
    title: "Annotations",
    text:
      "Key events are labeled below the axis. Click a label to jump to that event.",
    target: "svg .annotation-boxes, #chart"
  }
];

let tourIndex = 0;

/** Start the tour once (shows mask, highlights first step). */
function startTour() {
  if (TOUR_STARTED) return;
  TOUR_STARTED = true;

  const { mask } = ensureTourNodes();
  mask.style.display = "block";
  tourIndex = 0;
  showTourStep(tourIndex);
}

/** Close all tour UI elements. */
function endTour() {
  const mask = document.getElementById("tourMask");
  const spot = document.querySelector(".tour-spotlight");
  const pop = document.getElementById("tourPopover");
  if (mask) mask.style.display = "none";
  if (spot) spot.style.display = "none";
  if (pop) pop.style.display = "none";
}

/** Go forward/back between steps; end when reaching the last step. */
function tourNext() {
  if (tourIndex < TOUR_STEPS.length - 1) {
    tourIndex++;
    showTourStep(tourIndex);
  } else endTour();
}
function tourPrev() {
  if (tourIndex > 0) {
    tourIndex--;
    showTourStep(tourIndex);
  }
}

/** Position the spotlight & popover near the target of the current step. */
async function showTourStep(i) {
  const step = TOUR_STEPS[i];
  const { mask, spot, pop } = ensureTourNodes();

  // Support comma-separated selector fallbacks (try each until one exists).
  const parts = step.target.split(",").map((s) => s.trim());
  let el = null;
  for (const part of parts) {
    try {
      el = await waitForEl(part, 8, 120);
      if (el) break;
    } catch (_) {
      /* try next part */
    }
  }
  // If no target can be found, skip this step.
  if (!el) {
    tourNext();
    return;
  }

  // Make sure target is in view.
  el.scrollIntoView?.({
    block: "center",
    inline: "center",
    behavior: "smooth"
  });

  // Measure target and compute spotlight frame.
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const sLeft = Math.max(8, rect.left - pad);
  const sTop = Math.max(8, rect.top - pad);
  const sW = Math.min(window.innerWidth - sLeft - 8, rect.width + pad * 2);
  const sH = Math.min(window.innerHeight - sTop - 8, rect.height + pad * 2);

  // Spotlight box with a big outer shadow (mask).
  Object.assign(spot.style, {
    display: "block",
    left: `${sLeft}px`,
    top: `${sTop}px`,
    width: `${sW}px`,
    height: `${sH}px`
  });

  // Fill popover content.
  pop.querySelector("h4").textContent = step.title;
  pop.querySelector("p").textContent = step.text;

  // Position popover near the spotlight (prefer below).
  pop.style.display = "block";
  const popRect = pop.getBoundingClientRect();
  const belowTop = sTop + sH + 10;
  const aboveTop = sTop - popRect.height - 10;
  let popLeft = sLeft;

  // Keep popover inside viewport horizontally.
  if (popLeft + popRect.width > window.innerWidth - 10)
    popLeft = window.innerWidth - popRect.width - 10;
  if (popLeft < 10) popLeft = 10;

  // Choose vertical position (below unless it would overflow).
  let popTop = belowTop;
  if (belowTop + popRect.height + 10 > window.innerHeight) {
    popTop = Math.max(10, aboveTop);
  }

  Object.assign(pop.style, { left: `${popLeft}px`, top: `${popTop}px` });
}

  
