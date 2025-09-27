
// Layout constants control spacing and heights of major bands.
const LAYOUT = {
  top: 20,
  chartHeight: 320, // vertical band for the dots
  axisGap: 20, // vertical gap between dots and axis
  annoGap: 36, // gap between axis and first annotation row
  annoRow: 18, // height of one annotation row
  annoRowsMax: 8, // maximum annotation rows reserved
  bottom: 16
};

// Legend drawing constants (position and spacing).
const LEGEND = { x: 40, y: 8, dotR: 8, gapY: 20, gapX: 120 };

// Derived y-positions for axis/annotations; total SVG height budget.
const AXIS_Y = LAYOUT.top + LAYOUT.chartHeight;
const ANNO_Y0 = AXIS_Y + LAYOUT.annoGap;
const TOTAL_H =
  AXIS_Y + LAYOUT.annoGap + LAYOUT.annoRowsMax * LAYOUT.annoRow + LAYOUT.bottom;

// Dot radius for event markers.
const radius = 8;

// Canonical “bad” topic tokens to filter out of topic lists.
const BAD_TOPICS = new Set([
  "na",
  "n/a",
  "none",
  "",
  "unspecified",
  "-",
  "null"
]);

// Normalizer helper (not heavily used in this version, but kept for clarity).
const normTopic = (s) => String(s).trim().toLowerCase();

// ===== Dropdown builder (checkbox-less multi-select) =====
/**
 * Build a clickable list (no checkboxes) inside a dropdown element.
 * - items are ON by default
 * - provides "Select all" and "Deselect all" actions
 * - toggling calls updateChart() to refresh the view
 */
function buildSelectableList(dropdownEl, items) {
  if (!dropdownEl) return;

  // Add "Select all / Deselect all" row once.
  if (!dropdownEl.querySelector(".dropdown-actions")) {
    const actions = document.createElement("div");
    actions.className = "dropdown-actions";
    actions.innerHTML = `
      <button type="button" data-action="select">Select all</button>
      <button type="button" data-action="deselect">Deselect all</button>
    `;
    dropdownEl.appendChild(actions);

    // Bulk toggle handler for the action buttons.
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

  // Ensure a scrolling list container exists.
  let list = dropdownEl.querySelector(".dropdown-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "dropdown-list";
    dropdownEl.appendChild(list);
  }

  // Render options — ON by default.
  list.innerHTML = items
    .map(
      (v) => `
      <div class="dropdown-option on" data-value="${escapeHtml(
        v
      )}" tabindex="0">
        ${escapeHtml(v)}
      </div>
    `
    )
    .join("");

  // Mouse toggle
  list.addEventListener("click", (e) => {
    const opt = e.target.closest(".dropdown-option");
    if (!opt) return;
    opt.classList.toggle("on");
    opt.classList.toggle("off");
    updateChart();
  });

  // Keyboard toggle (space/enter)
  list.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const opt = e.target.closest(".dropdown-option");
    if (!opt) return;
    e.preventDefault();
    opt.classList.toggle("on");
    opt.classList.toggle("off");
    updateChart();
  });
}

/** Collect values of options that are currently ON. */
function getSelectedValues(dropdownEl) {
  if (!dropdownEl) return [];
  return Array.from(dropdownEl.querySelectorAll(".dropdown-option.on")).map(
    (el) => el.dataset.value
  );
}

/** Basic HTML-escape for text content to avoid accidental injection. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ===== Legend state (which categories are visible) =====
// Start with all categories and key events enabled.
let selectedCats = new Set(["biological", "chemical", "multi", "key"]);

// Published Google Sheet CSV URL (data source).
const csvUrl =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSavU5klATPLFcSRUkwYtIaZStNUpyQ03tDJrP4110ckYNpkSeEY-X78QWQLFXr4seeYZr0H7mwZ6Fk/pub?gid=0&single=true&output=csv";

// Color palette for single- and multi-category events.
const categoryColors = {
  chemical: "#193a1d",
  biological: "#6cc06f",
  multi: "#555"
};

/** Color accessor: multi-category → gray; else map primary category. */
const color = (d) => {
  if (Array.isArray(d.categories) && d.categories.length > 1)
    return categoryColors.multi;
  const primary = d.categories?.[0];
  return categoryColors[primary] || "#ccc";
};

