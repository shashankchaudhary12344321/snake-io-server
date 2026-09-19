// ═══════════════════════════════════════════════════════════════
// SNAKE.IO — AUTHORITATIVE MULTIPLAYER SERVER
// ═══════════════════════════════════════════════════════════════
// This server owns the real game state (positions, collisions, food).
// Clients only ever SEND their input (turn angle + boost on/off) and
// RECEIVE the world snapshot — they never decide who died or who ate
// what. That's what makes this "zero lag" in the way Slither.io-style
// games actually achieve it: everyone sees the same authoritative
// truth, broadcast at a fixed rate, instead of each client guessing
// from a slow database sync.
//
// This server handles ONLY real-time gameplay (movement, collision,
// food, powerups). Login, shop, and leaderboard stay on Firebase as
// decided — this server doesn't touch that data at all.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // the game page can be hosted anywhere (Netlify, etc.)
  pingInterval: 5000,
  pingTimeout: 10000
});

app.get('/', (req, res) => res.send('Snake.IO game server is running.'));
app.get('/health', (req, res) => res.json({ ok: true, players: Object.keys(players).length }));

// ── CONSTANTS (mirrors the client's values so physics/sizing agree) ──
// IMPORTANT: these were previously tuned for a "huge unlimited map" request
// (12000x12000, 1100+ food items, 10 bots, 20 broadcasts/sec). That workload
// was too heavy for Railway's free/trial tier RAM+CPU limit, which is why the
// server kept getting "Killed" (out-of-memory) and crashing — every player's
// game would freeze whenever that happened. These numbers are now sized to
// comfortably fit a small free-tier instance while still feeling spacious.
const WW = 6000, WH = 6000;
const SEG_R = 11, HEAD_R = 14;
const BASE_SPD = 2.6, BOOST_SPD = 5.0;
const FOOD_N = 260, SPEC_N = 20, PU_N = 8;
const BOT_N = 6;
const GROWTH_CAP = 1.35, GROWTH_AT = 260;
const TICK_HZ = 20;           // server steps the simulation 20x/second (was 30 — lighter CPU load)
const BROADCAST_HZ = 12;      // world snapshot sent to clients 12x/second (was 20 — much less bandwidth/CPU per tick)
const WALL_MARGIN = 30;

function growthFactor(len) { return 1 + (GROWTH_CAP - 1) * (1 - Math.exp(-len / GROWTH_AT)); }
function collisionDistFor(snake) { return (HEAD_R + SEG_R * 0.72) * growthFactor(snake.segs.length); }
function headHeadDistFor(a, b) {
  const ga = growthFactor(a.segs.length), gb = growthFactor(b.segs.length);
  return HEAD_R * 1.5 * Math.max(ga, gb);
}
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function rand(min, max) { return min + Math.random() * (max - min); }

// ── WORLD STATE ──────────────────────────────────────────────────
const players = {};   // socket.id -> player snake
const bots = {};       // botId -> bot snake
let foods = [];
let specFoods = [];
let powerUps = [];
let nextFoodId = 1, nextPuId = 1;

const FOOD_COLORS = [
  { c: '#dd1100', g: '#ff2200' }, { c: '#0055cc', g: '#0077ff' }, { c: '#007722', g: '#009933' },
  { c: '#770077', g: '#aa00aa' }, { c: '#cc5500', g: '#ff7700' }, { c: '#006688', g: '#0099bb' },
  { c: '#885500', g: '#bb8800' }, { c: '#550088', g: '#8800cc' },
];
const SNAKE_COLORS = ['#0077cc','#00aa44','#aa00aa','#cc2200','#cc7700','#008877','#cc0055','#5500cc'];
const BOT_NAMES = ['DragonFang','CyberViper','GhostWorm','NeonCoil','AcidSlider','BlazeKing','IceQueen','ShadowScale','ZeroSerpent','VoidFang'];

