// YATA game renderer. This file NEVER decides anything -- it only reads
// /api/state (which mirrors the shared event log + repo-map JSON that
// yata.py / interactive_flow.py write) and, only when this client is the
// declared owner (gamer mode), forwards a click to /api/decision. All
// four-step decision logic lives in interactive_flow.py's state machine.

const CELL = 96;            // must match game/layout.py GRID_CELL_SIZE
const TILE = 48;            // on-screen size of one Kenney 64x64 tile
const SPACING_X = 140;      // horizontal gap between building slots
const SPACING_Y = 172;      // vertical gap (buildings are 2 tiles tall + label)
const OUTPOST_HEIGHT = 190;
const VILLAGE_TOP = OUTPOST_HEIGHT + 56;

const TIER_SPRITES = {
  imp: "monster_imp",
  hobgoblin: "monster_hobgoblin",
  demon: "monster_demon",
};

// Buildings are composed from Kenney RPG-pack tiles: a roof tile stacked on
// a wall tile, with a door on the wall. Roof/wall/door vary per
// building_type so the six types read apart at a glance.
const BUILDING_STYLE = {
  "Townhall":     { roof: "roof_white", wall: "wall_stone", door: "door_double" },
  "Market Stall": { roof: "roof_brown", wall: "wall_beige", door: "door_wood" },
  "The Vault":    { roof: "roof_dark",  wall: "wall_stone", door: "door_dark" },
  "Strongbox":    { roof: "roof_steel", wall: "wall_stone", door: "door_plain" },
  "Guild Hall":   { roof: "roof_dark",  wall: "wall_beige", door: "door_wood" },
  "House":        { roof: "roof_brown", wall: "wall_beige", door: "door_plain" },
};
const DEFAULT_STYLE = BUILDING_STYLE["House"];

// Kenney RPGpack tile numbers, identified from the pack's own contact sheet.
const TILE_FILES = {
  grass:       "003",
  wall_beige:  "048",
  wall_stone:  "061",
  roof_brown:  "122",
  roof_dark:   "130",
  roof_white:  "144",
  roof_steel:  "153",
  door_wood:   "189",
  door_plain:  "210",
  door_dark:   "209",
  door_double: "214",
};

const LPC_FRAMES = {
  idle_down: 130,
  walk_down: { start: 130, end: 138 },
  walk_left: { start: 117, end: 125 },
};

let cursor = 0;
let owner = window.YATA_OWNER === true;
let repoName = window.YATA_REPO || "";
let village = [];
let edges = [];
let buildingIndex = {}; // filename -> {x, y, building_type, container, demon, overlay}
let activeFindingFile = null;
let lastPendingGeneration = 0;
let scene = null;

