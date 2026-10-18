const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════════════
// Paprikachips Proeverij — game core (all server-side logic)
// Used by server.js (real Socket.io) and by the in-browser preview mock, so both
// behave identically. `io` only needs: io.on('connection'), io.emit() and
// io.sockets.sockets (Map of sockets with .data, .on(), .emit()).
// ══════════════════════════════════════════════════════════════════════════════
function attachGame(io) {
  // Minigames between the tasting rounds (every player plays on their own device
  // with the same seed; highest score wins 3/2/1 points).
  const MINIGAME_EVERY = 4;          // a minigame after every 4th product
  const MINIGAME_SEQUENCE = ['chip_eating', 'chipocalypse', 'bike_race'];
  const ARCADE_MAX = { chip_eating: 600, chipocalypse: 20000, bike_race: 450000 };
  const TASTE_KEYS = ['geur', 'stevigheid', 'smaak', 'textuur', 'uiterlijk', 'nasmaak'];
  const MAX_PRODUCTS = 20;

  const state = {
    mode: 'tasting',           // 'tasting' (default: tasting + blind guess + minigames) | 'minigames' (minigames only)
    phase: 'setup',            // setup → tasting → scoreboard → (minigame) → … → results
    host: null,
    players: {},
    fuets: [],                 // products entered by the host: { id, name, price }
    shuffledOrder: [],         // rounds: { id: 'r0', fuetId, name, price }  (name/price hidden until revealed)
    currentFuetIdx: 0,
    ratedPlayers: {},          // roundId → [names who submitted rating + guess]
    scores: {},                // roundId → { name: { geur…, prijs } }
    guesses: {},               // roundId → { name: fuetId | null }   (hidden until revealed)
    comments: {},              // roundId → [{ name, text, t }]
    blindScores: {},           // name → number of correct blind guesses
    blindResults: {},          // roundId → { correct: [names] }
    minigame: null,
    minigameScores: {},
    minigameIdx: 0,
  };
  let _mgTimer = null;

  // ── Visibility: which rounds are revealed to the players ───────────────────
  function revealedUpTo() {
    if (state.phase === 'results') return Infinity;
    if (state.phase === 'scoreboard' || state.phase === 'minigame') return state.currentFuetIdx;
    if (state.phase === 'tasting') return state.currentFuetIdx - 1;
    return -1;
  }
  function publicState(forName) {
    const upTo = revealedUpTo();
    const revealed = (i) => i <= upTo;
    const rest = {};
    Object.keys(state).forEach(k => { if (!['fuets', 'shuffledOrder', 'guesses', 'comments', 'blindResults'].includes(k)) rest[k] = state[k]; });
    const pub = Object.assign(rest, {
      fuets: state.fuets.map(f => ({ id: f.id, name: f.name })),                      // names only: these are the answer options
      shuffledOrder: state.shuffledOrder.map((r, i) => revealed(i) ? { id: r.id, fuetId: r.fuetId, name: r.name, price: r.price, bin: r.bin } : (i <= state.currentFuetIdx ? { id: r.id, bin: r.bin } : { id: r.id })),   // the bakje number of the current round is public; the contents are not
      guesses: {}, comments: {}, blindResults: {},
    });
    const cur = state.shuffledOrder[state.currentFuetIdx];
    if (state.phase === 'tasting' && cur && forName && (state.ratedPlayers[cur.id] || []).includes(forName)) pub.comments[cur.id] = state.comments[cur.id] || [];   // you may chat about the current chips once you've rated it
    state.shuffledOrder.forEach((r, i) => {
      if (!revealed(i)) return;
      pub.guesses[r.id] = state.guesses[r.id] || {};
      pub.comments[r.id] = state.comments[r.id] || [];
      if (state.blindResults[r.id]) pub.blindResults[r.id] = state.blindResults[r.id];
    });
    if (forName && forName === state.host) { pub.hostFuets = state.fuets; }               // only the host sees the prices up front
    return pub;
  }
  function broadcast() {
    const map = io.sockets && io.sockets.sockets;
    if (map && typeof map.forEach === 'function') map.forEach(s => s.emit('stateUpdate', publicState(s.data && s.data.name)));
  }

  function connectedNames() { return Object.entries(state.players).filter(([, p]) => p.connected).map(([n]) => n); }
  function curRound() { return state.shuffledOrder[state.currentFuetIdx]; }
  function rnd(n) {                                                  // unbiased random int in [0, n)
    try { const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || require('crypto').webcrypto; const u = new Uint32Array(1); c.getRandomValues(u); return Math.floor(u[0] / 4294967296 * n); }
    catch (e) { return Math.floor(Math.random() * n); }
  }
  function shuffleArray(arr) {
    let a = [...arr];
    for (let attempt = 0; attempt < 20; attempt++) {                  // Fisher-Yates; never return the entered order (when 2+ items)
      a = [...arr];
      for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
      if (arr.length < 2 || a.some((x, i) => x !== arr[i])) break;
    }
    return a;
  }
  function parsePrice(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    if (!isFinite(n) || n < 0) return null;
    return Math.min(99.99, Math.round(n * 100) / 100);
  }

  // ── Round flow ─────────────────────────────────────────────────────────────
  function advanceFuet() {
    state.minigame = null;
    if (state.currentFuetIdx < state.shuffledOrder.length - 1) { state.currentFuetIdx++; state.phase = 'tasting'; }
    else state.phase = 'results';
    broadcast();
  }
  function enterScoreboard() {
    if (state.phase !== 'tasting') return;
    const round = curRound();
    if (round && !state.blindResults[round.id]) {
      const g = state.guesses[round.id] || {};
      const correct = Object.keys(g).filter(n => g[n] === round.fuetId);
      state.blindResults[round.id] = { correct };
      correct.forEach(n => { state.blindScores[n] = (state.blindScores[n] || 0) + 1; });
    }
    state.phase = 'scoreboard';
    broadcast();
  }
  function usedFuetIds() {                     // products already revealed in earlier rounds
    const upTo = revealedUpTo();
    return state.shuffledOrder.filter((r, i) => i <= upTo).map(r => r.fuetId);
  }
  function submitScoreFor(name, payload) {
    if (state.phase !== 'tasting' || !name || !state.players[name]) return false;
    const round = curRound();
    const { fuetId, scores, guess } = payload || {};
    if (!round || fuetId !== round.id) return false;                     // only the current round, never stale
    const clean = {};
    TASTE_KEYS.forEach(k => { const v = Number(scores && scores[k]); clean[k] = isFinite(v) ? Math.max(0, Math.min(10, Math.round(v))) : 5; });
    const pv = Number(scores && scores.prijs);
    clean.prijs = isFinite(pv) ? Math.max(0, Math.min(5, Math.round(pv * 10) / 10)) : 2.5;
    if (!state.scores[round.id]) state.scores[round.id] = {};
    state.scores[round.id][name] = clean;
    if (!state.guesses[round.id]) state.guesses[round.id] = {};
    const valid = guess && state.fuets.some(f => f.id === guess) && !usedFuetIds().includes(guess);
    state.guesses[round.id][name] = valid ? guess : null;
    if (!state.ratedPlayers[round.id]) state.ratedPlayers[round.id] = [];
    if (!state.ratedPlayers[round.id].includes(name)) state.ratedPlayers[round.id].push(name);
    broadcast();
    return true;
  }

  // ── Minigame helpers ───────────────────────────────────────────────────────
  function startMinigame(type) {
    if (_mgTimer) { clearTimeout(_mgTimer); _mgTimer = null; }
    state.minigame = {
      type, status: 'intro', submissions: {}, stats: {},
      seed: Math.floor(Math.random() * 2147483647),
      results: null, pointsAwarded: {},
    };
    state.phase = 'minigame';
    broadcast();
  }
  function awardMinigamePoints(ranked) {
    const mg = state.minigame, pts = [3, 2, 1];
    mg.results = ranked; mg.pointsAwarded = {};
    ranked.forEach((name, i) => {
      const p = pts[i] || 0;
      mg.pointsAwarded[name] = p;
      if (p > 0) state.minigameScores[name] = (state.minigameScores[name] || 0) + p;
    });
    mg.status = 'reveal';
  }
  function revealMinigame() {
    const mg = state.minigame;
    if (!mg || mg.status === 'reveal') return;
    const subs = mg.submissions;
    const players = connectedNames().filter(n => subs[n] !== undefined);
    awardMinigamePoints([...players].sort((a, b) => subs[b] - subs[a]));      // highest score wins
    broadcast();
  }
  function submitMinigameFor(name, value, stats) {
    const mg = state.minigame;
    if (!name || !mg || !(mg.type in ARCADE_MAX) || mg.submissions[name] !== undefined) return;
    let v = parseFloat(value);
    if (isNaN(v)) return;
    v = Math.max(0, Math.min(ARCADE_MAX[mg.type], Math.round(v)));
    const clean = {};
    if (stats && typeof stats === 'object') {
      Object.keys(stats).slice(0, 12).forEach(k => {
        const x = Number(stats[k]);
        if (/^[a-zA-Z]{1,16}$/.test(k) && isFinite(x)) clean[k] = Math.max(0, Math.min(100000, Math.round(x)));
      });
    }
    mg.stats[name] = clean;
    mg.submissions[name] = v;
    broadcast();
    if (connectedNames().every(n => mg.submissions[n] !== undefined)) setTimeout(() => revealMinigame(), 1200);
  }

  // ── Socket events ──────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const me = () => socket.data.name;
    const isHost = () => !!me() && me() === state.host;

    socket.on('join', ({ name, photoIdx, avatarUrl }) => {
      name = String(name || '').trim().slice(0, 30);
      if (!name) return;
      socket.data.name = name;
      if (!state.players[name]) state.players[name] = { photoIdx, connected: true, avatarUrl: avatarUrl || null };
      else {
        state.players[name].connected = true;
        state.players[name].photoIdx = photoIdx;
        if (avatarUrl) state.players[name].avatarUrl = avatarUrl;
      }
      if (!state.host || !state.players[state.host]) state.host = name;        // first player becomes host
      broadcast();
    });

    socket.on('renameMe', ({ name }) => {
      const old = me();
      name = String(name || '').trim().slice(0, 30);
      if (!old || !state.players[old]) return;
      if (!name || name === old) { socket.emit('renamed', { name: old }); return; }
      if (state.players[name]) { socket.emit('renameError', { message: 'Die naam is al in gebruik' }); return; }
      const mv = (o) => { if (o && Object.prototype.hasOwnProperty.call(o, old)) { o[name] = o[old]; delete o[old]; } };
      const arr = (a) => { const i = a.indexOf(old); if (i >= 0) a[i] = name; };
      mv(state.players); if (state.host === old) state.host = name;
      Object.values(state.ratedPlayers).forEach(arr);
      Object.values(state.scores).forEach(mv); Object.values(state.guesses).forEach(mv);
      Object.values(state.comments).forEach(list => list.forEach(c => { if (c.name === old) c.name = name; }));
      mv(state.blindScores); Object.values(state.blindResults).forEach(r => arr(r.correct || []));
      mv(state.minigameScores);
      const mg = state.minigame;
      if (mg) { mv(mg.submissions); mv(mg.stats); mv(mg.pointsAwarded); if (Array.isArray(mg.results)) arr(mg.results); }
      socket.data.name = name;
      socket.emit('renamed', { name });
      broadcast();
    });

    socket.on('leaveGame', () => {
      const n = me();
      if (!n || !state.players[n]) return;
      if (state.phase === 'setup') {
        delete state.players[n];
        if (state.host === n) state.host = Object.keys(state.players).find(k => state.players[k].connected) || Object.keys(state.players)[0] || null;
      } else state.players[n].connected = false;
      socket.data.name = null;
      broadcast();
    });

    socket.on('disconnect', () => {
      const n = me();
      if (n && state.players[n]) { state.players[n].connected = false; broadcast(); }
    });

    // ── Host-only: products, start, kick, reset, skip ──
    socket.on('addFuet', ({ name, price, bin }) => {
      if (!isHost() || state.phase !== 'setup') return;
      name = String(name || '').trim().slice(0, 40);
      if (!name || state.fuets.length >= MAX_PRODUCTS) return;
      const used = new Set(state.fuets.map(f => f.bin));
      let b = parseInt(bin, 10);
      if (!isFinite(b) || b < 1 || b > 99) { b = 1; while (used.has(b)) b++; }                      // no number given → next free bakje
      else if (used.has(b)) { socket.emit('fuetError', { message: 'Bakje ' + b + ' is al in gebruik' }); return; }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      state.fuets.push({ id, name, price: parsePrice(price), bin: b });
      broadcast();
    });
    socket.on('removeFuet', ({ id }) => {
      if (!isHost() || state.phase !== 'setup') return;
      state.fuets = state.fuets.filter(f => f.id !== id);
      broadcast();
    });
    socket.on('setMode', ({ mode }) => {
      if (!isHost() || state.phase !== 'setup' || !['tasting', 'minigames'].includes(mode) || state.mode === mode) return;
      state.mode = mode; state.minigameScores = {}; state.minigameIdx = 0;
      broadcast();
    });
    socket.on('startMinigameRun', () => {                     // minigames-only: play all games in a row, then the final standings
      if (!isHost() || state.phase !== 'setup' || state.mode !== 'minigames') return;
      state.minigameScores = {}; state.minigameIdx = 0;
      startMinigame(MINIGAME_SEQUENCE[state.minigameIdx++]);
    });
    socket.on('startTasting', () => {
      if (!isHost() || state.phase !== 'setup' || state.mode !== 'tasting' || !state.fuets.length) return;
      const shuffled = shuffleArray(state.fuets);
      state.shuffledOrder = shuffled.map((f, i) => ({ id: 'r' + i, fuetId: f.id, name: f.name, price: f.price, bin: f.bin }));
      Object.assign(state, { currentFuetIdx: 0, ratedPlayers: {}, scores: {}, guesses: {}, comments: {}, blindScores: {}, blindResults: {}, minigame: null, minigameScores: {}, minigameIdx: 0 });
      state.phase = 'tasting';
      broadcast();
    });
    socket.on('kickPlayer', ({ name }) => {
      if (!me() || !state.players[me()] || !state.players[name]) return;            // any player may remove another player
      delete state.players[name];
      Object.values(state.ratedPlayers).forEach(a => { const i = a.indexOf(name); if (i >= 0) a.splice(i, 1); });
      if (state.host === name) state.host = Object.keys(state.players).find(k => state.players[k].connected) || Object.keys(state.players)[0] || null;   // new host
      broadcast();
    });
    socket.on('setHost', ({ name }) => {
      if (!isHost() || !state.players[name]) return;
      state.host = name; broadcast();
    });
    socket.on('claimHost', () => {                       // fallback when the host's phone went offline
      const n = me();
      if (!n || !state.players[n]) return;
      const h = state.players[state.host];
      if (!h || !h.connected) { state.host = n; broadcast(); }
    });
    socket.on('nextFuet', () => { if (isHost()) advanceFuet(); });
    socket.on('resetGame', () => {
      if (!isHost()) return;
      if (_mgTimer) { clearTimeout(_mgTimer); _mgTimer = null; }
      Object.assign(state, {
        phase: 'setup', fuets: [], shuffledOrder: [], currentFuetIdx: 0, ratedPlayers: {}, scores: {},
        guesses: {}, comments: {}, blindScores: {}, blindResults: {}, minigame: null, minigameScores: {}, minigameIdx: 0,
      });
      broadcast();
    });

    // ── Everyone ──
    socket.on('submitScore', (payload) => { submitScoreFor(me(), payload); });

    socket.on('addComment', ({ rid, text }) => {
      const n = me();
      if (!n || !state.players[n]) return;
      const idx = state.shuffledOrder.findIndex(r => r.id === rid);
      const mayCurrent = state.phase === 'tasting' && idx === state.currentFuetIdx && (state.ratedPlayers[rid] || []).includes(n);
      if (idx < 0 || (idx > revealedUpTo() && !mayCurrent)) return;      // revealed products, or the current one after you've rated it
      text = String(text || '').trim().slice(0, 200);
      if (!text) return;
      if (!state.comments[rid]) state.comments[rid] = [];
      if (state.comments[rid].length >= 80) return;
      state.comments[rid].push({ name: n, text, t: Date.now() });
      broadcast();
    });

    socket.on('sendReaction', ({ emoji }) => {
      const n = me();
      if (!n) return;
      io.emit('reaction', { name: n, emoji: String(emoji || '').slice(0, 12), id: Date.now().toString(36) + Math.random().toString(36).slice(2) });
    });

    socket.on('advancePhase', () => {
      switch (state.phase) {
        case 'tasting': {
          const round = curRound();
          const rated = (round && state.ratedPlayers[round.id]) || [];
          const conn = connectedNames();
          if (conn.length && conn.every(n => rated.includes(n))) enterScoreboard();
          break;
        }
        case 'scoreboard': {
          const should = state.currentFuetIdx < state.shuffledOrder.length - 1 && (state.currentFuetIdx + 1) % MINIGAME_EVERY === 0;
          if (should) startMinigame(MINIGAME_SEQUENCE[state.minigameIdx++ % MINIGAME_SEQUENCE.length]);
          else advanceFuet();
          break;
        }
        case 'minigame':
          if (state.minigame && state.minigame.status === 'reveal') {
            if (state.mode === 'minigames') {
              if (state.minigameIdx < MINIGAME_SEQUENCE.length) startMinigame(MINIGAME_SEQUENCE[state.minigameIdx++]);
              else { state.minigame = null; state.phase = 'results'; broadcast(); }
            }
            else advanceFuet();
          }
          break;
      }
    });

    socket.on('advanceMinigame', () => {
      if (state.phase !== 'minigame' || !state.minigame) return;
      if (state.minigame.status === 'intro') { state.minigame.status = 'submit'; broadcast(); }
    });
    socket.on('submitMinigameResult', ({ value, stats }) => { submitMinigameFor(me(), value, stats); });
    socket.on('revealMinigame', () => { if (state.phase === 'minigame') revealMinigame(); });
  });

  // ── Dev helper (preview + tests only): simulate other players ──────────────
  function simulateOthers(names) {
    names = names || ['Rik', 'Bram', 'Gert Jan', 'Marten'];
    names.forEach(n => { if (!state.players[n]) state.players[n] = { photoIdx: 0, connected: true, avatarUrl: null }; else state.players[n].connected = true; });
    if (state.phase === 'tasting') {
      const round = curRound();
      const open = state.fuets.map(f => f.id).filter(id => !usedFuetIds().includes(id));
      names.forEach(n => {
        const s = {}; TASTE_KEYS.forEach(k => { s[k] = Math.round(Math.random() * 10); }); s.prijs = Math.round(Math.random() * 50) / 10;
        submitScoreFor(n, { fuetId: round.id, scores: s, guess: Math.random() < .35 ? round.fuetId : open[Math.floor(Math.random() * open.length)] });
      });
    } else if (state.phase === 'minigame' && state.minigame && state.minigame.status === 'submit') {
      names.forEach(n => submitMinigameFor(n, Math.round(Math.random() * 300), {}));
    }
    broadcast();
  }

  function resetAll() {                                  // preview/tests only: forget everybody
    if (_mgTimer) { clearTimeout(_mgTimer); _mgTimer = null; }
    Object.assign(state, {
      phase: 'setup', host: null, players: {}, fuets: [], shuffledOrder: [], currentFuetIdx: 0, ratedPlayers: {}, scores: {},
      guesses: {}, comments: {}, blindScores: {}, blindResults: {}, minigame: null, minigameScores: {}, minigameIdx: 0,
    });
    broadcast();
  }

  return { state, publicState, broadcast, simulateOthers, submitScoreFor, resetAll };
}
if (typeof module !== 'undefined' && module.exports) module.exports = attachGame;


attachGame(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Paprikachips server running on port ${PORT}`));