function addFood() {
  const fc = FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)];
  foods.push({
    id: nextFoodId++, x: rand(80, WW - 80), y: rand(80, WH - 80),
    r: rand(5, 9), val: Math.floor(Math.random() * 8) + 2,
    color: fc.c, glow: fc.g
  });
}
function foods_special_push() {
  specFoods.push({ id: nextFoodId++, x: rand(80, WW - 80), y: rand(80, WH - 80), r: 11, val: 30 });
}
function addPU() {
  const types = ['speed', 'shield', 'magnet', 'star'];
  powerUps.push({ id: nextPuId++, x: rand(80, WW - 80), y: rand(80, WH - 80), r: 15, type: types[Math.floor(Math.random() * types.length)] });
}
function spawnWorld() {
  for (let i = 0; i < FOOD_N; i++) addFood();
  for (let i = 0; i < SPEC_N; i++) foods_special_push();
  for (let i = 0; i < PU_N; i++) addPU();
}

function findSafeSpawn() {
  // simple retry-based spawn: pick a random point, reject if too close to any live head
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = rand(400, WW - 400), y = rand(400, WH - 400);
    let safe = true;
    for (const s of [...Object.values(players), ...Object.values(bots)]) {
      if (!s.alive) continue;
      if (dist2({ x, y }, s.segs[0]) < 300 * 300) { safe = false; break; }
    }
    if (safe) return { x, y };
  }
  return { x: rand(400, WW - 400), y: rand(400, WH - 400) };
}

function mkSnake(id, name, color, skin, x, y, isBot) {
  const a = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < 22; i++) segs.push({ x: x - Math.cos(a) * i * (SEG_R * 1.1), y: y - Math.sin(a) * i * (SEG_R * 1.1) });
  return {
    id, name, color, skin, segs, angle: a, targetAngle: a,
    alive: true, score: 0, kills: 0, isBot, boosting: false, spawnGrace: 75,
    pu_speed: 0, pu_shield: 0, pu_magnet: 0, pu_star: 0,
    foodTarget: null
  };
}

function spawnBots() {
  for (let i = 0; i < BOT_N; i++) {
    const id = 'bot_' + i;
    const sp = findSafeSpawn();
    bots[id] = mkSnake(id, BOT_NAMES[i % BOT_NAMES.length], SNAKE_COLORS[i % SNAKE_COLORS.length], 'default', sp.x, sp.y, true);
  }
}

// ── MOVEMENT ─────────────────────────────────────────────────────
function moveSnake(sn) {
  if (!sn.alive) return;
  if (sn.spawnGrace > 0) sn.spawnGrace--;
  const spd = sn.boosting ? BOOST_SPD : (BASE_SPD + (sn.pu_speed > 0 ? 1.4 : 0));
  let diff = sn.targetAngle - sn.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  sn.angle += Math.max(-0.11, Math.min(0.11, diff));
  const hd = sn.segs[0];
  let nx = hd.x + Math.cos(sn.angle) * spd;
  let ny = hd.y + Math.sin(sn.angle) * spd;
  nx = Math.max(WALL_MARGIN, Math.min(WW - WALL_MARGIN, nx));
  ny = Math.max(WALL_MARGIN, Math.min(WH - WALL_MARGIN, ny));
  sn.segs.unshift({ x: nx, y: ny });
  sn.segs.pop();
  ['pu_speed', 'pu_shield', 'pu_magnet', 'pu_star'].forEach(k => { if (sn[k] > 0) sn[k]--; });
}

function grow(sn, n) {
  const t = sn.segs[sn.segs.length - 1];
  for (let i = 0; i < n; i++) sn.segs.push({ ...t });
}

function eatFor(sn) {
  const er = (HEAD_R + 14) * growthFactor(sn.segs.length);
  const hd = sn.segs[0];
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    const rr = er + f.r;
    if (dist2(hd, f) < rr * rr) {
      sn.score += f.val; grow(sn, Math.ceil(f.val / 3));
      foods.splice(i, 1); addFood();
    }
  }
  for (let i = specFoods.length - 1; i >= 0; i--) {
    const f = specFoods[i];
    const rr = er + f.r;
    if (dist2(hd, f) < rr * rr) {
      sn.score += f.val; grow(sn, 10);
      specFoods.splice(i, 1);
      setTimeout(foods_special_push, 4000);
    }
  }
  for (let i = powerUps.length - 1; i >= 0; i--) {
    const pu = powerUps[i];
    const rr = er + pu.r;
    if (dist2(hd, pu) < rr * rr) {
      sn['pu_' + pu.type] = 360;
      powerUps.splice(i, 1);
      setTimeout(addPU, 9000);
    }
  }
}

