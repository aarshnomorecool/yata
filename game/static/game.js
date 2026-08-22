// YATA game renderer.
//
// This file NEVER decides anything. It reads /api/state -- which mirrors the
// shared event log and repo_map.json that yata.py / interactive_flow.py
// write -- and, only when this client is the declared owner (gamer mode),
// forwards a click to /api/decision. All four-step decision logic lives in
// interactive_flow.py's single state machine.
//
// Every number shown in the HUD is derived from real assessment state
// (findings, patch outcomes, VALIDATOR's RISK_WEIGHTS, security score).
// Nothing here invents or simulates a value.

const CELL = 96;              // must match game/layout.py GRID_CELL_SIZE
const TILE = 32;              // dcss dungeon tiles are 32x32
const BUILDING_W = 84;
const BUILDING_H = 92;
const SPACING_X = 150;
const SPACING_Y = 172;

const WALL_TOP = 0;
const WALL_H = 260;           // dark brick backdrop band
const FLOOR_TOP = WALL_H;
const WALKWAY_H = 74;
const VILLAGE_TOP = FLOOR_TOP + 96;

const TIER_SPRITES = { imp: "monster_imp", hobgoblin: "monster_hobgoblin", demon: "monster_demon" };

// Real pixel-art buildings, one per building_type. A building with a live
// vulnerability is drawn as BROKEN_ART and reverts to its own art once
// VALIDATOR confirms the patch held -- the damage is driven by real state,
// not decoration.
// Only the pixel-art buildings are used. watchtower.png / watchtower2.png are
// photorealistic 3D renders and read as a different game next to these, so
// they stay in assets/ unused rather than breaking the visual language.
const BUILDING_ART = {
  "Townhall":     "b_townhall",
  "Market Stall": "b_house1",
  "The Vault":    "b_townhall",
  "Strongbox":    "b_house1",
  "Guild Hall":   "b_dungeon_house",
  "House":        "b_dungeon_house",
};
const BROKEN_ART = "b_broken_keyed";

// Rendered height per type; widths follow each source image's aspect ratio.
const BUILDING_HEIGHT = {
  "Townhall": 190,
  "The Vault": 170,
  "Strongbox": 170,
};
const DEFAULT_BUILDING_HEIGHT = 130;

const ROOF_TINT = {
  "Townhall": 0xf0c246,
  "Market Stall": 0xc98b3a,
  "The Vault": 0x8e7cc3,
  "Strongbox": 0x6fa8dc,
  "Guild Hall": 0x76a5af,
  "House": 0xa89070,
};

const LPC_IDLE = 130;

// Events are applied from a paced queue rather than all at once. On a live
// run a finding and its patch outcome can arrive in the same poll, which
// would spawn a demon and kill it in the same frame; pacing guarantees each
// beat is actually visible. ?replay=1 re-runs a finished event log from the
// start so a demo can be filmed without re-running the assessment.
const PARAMS = new URLSearchParams(location.search);
const REPLAY = PARAMS.get("replay") === "1";
const SPEED = Math.max(0.25, Math.min(parseFloat(PARAMS.get("speed") || "1"), 4));
const LIVE_EVENT_GAP = 700;
const REPLAY_EVENT_GAP = 1100;

let cursor = 0;
const owner = window.YATA_OWNER === true;
let village = [];
let edges = [];
let buildingIndex = {};
let activeFindingFile = null;
let lastPendingGeneration = 0;
let scene = null;
let riskWeights = {};
let xpPerRisk = 4;
let tierMap = {};
let eventQueue = [];
let drainTimer = null;
let paused = false;
let allEvents = [];

// Real, derived HUD state.
const stats = { threats: [], healed: 0, xp: 0, score: null, batteryText: null };

/* ------------------------------------------------------------------ HUD */

