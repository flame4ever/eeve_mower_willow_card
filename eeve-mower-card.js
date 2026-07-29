/**
 * EEVE Mower Card — a self-building control panel for the EEVE Mower Willow
 * Home Assistant integration (github.com/flame4ever/eeve_mower_willow).
 *
 * You only point it at your mower (device or any one of its entities) and the
 * card discovers all the mower's entities automatically and builds the full
 * control panel: camera, joystick, drive buttons, lawn-mower controls, the
 * switches, sound + volume, map exploration, system actions and all zone /
 * global settings.
 *
 * Minimal config:
 *   type: custom:eeve-mower-card
 *
 * Full config:
 *   type: custom:eeve-mower-card
 *   title: EEVE Mower          # optional header
 *   device: <device_id>        # optional; auto-detected if omitted
 *   entity: lawn_mower.xxx     # optional alternative to device
 *   show_camera: true          # optional (default true)
 *   show_joystick: true        # optional (default true)
 *   show_settings: true        # optional (default true)
 *
 * This single file also registers the embedded eeve-joystick-card, so no other
 * resource is required.
 */

const PLATFORM = "eeve_mower_willow";

/* ------------------------------------------------------------------ *
 * Embedded joystick card (only defined if not already present)
 * ------------------------------------------------------------------ */
if (!customElements.get("eeve-joystick-card")) {
  class EeveJoystickCard extends HTMLElement {
    setConfig(config) {
      this._config = Object.assign(
        {
          start: null,
          max_speed: 0.4,
          turn_speed: 0.14,
          spin_step: 20,
          min_turn_radius: 0.35,
          max_turn_radius: 4.0,
          repeat_ms: 300,
          size: 220,
          title: "Steuerstick",
        },
        config || {}
      );
      if (!this._built) this._build();
    }
    set hass(hass) { this._hass = hass; }
    getCardSize() { return 4; }

    _build() {
      this._built = true;
      const s = this._config.size;
      const card = document.createElement("ha-card");
      if (this._config.title) card.header = this._config.title;
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;flex-direction:column;align-items:center;padding:16px;gap:12px;";
      const base = document.createElement("div");
      base.style.cssText =
        `position:relative;width:${s}px;height:${s}px;border-radius:50%;` +
        "background:radial-gradient(circle, var(--secondary-background-color) 55%, var(--divider-color) 100%);" +
        "box-shadow:inset 0 0 0 2px var(--divider-color);touch-action:none;user-select:none;";
      for (const [ch, pos] of [
        ["↑", "top:6px;left:50%;transform:translateX(-50%);"],
        ["↓", "bottom:6px;left:50%;transform:translateX(-50%);"],
        ["↺", "left:8px;top:50%;transform:translateY(-50%);"],
        ["↻", "right:8px;top:50%;transform:translateY(-50%);"],
      ]) {
        const a = document.createElement("div");
        a.textContent = ch;
        a.style.cssText =
          `position:absolute;${pos}color:var(--secondary-text-color);font-size:18px;opacity:.6;pointer-events:none;`;
        base.appendChild(a);
      }
      const knob = document.createElement("div");
      const ks = Math.round(s * 0.36);
      knob.style.cssText =
        `position:absolute;width:${ks}px;height:${ks}px;border-radius:50%;left:50%;top:50%;` +
        "transform:translate(-50%,-50%);background:var(--primary-color);" +
        "box-shadow:0 2px 6px rgba(0,0,0,.4);transition:transform .06s ease-out;";
      base.appendChild(knob);
      const label = document.createElement("div");
      label.style.cssText =
        "min-height:18px;color:var(--secondary-text-color);font-size:13px;text-align:center;";
      label.textContent = "Halten zum Fahren";
      wrap.appendChild(base); wrap.appendChild(label); card.appendChild(wrap); this.appendChild(card);
      this._base = base; this._knob = knob; this._label = label;
      this._maxOffset = (s - ks) / 2 - 4; this._cmd = null;
      base.addEventListener("pointerdown", (e) => this._start(e));
      base.addEventListener("pointermove", (e) => this._move(e));
      base.addEventListener("pointerup", (e) => this._end(e));
      base.addEventListener("pointercancel", (e) => this._end(e));
      base.addEventListener("pointerleave", (e) => { if (this._dragging) this._end(e); });
    }
    _activate(entity) {
      if (!entity || !this._hass) return;
      const domain = String(entity).split(".")[0];
      if (domain === "switch") this._hass.callService("switch", "turn_on", { entity_id: entity });
      else if (domain === "button") this._hass.callService("button", "press", { entity_id: entity });
    }
    _drive(data) {
      if (!this._hass) return;
      this._hass.callService("eeve_mower_willow", "drive", Object.assign({}, data));
    }
    _start(e) {
      this._dragging = true;
      try { this._base.setPointerCapture(e.pointerId); } catch (_) {}
      this._activate(this._config.start);
      this._timer = setInterval(() => { if (this._cmd) this._drive(this._cmd); },
        Math.max(150, this._config.repeat_ms));
      this._move(e);
    }
    _move(e) {
      if (!this._dragging) return;
      const r = this._base.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, this._maxOffset);
      const ang = Math.atan2(dy, dx);
      const kx = Math.cos(ang) * clamped, ky = Math.sin(ang) * clamped;
      this._knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
      const force = Math.min(clamped / this._maxOffset, 1);
      if (force < 0.18) { this._setCmd(null); return; }
      const nx = kx / this._maxOffset, ny = -ky / this._maxOffset;
      if (Math.abs(ny) >= 0.25) {
        const action = ny > 0 ? "forward" : "backwards";
        const speed = +(this._config.max_speed * Math.min(1, Math.abs(ny))).toFixed(3);
        const distance = Math.max(0.05, +(speed * (this._config.repeat_ms / 1000)).toFixed(3));
        const cmd = { action, speed, distance };
        let label = action === "forward" ? "Vorwärts" : "Rückwärts";
        if (Math.abs(nx) > 0.15) {
          const minR = this._config.min_turn_radius, maxR = this._config.max_turn_radius;
          const mag = minR + (1 - Math.abs(nx)) * (maxR - minR);
          cmd.turn_radius = +((nx > 0 ? -1 : 1) * mag).toFixed(2);
          label += nx > 0 ? " + rechts" : " + links";
        }
        this._setCmd(cmd, label);
      } else {
        const turnSpd = +(this._config.turn_speed * force).toFixed(3);
        const rotation = +((nx > 0 ? -1 : 1) * this._config.spin_step * force).toFixed(1);
        this._setCmd({ action: "spin", speed: turnSpd, rotation }, nx > 0 ? "Rechts drehen" : "Links drehen");
      }
    }
    _setCmd(cmd, labelText) {
      const key = cmd ? JSON.stringify(cmd) : null;
      if (key === this._cmdKey) return;
      this._cmdKey = key; this._cmd = cmd;
      this._label.textContent = cmd ? labelText : "Halten zum Fahren";
      if (cmd) this._drive(cmd);
    }
    _end(e) {
      this._dragging = false;
      try { this._base.releasePointerCapture(e.pointerId); } catch (_) {}
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._cmd = null; this._cmdKey = null;
      this._drive({ action: "stop", speed: 0 });
      this._knob.style.transform = "translate(-50%,-50%)";
      this._label.textContent = "Halten zum Fahren";
    }
  }
  customElements.define("eeve-joystick-card", EeveJoystickCard);
}