// ── BOTS (simple AI, same behaviour as the old client-side bots) ──
let botFrame = 0;
function updateBots() {
  Object.values(bots).forEach(bot => {
    if (!bot.alive) {
      // respawn dead bots after a short delay
      if (!bot.respawnAt) bot.respawnAt = Date.now() + 3000;
      if (Date.now() >= bot.respawnAt) {
        const sp = findSafeSpawn();
        const fresh = mkSnake(bot.id, bot.name, bot.color, 'default', sp.x, sp.y, true);
        bots[bot.id] = fresh;
      }
      return;
    }
    if (botFrame % 5 === 0 || !bot.foodTarget) {
      let best = null, bd = Infinity;
      const bx = bot.segs[0].x, by = bot.segs[0].y;
      for (const f of foods) {
        const dx = f.x - bx, dy = f.y - by, d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = f; }
      }
      bot.foodTarget = best;
    }
    const best = bot.foodTarget;
    if (best) {
      const ta = Math.atan2(best.y - bot.segs[0].y, best.x - bot.segs[0].x);
      let diff = ta - bot.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Wall avoidance: bend the desired heading away from nearby edges
      const h = bot.segs[0], m = 300;
      let desiredAngle = bot.angle + diff;
      if (h.x < m) desiredAngle += 0.4; else if (h.x > WW - m) desiredAngle -= 0.4;
      if (h.y < m) desiredAngle += 0.4; else if (h.y > WH - m) desiredAngle -= 0.4;
      // Set the target heading directly — moveSnake() already smooths the turn
      // toward targetAngle by a fixed max-rate each tick, so we must NOT also
      // scale/multiply the turn here or the bot steers erratically.
      bot.targetAngle = desiredAngle;
      bot.boosting = Math.random() < 0.007;
    }
    moveSnake(bot);
    eatFor(bot);
  });
  botFrame++;
}

// ── SPATIAL GRID + COLLISION (same rules as before, now authoritative) ──
const GRID_CELL = 60;
function gridKey(x, y) { return ((x / GRID_CELL) | 0) + ',' + ((y / GRID_CELL) | 0); }
function buildSegGrid(arr) {
  const grid = new Map();
  arr.forEach(sn => {
    for (let i = 1; i < sn.segs.length; i++) {
      const seg = sn.segs[i];
      const k = gridKey(seg.x, seg.y);
      let bucket = grid.get(k);
      if (!bucket) { bucket = []; grid.set(k, bucket); }
      bucket.push({ sn, seg });
    }
  });
  return grid;
}
function forNearby(grid, x, y, cb) {
  const cx = (x / GRID_CELL) | 0, cy = (y / GRID_CELL) | 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const bucket = grid.get((cx + dx) + ',' + (cy + dy));
    if (bucket) for (let i = 0; i < bucket.length; i++) cb(bucket[i]);
  }
}

function killSnake(sn, killer) {
  if (!sn.alive) return;
  sn.alive = false;
  if (killer && killer.id !== sn.id) {
    killer.score += Math.floor(sn.segs.length * 1.6);
    killer.kills++;
  }
  // Scatter some of the dead snake's length as food. Capped against a hard
  // ceiling — this was previously uncapped, so on a server that stays up for
  // a while with many deaths, the foods array grew without bound (nothing
  // ever removes food that isn't eaten), eventually exhausting memory. That's
  // what caused the "Killed" crashes in the Railway logs.
  const FOOD_HARD_CAP = FOOD_N * 2;
  for (let i = 0; i < sn.segs.length && foods.length < FOOD_HARD_CAP; i += 3) {
    const t = sn.segs[i];
    const fc = FOOD_COLORS[i % FOOD_COLORS.length];
    foods.push({ id: nextFoodId++, x: t.x, y: t.y, r: rand(6, 9), val: 6, color: fc.c, glow: fc.g });
  }
  const sock = io.sockets.sockets.get(sn.id);
  if (sock) sock.emit('died', { killerName: killer ? killer.name : null, score: sn.score, kills: sn.kills });
}