function logLine(text, highlight) {
  const log = document.getElementById("log");
  const line = document.createElement("div");
  if (highlight) line.className = "hl";
  line.textContent = text;
  log.appendChild(line);
  while (log.children.length > 200) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function bountyFor(vulnerabilityType) {
  const risk = riskWeights[vulnerabilityType] || 20;
  return risk * xpPerRisk;
}

function renderThreats() {
  const el = document.getElementById("threat-list");
  if (!stats.threats.length) {
    el.innerHTML = '<div class="empty">No threats confirmed yet.</div>';
    return;
  }
  el.innerHTML = "";
  stats.threats.forEach((t) => {
    const div = document.createElement("div");
    div.className = "threat" + (t.healed ? " healed" : "");
    div.innerHTML =
      `<div class="name">${t.healed ? "&#10003;" : "&#10007;"} ${t.type}</div>` +
      `<div class="meta">Severity: ${t.severity} | Bounty: +${bountyFor(t.type)} XP<br>${t.file}:${t.line}</div>`;
    el.appendChild(div);
  });
}

function renderStats() {
  const total = stats.threats.length;
  const totalXp = stats.threats.reduce((sum, t) => sum + bountyFor(t.type), 0);
  const level = 1 + Math.floor(stats.xp / 250);
  const spanStart = (level - 1) * 250;
  const pct = Math.max(0, Math.min(100, ((stats.xp - spanStart) / 250) * 100));

  document.getElementById("xp-level").textContent = level;
  document.getElementById("guild-level").textContent = "LV." + level;
  document.getElementById("xp-fill").style.width = pct + "%";
  document.getElementById("xp-text").textContent = `${stats.xp} / ${totalXp || 0} XP`;
  document.getElementById("stat-xp").textContent = stats.xp;
  document.getElementById("stat-healed").textContent = `${stats.healed}/${total}`;
  document.getElementById("stat-score").textContent = stats.score === null ? "--" : stats.score;
}

function drawMinimap() {
  const canvas = document.getElementById("minimap");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#05060c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!village.length) return;

  let maxCol = 0;
  let maxRow = 0;
  village.forEach((e) => {
    maxCol = Math.max(maxCol, e.x / CELL);
    maxRow = Math.max(maxRow, e.y / CELL);
  });
  const stepX = canvas.width / (maxCol + 2);
  const stepY = canvas.height / (maxRow + 2);

  village.forEach((e) => {
    const b = buildingIndex[e.filename];
    const cx = (e.x / CELL + 1) * stepX;
    const cy = (e.y / CELL + 1) * stepY;
    ctx.fillStyle = b && b.demon ? "#ff5a3c" : "#5aa0ff";
    ctx.fillRect(cx - 3, cy - 3, 6, 6);
  });
}

/* ---------------------------------------------------------------- Phaser */

function preload() {
  // Purpose-built agent sheets (832x1344 = the standard LPC 13x21 grid).
  const ch = "/assets/characters/portraits";
  this.load.spritesheet("agent_archer", `${ch}/hunter.png`, { frameWidth: 64, frameHeight: 64 });
  this.load.spritesheet("agent_sage", `${ch}/healer.png`, { frameWidth: 64, frameHeight: 64 });
  this.load.spritesheet("agent_knight", `${ch}/validator.png`, { frameWidth: 64, frameHeight: 64 });
  this.load.spritesheet("agent_scholar", `${ch}/scholar.png`, { frameWidth: 64, frameHeight: 64 });

  this.load.image("monster_imp", "/assets/monsters/tier1_goblin/dcss_goblins/goblin.png");
  this.load.image("monster_hobgoblin", "/assets/monsters/tier2_orc/dcss_orcs/orc.png");
  this.load.image("monster_demon", "/assets/monsters/tier3_troll/dcss_trolls_ogres/ogre.png");
  this.load.image("boss", "/assets/monsters/tier4_dragon/dcss_dragons/fire_dragon.png");
  this.load.image("fire_overlay", "/assets/ui/dcss_icons/spell_icons/fireball.png");

  const dg = "/assets/environment/dungeon/dcss_dungeon_tiles";
  this.load.image("wall_brick", `${dg}/wall/brick_dark_1_0.png`);
  this.load.image("floor_dark", `${dg}/floor/black_cobalt01.png`);
  this.load.image("walkway", `${dg}/floor/cobble_blood1.png`);
  for (let i = 0; i < 6; i++) {
    this.load.image(`lava${i}`, `${dg}/floor/lava0${i}.png`);
  }
  this.load.image("column", `${dg}/statues/depths_column.png`);
  this.load.image("statue", `${dg}/statues/metal_statue.png`);
  this.load.image("fountain", `${dg}/decor/sparkling_fountain.png`);
  this.load.image("altar", `${dg}/altars/ecumenical.png`);

  const bd = "/assets/buildings";
  this.load.image("b_townhall", `${bd}/dungeon_townhall.png`);
  this.load.image("b_dungeon_house", `${bd}/dungeon_house.png`);
  this.load.image("b_house1", `${bd}/house1.png`);
  this.load.image("b_broken", `${bd}/broken_house.png`);

  this.load.image("icon_xp", "/assets/ui/dcss_icons/spell_icons/fireball.png");
  this.load.image("icon_heal", "/assets/ui/dcss_icons/potions/ruby.png");
  this.load.image("icon_shield", "/assets/ui/dcss_icons/shields/kite_shield1.png");
}

function worldWidth() {
  let cols = 6;
  village.forEach((e) => { cols = Math.max(cols, e.x / CELL + 1); });
  return Math.max(1500, 120 + cols * SPACING_X + 200);
}

function villageRows() {
  let rows = 1;
  village.forEach((e) => { rows = Math.max(rows, e.y / CELL + 1); });
  return rows;
}

// Walkway sits directly under the last building row and the lava trench
// closes the scene, so the whole composition stays compact enough to frame
// however many rows the repo produces.
function walkwayTop() {
  return VILLAGE_TOP + villageRows() * SPACING_Y + 16;
}

function worldHeight() {
  return walkwayTop() + WALKWAY_H + 132;
}

function drawEnvironment(sc) {
  const w = worldWidth();
  const h = worldHeight();
  const walkwayY = walkwayTop();
  // Overdraw sideways so the dungeon fills the viewport for a narrow repo.
  const bleed = 900;
  const bw = w + bleed * 2;

  sc.add.tileSprite(-bleed, WALL_TOP, bw, WALL_H, "wall_brick").setOrigin(0, 0);
  sc.add.tileSprite(-bleed, FLOOR_TOP, bw, h - FLOOR_TOP, "floor_dark").setOrigin(0, 0);
  sc.add.tileSprite(-bleed, walkwayY, bw, WALKWAY_H, "walkway").setOrigin(0, 0);

  const lava = sc.add.tileSprite(-bleed, walkwayY + WALKWAY_H, bw, 132, "lava0").setOrigin(0, 0);
  // A tileSprite can't run an animation, so cycle its texture on a timer.
  let lavaFrame = 0;
  sc.time.addEvent({
    delay: 170,
    loop: true,
    callback: () => {
      lavaFrame = (lavaFrame + 1) % 6;
      lava.setTexture(`lava${lavaFrame}`);
    },
  });

  // Torch placeholders along the wall -- glow only, real torch art pending.
  for (let x = -bleed + 120; x < w + bleed; x += 240) {
    const glow = sc.add.circle(x, WALL_H - 96, 16, 0xffb347, 0.5);
    sc.tweens.add({ targets: glow, alpha: 0.16, scale: 1.25, duration: 900, yoyo: true, repeat: -1 });
    sc.add.circle(x, WALL_H - 96, 5, 0xfff0b0, 0.95);
  }

  // Ambient dressing stands on the walkway, kept right of the agent roster.
  const walkY = walkwayY + WALKWAY_H - 8;
  sc.add.image(w * 0.60, walkY, "statue").setOrigin(0.5, 1).setScale(1.4);
  sc.add.image(w * 0.72, walkY, "fountain").setOrigin(0.5, 1).setScale(1.4);
  sc.add.image(w * 0.84, walkY, "altar").setOrigin(0.5, 1).setScale(1.4);
  for (let x = -bleed + 80; x < w + bleed; x += 300) {
    sc.add.image(x, FLOOR_TOP + 6, "column").setOrigin(0.5, 0).setScale(1.3).setAlpha(0.8);
  }

  return { width: w, height: h, walkwayY };
}

function drawAgents(sc, walkwayY) {
  const roster = [
    { key: "agent_archer", label: "HUNTER" },
    { key: "agent_sage", label: "HEALER" },
    { key: "agent_knight", label: "VALIDATOR" },
    { key: "agent_scholar", label: "SCHOLAR" },
  ];
  roster.forEach((agent, i) => {
    const x = 180 + i * 130;
    const y = walkwayY + WALKWAY_H - 8;
    sc.add.ellipse(x, y + 2, 44, 14, 0x000000, 0.35);
    sc.add.sprite(x, y, agent.key, LPC_IDLE).setOrigin(0.5, 1).setScale(1.5);
    const label = sc.add.text(x, y - 96, agent.label, {
      fontFamily: "Courier New", fontSize: "11px", color: "#0d0a07",
      backgroundColor: "#f0c246", padding: { x: 4, y: 1 },
    }).setOrigin(0.5, 0);
    label.setDepth(3);
  });
}

// broken_house.png ships with an opaque black background rather than
// transparency, which renders as a black slab behind the ruins. Key the
// near-black pixels out once at startup into a derived texture.
function keyOutBlack(sc, srcKey, outKey, threshold) {
  threshold = threshold || 28;
  if (sc.textures.exists(outKey)) return;
  const source = sc.textures.get(srcKey).getSourceImage();
  const canvasTexture = sc.textures.createCanvas(outKey, source.width, source.height);
  const ctx = canvasTexture.getContext();
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, source.width, source.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < threshold && data[i + 1] < threshold && data[i + 2] < threshold) {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(image, 0, 0);
  canvasTexture.refresh();
}

// Scale a sprite to a target height, preserving its source aspect ratio.
function scaleToHeight(sprite, height) {
  const ratio = sprite.width ? sprite.height / sprite.width : 1;
  sprite.setDisplaySize(height / ratio, height);
}

function drawVillage(sc, initial) {
  village = initial.village || [];
  edges = initial.edges || [];
  buildingIndex = {};

  village.forEach((entry) => {
    const col = entry.x / CELL;
    const row = entry.y / CELL;
    const x = 140 + col * SPACING_X;
    const y = VILLAGE_TOP + row * SPACING_Y;

    const artKey = BUILDING_ART[entry.building_type] || "b_dungeon_house";
    const height = BUILDING_HEIGHT[entry.building_type] || DEFAULT_BUILDING_HEIGHT;
    const baseY = y + BUILDING_H;   // every building stands on a common baseline

    const sprite = sc.add.image(x + BUILDING_W / 2, baseY, artKey).setOrigin(0.5, 1);
    scaleToHeight(sprite, height);
    sc.add.ellipse(x + BUILDING_W / 2, baseY + 3, sprite.displayWidth * 0.8, 14, 0x000000, 0.35).setDepth(-1);

    const plate = sc.add.text(x + BUILDING_W / 2, baseY + 10, entry.filename.split(/[\\/]/).pop(), {
      fontFamily: "Courier New", fontSize: "10px", color: "#0d0a07",
      backgroundColor: "#c9a94e", padding: { x: 4, y: 1 },
    }).setOrigin(0.5, 0);
    plate.setDepth(3);
    sc.add.text(x + BUILDING_W / 2, baseY - height - 16, entry.building_type, {
      fontFamily: "Courier New", fontSize: "10px", color: "#9c8a68",
    }).setOrigin(0.5, 0);

    buildingIndex[entry.filename] = {
      x: x + BUILDING_W / 2,
      y: baseY - height / 2,
      top: baseY - height,
      bottom: baseY,
      height,
      sprite,
      artKey,
      demon: null,
      overlay: null,
    };
  });

  edges.forEach((edge) => {
    const from = buildingIndex[edge.from];
    const to = buildingIndex[edge.to];
    if (!from || !to) return;
    const villager = sc.add.circle(from.x, from.bottom + 22, 4, 0xd9c79b).setStrokeStyle(1, 0x2a1d10);
    sc.tweens.add({
      targets: villager, x: to.x, y: to.bottom + 22,
      duration: 2600 + Math.random() * 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut",
    });
  });
}

function fitCamera(sc, bounds) {
  const cam = sc.cameras.main;
  const raw = Math.min(cam.width / bounds.width, cam.height / bounds.height);
  cam.setZoom(Math.max(0.5, Math.min(raw, 1.3)));
  cam.centerOn(bounds.width / 2, bounds.height / 2);

  sc.input.on("pointermove", (pointer) => {
    if (!pointer.isDown) return;
    cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
    cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
  });
  sc.input.on("wheel", (pointer, over, dx, dy) => {
    cam.setZoom(Phaser.Math.Clamp(cam.zoom - dy * 0.0012, 0.28, 2.2));
  });
}

/* ------------------------------------------------------- event rendering */

function spawnDemon(sc, filename, vulnerabilityType, tierMap) {
  const building = buildingIndex[filename];
  if (!building) return;
  const tier = tierMap[vulnerabilityType] || "imp";
  const spriteKey = TIER_SPRITES[tier] || "monster_imp";

  if (building.demon) building.demon.destroy();
  if (building.overlay) building.overlay.destroy();

  // The building itself takes damage while the vulnerability is live.
  if (building.sprite) {
    building.sprite.setTexture(BROKEN_ART);
    scaleToHeight(building.sprite, building.height);
  }

  building.demon = sc.add.image(building.x + BUILDING_W * 0.62, building.bottom, spriteKey)
    .setOrigin(0.5, 1).setDisplaySize(40, 40).setDepth(2);
  building.overlay = sc.add.image(building.x, building.y + 8, "fire_overlay")
    .setOrigin(0.5, 0.5).setDisplaySize(58, 58).setAlpha(0.9).setDepth(2);
  sc.tweens.add({ targets: building.overlay, alpha: 0.5, duration: 620, yoyo: true, repeat: -1 });
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

  // Patch held -- the building is rebuilt back to its own art.
  if (building.sprite && building.artKey) {
    building.sprite.setTexture(building.artKey);
    scaleToHeight(building.sprite, building.height);
    building.sprite.setAlpha(0.35);
    sc.tweens.add({ targets: building.sprite, alpha: 1, duration: 650 });
  }
  if (activeFindingFile === filename) activeFindingFile = null;
}

function flashBypass(sc, filename) {
  const building = buildingIndex[filename];
  if (!building || !building.overlay) return;
  building.overlay.setAlpha(1);
  sc.tweens.add({ targets: building.overlay, alpha: 0.85, duration: 380, yoyo: true, repeat: 1 });
  if (building.demon) sc.tweens.add({ targets: building.demon, scale: 1.4, duration: 200, yoyo: true });
}

function describeEvent(evt) {
  switch (evt.event_type) {
    case "run_started": return [`[SYSTEM] Assessment started (${evt.mode} mode)`, true];
    case "run_aborted": return [`[SYSTEM] Aborted by user at round ${evt.round}`, true];
    case "finding_confirmed": return [`[HUNTER] ${evt.vulnerability_type} confirmed -- ${evt.file}:${evt.line_number}`, true];
    case "patch_outcome": return [`[VALIDATOR] Patch ${evt.succeeded ? "HELD" : "FAILED"} -- ${evt.file}`, false];
    case "human_choice": return [`[HUMAN] chose: ${evt.choice}`, false];
    case "step_shown":
      if (evt.step === 1) return [`STEP 1/4 Finding Confirmed -- ${evt.vulnerability_type}`, false];
      if (evt.step === 2) return [`STEP 2/4 Patch Generated -- ${evt.strategy}`, false];
      if (evt.step === 3) return [`STEP 3/4 MUTATOR ${evt.battery_blocked}/${evt.battery_total} blocked`, true];
      if (evt.step === 4) return [`STEP 4/4 Applied -- score ${evt.score_before} -> ${evt.score_after}`, true];
      if (evt.step === "3-exception") return [`[MUTATOR] ${evt.bypasses}/${evt.total} bypasses SURVIVED`, true];
      return [`step ${evt.step}`, false];
    default: return [evt.event_type, false];
  }
}

function applyEvent(sc, evt) {
  const [text, hl] = describeEvent(evt);
  logLine(text, hl);

  if (evt.event_type === "finding_confirmed") {
    spawnDemon(sc, evt.file, evt.vulnerability_type, tierMap);
    stats.threats.push({
      type: evt.vulnerability_type, severity: evt.severity || "UNKNOWN",
      file: evt.file, line: evt.line_number, healed: false,
    });
  } else if (evt.event_type === "patch_outcome") {
    if (evt.succeeded) {
      fadeOutFinding(sc, evt.file);
      const threat = stats.threats.find((t) => t.file === evt.file && !t.healed);
      if (threat) {
        threat.healed = true;
        stats.healed += 1;
        stats.xp += bountyFor(threat.type);
      }
    }
  } else if (evt.event_type === "step_shown") {
    if (evt.step === 4 && typeof evt.score_after === "number") stats.score = evt.score_after;
    if (evt.step === 3 && evt.battery_total > 0 && evt.battery_blocked < evt.battery_total && activeFindingFile) {
      flashBypass(sc, activeFindingFile);
    }
    if (evt.step === "3-exception" && activeFindingFile) flashBypass(sc, activeFindingFile);
  }

  renderThreats();
  renderStats();
  drawMinimap();
}

function enqueueEvents(events) {
  if (!events || !events.length) return;
  eventQueue.push(...events);
  updateReplayStatus();
}

function startDrain(sc) {
  if (drainTimer) return;
  const gap = (REPLAY ? REPLAY_EVENT_GAP : LIVE_EVENT_GAP) / SPEED;
  drainTimer = setInterval(() => {
    if (paused || !eventQueue.length) return;
    applyEvent(sc, eventQueue.shift());
    updateReplayStatus();
  }, gap);
}

function resetSceneState() {
  stats.threats = [];
  stats.healed = 0;
  stats.xp = 0;
  stats.score = null;
  Object.values(buildingIndex).forEach((b) => {
    if (b.demon) { b.demon.destroy(); b.demon = null; }
    if (b.overlay) { b.overlay.destroy(); b.overlay = null; }
  });
  activeFindingFile = null;
  document.getElementById("log").innerHTML = "";
  renderThreats();
  renderStats();
  drawMinimap();
}

function restartReplay() {
  eventQueue = allEvents.slice();
  resetSceneState();
  paused = false;
  updateReplayStatus();
}

function updateReplayStatus() {
  const el = document.getElementById("replay-status");
  if (!el) return;
  const done = allEvents.length - eventQueue.length;
  el.textContent = `${done}/${allEvents.length}`;
  const btn = document.getElementById("replay-pause");
  if (btn) btn.textContent = paused ? "PLAY" : "PAUSE";
}

/* ------------------------------------------------------------- decisions */

function setParchmentVisible(visible) {
  const overlay = document.getElementById("parchment-overlay");
  const scrim = document.getElementById("scrim");
  overlay.style.display = visible ? "flex" : "none";
  if (scrim) scrim.classList.toggle("on", visible);
  if (visible) {
    // restart the scale-in so each new decision reads as a distinct beat
    overlay.style.animation = "none";
    void overlay.offsetWidth;
    overlay.style.animation = "";
  }
}

function renderPending(pending) {
  const overlay = document.getElementById("parchment-overlay");
  if (!owner || !pending) { setParchmentVisible(false); return; }
  if (pending.generation === lastPendingGeneration) return;
  lastPendingGeneration = pending.generation;

  const isException = pending.message.indexOf("failed re-attack") !== -1;
  overlay.classList.toggle("exception", isException);
  overlay.querySelector("#parchment-message").textContent = pending.message;

  const choicesEl = overlay.querySelector("#parchment-choices");
  choicesEl.innerHTML = "";
  pending.choices.forEach((choice) => {
    if (choice.value === "view") return;   // diff already streams into the log
    const btn = document.createElement("button");
    btn.textContent = choice.name;
    btn.onclick = () => {
      setParchmentVisible(false);
      fetch("/api/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: choice.value }),
      });
    };
    choicesEl.appendChild(btn);
  });
  setParchmentVisible(true);
}

