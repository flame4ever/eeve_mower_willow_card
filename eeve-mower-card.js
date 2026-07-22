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

  /* --- entity discovery ------------------------------------------- */
  _deviceEntities() {
    const ents = this._hass.entities || {};
    // 1) explicit device
    let deviceId = this._config.device;
    // 2) derive device from a given entity
    if (!deviceId && this._config.entity && ents[this._config.entity])
      deviceId = ents[this._config.entity].device_id;
    // 3) auto-detect: the (single) device that owns eeve_mower_willow entities
    if (!deviceId) {
      const counts = {};
      for (const eid in ents) {
        const e = ents[eid];
        if (e.platform === PLATFORM && e.device_id) counts[e.device_id] = (counts[e.device_id] || 0) + 1;
      }
      deviceId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    }
    this._deviceId = deviceId;
    const list = [];
    for (const eid in ents) {
      const e = ents[eid];
      if (e.device_id === deviceId || (e.platform === PLATFORM && !deviceId)) list.push(eid);
    }
    return list;
  }

  _find(entities, domain, suffix) {
    // first entity whose id is "<domain>.*<suffix>"
    return entities.find((eid) => {
      if (!eid.startsWith(domain + ".")) return false;
      return eid.split(".")[1].endsWith(suffix);
    });
  }
  _all(entities, domain, test) {
    return entities.filter((eid) => eid.startsWith(domain + ".") && test(eid.split(".")[1]));
  }

  /* --- layout ------------------------------------------------------ */
  _cardConfigs() {
    const E = this._deviceEntities();
    const f = (d, s) => this._find(E, d, s);
    // Left column = camera + joystick; right column = all the controls.
    const left = [];
    const right = [];
    const cards = right; // control sections go into the right column

    const camera = f("camera", "");
    const lawn = f("lawn_mower", "");
    const manual = f("switch", "manual_driving");
    const mowing = f("switch", "mowing_motor");
    const docking = f("switch", "docking");
    const estop = f("switch", "emergency_stop");
    const sound = f("switch", "sound");
    const volume = f("number", "volume");
    const speed = f("number", "manual_drive_speed");

    // Camera (left column)
    if (this._config.show_camera && camera)
      left.push({ type: "picture-entity", entity: camera, camera_view: "live",
        show_state: false, show_name: false });

    // Joystick (left column)
    if (this._config.show_joystick && manual)
      left.push({ type: "custom:eeve-joystick-card", title: "Steuerstick",
        start: manual, max_speed: 0.4, turn_speed: 0.14, size: 230 });

    // Drive buttons are intentionally omitted — the joystick above covers
    // manual driving. (manual_drive_speed is kept out of the settings list too.)

    // Lawn mower entity
    if (lawn)
      cards.push({ type: "tile", entity: lawn, name: "Mähen / Dock",
        features: [{ type: "lawn-mower-commands", commands: ["start_pause", "dock"] }] });

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
    const mapBtns = [
      f("button", "start_map_exploration"), f("button", "stop_map_exploration"),
      f("button", "finish_map_exploration"), f("button", "abort_map_exploration"),
      f("button", "build_map"), f("button", "auto_align_maps"),
    ].filter(Boolean);
    if (mapBtns.length)
      cards.push({ type: "entities", title: "Karten",
        entities: mapBtns.map((e) => ({ entity: e })) });

    // Schedule + extras (weekday switches, beacons, auto annotation)
    const extras = this._all(E, "switch",
      (o) => o.includes("mow_on_") || o.endsWith("starlight_beacons") || o.endsWith("auto_annotation"));
    if (extras.length)
      cards.push({ type: "entities", title: "Zeitplan & Extras",
        entities: extras.map((e) => ({ entity: e })) });

    // Zone & global settings: every select + number except the ones used above
    if (this._config.show_settings) {
      const used = new Set([volume, speed].filter(Boolean));
      const settings = E.filter((eid) =>
        (eid.startsWith("select.") || eid.startsWith("number.")) && !used.has(eid));
      settings.sort();
      if (settings.length)
        cards.push({ type: "entities", title: "Zonen & Einstellungen",
          entities: settings.map((e) => ({ entity: e })) });
    }

    // System actions
    const sys = [f("button", "reboot_mower"), f("button", "shutdown_mower")].filter(Boolean);
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
        const el = helpers.createCardElement(cfg);
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

customElements.define("eeve-mower-card", EeveMowerCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "eeve-mower-card",
  name: "EEVE Mower Card",
  description: "Self-building control panel for the EEVE Mower Willow integration",
  preview: false,
});
console.info("%c EEVE-MOWER-CARD %c loaded ", "background:#03a9f4;color:#fff;border-radius:3px 0 0 3px", "background:#555;color:#fff;border-radius:0 3px 3px 0");
