const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ── Wildcard questions ────────────────────────────────────────────────────────
const WILDCARDS = [
  {q:"Eerste date-waardig?",       left:"Wegrennen 🏃", right:"Romantisch 💍"},
  {q:"Oma-approval rating",        left:"Schande 😤",   right:"Trots 🥹"},
  {q:"Tinder-worthy?",             left:"Hard links 👈", right:"Super-like ⭐"},
  {q:"Geschikt voor een kater?",   left:"Verkeerde keuze 💀", right:"Levensreddend 🏥"},
  {q:"Delen met de groep?",        left:"Voor mezelf 🤫", right:"Voor iedereen 🎉"},
  {q:"Midden in de nacht voor wakker worden?", left:"Nooit 😴", right:"Al onderweg 🚗"},
  {q:"Verdedigen als iemand dit aanvalt?", left:"Laat maar 🤷", right:"Ga ik voor 🥊"},
  {q:"Cadeau-waardig?",            left:"Nooit 🗑️",    right:"Onder de boom 🎁"},
];

// ── Quiz questions ────────────────────────────────────────────────────────────
const QUIZ_QUESTIONS = [
  { q: "Uit welk land komt de Bratwurst origineel?", options: ["Nederland", "Oostenrijk", "Duitsland", "Zwitserland"], correct: 2 },
  { q: "Wat is de ideale kerntemperatuur voor een gaar gegrilde worst?", options: ["55°C", "63°C", "72°C", "90°C"], correct: 2 },
  { q: "Welke stad is wereldberoemd om zijn Currywurst?", options: ["München", "Hamburg", "Berlijn", "Keulen"], correct: 2 },
  { q: "Hoe noem je het bruiningsproces van vlees op de grill?", options: ["Karamelisatie", "Maillard reactie", "Oxidatie", "Fermentatie"], correct: 1 },
  { q: "Hoeveel worstvarianten telt Duitsland officieel?", options: ["Meer dan 200", "Meer dan 500", "Meer dan 1000", "Meer dan 1500"], correct: 3 },
  { q: "Welk kruid is het meest kenmerkend in een Thüringer Rostbratwurst?", options: ["Tijm", "Majoraan", "Rozemarijn", "Salie"], correct: 1 },
  { q: "Van welk dier is de meeste Nederlandse rookworst gemaakt?", options: ["Koe", "Kip", "Schaap", "Varken"], correct: 3 },
  { q: "Wat maakt een grilworst 'knakken' als je erin bijt?", options: ["De darm", "Het vet", "Het zout", "De rook"], correct: 0 },
];

// ── Minigame sequence ─────────────────────────────────────────────────────────
const MINIGAME_SEQUENCE = ['bitterbal_catch', 'bitterbal_stack', 'bitterbal_slice', 'bitterbal_basket', 'saus_memory', 'bitterbal_bounce', 'mosterd_mikken'];
// Arcade games: every player plays on their own device with the same seed; highest score wins.
const ARCADE_TYPES = ['bitterbal_catch', 'bitterbal_basket', 'bitterbal_stack', 'mosterd_mikken', 'bitterbal_slice', 'saus_memory', 'bitterbal_bounce'];
const ARCADE_MAX = { bitterbal_catch: 20000, bitterbal_basket: 8000, bitterbal_stack: 4000, mosterd_mikken: 2000, bitterbal_slice: 3000, saus_memory: 13000, bitterbal_bounce: 6000 };

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  phase: 'setup',
  players: {},
  fuets: [],
  shuffledOrder: [],
  currentFuetIdx: 0,
  ratedPlayers: {},
  scores: {},
  quiz: null,
  quizIdx: 0,  // kept for compat, unused
  minigame: null,
  minigameScores: {},
  minigameIdx: 0,
};

let _quizTimer = null;
let _mgTimer = null;

function broadcast() { io.emit('stateUpdate', state); }

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startQuiz() {
  const q = QUIZ_QUESTIONS[state.quizIdx % QUIZ_QUESTIONS.length];
  state.quizIdx++;
  state.quiz = { ...q, answers: {}, revealed: false, startedAt: Date.now(), duration: 20000 };
  state.phase = 'quiz';
  broadcast();
  _quizTimer = setTimeout(() => { _quizTimer = null; revealQuiz(); }, 20000);
}

function checkAllAnswered() {
  const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
  if (!connected.length || !state.quiz) return;
  if (connected.every(n => state.quiz.answers[n] !== undefined)) {
    if (_quizTimer) { clearTimeout(_quizTimer); _quizTimer = null; }
    setTimeout(revealQuiz, 1500);
  }
}

function revealQuiz() {
  if (!state.quiz) return;
  state.quiz.revealed = true;
  broadcast();
}

function advanceFuet() {
  state.quiz = null;
  state.minigame = null;
  if (state.currentFuetIdx < state.shuffledOrder.length - 1) {
    state.currentFuetIdx++;
    state.phase = 'tasting';
  } else {
    state.phase = 'results';
  }
  broadcast();
}