/* ------------------------------------------------------------ scene wiring */

function create() {
  scene = this;
  const initial = window.__yataInitial;
  riskWeights = initial.risk_weights || {};
  xpPerRisk = initial.xp_per_risk_point || 4;

  keyOutBlack(this, "b_broken", "b_broken_keyed");

  village = initial.village || [];
  const bounds = drawEnvironment(this);
  drawVillage(this, initial);
  drawAgents(this, bounds.walkwayY);
  this.add.image(worldWidth() - 120, bounds.walkwayY + WALKWAY_H - 8, "boss")
    .setOrigin(0.5, 1).setScale(1.7).setDepth(2);
  fitCamera(this, bounds);

  ["xp", "heal", "shield"].forEach((name) => {
    const img = document.getElementById("icon-" + name);
    if (img) img.src = this.textures.getBase64("icon_" + name);
  });

  tierMap = initial.tier_map || {};
  allEvents = (initial.events || []).slice();
  enqueueEvents(initial.events || []);
  startDrain(this);

  renderThreats();
  renderStats();
  drawMinimap();
  renderPending(initial.pending);
  cursor = initial.cursor || 0;

  setupReplayControls();

  setInterval(async () => {
    try {
      const res = await fetch(`/api/state?since=${cursor}`);
      const data = await res.json();
      cursor = data.cursor;
      if (data.tier_map) tierMap = data.tier_map;
      if (data.events && data.events.length) {
        allEvents.push(...data.events);
        enqueueEvents(data.events);
      }
      renderPending(data.pending);
    } catch (err) {
      // transient poll failure; next tick retries
    }
  }, 1000);
}

function setupReplayControls() {
  const bar = document.getElementById("replay-bar");
  if (!bar) return;
  bar.style.display = "flex";
  document.getElementById("replay-mode").textContent = REPLAY ? "REPLAY" : "LIVE";
  document.getElementById("replay-pause").onclick = () => {
    paused = !paused;
    updateReplayStatus();
  };
  document.getElementById("replay-restart").onclick = restartReplay;
  if (REPLAY) restartReplay();
  updateReplayStatus();
}

function bootstrap() {
  fetch("/api/state?since=0")
    .then((res) => res.json())
    .then((initial) => {
      window.__yataInitial = initial;
      window.__yataGame = new Phaser.Game({
        type: Phaser.AUTO,
        parent: "game-root",
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: "#0d0a07",
        pixelArt: true,
        scene: { preload, create },
      });
    });
}

bootstrap();
