# EEVE Mower Card

A self-building Lovelace control panel for the [EEVE Mower Willow integration](https://github.com/flame4ever/eeve_mower_willow).

You just point it at your mower — the card discovers all of the mower's entities automatically and builds the full panel: live camera, joystick, drive buttons, lawn-mower controls, the switches (manual driving, mowing motor, docking, emergency stop), sound + volume, map exploration, system actions and all zone / global settings.

![EEVE Mower device page](https://raw.githubusercontent.com/flame4ever/eeve_mower_willow/main/Example.png)

## Requirements

- The [EEVE Mower Willow integration](https://github.com/flame4ever/eeve_mower_willow) (v0.4.1+) installed and set up.

## Install (HACS)

1. HACS → three-dot menu → **Custom repositories**
2. Repository: `https://github.com/flame4ever/eeve_mower_willow_card`, category: **Dashboard** (Lovelace)
3. Install **EEVE Mower Card**, then reload your browser.

HACS registers the Lovelace resource for you. For a manual install, copy `eeve-mower-card.js` to `<config>/www/` and add it as a JavaScript-Module resource.

## Usage

Minimal — the card auto-detects your mower:

```yaml
type: custom:eeve-mower-card
```

Full options:

```yaml
type: custom:eeve-mower-card
title: EEVE Mower        # header text (optional)
device: <device_id>      # optional; auto-detected if omitted
entity: lawn_mower.xxx   # optional alternative to device
show_camera: true        # optional (default true)
show_joystick: true      # optional (default true)
show_settings: true      # optional (default true)
```

If you have **more than one** mower, set `device:` (or any one `entity:` of that mower) so the card knows which one to build.

### Layout

The card uses two responsive columns — camera + joystick on the left, all controls on the right. To see them side by side, give the card enough width: put it in a **Panel** dashboard (Settings → Dashboards → add view → *Panel (1 card)*) or any wide/full-width view. In a narrow column the two sections stack automatically.

## How it works

The card finds the mower's device and resolves every control by its entity's object-id suffix (e.g. `…_manual_driving`, `…_mowing_motor`, `move_forward`), so it keeps working regardless of the entity-id prefix or the interface language. The joystick is bundled in, so no extra resource is needed.

## License

MIT