function checkAdvance(fuetId) {
  const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
  if (!connected.length) return;
  const rated = state.ratedPlayers[fuetId] || [];
  if (!connected.every(n => rated.includes(n))) return;
  broadcast();
}

// ── Minigame helpers ──────────────────────────────────────────────────────────
function startMinigame(type) {
  if (_mgTimer) { clearTimeout(_mgTimer); _mgTimer = null; }
  state.minigame = {
    type,
    status: 'intro',
    startedAt: null,
    duration: null,
    submissions: {},
    stats: {},
    seed: Math.floor(Math.random() * 2147483647),
    curlingShots: {},
    results: null,
    pointsAwarded: {},
  };
  state.phase = 'minigame';
  broadcast();
}

function advanceMinigameStatus() {
  const mg = state.minigame;
  if (!mg) return;
  switch (mg.type) {
    case 'count_slices':
    case 'count_urker_jan':
    case 'perfect_slice':
    case 'bitterbal_catch':
    case 'bitterbal_basket':
    case 'bitterbal_stack':
    case 'mosterd_mikken':
    case 'bitterbal_slice':
    case 'saus_memory':
    case 'bitterbal_bounce':
      if (mg.status === 'intro') { mg.status = 'submit'; broadcast(); }
      break;
    case 'curling':
      if (mg.status === 'intro') { mg.status = 'playing'; broadcast(); }
      break;
  }
}

function _awardMinigamePoints(ranked) {
  const mg = state.minigame;
  const pts = [3, 2, 1];
  mg.results = ranked;
  mg.pointsAwarded = {};
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
  const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
  const players = connected.filter(n => subs[n] !== undefined);
  let ranked;
  if (mg.type === 'perfect_slice') {
    mg.target = 2.0;
    ranked = [...players].sort((a, b) => Math.abs(subs[a] - 2.0) - Math.abs(subs[b] - 2.0));
  } else if (mg.type === 'count_urker_jan') {
    mg.target = 621;
    ranked = [...players].sort((a, b) => Math.abs(subs[a] - 621) - Math.abs(subs[b] - 621));
  } else if (mg.type === 'count_slices') {
    mg.target = 173;
    ranked = [...players].sort((a, b) => Math.abs(subs[a] - 173) - Math.abs(subs[b] - 173));
  } else if (ARCADE_TYPES.includes(mg.type)) {
    ranked = [...players].sort((a, b) => subs[b] - subs[a]);   // highest score wins
  } else {
    ranked = players;
  }
  _awardMinigamePoints(ranked);
  broadcast();
}