/* ------------------------------------------------------------------ *
 * Embedded mowing-plan card (current/next zone + next scheduled run,
 * formatted as "Today/Tomorrow/<weekday>, HH:MM" — localized to HA's
 * configured language via Intl, not hardcoded — instead of a raw
 * timestamp. Only defined if not already present.)
 * ------------------------------------------------------------------ */
if (!customElements.get("eeve-mowplan-card")) {
  class EeveMowPlanCard extends HTMLElement {
    setConfig(config) {
      this._config = Object.assign(
        { title: "Mähplan", zone_entity: null, schedule_entity: null }, config || {});
      if (!this._built) this._build();
    }
    set hass(hass) { this._hass = hass; this._render(); }
    getCardSize() { return 2; }

    _build() {
      this._built = true;
      const card = document.createElement("ha-card");
      if (this._config.title) card.header = this._config.title;
      const body = document.createElement("div");
      body.style.cssText = "padding:0 16px 16px;display:flex;flex-direction:column;gap:10px;";
      this._zoneRow = this._makeRow("Aktuelle / nächste Zone");
      this._schedRow = this._makeRow("Nächster Mähzeitpunkt");
      body.appendChild(this._zoneRow.el);
      body.appendChild(this._schedRow.el);
      card.appendChild(body);
      this.innerHTML = "";
      this.appendChild(card);
      this._render();
    }
    _makeRow(label) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;";
      const l = document.createElement("div");
      l.textContent = label;
      l.style.cssText = "color:var(--primary-text-color);";
      const v = document.createElement("div");
      v.style.cssText = "color:var(--secondary-text-color);text-align:right;";
      el.appendChild(l); el.appendChild(v);
      return { el, valueEl: v };
    }
    /* HA's own display language, e.g. from Settings > General. Falls back
       to English rather than hardcoding German. */
    _lang() {
      return (this._hass && this._hass.locale && this._hass.locale.language) ||
        (this._hass && this._hass.language) || "en";
    }
    /* Turns the mower's raw "YYYY-MM-DD HH:MM:SS" string into a short,
       human-friendly label using the same building blocks Home Assistant's
       own frontend uses for relative timestamps (Intl.RelativeTimeFormat /
       Intl.DateTimeFormat) — so "today"/"tomorrow"/weekday names and the
       time itself automatically render in whatever language HA is set to,
       with no hardcoded translation table to maintain. Falls back to the
       raw text for anything unparseable (e.g. "No schedule", "unknown"). */
    _fmtSchedule(raw) {
      if (!raw) return "–";
      const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
      if (!m) return raw;
      const [, y, mo, d, hh, mm] = m;
      const target = new Date(+y, +mo - 1, +d, +hh, +mm);
      const targetMidnight = new Date(+y, +mo - 1, +d);
      const now = new Date();
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diffDays = Math.round((targetMidnight - todayMidnight) / 86400000);
      const lang = this._lang();
      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(target);
      let dayLabel;
      if (Math.abs(diffDays) <= 1) {
        // Locale-correct "today"/"tomorrow"/"yesterday" (or their local
        // equivalents) straight from ICU — same mechanism HA itself uses.
        dayLabel = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(diffDays, "day");
      } else if (diffDays > 1 && diffDays < 7) {
        dayLabel = new Intl.DateTimeFormat(lang, { weekday: "long" }).format(target);
      } else {
        return `${new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", year: "numeric" }).format(target)}, ${time}`;
      }
      return `${cap(dayLabel)}, ${time}`;
    }
    _render() {
      if (!this._hass || !this._built) return;
      const zs = this._config.zone_entity && this._hass.states[this._config.zone_entity];
      this._zoneRow.valueEl.textContent = zs ? zs.state : "–";
      const ss = this._config.schedule_entity && this._hass.states[this._config.schedule_entity];
      this._schedRow.valueEl.textContent = ss ? this._fmtSchedule(ss.state) : "–";
    }
  }
  customElements.define("eeve-mowplan-card", EeveMowPlanCard);
}