// Date formatter assigned in init() via d3.timeFormat.
let formatDate;

// ===== Module-scope state (populated in init) =====
let width; // current chart width (responsive)
let DOT_CENTER_Y; // vertical centerline for dots
let svg; // d3 selection for the #chart SVG
let lastClicked = null; // last dot clicked (for styling)
let keyEvents = []; // subset of filteredData with keyEvent=true
let rawData = []; // all parsed rows from CSV
let filteredData = []; // rows after filters/search
let currentXScale = null; // keep a ref for button zoom

// Simple device check (used to avoid binding wheel zoom on touch).
let IS_MOBILE = window.matchMedia("(max-width: 600px)").matches;

let ZOOM_LISTENERS_BOUND = false;

function bindZoomButtons() {
  if (ZOOM_LISTENERS_BOUND) return;
  ZOOM_LISTENERS_BOUND = true;

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");

  zoomInBtn?.addEventListener("click", () => zoomBy(1.25));
  zoomOutBtn?.addEventListener("click", () => zoomBy(0.8));
}

// ===== Init (bootstraps the chart) =====
function init() {
  // Set up a readable date format (e.g., "23 March 2021").
  formatDate = d3.timeFormat("%d %B %Y");

  // DOM guards
  const container = document.getElementById("container");
  const chartEl = document.getElementById("chart");
  if (!container || !chartEl) {
    console.error("Missing #container or #chart");
    return;
  }

  // Compute width and vertical dot line.
  width = Math.max(320, (container.clientWidth || 0) - 40);
  DOT_CENTER_Y = LAYOUT.top + LAYOUT.chartHeight / 2;

  // Create the SVG root (responsive via viewBox).
  svg = d3
    .select(chartEl)
    .attr("viewBox", `0 0 ${width} ${TOTAL_H}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Load CSV and normalize rows.
  d3.csv(csvUrl, (d) => {
    const parsedDate = new Date(d.Date);
    if (isNaN(parsedDate)) return null; // skip bad rows

    // Keep display versions (original casing) for UI rendering.
    const displayCategories = (d.Category || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const displayTopics = (d.Topic || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Lowercased arrays for filtering & coloring logic.
    const categories = displayCategories.map((c) => c.toLowerCase());
    const topicsNorm = displayTopics.map((t) => String(t).trim().toLowerCase());

    // Preserve “Source” exactly as in CSV for UI and dropdowns.
    const displaySource = (d["Source"] || "").toString().trim();

    return {
      // core fields
      date: parsedDate,
      displayDate: d["Display_Date"] ? String(d["Display_Date"]).trim() : "",
      event: d.Event || "(No event name)",
      notes: d["Source/Notes"] || "",

      // source fields
      displaySource,
      sourceUrl: d["Source_URL"] ? String(d["Source_URL"]).trim() : "",

      // filtering / coloring fields (normalized)
      categories,
      category: (d.Category || "").trim().toLowerCase(),
      topics: topicsNorm,
      validTopics: topicsNorm.filter((t) => !BAD_TOPICS.has(t)),

      // display-only (original casing)
      displayCategories,
      displayTopics,

      // boolean: whether to include in key event overlay
      keyEvent: (d["Key Event"] || "").toLowerCase() === "true"
    };
  })
    .then((data) => {
      // Store cleaned rows and wire UI.
      rawData = data.filter(Boolean);
      setupFilters();
      updateChart();
    })
    .catch((err) => {
      // Show friendly error in the details panel if data fails to load.
      console.error("CSV load failed:", err?.message || err, err);
      d3.select("#detailView").html(
        `<p style="color:#b00">⚠️ Data failed to load.<br>
        <small>${
          (err && (err.message || err.status || err.toString())) || ""
        }</small>
       </p>`
      );
    });

  // Debounced resize: re-flow on window size changes.
  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer__);
    window.__resizeTimer__ = setTimeout(resizeChart, 200);
  });
  bindZoomButtons();
}

// ===== Simple “wait until condition” helpers =====
/** Polls until cond() is true or times out. */
function when(cond, timeout = 10000, every = 25) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (cond()) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - t0 > timeout) {
        clearInterval(id);
        reject(new Error("timeout"));
      }
    }, every);
  });
}

/** Resolves after DOMContentLoaded (or immediately if already ready). */
function whenDomReady() {
  return new Promise((res) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => res(), {
        once: true
      });
    } else res();
  });
}

// Kickoff sequence: wait for DOM + D3 to be available, then init.
whenDomReady()
  .then(() => when(() => window.d3 && d3.csv))
  .then(() => init())
  .catch((e) => console.error("Startup failed:", e));

// Enable manual tour start
document.getElementById("helpTourBtn")?.addEventListener("click", () => {
  // if the tour was already shown and closed, allow re-run:
  TOUR_STARTED = false;
  startTour();
});

// ===== UI wiring & filter dropdowns =====
function setupFilters() {
  // Title-case helper: preserves hyphens/apostrophes in words.
  const toTitleCase = (s) =>
    s.replace(
      /\b([\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*)\b/gu,
      (w) => w.charAt(0).toUpperCase() + w.slice(1)
    );

  // ---- TOPIC DROPDOWN ----
  const topics = Array.from(
    new Set(rawData.flatMap((d) => d.validTopics).filter(Boolean))
  ).sort();

  const topicDropdown = document.getElementById("topicDropdown");
  if (topicDropdown) {
    // Display Title Case labels, but keep a lookup to the lowercase values.
    const itemsForUI = topics.map((t) => toTitleCase(t));
    topicDropdown.__valueLookup = new Map(
      itemsForUI.map((label, i) => [label, topics[i]])
    );
    buildSelectableList(topicDropdown, itemsForUI);

    // Toggle panel visibility.
    document
      .getElementById("topicDropdownBtn")
      ?.addEventListener("click", () => topicDropdown.classList.toggle("show"));
  }

  // ---- SOURCE DROPDOWN ----
  const sources = Array.from(
    new Set(rawData.map((d) => d.displaySource).filter(Boolean))
  ).sort();

  const sourceDropdown = document.getElementById("sourceDropdown");
  if (sourceDropdown) {
    buildSelectableList(sourceDropdown, sources);
    document
      .getElementById("sourceDropdownBtn")
      ?.addEventListener("click", () =>
        sourceDropdown.classList.toggle("show")
      );
  }

  // ---- OTHER CONTROLS ----
  // - Key event only checkbox 
  document
    .getElementById("keyEventFilter")
    ?.addEventListener("change", updateChart);
  // - Live search
  document.getElementById("search")?.addEventListener("input", updateChart);
}

// ===== Core: recompute filteredData and redraw =====
function updateChart() {
  // Read selected topics; map visible labels back to lowercase values.
  const topicDropdown = document.getElementById("topicDropdown");
  let selectedTopics = getSelectedValues(topicDropdown);
  if (topicDropdown?.__valueLookup) {
    selectedTopics = selectedTopics.map(
      (label) => topicDropdown.__valueLookup.get(label) || label
    );
  }

  // Read selected sources (strings are already the display values).
  const sourceDropdown = document.getElementById("sourceDropdown");
  const selectedSources = getSelectedValues(sourceDropdown);

  // Read toggles and search term.
  const onlyKeyEvents = document.getElementById("keyEventFilter")?.checked;
  const searchTerm = (document.getElementById("search")?.value || "")
    .trim()
    .toLowerCase();

  // Legend categories in play (biological/chemical/multi).
  const categoryKeys = ["biological", "chemical", "multi"];
  const activeCats = categoryKeys.filter((k) => selectedCats.has(k));

  // Edge case: nothing selected in legend → show nothing and exit early.
  if (activeCats.length === 0 && !selectedCats.has("key")) {
    filteredData = [];
    keyEvents = [];
    drawChart([]);
    return;
  }

  // “Select all” detection for NA/blank handling in topics/sources.
  const totalTopics =
    topicDropdown?.querySelectorAll(".dropdown-option").length || 0;
  const totalSources =
    sourceDropdown?.querySelectorAll(".dropdown-option").length || 0;
  const isAllTopicsSelected =
    totalTopics > 0 && selectedTopics.length === totalTopics;
  const isAllSourcesSelected =
    totalSources > 0 && selectedSources.length === totalSources;

  // Main record filter pipeline.
  const data = rawData.filter((d) => {
    const isMulti = (d.categories?.length || 0) > 1;

    // 1) Category match (driven by legend toggles)
    let catMatch;
    if (activeCats.length === 0) catMatch = false;
    else if (isMulti) catMatch = activeCats.includes("multi");
    else catMatch = (d.categories || []).some((c) => activeCats.includes(c));

    // 2) Key event visibility (legend also controls whether key events are allowed)
    const keyOk = selectedCats.has("key") || !d.keyEvent;

    // 3) Topic match: treat “select all” as include everything (even NA-only)
    const eventTopics = d.validTopics || [];
    let topicMatch;
    if (selectedTopics.length === 0) topicMatch = false;
    else if (isAllTopicsSelected) topicMatch = true;
    else if (eventTopics.length === 0) topicMatch = false;
    else topicMatch = eventTopics.some((t) => selectedTopics.includes(t));

    // 4) Source match: treat “select all” as include everything (even blanks)
    let sourceMatch;
    if (selectedSources.length === 0) sourceMatch = false;
    // none selected → hide all
    else if (isAllSourcesSelected) sourceMatch = true;
    // select all → include blank/NA
    else if (!d.displaySource) sourceMatch = false;
    // blank → exclude unless select all
    else sourceMatch = selectedSources.includes(d.displaySource);

    // 5) Key-event-only filter
    const keyMatch = !onlyKeyEvents || d.keyEvent;

    // 6) Free-text search across event/notes
    const searchMatch =
      !searchTerm ||
      (d.event && d.event.toLowerCase().includes(searchTerm)) ||
      (d.notes && d.notes.toLowerCase().includes(searchTerm));

    // Overall boolean
    return (
      catMatch && keyOk && topicMatch && sourceMatch && keyMatch && searchMatch
    );
  });

  // Save filtered arrays and render.
  filteredData = data;
  keyEvents = data.filter((d) => d.keyEvent);
  drawChart(data);
}

// ===== Drawing (scales, dots, axis, interactions, annotations, legend) =====
function drawChart(data) {
  // Clear only dynamic layers (keep legend if any).
  svg.selectAll(".annotations").remove();
  svg.selectAll(".dots").remove();

  // If no data left to draw, keep axis/legend as-is and exit.
  if (!data.length) return;

  // --- 1) Time scale and x-axis (reuse group if exists) ---
  const x = d3
    .scaleTime()
    .domain(d3.extent(data, (d) => d.date))
    .range([40, width - 40]);

  let xAxisG = svg.select(".x-axis");
  currentXScale = x; // store for button zoom controls
  if (xAxisG.empty()) {
    xAxisG = svg
      .append("g")
      .attr("class", "x-axis")
      .attr("transform", `translate(0,${AXIS_Y})`);
  }
  xAxisG.call(d3.axisBottom(x).ticks(6));

  // --- 2) Force simulation for dot packing along the timeline ---
  // We simulate to avoid overlap; x-force pulls to time, y-force to center band.
  const simulation = d3
    .forceSimulation(data)
    .force("x", d3.forceX((d) => x(d.date)).strength(1))
    .force("y", d3.forceY(DOT_CENTER_Y))
    .force("collide", d3.forceCollide(radius + 1))
    .stop();

  // Manual ticks for deterministic, synchronous layout.
  for (let i = 0; i < 150; i++) simulation.tick();

  // Track whether a dot was previously clicked (affects opacity).
  data.forEach((d) => {
    if (d.viewed === undefined) d.viewed = false;
  });

  // --- 3) Singleton tooltip (create once if missing) ---
  let tooltip = d3.select("body").select(".tooltip");
  if (tooltip.empty()) {
    tooltip = d3
      .select("body")
      .append("div")
      .attr("class", "tooltip")
      .style("opacity", 0);
  }

  // --- 4) Dots layer (circles bound to data) ---
  const dotsGroup = svg.append("g").attr("class", "dots");

  dotsGroup
    .selectAll("circle")
    .data(data)
    .join("circle")
    .classed("dot", true)
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", radius)
    .attr("fill", (d) => color(d))
    .attr("opacity", (d) => (d.viewed ? 0.4 : 0.8))
    .attr("stroke", (d) => (d.keyEvent ? "red" : "none"))
    .attr("stroke-width", (d) => (d.keyEvent ? 2 : 0))
    // Hover/touch tooltip preview
    .on("mouseenter touchstart", (event, d) => {
      const noteText =
        d.notes.length > 200 ? d.notes.slice(0, 200) + "…" : d.notes;
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
    // Click → highlight + populate details panel
    .on("click", (event, d) => {
      if (lastClicked && lastClicked !== d) lastClicked.viewed = true;
      lastClicked = d;

      // Reset all dots then emphasize current selection.
      dotsGroup
        .selectAll("circle")
        .attr("opacity", (c) => (c === lastClicked ? 1 : c.viewed ? 0.4 : 0.8))
        .attr("stroke", (c) => (c.keyEvent ? "red" : "none"))
        .attr("stroke-width", (c) => (c.keyEvent ? 2 : 0))
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

      d3.select("#detailView").html(`
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

  // --- 5) Mouse-wheel zoom (disabled on touch devices) ---
  const IS_TOUCH = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  if (!IS_TOUCH) {
    svg.on("wheel", (event) => {
      event.preventDefault();

      // Zoom around the pointer’s date.
      const mouseX = d3.pointer(event)[0];
      const mouseDate = x.invert(mouseX);
      const factor = event.deltaY > 0 ? 1.1 : 0.9; // wheel-down zooms out

      const domain = x.domain();
      const dataExtent = d3.extent(filteredData, (d) => d.date);
      const maxSpan = dataExtent[1] - dataExtent[0];
      const newSpan = (domain[1] - domain[0]) / factor;
      const centerTime = +mouseDate;

      let newStart = new Date(centerTime - newSpan / 2);
      let newEnd = new Date(centerTime + newSpan / 2);

      // Clamp to data extent.
      if (newStart < dataExtent[0]) {
        newStart = dataExtent[0];
        newEnd = new Date(+newStart + newSpan);
      }
      if (newEnd > dataExtent[1]) {
        newEnd = dataExtent[1];
        newStart = new Date(+newEnd - newSpan);
      }
      if (newEnd - newStart > maxSpan) {
        newStart = dataExtent[0];
        newEnd = dataExtent[1];
      }

      // Minimum zoom window: 1 day
      const minZoomSpan = 1000 * 60 * 60 * 24;
      if (newEnd - newStart < minZoomSpan) return;

      // Apply new domain & refresh axis.
      x.domain([newStart, newEnd]);
      xAxisG.call(d3.axisBottom(x).ticks(6));

      // Re-run simulation so dots re-pack to the new x positions.
      simulation
        .force("x", d3.forceX((d) => x(d.date)).strength(1))
        .alpha(0.3)
        .restart();
      for (let i = 0; i < 150; i++) simulation.tick();

      // Move circles.
      dotsGroup
        .selectAll("circle")
        .attr("cx", (d) => d.x)
        .attr("cy", (d) => d.y);

      // Recompute annotation connectors/boxes
      drawAnnotations(x, data);
    });
  } else {
    // Ensure wheel handler is removed for touch devices.
    svg.on("wheel", null);
  }

  // --- 6) Draw annotations linked to keyEvents subset ---
  drawAnnotations(x, data);

  // --- 7) Draw (or refresh) legend ---
  drawLegend();
}

/** Zoom helper used by +/− buttons; recenters around domain midpoint by default. */

function zoomBy(factor, anchorDate) {
  if (!currentXScale || !filteredData.length) return;

  const x = currentXScale;

  // Current domain and center
  const [d0, d1] = x.domain();
  const center = anchorDate ? +anchorDate : (+d0 + +d1) / 2;

  // Proposed new span
  const span = (d1 - d0) / factor;
  let newStart = new Date(center - span / 2);
  let newEnd = new Date(center + span / 2);

  // Clamp to data extent (just like wheel handler)
  const dataExtent = d3.extent(filteredData, (d) => d.date);
  const maxSpan = dataExtent[1] - dataExtent[0];
  const minZoomSpan = 1000 * 60 * 60 * 24; // 1 day

  // Don’t allow zoom beyond entire dataset (if user tries to zoom out too far)
  if (+newEnd - +newStart > maxSpan) {
    newStart = dataExtent[0];
    newEnd = dataExtent[1];
  }

  // Keep the window inside the data bounds
  if (newStart < dataExtent[0]) {
    newStart = dataExtent[0];
    newEnd = new Date(+newStart + span);
  }
  if (newEnd > dataExtent[1]) {
    newEnd = dataExtent[1];
    newStart = new Date(+newEnd - span);
  }

  // Enforce minimum zoom window
  if (+newEnd - +newStart < minZoomSpan) {
    return; // ignore if it would zoom in too far
  }

  // Apply & re-render
  x.domain([newStart, newEnd]);
  svg.select(".x-axis").call(d3.axisBottom(x).ticks(6));

  // Recompute simulation for new x-positions
  const sim = d3
    .forceSimulation(filteredData)
    .force("x", d3.forceX((d) => x(d.date)).strength(1))
    .force("y", d3.forceY(DOT_CENTER_Y))
    .force("collide", d3.forceCollide(radius + 1))
    .stop();

  for (let i = 0; i < 150; i++) sim.tick();

  svg
    .select(".dots")
    .selectAll("circle")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y);

  drawAnnotations(x, filteredData);
}