function revealCurling() {
  const mg = state.minigame;
  if (!mg || mg.type !== 'curling' || mg.status === 'reveal') return;
  const shots = mg.curlingShots;
  const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
  const bestDist = {};
  connected.forEach(name => {
    const ps = shots[name] || [];
    bestDist[name] = ps.length > 0 ? Math.min(...ps.map(s => s.dist)) : 999;
  });
  mg.bestDistances = bestDist;
  const ranked = [...connected].sort((a, b) => (bestDist[a] || 999) - (bestDist[b] || 999));
  _awardMinigamePoints(ranked);
  broadcast();
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join', ({ name, photoIdx, avatarUrl }) => {
    socket.data.name = name;
    if (!state.players[name]) {
      state.players[name] = { photoIdx, connected: true, avatarUrl: avatarUrl || null };
    } else {
      state.players[name].connected = true;
      state.players[name].photoIdx = photoIdx;
      if (avatarUrl) state.players[name].avatarUrl = avatarUrl;
    }
    broadcast();
  });

  socket.on('disconnect', () => {
    const name = socket.data.name;
    if (name && state.players[name]) { state.players[name].connected = false; broadcast(); }
  });

  socket.on('addFuet', ({ name }) => {
    if (state.phase !== 'setup') return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.fuets.push({ id, name });
    broadcast();
  });

  socket.on('removeFuet', ({ id }) => {
    if (state.phase !== 'setup') return;
    state.fuets = state.fuets.filter(f => f.id !== id);
    broadcast();
  });

  socket.on('startTasting', () => {
    if (state.phase !== 'setup' || !state.fuets.length) return;
    const shuffled = shuffleArray(state.fuets);
    state.shuffledOrder = shuffled.map(f => ({ ...f }));
    state.currentFuetIdx = 0;
    state.ratedPlayers = {};
    state.scores = {};
    state.quizIdx = 0;
    state.phase = 'tasting';
    broadcast();
  });

  socket.on('submitScore', ({ fuetId, scores }) => {
    if (state.phase !== 'tasting') return;
    const name = socket.data.name;
    if (!name) return;
    if (!state.scores[fuetId]) state.scores[fuetId] = {};
    state.scores[fuetId][name] = scores;
    if (!state.ratedPlayers[fuetId]) state.ratedPlayers[fuetId] = [];
    if (!state.ratedPlayers[fuetId].includes(name)) state.ratedPlayers[fuetId].push(name);
    broadcast();
    checkAdvance(fuetId);
  });

  socket.on('answerQuiz', ({ answerIdx }) => {
    if (state.phase !== 'quiz' || !state.quiz) return;
    const name = socket.data.name;
    if (!name || state.quiz.answers[name] !== undefined) return;
    state.quiz.answers[name] = answerIdx;
    broadcast();
    checkAllAnswered();
  });

  socket.on('sendReaction', ({ emoji }) => {
    const name = socket.data.name;
    if (!name) return;
    io.emit('reaction', { name, emoji, id: Date.now().toString(36) + Math.random().toString(36).slice(2) });
  });

  socket.on('chatMessage', ({ text }) => {
    const name = socket.data.name;
    if (!name || !text) return;
    io.emit('chatMessage', { name, text: String(text).slice(0, 300) });
  });

  socket.on('kickPlayer', ({ name }) => {
    if (state.players[name]) { delete state.players[name]; broadcast(); }
  });

  socket.on('advancePhase', () => {
    switch (state.phase) {
      case 'tasting': {
        const fuet = state.shuffledOrder[state.currentFuetIdx];
        const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
        const rated = state.ratedPlayers[fuet?.id] || [];
        if (connected.length && connected.every(n => rated.includes(n))) {
          state.phase = 'scoreboard';
          broadcast();
        }
        break;
      }
      // quiz phase removed
      case 'scoreboard': {
        const shouldMinigame =
          state.currentFuetIdx < state.shuffledOrder.length - 1 &&
          state.minigameIdx < MINIGAME_SEQUENCE.length;
        if (shouldMinigame) {
          startMinigame(MINIGAME_SEQUENCE[state.minigameIdx++]);
        } else {
          advanceFuet();
        }
        break;
      }
      case 'minigame':
        if (state.minigame?.status === 'reveal') advanceFuet();
        break;
    }
  });

  socket.on('advanceMinigame', () => {
    if (state.phase !== 'minigame') return;
    advanceMinigameStatus();
  });

  socket.on('submitMinigameResult', ({ value, stats }) => {
    const name = socket.data.name;
    if (!name || !state.minigame) return;
    if (state.minigame.submissions[name] !== undefined) return;
    let numVal = parseFloat(value);
    if (isNaN(numVal)) return;
    if (ARCADE_TYPES.includes(state.minigame.type)) {
      numVal = Math.max(0, Math.min(ARCADE_MAX[state.minigame.type], Math.round(numVal)));
      const clean = {};
      if (stats && typeof stats === 'object') {
        Object.keys(stats).slice(0, 12).forEach(k => {
          const v = Number(stats[k]);
          if (/^[a-zA-Z]{1,16}$/.test(k) && isFinite(v)) clean[k] = Math.max(0, Math.min(100000, Math.round(v)));
        });
      }
      state.minigame.stats[name] = clean;
    }
    state.minigame.submissions[name] = numVal;
    broadcast();
    const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
    if (connected.every(n => state.minigame.submissions[n] !== undefined)) {
      setTimeout(() => revealMinigame(), 1200);
    }
  });

  socket.on('curlingShot', ({ x, y }) => {
    const name = socket.data.name;
    if (!name || !state.minigame || state.minigame.type !== 'curling') return;
    if (state.minigame.status !== 'playing') return;
    if (!state.minigame.curlingShots[name]) state.minigame.curlingShots[name] = [];
    if (state.minigame.curlingShots[name].length >= 3) return;
    const cx = Math.max(0, Math.min(1, parseFloat(x)));
    const cy = Math.max(0, Math.min(1, parseFloat(y)));
    const dist = Math.sqrt(Math.pow(cx - 0.5, 2) + Math.pow(cy - 0.5, 2));
    state.minigame.curlingShots[name].push({ x: cx, y: cy, dist });
    broadcast();
    const connected = Object.entries(state.players).filter(([,p])=>p.connected).map(([n])=>n);
    if (connected.every(n => (state.minigame.curlingShots[n] || []).length >= 3)) {
      setTimeout(() => revealCurling(), 1200);
    }
  });

  socket.on('revealMinigame', () => {
    if (state.phase !== 'minigame') return;
    if (state.minigame?.type === 'curling') revealCurling();
    else revealMinigame();
  });

  socket.on('nextFuet', () => {
    if (_quizTimer) { clearTimeout(_quizTimer); _quizTimer = null; }
    advanceFuet();
  });

  socket.on('resetGame', () => {
    if (_quizTimer) { clearTimeout(_quizTimer); _quizTimer = null; }
    if (_mgTimer) { clearTimeout(_mgTimer); _mgTimer = null; }
    Object.assign(state, {
      phase: 'setup', fuets: [], shuffledOrder: [], currentFuetIdx: 0,
      ratedPlayers: {}, scores: {}, quiz: null, quizIdx: 0,
      minigame: null, minigameScores: {}, minigameIdx: 0,
    });
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fuet server running on port ${PORT}`));