/* ------------------------------------------------------------------ *
 * Camera feed with a small status-icon overlay (WiFi signal, battery,
 * mowing-motor state, current activity) baked directly onto the video —
 * wraps HA's own picture-entity card so the camera view/live-refresh
 * behaviour is unchanged; only defined if not already present.
 * ------------------------------------------------------------------ */
if (!customElements.get("eeve-camera-overlay-card")) {
  class EeveCameraOverlayCard extends HTMLElement {
    setConfig(config) {
      this._config = Object.assign(
        { camera_entity: null, wifi_entity: null, battery_entity: null,
          motor_entity: null, activity_entity: null, ip_entity: null },
        config || {});
      if (!this._built) this._build();
    }
    set hass(hass) {
      this._hass = hass;
      if (this._innerCard) this._innerCard.hass = hass;
      this._render();
    }
    getCardSize() { return 4; }

    connectedCallback() {
      // Resume overlay polling whenever the card is (re-)inserted into the
      // DOM (e.g. after a dashboard tab switch removed/re-added it). The
      // per-layer enabled flags (set from localStorage / the toggle
      // buttons) decide what actually gets fetched each tick.
      if (this._built) this._startPolling();
    }
    disconnectedCallback() {
      this._stopPolling();
    }

    async _build() {
      this._built = true;
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "position:relative;border-radius:var(--ha-card-border-radius,12px);overflow:hidden;";
      if (this._config.camera_entity) {
        const helpers = await window.loadCardHelpers();
        this._innerCard = helpers.createCardElement({
          type: "picture-entity", entity: this._config.camera_entity,
          camera_view: "live", show_state: false, show_name: false,
        });
        if (this._hass) this._innerCard.hass = this._hass;
        wrap.appendChild(this._innerCard);
      }
      // AI-overlay layers, each a small stand-alone SVG fetched directly
      // from the mower's own onboard web server (see _LAYER_DEFS below for
      // the endpoints) and stacked on top of the video, below the status
      // bar. Order matters: environment coloring at the bottom, then
      // DepthSense obstacle boxes, then people/charging-station on top.
      // The mower's camera frame is natively 4:3 (640x480), but the
      // picture-entity card's default aspect ratio is 16:9 — HA sizes the
      // <img> itself to 4:3 (matching the real stream, full width) and it
      // simply flows top-aligned inside the shorter 16:9 box, which clips
      // the excess off the *bottom* via the parent's overflow:hidden (NOT
      // centered — verified via getBoundingClientRect: the img's own top
      // coincides exactly with the container's top). An overlay stretched
      // to fill the 16:9 box, or one centered vertically, both line up
      // wrong. Mirror the image's own top-anchored sizing instead: full
      // width, 4:3 height, flush at the top.
      const svgNS = "http://www.w3.org/2000/svg";
      const mkOverlaySvg = () => {
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 640 480");
        svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
        svg.style.cssText =
          "position:absolute;left:0;top:0;width:100%;height:auto;" +
          "aspect-ratio:4/3;pointer-events:none;";
        wrap.appendChild(svg);
        return svg;
      };
      this._envSvg = mkOverlaySvg();
      this._depthSvg = mkOverlaySvg();
      this._detectionSvg = mkOverlaySvg();
      // Translucent status-chip bar, top-left of the video feed.
      const bar = document.createElement("div");
      bar.style.cssText =
        "position:absolute;top:8px;left:8px;right:8px;display:flex;gap:6px;" +
        "flex-wrap:wrap;pointer-events:none;";
      const mkChip = () => {
        const chip = document.createElement("div");
        chip.style.cssText =
          "display:flex;align-items:center;gap:2px;background:rgba(0,0,0,.55);" +
          "border-radius:12px;padding:3px 8px;font-size:12px;font-weight:600;" +
          "line-height:1;";
        const icon = document.createElement("ha-icon");
        icon.style.cssText = "--mdc-icon-size:16px;display:flex;";
        const label = document.createElement("span");
        chip.appendChild(icon); chip.appendChild(label);
        return { chip, icon, label };
      };
      this._wifiChip = mkChip();
      this._batteryChip = mkChip();
      this._motorChip = mkChip();
      this._activityChip = mkChip();
      for (const c of [this._wifiChip, this._batteryChip, this._motorChip, this._activityChip])
        bar.appendChild(c.chip);
      wrap.appendChild(bar);

      // AI-overlay on/off toggle buttons, top-right — mirror the 3 toggle
      // buttons in the stock EEVE web UI (http://<mower-ip>:8080/): "Detects
      // people and the charging station", "Detects your environment" and
      // "Detects obstacles using DepthSense". Each is persisted per-browser
      // (localStorage) so the preference survives reloads. The status chips
      // stay pointer-events:none, so these buttons live in their own row.
      const btnRow = document.createElement("div");
      btnRow.style.cssText =
        "position:absolute;top:8px;right:8px;display:flex;gap:6px;";
      wrap.appendChild(btnRow);

      this._layerButtons = {};
      for (const def of EeveCameraOverlayCard._LAYER_DEFS) {
        const enabled = window.localStorage.getItem(def.storageKey) !== "off";
        const btn = document.createElement("button");
        btn.style.cssText =
          "display:flex;align-items:center;justify-content:center;width:28px;" +
          "height:28px;border:none;border-radius:50%;cursor:pointer;padding:0;";
        const icon = document.createElement("ha-icon");
        icon.setAttribute("icon", def.icon);
        icon.style.cssText = "--mdc-icon-size:16px;display:flex;color:#fff;";
        btn.appendChild(icon);
        btn.title = def.title;
        btn.addEventListener("click", () => {
          const nowEnabled = this._layerButtons[def.key].enabled = !this._layerButtons[def.key].enabled;
          window.localStorage.setItem(def.storageKey, nowEnabled ? "on" : "off");
          this._updateLayerButton(def.key);
          if (!nowEnabled) { const svg = this[def.svgProp]; if (svg) svg.innerHTML = ""; }
          if (def.key === "environment") this._updateLegendVisibility();
        });
        btnRow.appendChild(btn);
        this._layerButtons[def.key] = { btn, icon, enabled };
        this._updateLayerButton(def.key);
      }

      // Legend for the environment (terrain-segmentation) overlay — same
      // colour/category list as the stock EEVE UI's "view the legend" info
      // panel, hardcoded here since it's static reference data baked into
      // that UI's own bundle (not served by any API endpoint).
      const legend = document.createElement("div");
      legend.style.cssText =
        "position:absolute;top:42px;right:8px;background:rgba(0,0,0,.7);" +
        "border-radius:8px;padding:6px 10px;font-size:11px;color:#fff;" +
        "display:none;max-height:160px;overflow-y:auto;";
      for (const item of EeveCameraOverlayCard._ENV_LEGEND) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:1px 0;";
        const dot = document.createElement("span");
        dot.style.cssText =
          `display:inline-block;width:9px;height:9px;border-radius:50%;background:${item.color};flex:none;`;
        const label = document.createElement("span");
        label.textContent = item.name;
        row.appendChild(dot); row.appendChild(label);
        legend.appendChild(row);
      }
      this._legendEl = legend;
      wrap.appendChild(legend);
      this._updateLegendVisibility();

      this.innerHTML = "";
      this.appendChild(wrap);
      this._render();
      this._startPolling();
    }

    _updateLayerButton(key) {
      const l = this._layerButtons && this._layerButtons[key];
      if (!l) return;
      l.btn.style.background = l.enabled ? "#03a9f4" : "rgba(0,0,0,.55)";
    }
    _updateLegendVisibility() {
      if (!this._legendEl) return;
      const env = this._layerButtons && this._layerButtons.environment;
      this._legendEl.style.display = env && env.enabled ? "block" : "none";
    }

    /* --- AI-overlay layers ----------------------------------------------
     * The mower's onboard web server (port 8080) renders several stand-
     * alone SVG overlays sized to match the raw camera frame (640x480),
     * each corresponding 1:1 to a toggle button in the stock EEVE web UI:
     *   - "Detects people and the charging station":
     *     GET /image/front/scene.svg?layerItems=GeneralObjectDetectionTransformer
     *         &layerItems=ToadiObjectDetectionTransformer
     *         &layerItems=ChargingStationPoseRenderer
     *         &layerItems=ChargingStationConfidenceRenderer
     *   - "Detects your environment" (terrain/obstacle segmentation):
     *     GET /image/front/grass.svg?layerItems=detection&layerItems=surface
     *         &layerItems=robotMotionState&layerItems=inferenceType
     *   - "Detects obstacles using DepthSense":
     *     GET /image/front/depth_obstacles.svg?layerItems=front
     *     (404 when nothing is currently detected — treated as "empty",
     *     not an error)
     * All reverse-engineered from that UI's own network traffic (no
     * documented API for any of this). We poll directly from the browser
     * (same LAN as the mower, not through HA), using the mower's local IP
     * from the network_wifi_local_ip sensor. Best-effort only: if the
     * mower is unreachable (different network, offline, etc.) this
     * silently does nothing rather than breaking the rest of the card. */
    _startPolling() {
      if (this._pollTimer) return;
      this._pollTick();
      this._pollTimer = setInterval(() => this._pollTick(), 1000);
    }
    _stopPolling() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    }
    _mowerBase() {
      if (!this._hass || !this._config.ip_entity) return null;
      const ipState = this._hass.states[this._config.ip_entity];
      const host = ipState && ipState.state;
      if (!host || host === "unknown" || host === "unavailable") return null;
      return `http://${host}:8080`;
    }
    _pollTick() {
      const base = this._mowerBase();
      for (const def of EeveCameraOverlayCard._LAYER_DEFS) {
        const layer = this._layerButtons && this._layerButtons[def.key];
        const svg = this[def.svgProp];
        if (!layer || !layer.enabled || !base) { if (svg) svg.innerHTML = ""; continue; }
        this._fetchLayer(svg, base + def.path + (def.path.includes("?") ? "&" : "?") + "timestamp=" + Date.now());
      }
    }
    async _fetchLayer(svgEl, url) {
      if (!svgEl) return;
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        if (res.status === 404) { svgEl.innerHTML = ""; return; } // nothing detected right now
        if (!res.ok) return;
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const root = doc.documentElement;
        if (root && root.tagName === "svg") svgEl.innerHTML = root.innerHTML;
      } catch (e) {
        // Mower unreachable from this browser (not on the same LAN, mower
        // offline, etc.) — leave whatever was last drawn (or nothing).
      }
    }

    _setChip(c, icon, text, color) {
      c.icon.setAttribute("icon", icon);
      c.icon.style.color = color;
      c.label.textContent = text;
      c.label.style.color = color;
    }

    _render() {
      // Guard on chip existence, not just this._built: _build() is async
      // (it awaits loadCardHelpers()), so hass can be set by the caller
      // before the chip DOM nodes created after that await actually exist.
      if (!this._wifiChip || !this._hass) return;
      const st = (eid) => (eid && this._hass.states[eid]) || null;

      const wifi = st(this._config.wifi_entity);
      const wifiPct = wifi ? parseFloat(wifi.state) : NaN;
      this._setChip(this._wifiChip, EeveCameraOverlayCard._wifiIcon(wifiPct),
        isNaN(wifiPct) ? "–" : `${Math.round(wifiPct)}%`,
        !isNaN(wifiPct) && wifiPct < 25 ? "#ff5252" : "#fff");

      const batt = st(this._config.battery_entity);
      const battPct = batt ? parseFloat(batt.state) : NaN;
      this._setChip(this._batteryChip, EeveCameraOverlayCard._batteryIcon(battPct),
        isNaN(battPct) ? "–" : `${Math.round(battPct)}%`,
        !isNaN(battPct) && battPct < 20 ? "#ff5252" : "#fff");

      const motor = st(this._config.motor_entity);
      const motorOn = !!motor && motor.state === "on";
      this._setChip(this._motorChip, "mdi:mower", motorOn ? "An" : "Aus",
        motorOn ? "#69f0ae" : "#bbb");

      const act = st(this._config.activity_entity);
      const info = EeveCameraOverlayCard._activityInfo(act && act.state);
      this._setChip(this._activityChip, info.icon, info.label, "#fff");
    }

    static _wifiIcon(pct) {
      if (isNaN(pct)) return "mdi:wifi-strength-off-outline";
      if (pct >= 80) return "mdi:wifi-strength-4";
      if (pct >= 60) return "mdi:wifi-strength-3";
      if (pct >= 40) return "mdi:wifi-strength-2";
      if (pct >= 15) return "mdi:wifi-strength-1";
      return "mdi:wifi-strength-outline";
    }
    static _batteryIcon(pct) {
      if (isNaN(pct)) return "mdi:battery-unknown";
      const r = Math.min(100, Math.max(0, Math.round(pct / 10) * 10));
      if (r >= 100) return "mdi:battery";
      if (r === 0) return "mdi:battery-outline";
      return `mdi:battery-${r}`;
    }
    /* Maps the mower's free-text activity string (English, from the
       device's own API — e.g. "in Charging Station", "no activities",
       "manualdriving", or a tool name like "mowing") onto a short,
       sensible icon + label. Falls back to showing the raw text so an
       unrecognised value is never silently hidden. */
    static _activityInfo(raw) {
      const s = (raw || "").toLowerCase();
      if (s.includes("charg")) return { icon: "mdi:battery-charging", label: "Lädt" };
      if (s.includes("dock")) return { icon: "mdi:home-import-outline", label: "Docking" };
      if (s.includes("manual")) return { icon: "mdi:steering", label: "Manuell" };
      if (s.includes("mow")) return { icon: "mdi:mower", label: "Mäht" };
      if (!raw || s.includes("no activ")) return { icon: "mdi:pause-circle-outline", label: "Inaktiv" };
      return { icon: "mdi:robot-mower-outline", label: raw };
    }
  }

  // Toggleable overlay layers, in bottom-to-top stacking order (each
  // svgProp is one of the <svg> elements created in _build()). Mirrors the
  // 3 toggle buttons of the stock EEVE web UI 1:1 — see the comment above
  // _startPolling() for the reverse-engineered endpoint details.
  EeveCameraOverlayCard._LAYER_DEFS = [
    { key: "environment", svgProp: "_envSvg",
      path: "/image/front/grass.svg?layerItems=detection&layerItems=surface&layerItems=robotMotionState&layerItems=inferenceType",
      icon: "mdi:image-filter-hdr", title: "Umgebungserkennung (Gras, Hindernisse, Untergrund …)",
      storageKey: "eeve_mower_env_detection" },
    { key: "depth", svgProp: "_depthSvg",
      path: "/image/front/depth_obstacles.svg?layerItems=front",
      icon: "mdi:cube-scan", title: "Hinderniserkennung (DepthSense)",
      storageKey: "eeve_mower_depth_detection" },
    { key: "ai", svgProp: "_detectionSvg",
      path: "/image/front/scene.svg?layerItems=GeneralObjectDetectionTransformer&layerItems=ToadiObjectDetectionTransformer&layerItems=ChargingStationPoseRenderer&layerItems=ChargingStationConfidenceRenderer",
      icon: "mdi:account-eye", title: "KI-Erkennung (Personen / Ladestation)",
      storageKey: "eeve_mower_ai_detection" },
  ];
  // Terrain/obstacle category legend for the "environment" layer — static
  // reference data mirrored from the stock EEVE UI's own bundle (there is
  // no API endpoint serving this; the UI hardcodes it too).
  EeveCameraOverlayCard._ENV_LEGEND = [
    { name: "obstacle", color: "#eb3223" },
    { name: "grass", color: "#387d21" },
    { name: "leaves", color: "#eee597" },
    { name: "soil", color: "#f5c3cb" },
    { name: "rain", color: "#0d26f5" },
    { name: "charging station", color: "#74f94d" },
    { name: "wire", color: "#fffd54" },
    { name: "weed", color: "#f3a73a" },
    { name: "flower", color: "#ffffff" },
    { name: "stonefloor", color: "#808080" },
    { name: "water", color: "#72fbfd" },
    { name: "unknown", color: "#000000" },
  ];
  customElements.define("eeve-camera-overlay-card", EeveCameraOverlayCard);
}