function logLine(text) {
  const log = document.getElementById("log");
  const line = document.createElement("div");
  line.textContent = text;
  log.appendChild(line);
  while (log.children.length > 200) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function describeEvent(evt) {
  if (evt.event_type === "run_started") return `Run started (${evt.mode} mode)`;
  if (evt.event_type === "run_aborted") return `Assessment aborted by user (round ${evt.round})`;
  if (evt.event_type === "finding_confirmed") return `HUNTER confirmed ${evt.vulnerability_type} in ${evt.file}:${evt.line_number}`;
  if (evt.event_type === "patch_outcome") return `Patch ${evt.succeeded ? "HEALED" : "FAILED"} -- ${evt.file}`;
  if (evt.event_type === "step_shown" && evt.step === 1) return `STEP 1/4 Finding Confirmed -- ${evt.vulnerability_type} (${evt.file})`;
  if (evt.event_type === "step_shown" && evt.step === 2) return `STEP 2/4 Patch Generated -- strategy: ${evt.strategy}`;
  if (evt.event_type === "step_shown" && evt.step === 3) return `STEP 3/4 Validating -- MUTATOR ${evt.battery_blocked}/${evt.battery_total} blocked`;
  if (evt.event_type === "step_shown" && evt.step === "3-exception") return `${evt.bypasses}/${evt.total} bypasses succeeded -- patch rejected`;
  if (evt.event_type === "step_shown" && evt.step === 4) return `STEP 4/4 Applied -- score ${evt.score_before} -> ${evt.score_after}`;
  if (evt.event_type === "human_choice") return `Human chose: ${evt.choice}`;
  return evt.event_type;
}

async function fetchState() {
  const res = await fetch(`/api/state?since=${cursor}`);
  return res.json();
}

function buildingKeyFor(filename) {
  return filename;
}

function layoutBuilding(entry) {
  // layout.py spaces slots by CELL; convert those to on-screen spacing that
  // fits a 2-tile-tall building plus its labels.
  const col = entry.x / CELL;
  const row = entry.y / CELL;
  return {
    x: 60 + col * SPACING_X,
    y: VILLAGE_TOP + row * SPACING_Y,
  };
}

function preload() {
  this.load.spritesheet("agent_archer", "/assets/characters/archer/lpc_archer_ranger_male.png", { frameWidth: 64, frameHeight: 64 });
  this.load.spritesheet("agent_sage", "/assets/characters/sage/lpc_wizard_male.png", { frameWidth: 64, frameHeight: 64 });
  this.load.spritesheet("agent_knight", "/assets/characters/knight/lpc_knight_steel_male.png", { frameWidth: 64, frameHeight: 64 });
  this.load.spritesheet("agent_scholar", "/assets/characters/scholar/lpc_scholar_female.png", { frameWidth: 64, frameHeight: 64 });

  this.load.image("monster_imp", "/assets/monsters/tier1_goblin/dcss_goblins/goblin.png");
  this.load.image("monster_hobgoblin", "/assets/monsters/tier2_orc/dcss_orcs/orc.png");
  this.load.image("monster_demon", "/assets/monsters/tier3_troll/dcss_trolls_ogres/ogre.png");
  this.load.image("fire_overlay", "/assets/ui/dcss_icons/spell_icons/fireball.png");

  const tileBase = "/assets/environment/town/kenney_rpg_pack/PNG/rpgTile";
  Object.entries(TILE_FILES).forEach(([key, number]) => {
    this.load.image(key, `${tileBase}${number}.png`);
  });
}

// Grass ground under the whole scene, so the map reads as a place rather
// than sprites floating on a flat background.
function contentBounds(entries) {
  let width = 1000;
  let height = VILLAGE_TOP + 180;
  entries.forEach((entry) => {
    const col = entry.x / CELL;
    const row = entry.y / CELL;
    width = Math.max(width, 60 + col * SPACING_X + TILE + 80);
    height = Math.max(height, VILLAGE_TOP + row * SPACING_Y + TILE * 2 + 80);
  });
  return { width, height };
}

function drawGround(sc, initial) {
  const entries = initial.village || [];
  const bounds = contentBounds(entries);
  // Overdraw well past the content so grass still fills the viewport when the
  // village is narrow (a repo with few files) or when the camera is panned.
  const width = bounds.width + 2400;
  const height = bounds.height + 1600;
  sc.add.tileSprite(-1200, -800, width, height, "grass").setOrigin(0, 0).setTileScale(TILE / 64, TILE / 64);

  // Darken the Outpost band so it separates from the Village below.
  sc.add.rectangle(-1200, -800, width, OUTPOST_HEIGHT + 800, 0x14100c, 0.55).setOrigin(0, 0);
}

function drawOutpost(sc) {
  sc.add.text(20, 8, "THE OUTPOST", { fontFamily: "monospace", fontSize: "14px", color: "#e8dcc4" });

  const roster = [
    { key: "agent_archer", label: "HUNTER" },
    { key: "agent_sage", label: "HEALER" },
    { key: "agent_knight", label: "VALIDATOR" },
    { key: "agent_scholar", label: "LEARNER" },
  ];
  roster.forEach((agent, i) => {
    const x = 60 + i * 90;
    const y = 90;
    const sprite = sc.add.sprite(x, y, agent.key, LPC_FRAMES.idle_down).setScale(1.4);
    sc.add.text(x - 34, y + 34, agent.label, { fontFamily: "monospace", fontSize: "11px", color: "#e8dcc4" });
  });

  const archiveX = 60 + roster.length * 90 + 60;
  sc.add.rectangle(archiveX, 90, 90, 70, 0x5a4a33).setStrokeStyle(2, 0xd9a441);
  sc.add.text(archiveX - 42, 90 - 10, "Scholar's\nArchive", { fontFamily: "monospace", fontSize: "10px", color: "#e8dcc4" });

  const noticeX = archiveX + 110;
  sc.add.rectangle(noticeX, 90, 90, 70, 0x4a3d2a).setStrokeStyle(2, 0x76a5af);
  sc.add.text(noticeX - 46, 90 - 10, "Herald's\nNotice Board", { fontFamily: "monospace", fontSize: "10px", color: "#e8dcc4" });
}

function drawVillage(sc, initial) {
  village = initial.village || [];
  edges = initial.edges || [];
  buildingIndex = {};

  sc.add.text(20, VILLAGE_TOP - 30, "THE VILLAGE", { fontFamily: "monospace", fontSize: "14px", color: "#e8dcc4" });

  village.forEach((entry) => {
    const pos = layoutBuilding(entry);
    const style = BUILDING_STYLE[entry.building_type] || DEFAULT_STYLE;

    // Roof tile stacked on a wall tile, door centred on the wall.
    const roofY = pos.y;
    const wallY = pos.y + TILE;
    sc.add.image(pos.x, roofY, style.roof).setOrigin(0, 0).setDisplaySize(TILE, TILE);
    sc.add.image(pos.x, wallY, style.wall).setOrigin(0, 0).setDisplaySize(TILE, TILE);
    sc.add.image(pos.x + TILE / 2, wallY + TILE, style.door)
      .setOrigin(0.5, 1)
      .setDisplaySize(TILE * 0.5, TILE * 0.62);

    sc.add.text(pos.x + TILE / 2, pos.y - 22, entry.building_type, { fontFamily: "monospace", fontSize: "10px", color: "#a08f6d" }).setOrigin(0.5, 0);
    sc.add.text(pos.x + TILE / 2, wallY + TILE + 4, entry.filename.split(/[\\/]/).pop(), { fontFamily: "monospace", fontSize: "10px", color: "#e0cfa4" }).setOrigin(0.5, 0);

    buildingIndex[buildingKeyFor(entry.filename)] = {
      x: pos.x + TILE / 2,
      y: pos.y + TILE,          // centre of the 2-tile-tall building
      top: pos.y,
      bottom: wallY + TILE,
      demon: null,
      overlay: null,
    };
  });

  // Fixed two-point villager walk cycles, one per internal import edge.
  edges.forEach((edge) => {
    const from = buildingIndex[edge.from];
    const to = buildingIndex[edge.to];
    if (!from || !to) return;
    const villager = sc.add.circle(from.x, from.bottom + 12, 4, 0xf0e0b8).setStrokeStyle(1, 0x4a3620);
    sc.tweens.add({
      targets: villager,
      x: to.x,
      y: to.bottom + 12,
      duration: 2600 + Math.random() * 800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  });
}

// Fit the scene into view. A one-file repo used to leave its single building
// stranded in a corner; scanning a large repo (many single-file directories,
// each starting its own row per the layout rule) makes a tall narrow map that
// would zoom out to something unreadable. So clamp the zoom to a legible
// range and let the viewer pan/wheel around anything that doesn't fit.
function fitCamera(sc) {
  const bounds = contentBounds(village);
  const cam = sc.cameras.main;
  const raw = Math.min(cam.width / bounds.width, cam.height / bounds.height);
  const zoom = Math.max(0.55, Math.min(raw, 1.4));
  cam.setZoom(zoom);
  cam.centerOn(bounds.width / 2, Math.min(bounds.height / 2, cam.height / zoom / 2));
  enableCameraControls(sc);
}

function enableCameraControls(sc) {
  const cam = sc.cameras.main;
  sc.input.on("pointermove", (pointer) => {
    if (!pointer.isDown) return;
    cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
    cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
  });
  sc.input.on("wheel", (pointer, over, dx, dy) => {
    const next = Phaser.Math.Clamp(cam.zoom - dy * 0.0012, 0.3, 2.4);
    cam.setZoom(next);
  });
}

function spawnDemon(sc, filename, vulnerabilityType, tierMap) {
  const building = buildingIndex[filename];
  if (!building) return;
  const tier = tierMap[vulnerabilityType] || "imp";
  const spriteKey = TIER_SPRITES[tier] || "monster_imp";

  if (building.demon) building.demon.destroy();
  if (building.overlay) building.overlay.destroy();

  // Demon stands beside the building; one generic fire overlay sits on it.
  building.demon = sc.add.image(building.x + TILE * 0.72, building.bottom - 10, spriteKey)
    .setOrigin(0.5, 1)
    .setDisplaySize(38, 38);
  building.overlay = sc.add.image(building.x, building.y + 6, "fire_overlay")
    .setOrigin(0.5, 0.5)
    .setDisplaySize(TILE * 0.95, TILE * 0.95)
    .setAlpha(0.9);
  sc.tweens.add({ targets: building.overlay, alpha: 0.55, duration: 620, yoyo: true, repeat: -1 });
  activeFindingFile = filename;
}

function fadeOutFinding(sc, filename) {
  const building = buildingIndex[filename];
  if (!building) return;
  [building.overlay, building.demon].forEach((obj) => {
    if (!obj) return;
    sc.tweens.add({ targets: obj, alpha: 0, duration: 700, onComplete: () => obj.destroy() });
  });
  building.overlay = null;
  building.demon = null;
  if (activeFindingFile === filename) activeFindingFile = null;
}

function flashBypass(sc, filename) {
  const building = buildingIndex[filename];
  if (!building || !building.overlay) return;
  building.overlay.setAlpha(1);
  sc.tweens.add({ targets: building.overlay, alpha: 0.85, duration: 400, yoyo: true, repeat: 1 });
  if (building.demon) {
    sc.tweens.add({ targets: building.demon, scale: 1.5, duration: 200, yoyo: true });
  }
}

function applyEvents(sc, events, tierMap) {
  events.forEach((evt) => {
    logLine(describeEvent(evt));
    if (evt.event_type === "finding_confirmed") {
      spawnDemon(sc, evt.file, evt.vulnerability_type, tierMap);
    } else if (evt.event_type === "patch_outcome") {
      if (evt.succeeded) fadeOutFinding(sc, evt.file);
    } else if (evt.event_type === "step_shown" && evt.step === 4) {
      // redundant safety net if patch_outcome was missed
    } else if (evt.event_type === "step_shown" && evt.step === 3 && evt.battery_total > 0 && evt.battery_blocked < evt.battery_total) {
      if (activeFindingFile) flashBypass(sc, activeFindingFile);
    } else if (evt.event_type === "step_shown" && evt.step === "3-exception") {
      if (activeFindingFile) flashBypass(sc, activeFindingFile);
    }
  });
}

function renderPending(pending) {
  const overlay = document.getElementById("parchment-overlay");
  if (!owner || !pending || pending.generation === lastPendingGeneration) {
    if (!owner || !pending) overlay.style.display = "none";
    return;
  }
  lastPendingGeneration = pending.generation;

  const isException = pending.message.indexOf("failed re-attack") !== -1;
  overlay.style.backgroundImage = isException
    ? "url(/assets/ui/dcss_icons/parchment/parchment_single_fire.png)"
    : "url(/assets/ui/dcss_icons/parchment/base_parchment_mid_level.png)";
  overlay.querySelector("#parchment-message").textContent = pending.message;

  const choicesEl = overlay.querySelector("#parchment-choices");
  choicesEl.innerHTML = "";
  pending.choices.forEach((choice) => {
    if (choice.value === "view") return; // diff is already visible in the log; no bridge round-trip needed
    const btn = document.createElement("button");
    btn.textContent = choice.name;
    btn.onclick = () => {
      overlay.style.display = "none";
      fetch("/api/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: choice.value }),
      });
    };
    choicesEl.appendChild(btn);
  });
  overlay.style.display = "flex";
}

function create() {
  scene = this;
  drawGround(this, window.__yataInitial);
  drawOutpost(this);
  drawVillage(this, window.__yataInitial);
  fitCamera(this);
  applyEvents(this, window.__yataInitial.events || [], window.__yataInitial.tier_map || {});
  renderPending(window.__yataInitial.pending);
  cursor = window.__yataInitial.cursor || 0;

  setInterval(async () => {
    try {
      const data = await fetchState();
      cursor = data.cursor;
      applyEvents(scene, data.events, data.tier_map);
      renderPending(data.pending);
    } catch (err) {
      // transient network error while polling; next tick retries.
    }
  }, 1000);
}

function bootstrap() {
  fetch(`/api/state?since=0`)
    .then((res) => res.json())
    .then((initial) => {
      window.__yataInitial = initial;
      window.__yataGame = new Phaser.Game({
        type: Phaser.AUTO,
        parent: "game-root",
        width: window.innerWidth,
        height: window.innerHeight - 40,
        backgroundColor: "#2b2118",
        scene: { preload, create },
      });
    });
}

bootstrap();