// ===== Annotations (labels + connectors for key events) =====
function drawAnnotations(x, data) {
  // Remove previous layers to fully rebuild.
  svg.selectAll(".annotations").remove();

  // Two groups: lines (connectors) and boxes (labels).
  const annotationGroup = svg.append("g").attr("class", "annotations");
  const linesGroup = annotationGroup
    .append("g")
    .attr("class", "annotation-lines");
  const boxesGroup = annotationGroup
    .append("g")
    .attr("class", "annotation-boxes");

  const labelPadding = 4;
  const placedLabels = []; // used to stack labels into non-overlapping rows

  // Iterate in time order so stacking looks predictable.
  keyEvents
    .sort((a, b) => a.date - b.date)
    .forEach((d) => {
      if (!d.date || isNaN(x(d.date))) return;

      const xPos = x(d.date);

      // Trim label to a sane length; rough measurement for stacking.
      const labelText =
        d.event.length > 50 ? d.event.slice(0, 50) + "…" : d.event;
      const labelWidth = labelText.length * 7;
      const labelX1 = xPos - labelWidth / 2;
      const labelX2 = xPos + labelWidth / 2;

      // Find a row (level) without horizontal overlap.
      let level = 0;
      while (
        placedLabels.some(
          (l) => !(labelX2 < l.x1 || labelX1 > l.x2 || level !== l.level)
        )
      )
        level++;

      // Reserve this label’s horizontal span in that row.
      placedLabels.push({
        x1: labelX1 - labelPadding,
        x2: labelX2 + labelPadding,
        level
      });

      const yBase = ANNO_Y0 + level * LAYOUT.annoRow;

      // Find the dot’s y for the connector start (or fall back to band center).
      const match = data.find(
        (item) =>
          item.date.getTime() === d.date.getTime() && item.event === d.event
      );
      const yStart = match?.y ?? DOT_CENTER_Y;

      // Connector line (hidden by default, highlighted on click).
      const line = linesGroup
        .append("line")
        .attr("x1", xPos)
        .attr("y1", yStart)
        .attr("x2", xPos)
        .attr("y2", yBase - 10)
        .attr("stroke", "#888")
        .attr("stroke-dasharray", "2,2")
        .attr("stroke-width", 1)
        .style("opacity", 0)
        .classed("annotation-line", true);

      // Label group (rect + text) with direction-aware anchoring.
      const labelGroup = boxesGroup
        .append("g")
        .attr("transform", `translate(${xPos},${yBase})`)
        .style("cursor", "pointer");

      let anchor;
      if (xPos < width * 0.33) anchor = "start";
      else if (xPos > width * 0.66) anchor = "end";
      else anchor = "middle";

      const text = labelGroup
        .append("text")
        .attr("x", 0)
        .attr("y", 0)
        .attr("dy", "0.35em")
        .attr("text-anchor", anchor)
        .attr("class", "key-event-label")
        .text(labelText);

      // Measure to place a background rect with padding.
      const bbox = text.node().getBBox();
      const rectX =
        anchor === "start"
          ? bbox.x - 4
          : anchor === "middle"
          ? -bbox.width / 2 - 4
          : -bbox.width - 4;

      const rect = labelGroup
        .insert("rect", "text")
        .attr("x", rectX)
        .attr("y", bbox.y - 2)
        .attr("width", bbox.width + 8)
        .attr("height", bbox.height + 4)
        .attr("rx", 4)
        .attr("ry", 4)
        .attr("fill", "#f2f2f2")
        .attr("stroke", "#aaa")
        .classed("annotation-box", true);

      // Clicking a label: highlight connector + box + the matching dot, and fill details panel.
      labelGroup.on("click", () => {
        // Reset styles for other annotations, then emphasize this one.
        svg
          .selectAll(".annotation-line")
          .attr("stroke", "#888")
          .attr("stroke-width", 1);
        line.attr("stroke", "#555").attr("stroke-width", 3);

        svg
          .selectAll(".annotation-box")
          .attr("fill", "#f2f2f2")
          .attr("stroke", "#aaa");
        rect.attr("fill", "#e0f7fa").attr("stroke", "#00796b");

        // Select corresponding dot (if any) and emphasize it.
        if (match) {
          if (lastClicked && lastClicked !== match) lastClicked.viewed = true;
          lastClicked = match;

          const circles = svg
            .selectAll("circle.dot")
            .attr("opacity", (c) =>
              c === lastClicked ? 1 : c.viewed ? 0.4 : 0.8
            )
            .attr("stroke", (c) => (c.keyEvent ? "red" : "none"))
            .attr("stroke-width", (c) => (c.keyEvent ? 2 : 0))
            .attr("stroke-dasharray", null);

          circles
            .filter((c) => c === match)
            .attr("stroke", "black")
            .attr("stroke-width", 3)
            .attr("stroke-dasharray", "4,2")
            .attr("opacity", 1);
        }

        // Update the side panel with full details.
        const dateHtml = d.displayDate ? d.displayDate : formatDate(d.date);
        const docLink = d.sourceUrl
          ? `<a href="${d.sourceUrl}" target="_blank" rel="noopener">Documentation</a>`
          : "—";

        d3.select("#detailView").html(`
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

  // Hide connector lines by default (become visible on click).
  svg.selectAll(".annotation-line").style("opacity", 0);
}

// ===== Legend (category toggles + key events) =====
function drawLegend() {
  // Rebuild legend each draw (cheap; also avoids stale handlers).
  svg.selectAll(".legend").remove();

  const legendItems = [
    {
      key: "biological",
      label: "Biological",
      color: categoryColors.biological,
      type: "dot"
    },
    {
      key: "chemical",
      label: "Chemical",
      color: categoryColors.chemical,
      type: "dot"
    },
    {
      key: "multi",
      label: "Both categories",
      color: categoryColors.multi,
      type: "dot"
    },
    { key: "key", label: "Key event", color: null, type: "ring" }
  ];

  const g = svg
    .append("g")
    .attr("class", "legend")
    .attr("transform", `translate(${LEGEND.x},${LEGEND.y})`);

  // One row per legend item; clicking toggles membership in selectedCats.
  const rows = g
    .selectAll(".legend-row")
    .data(legendItems, (d) => d.key)
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

  // Marker glyph (filled dot or ring).
  rows.each(function (d) {
    const row = d3.select(this);
    if (d.type === "dot") {
      row
        .append("circle")
        .attr("class", "legend-dot")
        .attr("cx", LEGEND.dotR)
        .attr("cy", LEGEND.dotR)
        .attr("r", LEGEND.dotR)
        .attr("fill", d.color)
        .attr("stroke", "#999");
    } else {
      row
        .append("circle")
        .attr("class", "legend-ring")
        .attr("cx", LEGEND.dotR)
        .attr("cy", LEGEND.dotR)
        .attr("r", LEGEND.dotR)
        .attr("fill", "#ddd")
        .attr("stroke", "red")
        .attr("stroke-width", 2);
    }
  });

  // Labels
  rows
    .append("text")
    .attr("x", LEGEND.dotR * 2 + 8)
    .attr("y", LEGEND.dotR + 4)
    .attr("font-size", 12)
    .attr("fill", "#333")
    .text((d) => d.label);

  // Style rows based on on/off state.
  function updateLegendStyles() {
    rows.classed("off", (d) => !selectedCats.has(d.key));
    rows
      .selectAll("circle")
      .attr("opacity", (d) => (selectedCats.has(d.key) ? 1 : 0.3));
    rows
      .selectAll("text")
      .attr("fill", (d) => (selectedCats.has(d.key) ? "#333" : "#999"));
  }

  updateLegendStyles();
}

// ===== Resize handler (responsive viewBox + redraw) =====
function resizeChart() {
  const container = document.getElementById("container");
  if (!container || !svg) return;
  width = Math.max(320, (container.clientWidth || 0) - 40);
  svg.attr("viewBox", `0 0 ${width} ${TOTAL_H}`);
  updateChart(); // recompute scale and layout with new width
}

// =========================
// Guided Tour
// =========================

// Track whether we've already shown the tour in this session.
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

/** Ordered steps shown by the tour (targets may be dynamic). */
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

// === AUDIT ===

function auditZoomClipping() {
  if (!currentXScale) {
    console.warn("No x scale yet.");
    return;
  }
  const [d0, d1] = currentXScale.domain();

  const outside = filteredData.filter((d) => d.date < d0 || d.date > d1);
  const inside = filteredData.length - outside.length;

  console.table({
    totalFiltered: filteredData.length,
    visibleInDomain: inside,
    clippedByZoom: outside.length
  });

  return outside; // array of records currently off-screen by date
}