/* ------------------------------------------------------------------ *
 * EEVE Mower Card
 * ------------------------------------------------------------------ */
class EeveMowerCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign(
      { title: "EEVE Mower", device: null, entity: null,
        show_camera: true, show_joystick: true, show_settings: true },
      config || {}
    );
    this._built = false;
    this.innerHTML = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass) return;
    if (!this._built) this._build();
    if (this._children) for (const el of this._children) el.hass = hass;
  }

  getCardSize() { return 20; }
  static getStubConfig() { return {}; }

  /* --- entity discovery (language-independent) --------------------- *
   * Entity IDs are localized on non-English installs (e.g. a German HA
   * names the manual-driving switch switch.…_manuelles_fahren), so we
   * resolve every control by its language-independent translation_key from
   * the entity registry (fetched in _build) instead of by entity_id suffix. */
  _deviceRegEntries() {
    const reg = this._reg || [];
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
    this._deviceId = deviceId;
    return reg.filter((r) => r.device_id === deviceId && !r.disabled_by);
  }

  /* --- layout ------------------------------------------------------ */
  _cardConfigs() {
    const ents = this._deviceRegEntries();
    // translation_key -> entity_id (language-independent lookup)
    const byKey = {};
    for (const r of ents)
      if (r.translation_key && !(r.translation_key in byKey)) byKey[r.translation_key] = r.entity_id;
    const k = (key) => byKey[key];
    const domainFirst = (d) => {
      const r = ents.find((x) => x.entity_id.startsWith(d + "."));
      return r && r.entity_id;
    };
    // Left column = camera + joystick; right column = all the controls.
    const left = [];
    const right = [];
    const cards = right; // control sections go into the right column

    const camera = domainFirst("camera");
    const lawn = domainFirst("lawn_mower");
    const manual = k("manual_driving");
    const mowing = k("mowing_motor");
    const docking = k("docking");
    const estop = k("emergency_stop");
    const sound = k("sound");
    const volume = k("volume");

    // Camera (left column) — with small status-icon overlay (WiFi, battery,
    // mowing motor, current activity) baked onto the video feed.
    if (this._config.show_camera && camera)
      left.push({ _cameraOverlay: {
        camera_entity: camera,
        wifi_entity: k("network_wifi_signal"),
        battery_entity: k("battery"),
        motor_entity: mowing,
        activity_entity: k("mower_activities"),
        ip_entity: k("network_wifi_local_ip"),
      } });

    // Joystick (left column). Marked with _joystick so _build instantiates the
    // bundled element directly (document.createElement) instead of going through
    // createCardElement — that way it never depends on HA resolving the custom
    // card type, which can fail right after a fresh HACS install.
    if (this._config.show_joystick && manual)
      left.push({ _joystick: { title: "Steuerstick",
        start: manual, max_speed: 0.4, turn_speed: 0.14, size: 230 } });

    // Drive buttons are intentionally omitted — the joystick above covers
    // manual driving. (manual_drive_speed is kept out of the settings list too.)

    // Lawn mower entity (left column, under the joystick — everything from
    // "Steuerung" onwards stays in the right column).
    if (lawn)
      left.push({ type: "tile", entity: lawn, name: "Mähen / Dock",
        features: [{ type: "lawn-mower-commands", commands: ["start_pause", "dock"] }] });

    // Mowing plan (shown ABOVE the controls): which zone is being / will be
    // mowed and when the next mowing run is scheduled.
    const zoneSensor = k("current_mowing_zone");
    const scheduler = k("scheduler");
    if (zoneSensor || scheduler)
      cards.push({ _plan: { title: "Mähplan", zone_entity: zoneSensor, schedule_entity: scheduler } });

    // Main switches
    const mainSwitches = [manual, mowing, docking, estop].filter(Boolean);
    if (mainSwitches.length)
      cards.push({ type: "entities", title: "Steuerung",
        entities: mainSwitches.map((e) => ({ entity: e })) });

    // Sound + volume
    const soundEnts = [sound, volume].filter(Boolean);
    if (soundEnts.length)
      cards.push({ type: "entities", title: "Sound",
        entities: soundEnts.map((e) => ({ entity: e })) });

    // Map exploration
    const mapBtns = ["start_map_exploration", "stop_map_exploration", "finish_map_exploration",
      "abort_map_exploration", "build_map", "auto_align_maps"].map(k).filter(Boolean);
    if (mapBtns.length)
      cards.push({ type: "entities", title: "Karten",
        entities: mapBtns.map((e) => ({ entity: e })) });

    // Schedule + extras (weekday switches, beacons, auto annotation)
    const extras = ents.filter((r) =>
      r.entity_id.startsWith("switch.") && r.translation_key &&
      (r.translation_key.startsWith("mow_on_") ||
       r.translation_key === "starlight_beacons" ||
       r.translation_key === "auto_annotation")).map((r) => r.entity_id);
    if (extras.length)
      cards.push({ type: "entities", title: "Zeitplan & Extras",
        entities: extras.map((e) => ({ entity: e })) });

    // Settings (select + number), grouped and sorted: global, all-zones, per-zone.
    // Grouping uses the language-independent translation_key; per-zone entities
    // all share the "zone_*" key, so we sort them by friendly name to keep each
    // zone's controls together (Grass 1 …, Grass 2 …) regardless of language.
    if (this._config.show_settings) {
      const usedIds = new Set([volume, k("manual_drive_speed")].filter(Boolean));
      const settings = ents.filter((r) =>
        (r.entity_id.startsWith("select.") || r.entity_id.startsWith("number.")) &&
        !usedIds.has(r.entity_id));
      const nameOf = (eid) => {
        const s = this._hass.states && this._hass.states[eid];
        return (s && s.attributes && s.attributes.friendly_name) || eid;
      };
      const tk = (r) => r.translation_key || "";
      const groupTitle = (title, list) => {
        if (!list.length) return;
        const ids = list.map((r) => r.entity_id)
          .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        cards.push({ type: "entities", title, entities: ids.map((e) => ({ entity: e })) });
      };
      groupTitle("Globale Einstellungen",
        settings.filter((r) => !tk(r).startsWith("all_zones_") && !tk(r).startsWith("zone_")));
      groupTitle("Alle Zonen", settings.filter((r) => tk(r).startsWith("all_zones_")));
      groupTitle("Zonen", settings.filter((r) => tk(r).startsWith("zone_")));
    }

    // System actions
    const sys = [k("reboot"), k("shutdown")].filter(Boolean);
    if (sys.length)
      cards.push({ type: "entities", title: "System",
        entities: sys.map((e) => ({ entity: e })) });

    // Disable the automatic "toggle all" header switch on every entities card —
    // it would otherwise flip all controls (incl. emergency stop) at once.
    for (const c of [...left, ...right])
      if (c.type === "entities") c.show_header_toggle = false;

    return { left, right };
  }

  async _build() {
    this._built = true;
    const helpers = await window.loadCardHelpers();
    // Fetch the entity registry so we can resolve controls by their
    // language-independent translation_key (entity IDs are localized).
    try {
      this._reg = await this._hass.callWS({ type: "config/entity_registry/list" });
    } catch (e) {
      this._reg = [];
    }
    const card = document.createElement("ha-card");
    if (this._config.title) card.header = this._config.title;
    const container = document.createElement("div");
    // Two responsive columns: camera + joystick on the left, controls on the
    // right. They stack automatically on narrow screens (min-width wrap).
    container.style.cssText =
      "display:flex;flex-wrap:wrap;gap:8px;padding:8px;align-items:flex-start;";
    card.appendChild(container);
    this.innerHTML = "";
    this.appendChild(card);

    this._children = [];
    const { left, right } = this._cardConfigs();
    if (!left.length && !right.length) {
      container.innerHTML =
        '<div style="padding:16px;color:var(--error-color)">No EEVE Mower device found. ' +
        'Add <code>device:</code> or <code>entity:</code> to the card config.</div>';
      return;
    }
    const makeColumn = (configs, grow) => {
      const col = document.createElement("div");
      col.style.cssText =
        `flex:${grow} 1 300px;min-width:280px;display:flex;flex-direction:column;gap:8px;`;
      for (const cfg of configs) {
        let el;
        if (cfg._joystick) {
          el = document.createElement("eeve-joystick-card");
          el.setConfig(cfg._joystick);
        } else if (cfg._plan) {
          el = document.createElement("eeve-mowplan-card");
          el.setConfig(cfg._plan);
        } else if (cfg._cameraOverlay) {
          el = document.createElement("eeve-camera-overlay-card");
          el.setConfig(cfg._cameraOverlay);
        } else {
          el = helpers.createCardElement(cfg);
        }
        el.hass = this._hass;
        this._children.push(el);
        col.appendChild(el);
      }
      return col;
    };
    if (left.length) container.appendChild(makeColumn(left, 5));
    if (right.length) container.appendChild(makeColumn(right, 6));
  }
}

if (!customElements.get("eeve-mower-card")) {
  customElements.define("eeve-mower-card", EeveMowerCard);
}
window.customCards = window.customCards || [];
window.customCards.push({
  type: "eeve-mower-card",
  name: "EEVE Mower Card",
  description: "Self-building control panel for the EEVE Mower Willow integration",
  preview: false,
});
console.info("%c EEVE-MOWER-CARD %c loaded ", "background:#03a9f4;color:#fff;border-radius:3px 0 0 3px", "background:#555;color:#fff;border-radius:0 3px 3px 0");
