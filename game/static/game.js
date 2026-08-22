// YATA game renderer. This file NEVER decides anything -- it only reads
// /api/state (which mirrors the shared event log + repo-map JSON that
// yata.py / interactive_flow.py write) and, only when this client is the
// declared owner (gamer mode), forwards a click to /api/decision. All
// four-step decision logic lives in interactive_flow.py's state machine.

const CELL = 96;
const BUILDING_SIZE = 64;
const OUTPOST_HEIGHT = 170;
const VILLAGE_TOP = OUTPOST_HEIGHT + 50;

const TIER_SPRITES = {
  imp: "monster_imp",
  hobgoblin: "monster_hobgoblin",
  demon: "monster_demon",
};

const BUILDING_COLORS = {
  "Townhall": 0xb08d57,
  "Market Stall": 0x6fa8dc,
  "The Vault": 0x8e7cc3,
  "Strongbox": 0xd9a441,
  "Guild Hall": 0x76a5af,
  "House": 0x93795c,
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
  return {
    x: 60 + entry.x,
    y: VILLAGE_TOP + entry.y,
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

  sc.add.text(20, VILLAGE_TOP - 26, "THE VILLAGE", { fontFamily: "monospace", fontSize: "14px", color: "#e8dcc4" });

  village.forEach((entry) => {
    const pos = layoutBuilding(entry);
    const color = BUILDING_COLORS[entry.building_type] || 0x77675a;
    const rect = sc.add.rectangle(pos.x + BUILDING_SIZE / 2, pos.y + BUILDING_SIZE / 2, BUILDING_SIZE, BUILDING_SIZE, color)
      .setStrokeStyle(2, 0x14100c);
    sc.add.text(pos.x, pos.y + BUILDING_SIZE + 2, entry.filename.split("/").pop(), { fontFamily: "monospace", fontSize: "9px", color: "#cbb98f" }).setOrigin(0, 0);
    sc.add.text(pos.x, pos.y - 12, entry.building_type, { fontFamily: "monospace", fontSize: "9px", color: "#8f8266" }).setOrigin(0, 0);

    buildingIndex[buildingKeyFor(entry.filename)] = {
      x: pos.x + BUILDING_SIZE / 2,
      y: pos.y + BUILDING_SIZE / 2,
      rect,
      demon: null,
      overlay: null,
    };
  });

  // Fixed two-point villager walk cycles, one per internal import edge.
  edges.forEach((edge) => {
    const from = buildingIndex[edge.from];
    const to = buildingIndex[edge.to];
    if (!from || !to) return;
    const villager = sc.add.circle(from.x, from.y - 40, 5, 0xd9c79b);
    sc.tweens.add({
      targets: villager,
      x: to.x,
      y: to.y - 40,
      duration: 2600 + Math.random() * 800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  });
}

function spawnDemon(sc, filename, vulnerabilityType, tierMap) {
  const building = buildingIndex[filename];
  if (!building) return;
  const tier = tierMap[vulnerabilityType] || "imp";
  const spriteKey = TIER_SPRITES[tier] || "monster_imp";

  if (building.demon) building.demon.destroy();
  if (building.overlay) building.overlay.destroy();

  building.demon = sc.add.image(building.x - 18, building.y - 18, spriteKey).setScale(1.2);
  building.overlay = sc.add.image(building.x, building.y, "fire_overlay").setScale(0.8).setAlpha(0.85);
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
  drawOutpost(this);
  drawVillage(this, window.__yataInitial);
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
      new Phaser.Game({
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