function checkCollisions() {
  const arr = [...Object.values(players), ...Object.values(bots)].filter(s => s.alive);
  const toKill = [];
  const grid = buildSegGrid(arr);
  arr.forEach(sn => {
    if (!sn.alive || sn.spawnGrace > 0) return;
    const hd = sn.segs[0];
    for (let j = 0; j < arr.length; j++) {
      const other = arr[j];
      if (other.id === sn.id || !other.alive) continue;
      if (dist2(hd, other.segs[0]) < headHeadDistFor(sn, other) ** 2) {
        if (sn.pu_shield > 0) return;
        if (sn.segs.length <= other.segs.length) toKill.push({ sn, killer: other });
        return;
      }
    }
    if (sn.pu_shield > 0) return;
    let dead = false;
    forNearby(grid, hd.x, hd.y, ({ sn: other, seg }) => {
      if (dead || other.id === sn.id) return;
      const cd = collisionDistFor(other);
      if (dist2(hd, seg) < cd * cd) { dead = true; toKill.push({ sn, killer: other }); }
    });
  });
  const seen = new Set();
  toKill.forEach(({ sn, killer }) => {
    if (seen.has(sn.id)) return;
    seen.add(sn.id);
    killSnake(sn, killer);
  });
}

// ── GAME LOOP ────────────────────────────────────────────────────
function tick() {
  Object.values(players).forEach(p => { if (p.alive) { moveSnake(p); eatFor(p); } });
  updateBots();
  checkCollisions();
  // Safety net: if foods ever creeps above a sane ceiling for any reason,
  // trim the oldest entries back down. Cheap insurance against the kind of
  // slow memory growth that previously crashed the server.
  if (foods.length > FOOD_N * 2.2) foods.splice(0, foods.length - FOOD_N * 2);
}
setInterval(tick, 1000 / TICK_HZ);

// ── BROADCAST (thin snapshot — only what clients need to render) ──
function snapshot() {
  const all = { ...players, ...bots };
  const out = {};
  Object.values(all).forEach(sn => {
    // Cap how many segments get sent over the wire. A very long snake doesn't
    // need every trailing point broadcast to look right — this keeps payload
    // size (and therefore CPU/bandwidth) roughly constant even as snakes grow,
    // instead of scaling up with every player's length on every single tick.
    const MAX_SENT_SEGS = 120;
    const segs = sn.segs.length > MAX_SENT_SEGS
      ? sn.segs.filter((_, i) => i < 20 || i % 2 === 0).slice(0, MAX_SENT_SEGS)
      : sn.segs;
    out[sn.id] = {
      name: sn.name, color: sn.color, skin: sn.skin, alive: sn.alive,
      score: sn.score, kills: sn.kills,
      segs,
      pu_speed: sn.pu_speed, pu_shield: sn.pu_shield, pu_magnet: sn.pu_magnet, pu_star: sn.pu_star
    };
  });
  return { players: out, foods, specFoods, powerUps, ts: Date.now() };
}
setInterval(() => { io.emit('world', snapshot()); }, 1000 / BROADCAST_HZ);

// ── SOCKET HANDLING ──────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', data => {
    const sp = findSafeSpawn();
    const name = (data && data.name || 'Player').slice(0, 16);
    const color = (data && data.color) || SNAKE_COLORS[0];
    const skin = (data && data.skin) || 'default';
    players[socket.id] = mkSnake(socket.id, name, color, skin, sp.x, sp.y, false);
    socket.emit('joined', { id: socket.id, ww: WW, wh: WH });
  });

  socket.on('input', data => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.angle === 'number') p.targetAngle = data.angle;
    p.boosting = !!data.boosting;
  });

  socket.on('respawn', data => {
    const existing = players[socket.id];
    const name = (data && data.name) || (existing ? existing.name : 'Player');
    const color = (data && data.color) || (existing ? existing.color : SNAKE_COLORS[0]);
    const skin = (data && data.skin) || (existing ? existing.skin : 'default');
    const sp = findSafeSpawn();
    players[socket.id] = mkSnake(socket.id, name, color, skin, sp.x, sp.y, false);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
  });
});

spawnWorld();
spawnBots();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Snake.IO server listening on port ${PORT}`));
