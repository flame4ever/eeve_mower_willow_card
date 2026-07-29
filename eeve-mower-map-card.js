/**
 * EEVE Mower Map Card — the mower's zone map on a satellite background,
 * like the StarLight map in the EEVE web interface.
 *
 * It draws the mower's zones (GeoJSON, exposed by the EEVE Mower Willow
 * integration as the "Zone Map" sensor) on an Esri World Imagery satellite
 * layer and shows the live mower position with heading.
 *
 * Minimal config:
 *   type: custom:eeve-mower-map-card
 *
 * Options:
 *   type: custom:eeve-mower-map-card
 *   title: Karte             # header (optional; omit for no header)
 *   device: <device_id>      # optional; auto-detected
 *   height: 420              # px (default 420)
 */

const PLATFORM = "eeve_mower_willow";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";

// Selectable satellite/aerial tile sources. maxNativeZoom = the highest zoom
// with real tiles; beyond that Leaflet upscales (blurrier but still usable).
const TILE_PRESETS = {
  esri: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxNativeZoom: 20,
  },
  esri_clarity: {
    url: "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxNativeZoom: 20,
  },
};

// Zone types the user can draw, with default colour. The zone's id is
// "<TYPE>_<uuid>", matching the mower's own naming.
const ZONE_TYPES = [
  { type: "GRASSZONE", label: "Grass-Zone", color: "#00FF20", icon: "🌱" },
  { type: "MOWBORDER", label: "Mähgrenze", color: "#2979FF", icon: "⬡" },
  { type: "INNER", label: "Sperrzone", color: "#FF3030", icon: "✋" },
  { type: "STEPSTONES", label: "Trittsteine", color: "#00BCD4", icon: "≈" },
  { type: "NARROWPASSAGE", label: "Engstelle", color: "#FFC400", icon: "〰" },
];

const GEOMAN_JS = "https://unpkg.com/@geoman-io/leaflet-geoman-free@2.17.0/dist/leaflet-geoman.min.js";
const GEOMAN_CSS = "https://unpkg.com/@geoman-io/leaflet-geoman-free@2.17.0/dist/leaflet-geoman.css";

let _geomanPromise = null;
function loadGeoman(L) {
  if (L && L.PM) return Promise.resolve();
  if (_geomanPromise) return _geomanPromise;
  _geomanPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GEOMAN_JS;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Leaflet-Geoman"));
    document.head.appendChild(s);
  });
  return _geomanPromise;
}

let _leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error("Failed to load Leaflet"));
    document.head.appendChild(s);
  });
  return _leafletPromise;
}

class EeveMowerMapCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign(
      { title: null, device: null, entity: null, height: 420, tile: "esri", editable: false },
      config || {}
    );
    this._built = false;
    this.innerHTML = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass) return;
    if (!this._built) this._build();
    else this._updateMower();
  }

  getCardSize() { return 8; }
  static getStubConfig() { return {}; }

  /* --- entity discovery (language-independent, via translation_key) ----- */
  async _resolve() {
    let reg = [];
    try { reg = await this._hass.callWS({ type: "config/entity_registry/list" }); }
    catch (e) { reg = []; }
    let deviceId = this._config.device;
    if (!deviceId && this._config.entity) {
      const e = reg.find((r) => r.entity_id === this._config.entity);
      if (e) deviceId = e.device_id;
    }
    if (!deviceId) {
      const counts = {};
      for (const r of reg)
        if (r.platform === PLATFORM && r.device_id)
          counts[r.device_id] = (counts[r.device_id] || 0) + 1;
      deviceId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    }
    const ents = reg.filter((r) => r.device_id === deviceId && !r.disabled_by);
    const byKey = {};
    for (const r of ents)
      if (r.translation_key && !(r.translation_key in byKey)) byKey[r.translation_key] = r.entity_id;
    this._zoneEntity = byKey["zone_map"];
    // Zone id -> human name map (from the "Zones" sensor's `zones` attribute).
    const namesEnt = byKey["zones_count"];
    const ns = namesEnt && this._hass.states[namesEnt];
    this._zoneNames = (ns && ns.attributes && ns.attributes.zones) || {};
    this._posEntity = byKey["slam_odometry"] || byKey["gps"] ||
      // fallback: any sensor on the device carrying latitude/longitude
      (ents.find((r) => {
        const s = this._hass.states[r.entity_id];
        return s && s.attributes && s.attributes.latitude != null;
      }) || {}).entity_id;
  }

  _getPos() {
    const s = this._posEntity && this._hass.states[this._posEntity];
    if (!s) return null;
    let lat = s.attributes.latitude, lng = s.attributes.longitude;
    if (lat == null && typeof s.state === "string" && s.state.includes(",")) {
      const p = s.state.split(",").map((x) => parseFloat(x.trim()));
      if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) { lat = p[0]; lng = p[1]; }
    }
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return null;
    // yaw is in radians (SLAM); convert to a compass-ish heading in degrees.
    const yaw = s.attributes.yaw;
    const heading = typeof yaw === "number" ? (-yaw * 180) / Math.PI : null;
    return { lat, lng, heading };
  }

  _zoneStyle(feature) {
    const p = feature.properties || {};
    const color = p.color || "#3388ff";
    const zt = p.zoneType || "";
    let fillOpacity = 0.05, weight = 2, dashArray = null;
    if (zt === "GRASSZONE") fillOpacity = 0.2;
    else if (zt === "MOWBORDER") { fillOpacity = 0; weight = 3; }
    else if (zt === "INNER" || zt === "KEEPOUT") fillOpacity = 0.35;
    else { weight = 2; dashArray = "4,4"; }
    return { color, weight, opacity: 1, fillColor: color, fillOpacity, dashArray };
  }

  _labelZone(feature, layer) {
    const name =
      (this._zoneNames && this._zoneNames[feature && feature.id]) ||
      (feature && feature.properties && feature.properties.customName);
    if (name && layer.bindTooltip) {
      layer.bindTooltip(name, {
        permanent: true, direction: "center", className: "eeve-zone-label", opacity: 1,
      });
    }
  }

  async _build() {
    this._built = true;
    await this._resolve();

    const card = document.createElement("ha-card");
    if (this._config.title) card.header = this._config.title;
    // Leaflet's stylesheet must live in THIS card's (shadow) scope — a <link>
    // in document.head does not apply inside Home Assistant's shadow DOM, which
    // would leave the map tiles unpositioned (position:static) and invisible.
    for (const href of [LEAFLET_CSS, GEOMAN_CSS]) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      card.appendChild(l);
    }
    // Home Assistant applies mix-blend-mode: plus-lighter to Leaflet tiles
    // (for its own dark-map styling), which washes the satellite imagery out to
    // near-white. Force normal blending for our tiles.
    const styleFix = document.createElement("style");
    styleFix.textContent =
      ".leaflet-tile{mix-blend-mode:normal !important;filter:none !important;}" +
      ".leaflet-tile-loaded{opacity:1 !important;}" +
      ".eeve-zone-label{background:transparent !important;border:none !important;" +
      "box-shadow:none !important;color:#fff;font-weight:700;font-size:12px;" +
      "text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;}" +
      ".eeve-zone-label:before{display:none !important;}";
    card.appendChild(styleFix);
    const mapDiv = document.createElement("div");
    mapDiv.style.cssText =
      `width:100%;height:${this._config.height}px;border-radius:0 0 var(--ha-card-border-radius,12px) var(--ha-card-border-radius,12px);overflow:hidden;`;
    card.appendChild(mapDiv);
    this.innerHTML = "";
    this.appendChild(card);

    if (!this._zoneEntity) {
      mapDiv.innerHTML =
        '<div style="padding:16px;color:var(--error-color)">No EEVE Mower "Zone Map" sensor found. ' +
        'Make sure the integration is v0.4.2+ and the sensor is enabled.</div>';
      return;
    }

    let L;
    try { L = await loadLeaflet(); }
    catch (e) {
      mapDiv.innerHTML = '<div style="padding:16px;color:var(--error-color)">Could not load the map library.</div>';
      return;
    }
    // Geoman must be loaded BEFORE the map is created — it attaches map.pm via a
    // map init hook, so a map built earlier would not have editing support.
    if (this._config.editable) { try { await loadGeoman(L); } catch (e) {} }

    const map = L.map(mapDiv, {
      attributionControl: false, zoomControl: true,
      maxZoom: 24, zoomSnap: 0.5, wheelPxPerZoomLevel: 80,
      fadeAnimation: false, // avoid tiles getting stuck mid fade-in (opacity ~0)
    });
    this._map = map; this._L = L;
    // Chosen tile source; zoom past its native level upscales (blurrier).
    const preset = TILE_PRESETS[this._config.tile] || TILE_PRESETS.esri;
    L.tileLayer(preset.url, {
      maxZoom: 24,
      maxNativeZoom: preset.maxNativeZoom,
      subdomains: preset.subdomains || "abc",
    }).addTo(map);

    // Zones
    const s = this._hass.states[this._zoneEntity];
    const gj = s && s.attributes && s.attributes.geojson;
    this._gjOriginal = gj || { type: "FeatureCollection", features: [] };
    this._drawZones(gj);

    this._updateMower();
    if (this._config.editable) this._addEditControl();

    // Robust initial fit. The card's width only settles after layout, so a
    // fit computed too early frames the zones for a smaller viewport and ends
    // up zoomed too far out. Re-fit whenever the container size changes until
    // it is stable, then stop so we don't fight the user's manual zoom/pan.
    this._initialFitDone = false;
    let lastW = 0, lastH = 0, stable = 0;
    const tryFit = () => {
      if (this._initialFitDone) return;
      const w = mapDiv.clientWidth, h = mapDiv.clientHeight;
      if (w < 50 || h < 50) return;
      map.invalidateSize();
      this._fitZones();
      if (w === lastW && h === lastH) stable++; else stable = 0;
      lastW = w; lastH = h;
      if (stable >= 2) this._finishInitialFit();
    };
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => tryFit());
      this._ro.observe(mapDiv);
    }
    setTimeout(tryFit, 100);
    setTimeout(tryFit, 400);
    setTimeout(tryFit, 800);
    // Safety: stop observing after 2.5s no matter what.
    setTimeout(() => this._finishInitialFit(), 2500);
  }

  _finishInitialFit() {
    this._initialFitDone = true;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  _drawZones(gj) {
    const L = this._L, map = this._map;
    if (this._zoneLayer) { map.removeLayer(this._zoneLayer); this._zoneLayer = null; }
    if (gj && gj.features && gj.features.length) {
      this._zoneLayer = L.geoJSON(gj, {
        style: (f) => this._zoneStyle(f),
        onEachFeature: (f, layer) => this._labelZone(f, layer),
      }).addTo(map);
      // Group sub-layers by zone type for the layer toggle panel.
      this._byType = {};
      this._zoneLayer.eachLayer((ly) => {
        const t = (ly.feature && ly.feature.properties && ly.feature.properties.zoneType) || "OTHER";
        (this._byType[t] = this._byType[t] || []).push(ly);
      });
      // Only auto-frame on the very first draw; the initial-fit observer and
      // "show all" handle framing. Later data reloads keep the user's view.
      if (!this._initialFitDone) this._fitZones();
    } else if (!this._zoneLayer) {
      this._zoneLayer = L.geoJSON({ type: "FeatureCollection", features: [] }).addTo(map);
      map.setView([50.8337, 10.9324], 18);
    }
  }

  /* Frame the map so all zones (or a given layer) fit with a margin.
     Called after size is final and whenever we return to the full view. */
  _fitZones(layer) {
    const map = this._map;
    if (!map) return;
    const target = layer || this._zoneLayer;
    if (!target || !target.getBounds) return;
    try {
      const b = target.getBounds();
      if (b && b.isValid && b.isValid()) {
        // maxZoom 22 lets the fit reach the natural framing zoom (often 21);
        // capping at 20 (Esri native) previously left the zones too small.
        // Tiles beyond z20 upscale slightly but stay perfectly usable.
        map.fitBounds(b, { padding: [24, 24], maxZoom: 22 });
      }
    } catch (e) { /* no valid bounds yet */ }
  }

  /* --- editing ----------------------------------------------------- */
  _addEditControl() {
    const L = this._L;
    const self = this;
    const Ctl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const div = L.DomUtil.create("div", "leaflet-bar");
        const btn = L.DomUtil.create("a", "", div);
        btn.href = "#"; btn.title = "Zonen bearbeiten"; btn.innerHTML = "✏️";
        btn.style.cssText = "font-size:16px;text-align:center;line-height:26px;";
        L.DomEvent.on(btn, "click", (e) => { L.DomEvent.stop(e); self._enterEdit(); });
        return div;
      },
    });
    this._editControl = new Ctl();
    this._map.addControl(this._editControl);
  }

  async _enterEdit() {
    const L = this._L, map = this._map;
    if (!map.pm) { try { await loadGeoman(L); } catch (e) {} }
    if (!map.pm) { alert("Editor nicht verfügbar (Geoman konnte nicht geladen werden)."); return; }
    if (this._editControl) { map.removeControl(this._editControl); this._editControl = null; }
    // Geoman toolbar: draw new zones, edit vertices, drag, remove.
    map.pm.addControls({
      position: "topright",
      drawPolygon: false, editMode: true, dragMode: true, removalMode: true,
      rotateMode: true,
      drawMarker: false, drawPolyline: false, drawCircle: false,
      drawRectangle: false, drawCircleMarker: false, drawText: false,
      cutPolygon: false, oneBlock: true,
    });
    map.pm.setLang("de");
    this._editing = true;
    this._focused = null;
    this._cycleKey = null;
    this._cycleIdx = 0;
    this._zoneLayer.eachLayer((ly) => { if (ly.pm) ly.pm.enable({ allowSelfIntersection: false }); });
    // Focus/cycle: a map click finds every zone under the point and steps
    // through the overlapping stack on repeated clicks (top → below → wrap).
    this._cycleHandler = (e) => this._onMapClickCycle(e);
    map.on("click", this._cycleHandler);
    // New polygons -> attach default GRASSZONE properties and fold into the layer.
    map.on("pm:create", (e) => {
      const layer = e.layer;
      const type = this._newZoneType || "GRASSZONE";
      const def = ZONE_TYPES.find((z) => z.type === type) || ZONE_TYPES[0];
      const id = type + "_" + this._uuid();
      layer.feature = { type: "Feature", id, properties: {
        color: def.color, zoneType: type, enabled: true, fill: type === "INNER",
        layerType: "zone", level: "", description: "Created via Home Assistant",
      } };
      layer.setStyle(this._zoneStyle(layer.feature));
      this._zoneLayer.addLayer(layer);
      (this._byType[type] = this._byType[type] || []).push(layer);
      if (layer.pm) layer.pm.enable({ allowSelfIntersection: false });
    });
    // Right-click:
    //  - while drawing a zone -> remove the last placed vertex
    //  - otherwise (a zone is focused) -> show all zones again ("Alle einblenden")
    this._ctxHandler = (e) => {
      const poly = this._map.pm.Draw && this._map.pm.Draw.Polygon;
      if (poly && poly.enabled && poly.enabled()) {
        if (e.originalEvent) e.originalEvent.preventDefault();
        try { poly._removeLastVertex(); } catch (err) {}
        return;
      }
      if (this._focused) {
        if (e.originalEvent) e.originalEvent.preventDefault();
        this._unfocusZones();
      }
    };
    map.on("contextmenu", this._ctxHandler);
    // Escape cancels the current drawing.
    this._keyHandler = (ev) => {
      if (ev.key !== "Escape") return;
      const poly = this._map.pm.Draw && this._map.pm.Draw.Polygon;
      if (poly && poly.enabled && poly.enabled()) { try { poly.disable(); } catch (e) {} }
    };
    document.addEventListener("keydown", this._keyHandler);
    this._showEditBar();
  }

  _exitEdit(reload) {
    const map = this._map;
    this._editing = false;
    this._focused = null;
    try { if (map.pm.Draw && map.pm.Draw.Polygon) map.pm.Draw.Polygon.disable(); } catch (e) {}
    try { map.pm.removeControls(); } catch (e) {}
    try { map.off("pm:create"); } catch (e) {}
    if (this._ctxHandler) { try { map.off("contextmenu", this._ctxHandler); } catch (e) {} this._ctxHandler = null; }
    if (this._cycleHandler) { try { map.off("click", this._cycleHandler); } catch (e) {} this._cycleHandler = null; }
    if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler); this._keyHandler = null; }
    try { this._zoneLayer.eachLayer((ly) => { if (ly.pm) ly.pm.disable(); }); } catch (e) {}
    if (this._editBar) { this._editBar.remove(); this._editBar = null; }
    if (reload) this._drawZones(this._hass.states[this._zoneEntity]?.attributes?.geojson);
    if (this._config.editable) this._addEditControl();
  }

  _showEditBar() {
    const bar = document.createElement("div");
    bar.style.cssText =
      "position:absolute;left:8px;bottom:8px;z-index:1000;display:flex;gap:8px;";
    const mk = (label, bg, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        `padding:8px 14px;border:none;border-radius:6px;color:#fff;font-weight:600;` +
        `cursor:pointer;background:${bg};box-shadow:0 1px 4px rgba(0,0,0,.4);`;
      b.addEventListener("click", fn);
      return b;
    };
    // Zone type palette (like the EEVE app): click a type, then draw it.
    const palette = document.createElement("div");
    palette.style.cssText =
      "display:flex;gap:4px;background:#fff;padding:4px;border-radius:8px;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.4);";
    const paletteBtns = [];
    for (const zt of ZONE_TYPES) {
      const b = document.createElement("button");
      b.title = "Neue " + zt.label + " zeichnen";
      b.style.cssText =
        "width:34px;height:34px;border:2px solid #ccc;border-radius:6px;background:#fff;" +
        "cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;";
      // Colour swatch identifies the type (mirrors the app's coloured palette).
      const chip = document.createElement("span");
      chip.style.cssText =
        `display:block;width:18px;height:18px;border-radius:4px;background:${zt.color};` +
        "border:1px solid rgba(0,0,0,.3);";
      b.appendChild(chip);
      b.addEventListener("click", () => {
        this._newZoneType = zt.type;
        paletteBtns.forEach((x) => (x.style.borderColor = "#ccc"));
        b.style.borderColor = zt.color;
        try { this._map.pm.enableDraw("Polygon", { snappable: true, allowSelfIntersection: false }); }
        catch (e) {}
      });
      paletteBtns.push(b);
      palette.appendChild(b);
    }
    this._newZoneType = ZONE_TYPES[0].type;
    bar.appendChild(palette);
    // Focus actions — only shown while a single zone is isolated for editing.
    const focusBar = document.createElement("div");
    focusBar.style.cssText = "display:none;gap:8px;align-items:center;";
    const info = document.createElement("span");
    info.style.cssText =
      "background:rgba(0,0,0,.7);color:#fff;padding:6px 10px;border-radius:6px;" +
      "font-size:12px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4);";
    this._focusInfo = info;
    focusBar.appendChild(info);
    focusBar.appendChild(mk("⧉ Klonen", "#1565c0", () => this._cloneZone()));
    focusBar.appendChild(mk("⊕ Alle einblenden", "#455a64", () => this._unfocusZones()));
    this._focusBar = focusBar;
    bar.appendChild(focusBar);
    bar.appendChild(mk("💾 Speichern", "#2e7d32", () => this._saveZones()));
    bar.appendChild(mk("✖ Abbrechen", "#c62828", () => this._exitEdit(true)));
    // The bar lives inside the map container; without this a click on a
    // palette/save/cancel button would also register as a map click and drop a
    // vertex while drawing.
    this._L.DomEvent.disableClickPropagation(bar);
    this._L.DomEvent.disableScrollPropagation(bar);
    this._map.getContainer().appendChild(bar);
    this._editBar = bar;
  }

  /* --- focus a single zone (isolate) / clone --------------------- */

  // Ray-casting point-in-polygon on a lat/lng ring.
  _pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
      if (((yi > lat) !== (yj > lat)) &&
          (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  _pointInLayer(latlng, layer) {
    if (!layer.getLatLngs) return false;
    let rings = layer.getLatLngs();
    if (rings.length && Array.isArray(rings[0]) === false) rings = [rings];
    // multipolygon -> array of polygons; polygon -> array of rings
    const polys = Array.isArray(rings[0]) && Array.isArray(rings[0][0]) ? rings : [rings];
    return polys.some((poly) => this._pointInRing(latlng.lat, latlng.lng, poly[0]));
  }
  _areaOf(layer) {
    try {
      const r = (layer.getLatLngs()[0] || []);
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++)
        a += (r[j].lng + r[i].lng) * (r[j].lat - r[i].lat);
      return Math.abs(a / 2);
    } catch (e) { return 0; }
  }
  _zonesAt(latlng) {
    const hits = [];
    this._zoneLayer.eachLayer((ly) => { if (this._pointInLayer(latlng, ly)) hits.push(ly); });
    // Smallest area first so tiny stacked zones are reachable at the top.
    hits.sort((a, b) => this._areaOf(a) - this._areaOf(b));
    return hits;
  }
  _onMapClickCycle(e) {
    if (!this._editing) return;
    const p = this._map.pm.Draw && this._map.pm.Draw.Polygon;
    if (p && p.enabled && p.enabled()) return; // busy drawing
    const hits = this._zonesAt(e.latlng);
    if (!hits.length) return; // clicked empty space — keep current focus
    const key = hits.map((l) => this._L.Util.stamp(l)).join(",");
    if (key === this._cycleKey) this._cycleIdx = (this._cycleIdx + 1) % hits.length;
    else { this._cycleKey = key; this._cycleIdx = 0; }
    this._focusZone(hits[this._cycleIdx], this._cycleIdx + 1, hits.length);
  }

  _setZoneHidden(layer, hidden) {
    if (hidden) layer.setStyle({ opacity: 0, fillOpacity: 0 });
    else layer.setStyle(this._zoneStyle(layer.feature));
    const tt = layer.getTooltip && layer.getTooltip();
    const el = tt && tt.getElement && tt.getElement();
    if (el) el.style.display = hidden ? "none" : "";
    if (layer.pm) {
      if (hidden) layer.pm.disable();
      else layer.pm.enable({ allowSelfIntersection: false });
    }
  }

  _zoneName(layer) {
    const f = layer.feature || {};
    const byId = this._zoneNames && this._zoneNames[f.id];
    if (byId) return byId;
    if (f.properties && f.properties.customName) return f.properties.customName;
    const zt = (f.properties && f.properties.zoneType) || "";
    const def = ZONE_TYPES.find((z) => z.type === zt);
    return def ? def.label : (zt || "Zone");
  }
  _focusZone(layer, idx, total) {
    this._focused = layer;
    this._zoneLayer.eachLayer((ly) => this._setZoneHidden(ly, ly !== layer));
    this._setZoneHidden(layer, false);
    if (layer.bringToFront) layer.bringToFront();
    if (this._focusBar) this._focusBar.style.display = "flex";
    if (this._focusInfo) {
      let txt = this._zoneName(layer);
      if (total > 1) txt += ` (${idx}/${total}) – erneut klicken für nächste`;
      this._focusInfo.textContent = txt;
    }
  }

  _unfocusZones() {
    this._focused = null;
    this._zoneLayer.eachLayer((ly) => this._setZoneHidden(ly, false));
    if (this._focusBar) this._focusBar.style.display = "none";
    this._fitZones();
  }

  _cloneZone() {
    if (!this._focused) { alert("Erst eine Zone anklicken, dann klonen."); return; }
    const L = this._L;
    const src = this._focused;
    // Ask for the new name, pre-filled with the source zone's name as template.
    const srcName = this._zoneName(src);
    const name = window.prompt("Name der geklonten Zone:", srcName);
    if (name === null) return; // cancelled
    const srcGj = src.toGeoJSON();
    const props = Object.assign(
      {}, (src.feature && src.feature.properties) || {},
      { description: "Cloned via Home Assistant" }
    );
    if (name.trim()) props.customName = name.trim();
    else delete props.customName;
    const type = props.zoneType || "GRASSZONE";
    const id = type + "_" + this._uuid();
    // Position the clone exactly over the original (no offset). It fully
    // overlaps, but is isolated on focus and reachable again via click-cycling.
    const coords = srcGj.geometry.coordinates;
    const feature = {
      type: "Feature", id, properties: props,
      geometry: { type: srcGj.geometry.type, coordinates: coords },
    };
    const layer = L.geoJSON(feature, { style: (f) => this._zoneStyle(f) }).getLayers()[0];
    layer.feature = feature;
    this._zoneLayer.addLayer(layer);
    (this._byType[type] = this._byType[type] || []).push(layer);
    // Register the name so the label + focus badge show it immediately.
    if (props.customName) {
      this._zoneNames = this._zoneNames || {};
      this._zoneNames[id] = props.customName;
    }
    this._labelZone(feature, layer);
    if (layer.pm) layer.pm.enable({ allowSelfIntersection: false });
    this._focusZone(layer); // isolate the clone so it can be adjusted straight away
  }

  _uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  _collectGeoJSON() {
    const feats = [];
    this._zoneLayer.eachLayer((layer) => {
      const gj = layer.toGeoJSON();
      const orig = (layer.feature && layer.feature.properties) || {};
      gj.properties = Object.assign({}, orig, gj.properties || {});
      if (layer.feature && layer.feature.id != null && gj.id == null) gj.id = layer.feature.id;
      feats.push(gj);
    });
    const base = this._gjOriginal || {};
    return Object.assign({}, base, { type: "FeatureCollection", features: feats });
  }

  async _saveZones() {
    const fc = this._collectGeoJSON();
    if (!window.confirm(
      `Zonen auf dem Mäher speichern?\n\n${fc.features.length} Zonen werden geschrieben. ` +
      `Das überschreibt die aktuelle Zonen-Konfiguration.`)) return;
    try {
      await this._hass.callService("eeve_mower_willow", "save_zones", { geojson: fc });
      this._exitEdit(false);
    } catch (e) {
      alert("Speichern fehlgeschlagen: " + (e && e.message ? e.message : e));
    }
  }

  _updateMower() {
    if (!this._map || !this._L) return;
    const pos = this._getPos();
    if (!pos) return;
    const L = this._L;
    const rot = pos.heading == null ? 0 : pos.heading;
    const html =
      `<div style="transform:rotate(${rot}deg);width:26px;height:26px;">` +
      '<svg viewBox="0 0 24 24" width="26" height="26">' +
      '<circle cx="12" cy="12" r="10" fill="#1e88e5" stroke="#fff" stroke-width="2"/>' +
      '<path d="M12 4 L16 13 L12 11 L8 13 Z" fill="#fff"/></svg></div>';
    const icon = L.divIcon({ html, className: "eeve-mower-marker", iconSize: [26, 26], iconAnchor: [13, 13] });
    if (!this._marker) {
      this._marker = L.marker([pos.lat, pos.lng], { icon }).addTo(this._map);
    } else {
      this._marker.setLatLng([pos.lat, pos.lng]);
      this._marker.setIcon(icon);
    }
  }
}

if (!customElements.get("eeve-mower-map-card")) {
  customElements.define("eeve-mower-map-card", EeveMowerMapCard);
}
window.customCards = window.customCards || [];
window.customCards.push({
  type: "eeve-mower-map-card",
  name: "EEVE Mower Map Card",
  description: "The mower's zones and live position on a satellite map",
  preview: false,
});
console.info("%c EEVE-MOWER-MAP-CARD %c loaded ", "background:#43a047;color:#fff;border-radius:3px 0 0 3px", "background:#555;color:#fff;border-radius:0 3px 3px 0");
