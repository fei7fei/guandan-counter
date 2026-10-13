'use strict';

// ---------- constants ----------
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ACE = 12;
const BUMP = { 2: 3, 3: 2, 4: 1 };                 // partner's finishing place -> levels gained
const PLACE_LABEL = { 2: '1-2', 3: '1-3', 4: '1-4' };
const PLACE_NAME = { 2: 'Partner 2nd', 3: 'Partner 3rd', 4: 'Partner 4th' };
const TEAM = ['Red', 'Blue'];
const SUIT = ['♥', '♠'];
const STORE_KEY = 'guandan-counter/v1';
const MUTE_KEY = 'guandan-counter/muted';
const DAY = 86400000;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- storage ----------
function emptyData() {
  return { version: 1, players: [], games: [], activeGameId: null };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (validData(d)) return d;
    }
  } catch (e) { /* storage unavailable */ }
  return emptyData();
}

function validData(d) {
  return d && Array.isArray(d.players) && Array.isArray(d.games);
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch (e) {
    toast('Could not save. Storage is unavailable.');
  }
}

let data = load();

const ui = {
  tab: 'play',
  undo: [],        // snapshots of `data` before each change
  sheet: null,     // open bottom sheet, e.g. { type: 'deal', ... }
  sheetIsNew: false,
  draft: null,     // new-game form
  gameId: null,    // history detail
  playerId: null,  // player detail
  range: 'all',
  shown: null,     // what the play screen last showed, to animate changes
  fanDealt: false,
};

// ---------- sound ----------
// Everything is synthesized with Web Audio, so there are no files to load.
const sound = (() => {
  let ctx = null;
  let noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* ignore */ }

  function ac() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, { t = 0, dur = 0.12, type = 'sine', gain = 0.12, slide = null } = {}) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + t;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  function noise({ t = 0, dur = 0.08, gain = 0.2, freq = 2000, q = 1, to = null } = {}) {
    const c = ac();
    if (!c) return;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t0 = c.currentTime + t;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5 E5 G5 C6 E6

  const fx = {
    tap: () => tone(1500, { dur: 0.035, type: 'triangle', gain: 0.05 }),
    open: () => noise({ dur: 0.14, gain: 0.08, freq: 900, to: 2600, q: 0.8 }),
    chip: () => {
      noise({ dur: 0.04, gain: 0.3, freq: 3800, q: 2 });
      noise({ t: 0.07, dur: 0.035, gain: 0.18, freq: 3200, q: 2 });
      tone(2100, { dur: 0.05, type: 'square', gain: 0.02 });
    },
    flip: () => noise({ dur: 0.16, gain: 0.14, freq: 600, to: 3000, q: 0.6 }),
    up: steps => {
      fx.flip();
      for (let i = 0; i <= Math.min(steps, 4); i++) tone(NOTES[i], { t: 0.12 + i * 0.075, dur: 0.22, type: 'triangle', gain: 0.1 });
    },
    down: () => {
      fx.flip();
      tone(660, { t: 0.08, dur: 0.18, type: 'triangle', gain: 0.08, slide: 440 });
    },
    win: () => {
      [0, 1, 2, 3].forEach(i => tone(NOTES[i], { t: i * 0.11, dur: 0.3, type: 'triangle', gain: 0.12 }));
      [523.25, 659.25, 783.99, 1046.5].forEach(f => tone(f, { t: 0.5, dur: 1.1, type: 'sine', gain: 0.06 }));
      noise({ t: 0.5, dur: 0.5, gain: 0.05, freq: 6000, q: 0.5 });
    },
    undo: () => tone(700, { dur: 0.16, type: 'triangle', gain: 0.09, slide: 330 }),
    del: () => tone(240, { dur: 0.2, type: 'sine', gain: 0.16, slide: 110 }),
    pop: () => tone(700, { dur: 0.1, type: 'sine', gain: 0.12, slide: 1400 }),
    nope: () => { tone(220, { dur: 0.09, type: 'square', gain: 0.04 }); tone(196, { t: 0.1, dur: 0.12, type: 'square', gain: 0.04 }); },
  };

  return {
    play(name, ...args) {
      if (muted || !fx[name]) return;
      try { fx[name](...args); } catch (e) { /* audio unavailable */ }
    },
    unlock() { if (!muted) ac(); },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
      if (!muted) fx.pop();
    },
  };
})();

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const findPlayer = id => data.players.find(p => p.id === id);
const pname = id => findPlayer(id)?.name ?? 'Unknown';
const teamNames = team => team.map(pname).join(' & ');
const findGame = id => data.games.find(g => g.id === id);
const activeGame = () => {
  const g = findGame(data.activeGameId);
  return g && !g.abandoned ? g : null;
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '-');
const rank = lv => RANKS[lv];
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// Every change goes through here so it can be undone.
function mutate(label, fn) {
  ui.undo.push({ label, snapshot: JSON.stringify(data) });
  if (ui.undo.length > 60) ui.undo.shift();
  fn();
  save();
  toast(label, true);
  render();
}

function undo() {
  const u = ui.undo.pop();
  if (!u) return;
  data = JSON.parse(u.snapshot);
  save();
  toast('Undone: ' + u.label);
  render();
}

// ---------- game engine ----------
// Levels are never stored; they're replayed from the deal list, so editing or
// deleting any deal fixes everything after it.
function computeState(g, upTo = g.deals.length) {
  const levels = g.start.levels.slice();
  let declarer = g.start.declarer; // team whose level is being played; null = equal start
  const fails = [0, 0];
  let winner = null;
  const steps = [];

  for (let i = 0; i < upTo; i++) {
    const d = g.deals[i];
    if (winner !== null) { steps.push({ ignored: true }); continue; }
    const step = {
      before: levels.slice(),
      playLevel: declarer === null ? Math.max(...levels) : levels[declarer],
      declarer,
      events: [],
    };

    if (d.type === 'adjust') {
      levels[0] = d.levels[0];
      levels[1] = d.levels[1];
      declarer = d.declarer;
      fails[0] = fails[1] = 0;
      step.after = levels.slice();
      steps.push(step);
      continue;
    }

    const w = d.winner, l = 1 - w;
    const winnerDeclaring = declarer === null || declarer === w;

    if (levels[w] === ACE && winnerDeclaring) {
      if (d.place <= 3 || g.rules.aPassWith14) {
        winner = w;
        step.events.push({ kind: 'win', team: w });
      } else {
        fails[w]++;
        step.events.push({ kind: 'afail', team: w, n: fails[w] });
      }
    } else {
      levels[w] = Math.min(ACE, levels[w] + BUMP[d.place]);
    }

    if (declarer === l && levels[l] === ACE) {
      fails[l]++;
      step.events.push({ kind: 'afail', team: l, n: fails[l] });
    }

    if (g.rules.aMaxFails) {
      for (const t of [0, 1]) {
        if (fails[t] >= g.rules.aMaxFails) {
          levels[t] = 0;
          fails[t] = 0;
          step.events.push({ kind: 'reset', team: t });
        }
      }
    }

    declarer = w;
    step.after = levels.slice();
    steps.push(step);
  }

  return { levels, declarer, fails, winner, steps };
}

const playLevelOf = st => (st.declarer === null ? Math.max(...st.levels) : st.levels[st.declarer]);

// What a result would do: { kind: 'win' | 'miss' | 'up', to }
function outcomeOf(g, st, w, place) {
  const winnerDeclaring = st.declarer === null || st.declarer === w;
  if (st.levels[w] === ACE && winnerDeclaring) return { kind: place <= 3 || g.rules.aPassWith14 ? 'win' : 'miss' };
  return { kind: 'up', to: Math.min(ACE, st.levels[w] + BUMP[place]) };
}

// ---------- stats ----------
function addInto(a, b) {
  for (const k in b) a[k] = (a[k] || 0) + b[k];
}

function computeStats(since = 0) {
  const players = {}, pairs = {}, h2h = {};
  const blank = () => ({ games: 0, wins: 0, deals: 0, dealWins: 0, doubles: 0, firstOuts: 0 });

  for (const g of data.games) {
    if (g.createdAt < since) continue;
    const st = computeState(g);
    const done = st.winner !== null;
    const deals = g.deals.filter((d, i) => d.type !== 'adjust' && !st.steps[i].ignored);

    g.teams.forEach((team, t) => {
      const won = deals.filter(d => d.winner === t);
      const rec = {
        games: done ? 1 : 0,
        wins: done && st.winner === t ? 1 : 0,
        deals: deals.length,
        dealWins: won.length,
        doubles: won.filter(d => d.place === 2).length,
      };
      const ids = [...team].sort();
      const key = ids.join('|');
      pairs[key] ??= { ids, ...blank() };
      addInto(pairs[key], rec);
      for (const id of team) {
        players[id] ??= blank();
        addInto(players[id], rec);
        for (const opp of g.teams[1 - t]) {
          const k = id + '>' + opp;
          h2h[k] ??= blank();
          addInto(h2h[k], rec);
        }
      }
    });

    for (const d of deals) {
      if (d.firstOut && players[d.firstOut]) players[d.firstOut].firstOuts++;
    }
  }
  return { players, pairs, h2h };
}

const byRecord = (a, b) =>
  (b.games ? b.wins / b.games : -1) - (a.games ? a.wins / a.games : -1) ||
  b.games - a.games ||
  (b.deals ? b.dealWins / b.deals : 0) - (a.deals ? a.dealWins / a.deals : 0);

// ---------- rendering ----------
function render() {
  const views = { play: renderPlay, history: renderHistory, stats: renderStats, players: renderPlayers };
  document.getElementById('view').innerHTML = views[ui.tab]();
  document.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  renderSheet();
  afterRender();
}

function header(title, { back, right = '' } = {}) {
  const left = back
    ? `<button class="back" data-action="${back}">‹ Back</button>`
    : `<button class="sound-btn ${sound.muted ? 'off' : ''}" data-action="toggle-sound" aria-label="${sound.muted ? 'Turn sound on' : 'Turn sound off'}"><span>♪</span>${sound.muted ? 'Off' : 'On'}</button>`;
  return `<header class="bar">
    <div class="bar-left">${left}</div>
    <h1>${title}</h1>
    <div class="bar-right">${right}</div>
  </header>`;
}

function playingCard(lv, t, size = '') {
  const r = rank(lv), s = SUIT[t];
  return `<div class="pcard-wrap ${size}" data-card="${t}">
    <div class="pcard t${t}">
      <div class="face front">
        <span class="idx tl">${r}<i>${s}</i></span>
        <span class="center ${r.length > 1 ? 'wide' : ''}">${r}</span>
        <span class="pip">${s}</span>
        <span class="idx br">${r}<i>${s}</i></span>
      </div>
      <div class="face cback"></div>
    </div>
  </div>`;
}

// ----- Play -----
function renderPlay() {
  const g = activeGame();
  if (!g) return renderNewGame();
  const st = computeState(g);
  const done = st.winner !== null;
  const dealNo = g.deals.filter(d => d.type !== 'adjust').length + 1;
  const pl = rank(playLevelOf(st));

  const status = done
    ? `<div class="status champ t${st.winner}">
         <span class="crown">♛</span>
         <strong>${TEAM[st.winner]} takes the game!</strong>
         <small>${esc(teamNames(g.teams[st.winner]))} climbed all the way past A.</small>
       </div>`
    : `<div class="status">
         <span class="deal-no">Deal ${dealNo}</span>
         <span class="playing">Playing <b>${pl}s</b>${st.declarer !== null ? `, ${TEAM[st.declarer]}’s level` : ''}</span>
         <span class="wild"><span class="wild-card">${pl}<i>♥</i></span> is wild</span>
       </div>`;

  const record = done
    ? `<div class="actions-row">
         <button class="btn gold big" data-action="new-game">Deal a new game</button>
         <button class="btn big" data-action="rematch">Rematch</button>
       </div>`
    : `<div class="record">
         <p class="hint">Who won this hand?</p>
         <div class="record-btns">
           <button class="chip-btn t0" data-action="record" data-team="0"><span>Red won</span></button>
           <button class="chip-btn t1" data-action="record" data-team="1"><span>Blue won</span></button>
         </div>
       </div>`;

  return `
    ${header('Guandan', { right: `<button class="icon-btn" data-action="game-menu" aria-label="Game options">•••</button>` })}
    <div class="play-grid">
      <section class="board">
        ${status}
        <div class="teams">${[0, 1].map(t => teamCard(g, st, t)).join('')}</div>
        ${record}
        <button class="btn subtle undo-deal" data-action="undo-deal" ${g.deals.length ? '' : 'disabled'}>↶ Undo last hand</button>
      </section>
      <section class="log panel">
        <h2>Hands</h2>
        ${dealLog(g, st)}
      </section>
    </div>`;
}

function teamCard(g, st, t, size = '') {
  const declaring = st.winner === null && st.declarer === t;
  let meta = '';
  if (st.winner === t) meta = `<span class="badge gold">Champions</span>`;
  else if (st.levels[t] === ACE && st.winner === null) {
    meta = `<span class="badge hot">On A, try ${st.fails[t] + 1}${g.rules.aMaxFails ? ` of ${g.rules.aMaxFails}` : ''}</span>`;
  } else if (declaring) meta = `<span class="badge">Their level</span>`;
  return `
    <div class="team t${t} ${declaring ? 'declaring' : ''} ${st.winner === t ? 'champ' : ''}">
      <div class="team-head">${TEAM[t]}</div>
      <div class="team-players">${esc(teamNames(g.teams[t]))}</div>
      ${playingCard(st.levels[t], t, size)}
      <div class="team-meta">${meta}</div>
    </div>`;
}

function dealLog(g, st) {
  if (!g.deals.length) return `<p class="empty">Fresh deck! After each hand, tap the team that won.</p>`;
  let n = 0;
  const rows = g.deals.map((d, i) => {
    const s = st.steps[i];
    if (d.type === 'adjust') {
      return `<li class="deal adjust" data-action="edit-deal" data-game="${g.id}" data-id="${d.id}">
        <span class="num">✎</span>
        <span class="what">Levels set: Red ${rank(d.levels[0])}, Blue ${rank(d.levels[1])}</span>
        <span class="res"></span>
      </li>`;
    }
    n++;
    let res = '';
    if (s.ignored) res = '<span class="muted">after the game ended</span>';
    else {
      const ev = s.events.map(e =>
        e.kind === 'win' ? `<b class="gold-text">Game!</b>` :
        e.kind === 'afail' ? `<span class="warn">${TEAM[e.team]} missed A${g.rules.aMaxFails ? ` (${e.n}/${g.rules.aMaxFails})` : ''}</span>` :
        `<span class="warn">${TEAM[e.team]} back to 2</span>`).join(' ');
      const moved = s.before[d.winner] !== s.after[d.winner]
        ? `<span class="mini t${d.winner}">${rank(s.before[d.winner])}</span><span class="arrow">→</span><span class="mini t${d.winner}">${rank(s.after[d.winner])}</span>`
        : '';
      res = moved + ev;
    }
    return `<li class="deal ${s.ignored ? 'ignored' : ''}" data-action="edit-deal" data-game="${g.id}" data-id="${d.id}">
      <span class="num">${n}</span>
      <span class="what"><span class="suit t${d.winner}">${SUIT[d.winner]}</span>${TEAM[d.winner]} ${PLACE_LABEL[d.place]}${d.firstOut ? `<span class="first">${esc(pname(d.firstOut))} out first</span>` : ''}</span>
      <span class="res">${res}</span>
    </li>`;
  });
  return `<ol class="deals">${rows.reverse().join('')}</ol><p class="hint small">Tap any hand to fix it.</p>`;
}

// ----- New game -----
function newDraft(teams) {
  return {
    teams: teams ? teams.map(t => t.slice()) : [[null, null], [null, null]],
    rules: { aPassWith14: false, aMaxFails: 0 },
    start: { levels: [0, 0], declarer: null },
    advanced: false,
  };
}

function lastGame() {
  return [...data.games].sort((a, b) => b.createdAt - a.createdAt)[0];
}

function renderNewGame() {
  const d = (ui.draft ??= newDraft());
  const picked = d.teams.flat();
  const ready = picked.every(Boolean) && new Set(picked).size === 4;
  const prev = lastGame();
  const unequal = d.start.levels[0] !== d.start.levels[1];

  const slot = (t, s) => {
    const id = d.teams[t][s];
    return id
      ? `<div class="slot filled"><button class="slot-name" data-action="slot" data-team="${t}" data-seat="${s}"><span class="avatar">${esc(pname(id).slice(0, 1).toUpperCase())}</span>${esc(pname(id))}</button><button class="slot-x" data-action="clear-slot" data-team="${t}" data-seat="${s}" aria-label="Remove">×</button></div>`
      : `<div class="slot"><button class="slot-name empty" data-action="slot" data-team="${t}" data-seat="${s}"><span class="avatar ghost">+</span>Pick a player</button></div>`;
  };

  const levelSelect = t => `<select data-change="start-level" data-team="${t}">${RANKS.map((r, i) => `<option value="${i}" ${d.start.levels[t] === i ? 'selected' : ''}>${r}</option>`).join('')}</select>`;

  const fan = `<div class="fan ${ui.fanDealt ? '' : 'deal-in'}" aria-hidden="true">
      ${playingCard(0, 0, 'sm')}${playingCard(ACE, 1, 'sm')}${playingCard(0, 1, 'sm')}
    </div>`;
  ui.fanDealt = true;

  return `
    ${header('New game')}
    <div class="narrow">
      <div class="hero">
        ${fan}
        <h2 class="hero-title">Shuffle up and deal!</h2>
        <p class="muted">Pick two partners for each side. Everyone starts on 2 and races to A.</p>
      </div>
      <div class="new-teams">
        ${[0, 1].map(t => `
          <div class="panel new-team t${t}">
            <div class="team-head"><span class="suit t${t}">${SUIT[t]}</span>${TEAM[t]} team</div>
            ${slot(t, 0)}${slot(t, 1)}
          </div>`).join('')}
      </div>
      <div class="chip-row">
        ${prev && prev.teams.flat().every(id => findPlayer(id)) ? `<button class="chip" data-action="same-teams">Same teams as last time</button>` : ''}
        ${picked.filter(Boolean).length === 4 ? `<button class="chip" data-action="shuffle-teams">Shuffle partners</button><button class="chip" data-action="swap-teams">Swap colors</button>` : ''}
      </div>

      <div class="panel rules">
        <h2>House rules</h2>
        <div class="rule">
          <div><b>Winning on A</b><p class="muted">A team on A has to win a hand played at A.</p></div>
          <div class="seg">
            <button class="${!d.rules.aPassWith14 ? 'on' : ''}" data-action="rule-14" data-v="0">Needs 1-2 or 1-3</button>
            <button class="${d.rules.aPassWith14 ? 'on' : ''}" data-action="rule-14" data-v="1">Any win counts</button>
          </div>
        </div>
        <div class="rule">
          <div><b>Missed tries on A</b><p class="muted">Drop back to 2 after this many missed A hands.</p></div>
          <div class="seg">
            ${[0, 3].map(n => `<button class="${d.rules.aMaxFails === n ? 'on' : ''}" data-action="rule-fails" data-n="${n}">${n ? n + ' tries' : 'Unlimited'}</button>`).join('')}
          </div>
        </div>
        <button class="link" data-action="toggle-advanced">${d.advanced ? '▾' : '▸'} Pick up a game already in progress</button>
        ${d.advanced ? `
          <div class="rule">
            <div><b>Starting levels</b></div>
            <div class="start-levels"><label class="t0">Red ${levelSelect(0)}</label><label class="t1">Blue ${levelSelect(1)}</label></div>
          </div>
          ${unequal ? `
          <div class="rule">
            <div><b>Whose level is up next?</b></div>
            <div class="seg">
              ${[0, 1].map(t => `<button class="${d.start.declarer === t ? 'on' : ''}" data-action="start-decl" data-team="${t}">${TEAM[t]}</button>`).join('')}
            </div>
          </div>` : ''}` : ''}
      </div>

      <button class="btn gold big full" data-action="start-game" ${ready && (!unequal || d.start.declarer !== null) ? '' : 'disabled'}>Let’s play!</button>
      ${!ready ? `<p class="hint center">Pick four different players to start.</p>` : ''}
    </div>`;
}

// ----- History -----
function renderHistory() {
  if (ui.gameId && findGame(ui.gameId)) return renderGameDetail(findGame(ui.gameId));
  const games = [...data.games].sort((a, b) => b.createdAt - a.createdAt);
  if (!games.length) return `${header('History')}<div class="narrow"><p class="empty big-empty"><span class="empty-suits">♠ ♥ ♣ ♦</span>No games yet. Your first one will show up here.</p></div>`;

  let lastDay = '';
  const items = games.map(g => {
    const st = computeState(g);
    const day = fmtDate(g.createdAt);
    const dayHead = day !== lastDay ? `<li class="day">${day}</li>` : '';
    lastDay = day;
    const result = st.winner !== null
      ? `<span class="pill t${st.winner}">${TEAM[st.winner]} won</span>`
      : g.abandoned ? `<span class="pill">Ended early</span>`
      : `<span class="pill live">${g.id === data.activeGameId ? 'Playing now' : 'Unfinished'}</span>`;
    const deals = g.deals.filter(d => d.type !== 'adjust').length;
    return `${dayHead}<li class="game-row" data-action="open-game" data-id="${g.id}">
      <div class="gr-teams">
        ${[0, 1].map(t => `<div class="${st.winner === t ? 'won' : ''}"><span class="mini t${t}">${rank(st.levels[t])}</span>${esc(teamNames(g.teams[t]))}</div>`).join('')}
      </div>
      <div class="gr-meta">${result}<span class="muted">${fmtTime(g.createdAt)}, ${deals} hand${deals === 1 ? '' : 's'}</span></div>
    </li>`;
  });
  return `${header('History')}<div class="narrow"><ul class="list">${items.join('')}</ul></div>`;
}

function renderGameDetail(g) {
  const st = computeState(g);
  const isActive = g.id === data.activeGameId && !g.abandoned;
  const result = st.winner !== null ? `${TEAM[st.winner]} won` : g.abandoned ? 'Ended early' : isActive ? 'Playing now' : 'Unfinished';
  return `
    ${header(fmtDate(g.createdAt), { back: 'back-history' })}
    <div class="narrow">
      <p class="muted center">${fmtTime(g.createdAt)}. ${result}</p>
      <div class="teams">${[0, 1].map(t => teamCard(g, st, t, 'md')).join('')}</div>
      <div class="actions-row">
        ${st.winner === null && !isActive ? `<button class="btn gold" data-action="resume-game" data-id="${g.id}">Resume this game</button>` : ''}
        ${isActive ? `<button class="btn gold" data-action="tab" data-tab="play">Back to the table</button>` : ''}
        <button class="btn danger" data-action="delete-game" data-id="${g.id}">Delete game</button>
      </div>
      <section class="panel log"><h2>Hands</h2>${dealLog(g, st)}</section>
    </div>`;
}

// ----- Stats -----
function rangeStart() {
  const now = new Date();
  if (ui.range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ui.range === '30') return Date.now() - 30 * DAY;
  return 0;
}

function renderStats() {
  const { players, pairs } = computeStats(rangeStart());
  const seg = `<div class="seg range">${[['all', 'All time'], ['30', '30 days'], ['today', 'Today']].map(([k, l]) => `<button class="${ui.range === k ? 'on' : ''}" data-action="range" data-r="${k}">${l}</button>`).join('')}</div>`;

  const prow = Object.entries(players).map(([id, s]) => ({ id, ...s })).sort(byRecord);
  const pairRows = Object.values(pairs).sort(byRecord);

  if (!prow.length) return `${header('Stats')}<div class="narrow">${seg}<p class="empty big-empty"><span class="empty-suits">♣ ♦</span>No games here yet. Play a few hands and the leaderboard fills itself in.</p></div>`;

  const leader = prow[0].games ? prow[0] : null;
  const bestPair = pairRows[0]?.games ? pairRows[0] : null;

  return `
    ${header('Stats')}
    <div class="narrow">
      ${seg}
      ${leader ? `
      <div class="podium">
        <div class="podium-card">
          <span class="crown">♛</span>
          <span class="muted">Top player</span>
          <b>${esc(pname(leader.id))}</b>
          <span>${pct(leader.wins, leader.games)} of ${leader.games} game${leader.games === 1 ? '' : 's'}</span>
        </div>
        ${bestPair ? `<div class="podium-card">
          <span class="crown">♥♠</span>
          <span class="muted">Best partnership</span>
          <b>${esc(teamNames(bestPair.ids))}</b>
          <span>${pct(bestPair.wins, bestPair.games)} of ${bestPair.games} game${bestPair.games === 1 ? '' : 's'}</span>
        </div>` : ''}
      </div>` : ''}
      <section class="panel">
        <h2>Players</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Player</th><th>Games W-L</th><th>Win %</th><th>Hands won</th><th>Out 1st</th></tr></thead>
          <tbody>${prow.map((s, i) => `
            <tr data-action="open-player" data-id="${s.id}">
              <td class="name">${i === 0 && leader ? '<span class="crown sm">♛</span>' : ''}${esc(pname(s.id))}</td>
              <td>${s.wins}-${s.games - s.wins}</td>
              <td><b>${pct(s.wins, s.games)}</b></td>
              <td>${pct(s.dealWins, s.deals)} <span class="muted">of ${s.deals}</span></td>
              <td>${s.firstOuts}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>Partnerships</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Pair</th><th>Games W-L</th><th>Win %</th><th>Hands won</th><th>1-2 wins</th></tr></thead>
          <tbody>${pairRows.map(s => `
            <tr>
              <td class="name">${esc(teamNames(s.ids))}</td>
              <td>${s.wins}-${s.games - s.wins}</td>
              <td><b>${pct(s.wins, s.games)}</b></td>
              <td>${pct(s.dealWins, s.deals)} <span class="muted">of ${s.deals}</span></td>
              <td>${s.doubles}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
      <p class="hint small center">Game records count finished games. Hand records include games still in progress.</p>
    </div>`;
}

// ----- Players -----
function renderPlayers() {
  if (ui.playerId && findPlayer(ui.playerId)) return renderPlayerDetail(findPlayer(ui.playerId));
  const { players: stats } = computeStats();
  const active = data.players.filter(p => !p.archived).sort((a, b) => a.name.localeCompare(b.name));
  const archived = data.players.filter(p => p.archived).sort((a, b) => a.name.localeCompare(b.name));
  const row = p => {
    const s = stats[p.id];
    return `<li class="player-row" data-action="open-player" data-id="${p.id}">
      <span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <span class="pr-name">${esc(p.name)}</span>
      <span class="muted">${s?.games ? `${s.wins}-${s.games - s.wins}, ${pct(s.wins, s.games)}` : 'Ready to play'}</span>
    </li>`;
  };
  return `
    ${header('Players')}
    <div class="narrow">
      <form class="add-form" data-form="add-player">
        <label class="sr" for="new-player">New player name</label>
        <input id="new-player" name="name" placeholder="Add a player" autocomplete="off" maxlength="30" required>
        <button class="btn gold">Add</button>
      </form>
      ${active.length ? `<ul class="list">${active.map(row).join('')}</ul>` : `<p class="empty big-empty"><span class="empty-suits">♥ ♠</span>Your table is empty. Add the friends you play with and their stats will start stacking up.</p>`}
      ${archived.length ? `<h3 class="sub">Hidden players</h3><ul class="list dim">${archived.map(row).join('')}</ul>` : ''}

      <section class="panel backup">
        <h2>Backup</h2>
        <p class="muted">Everything lives on this device. Export a backup now and then, or use one to move to a new device.</p>
        <div class="actions-row">
          <button class="btn" data-action="export">Export backup</button>
          <button class="btn" data-action="import">Import backup</button>
        </div>
      </section>
    </div>`;
}

function renderPlayerDetail(p) {
  const { players, pairs, h2h } = computeStats();
  const s = players[p.id] || { games: 0, wins: 0, deals: 0, dealWins: 0, doubles: 0, firstOuts: 0 };
  const partners = Object.values(pairs)
    .filter(x => x.ids.includes(p.id))
    .map(x => ({ ...x, other: x.ids.find(id => id !== p.id) }))
    .sort(byRecord);
  const opps = Object.entries(h2h)
    .filter(([k]) => k.startsWith(p.id + '>'))
    .map(([k, v]) => ({ other: k.split('>')[1], ...v }))
    .sort(byRecord);
  const used = data.games.some(g => g.teams.flat().includes(p.id));

  const table = (title, rows, emptyMsg) => `
    <section class="panel">
      <h2>${title}</h2>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Player</th><th>Games W-L</th><th>Win %</th><th>Hands won</th></tr></thead>
        <tbody>${rows.map(r => `<tr data-action="open-player" data-id="${r.other}">
          <td class="name">${esc(pname(r.other))}</td><td>${r.wins}-${r.games - r.wins}</td><td><b>${pct(r.wins, r.games)}</b></td><td>${pct(r.dealWins, r.deals)} <span class="muted">of ${r.deals}</span></td>
        </tr>`).join('')}</tbody></table></div>` : `<p class="muted">${emptyMsg}</p>`}
    </section>`;

  return `
    ${header(esc(p.name), { back: 'back-players' })}
    <div class="narrow">
      <div class="tiles">
        <div class="tile"><span>Games</span><b>${s.wins}-${s.games - s.wins}</b></div>
        <div class="tile"><span>Win rate</span><b>${pct(s.wins, s.games)}</b></div>
        <div class="tile"><span>Hands won</span><b>${pct(s.dealWins, s.deals)}</b></div>
        <div class="tile"><span>Out first</span><b>${s.firstOuts}</b></div>
      </div>
      ${table('With each partner', partners, 'No games with a partner yet. Deal them in!')}
      ${table('Against each opponent', opps, 'No rivals yet.')}
      <section class="panel">
        <h2>Edit</h2>
        <form class="add-form" data-form="rename-player" data-id="${p.id}">
          <label class="sr" for="rename">Name</label>
          <input id="rename" name="name" value="${esc(p.name)}" autocomplete="off" maxlength="30" required>
          <button class="btn">Rename</button>
        </form>
        <div class="actions-row">
          <button class="btn" data-action="archive-player" data-id="${p.id}">${p.archived ? 'Show in player list' : 'Hide from new games'}</button>
          ${used ? '' : `<button class="btn danger" data-action="delete-player" data-id="${p.id}">Delete player</button>`}
        </div>
        ${used ? `<p class="hint small">Players with games can be hidden but not deleted, so everyone’s stats stay correct.</p>` : ''}
      </section>
    </div>`;
}

// ---------- sheets ----------
function openSheet(sheet) {
  ui.sheet = sheet;
  ui.sheetIsNew = true;
  render();
}

function closeSheet() {
  ui.sheet = null;
  render();
}

function renderSheet() {
  const root = document.getElementById('sheet-root');
  const s = ui.sheet;
  if (!s) {
    document.body.classList.remove('sheet-open');
    const sheetEl = root.querySelector('.sheet');
    if (!sheetEl || root.dataset.leaving) return;
    if (reducedMotion()) { root.innerHTML = ''; return; }
    root.dataset.leaving = '1';
    const wide = window.matchMedia('(min-width: 700px)').matches;
    root.querySelector('.backdrop').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    sheetEl.animate(
      wide ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }]
           : [{ transform: 'none' }, { transform: 'translateY(100%)' }],
      { duration: 180, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' },
    ).onfinish = () => {
      delete root.dataset.leaving;
      if (!ui.sheet) root.innerHTML = '';
    };
    return;
  }
  delete root.dataset.leaving;
  const body = { deal: sheetDeal, menu: sheetMenu, adjust: sheetAdjust, pick: sheetPick, confirm: sheetConfirm }[s.type]();
  root.innerHTML = `
    <div class="backdrop ${ui.sheetIsNew ? 'enter' : ''}" data-action="close-sheet"></div>
    <div class="sheet ${ui.sheetIsNew ? 'enter' : ''}" role="dialog" aria-modal="true">
      <div class="grabber"></div>
      ${body}
    </div>`;
  document.body.classList.add('sheet-open');
  ui.sheetIsNew = false;
}

function sheetDeal() {
  const s = ui.sheet;
  const g = findGame(s.gameId);
  const idx = s.dealId ? g.deals.findIndex(d => d.id === s.dealId) : g.deals.length;
  const st = computeState(g, idx);
  const w = s.winner;
  const editing = Boolean(s.dealId);

  const preview = p => {
    const o = outcomeOf(g, st, w, p);
    if (o.kind === 'win') return '<b class="gold-ink">Wins the game!</b>';
    if (o.kind === 'miss') return 'Doesn’t clear A';
    return `${rank(st.levels[w])} → <b>${rank(o.to)}</b>`;
  };

  return `
    <h2>${editing ? 'Fix this hand' : 'Nice hand!'}</h2>
    <div class="seg big-seg">
      ${[0, 1].map(t => `<button class="t${t} ${w === t ? 'on' : ''}" data-action="deal-winner" data-team="${t}">${SUIT[t]} ${TEAM[t]} won</button>`).join('')}
    </div>
    <p class="label">Who went out first? <span class="muted">Optional, for stats</span></p>
    <div class="chip-row">
      ${g.teams[w].map(id => `<button class="chip ${s.firstOut === id ? 'on' : ''}" data-action="deal-first" data-id="${id}">${esc(pname(id))}</button>`).join('')}
    </div>
    <p class="label">Where did their partner finish?</p>
    <div class="place-btns">
      ${[2, 3, 4].map(p => `
        <button class="place t${w} ${editing && s.place === p ? 'on' : ''}" data-action="deal-place" data-place="${p}">
          <span class="pl-gain">+${BUMP[p]}</span>
          <span class="pl-main">${PLACE_NAME[p]} <small>${PLACE_LABEL[p]}</small></span>
          <span class="pl-prev">${preview(p)}</span>
        </button>`).join('')}
    </div>
    ${editing ? `<button class="btn danger full" data-action="delete-deal">Delete this hand</button>` : ''}
    <button class="btn subtle full" data-action="close-sheet">Cancel</button>`;
}

function sheetMenu() {
  const g = activeGame();
  const st = computeState(g);
  return `
    <h2>Game options</h2>
    <div class="menu">
      ${st.winner === null ? `<button data-action="adjust-open">Set levels by hand<small>For house rules this app doesn’t cover</small></button>` : ''}
      <button data-action="open-game" data-id="${g.id}">See this game in history</button>
      ${st.winner === null ? `<button class="danger" data-action="abandon-game">End without a winner<small>It stays in history and you can resume it later</small></button>` : ''}
      <button data-action="new-game">Start a new game</button>
    </div>
    <p class="muted small">House rules: ${g.rules.aPassWith14 ? 'any win clears A' : 'A needs a 1-2 or 1-3 win'}, ${g.rules.aMaxFails ? `back to 2 after ${g.rules.aMaxFails} missed tries` : 'unlimited tries on A'}.</p>
    <button class="btn subtle full" data-action="close-sheet">Close</button>`;
}

function sheetAdjust() {
  const s = ui.sheet;
  return `
    <h2>${s.dealId ? 'Edit level change' : 'Set levels by hand'}</h2>
    ${[0, 1].map(t => `
      <p class="label"><span class="suit t${t}">${SUIT[t]}</span>${TEAM[t]} level</p>
      <div class="rank-grid">${RANKS.map((r, i) => `<button class="t${t} ${s.levels[t] === i ? 'on' : ''}" data-action="adjust-level" data-team="${t}" data-lv="${i}">${r}</button>`).join('')}</div>`).join('')}
    <p class="label">Whose level is up next?</p>
    <div class="seg">${[0, 1].map(t => `<button class="${s.declarer === t ? 'on' : ''}" data-action="adjust-decl" data-team="${t}">${TEAM[t]}</button>`).join('')}</div>
    <button class="btn ink full" data-action="adjust-save">Save</button>
    ${s.dealId ? `<button class="btn danger full" data-action="delete-deal">Remove this change</button>` : ''}
    <button class="btn subtle full" data-action="close-sheet">Cancel</button>`;
}

function sheetPick() {
  const d = ui.draft;
  const s = ui.sheet;
  const taken = new Set(d.teams.flat().filter(Boolean));
  const avail = data.players.filter(p => !p.archived && !taken.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  return `
    <h2><span class="suit t${s.team}">${SUIT[s.team]}</span>${TEAM[s.team]} team, seat ${s.seat + 1}</h2>
    <form class="add-form" data-form="add-pick">
      <label class="sr" for="pick-new">New player name</label>
      <input id="pick-new" name="name" placeholder="Someone new? Type their name" autocomplete="off" maxlength="30" required>
      <button class="btn ink">Add</button>
    </form>
    ${avail.length ? `<div class="pick-list">${avail.map(p => `<button data-action="pick-player" data-id="${p.id}"><span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>${esc(p.name)}</button>`).join('')}</div>`
      : `<p class="muted">${data.players.length ? 'Everyone else is already seated.' : 'No players yet. Add the first one above!'}</p>`}
    <button class="btn subtle full" data-action="close-sheet">Cancel</button>`;
}

function sheetConfirm() {
  const s = ui.sheet;
  return `
    <h2>${s.title}</h2>
    <p>${s.body}</p>
    <button class="btn danger-solid full" data-action="confirm-run">${s.label}</button>
    <button class="btn subtle full" data-action="close-sheet">Cancel</button>`;
}

// ---------- feedback: toast, card flips, confetti ----------
let toastTimer = null;
function toast(msg, withUndo = false) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${withUndo ? '<button data-action="undo">Undo</button>' : ''}`;
  el.classList.remove('show');
  void el.offsetWidth; // restart the transition so repeated toasts still pop
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), withUndo ? 5000 : 2500);
}

function afterRender() {
  if (ui.tab !== 'play') return;
  const g = activeGame();
  if (!g) { ui.shown = null; return; }
  const st = computeState(g);
  const prev = ui.shown;
  ui.shown = { id: g.id, levels: st.levels.slice(), winner: st.winner, deals: g.deals.length };
  if (!prev || prev.id !== g.id) return;

  let rose = 0, fell = false;
  for (const t of [0, 1]) {
    const diff = st.levels[t] - prev.levels[t];
    if (!diff) continue;
    flipCard(t, diff);
    if (diff > 0) rose = Math.max(rose, diff);
    else fell = true;
  }

  if (st.winner !== null && prev.winner === null) {
    sound.play('win');
    celebrate();
  } else if (rose) sound.play('up', rose);
  else if (fell) sound.play('down');

  if (g.deals.length > prev.deals && !reducedMotion()) {
    document.querySelector('.deals .deal')?.animate(
      [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(.23, 1, .32, 1)' },
    );
  }
}

function flipCard(t, diff) {
  const wrap = document.querySelector(`.board [data-card="${t}"]`);
  if (!wrap) return;
  const card = wrap.querySelector('.pcard');
  if (reducedMotion()) {
    card.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 200 });
  } else {
    card.animate(
      [{ transform: 'rotateY(180deg) scale(.94)' }, { transform: 'rotateY(90deg) scale(1.04)', offset: 0.5 }, { transform: 'none' }],
      { duration: 620, easing: 'cubic-bezier(.23, 1, .32, 1)' },
    );
  }
  if (diff > 0) {
    const f = document.createElement('span');
    f.className = `float-gain t${t}`;
    f.textContent = `+${diff}`;
    wrap.appendChild(f);
    f.animate(
      [{ opacity: 0, transform: 'translate(-50%, 0) scale(.8)' }, { opacity: 1, transform: 'translate(-50%, -24px) scale(1.1)', offset: 0.3 }, { opacity: 0, transform: 'translate(-50%, -64px) scale(1)' }],
      { duration: 1100, easing: 'cubic-bezier(.23, 1, .32, 1)' },
    ).onfinish = () => f.remove();
  }
}

function celebrate() {
  if (reducedMotion()) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  document.body.appendChild(layer);
  const suits = ['♠', '♥', '♣', '♦'];
  const w = window.innerWidth, h = window.innerHeight;
  let left = 46;
  for (let i = 0; i < 46; i++) {
    const p = document.createElement('span');
    const s = suits[i % 4];
    p.textContent = s;
    p.className = s === '♥' || s === '♦' ? 'red' : '';
    p.style.left = Math.random() * w + 'px';
    p.style.fontSize = 16 + Math.random() * 22 + 'px';
    layer.appendChild(p);
    const drift = (Math.random() - 0.5) * 220;
    const spin = (Math.random() - 0.5) * 900;
    p.animate(
      [{ transform: 'translate(0, -40px) rotate(0deg)', opacity: 1 }, { transform: `translate(${drift}px, ${h + 60}px) rotate(${spin}deg)`, opacity: 0.9 }],
      { duration: 1800 + Math.random() * 1400, delay: Math.random() * 500, easing: 'cubic-bezier(.25, .46, .45, .94)', fill: 'forwards' },
    ).onfinish = () => { if (--left === 0) layer.remove(); };
  }
}

// ---------- actions ----------
function addPlayer(name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const existing = data.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.archived) mutate(`${existing.name} is back!`, () => { existing.archived = false; });
    else { toast(`${existing.name} is already at the table`); sound.play('nope'); }
    return existing.id;
  }
  const p = { id: uid(), name, createdAt: Date.now(), archived: false };
  mutate(`Welcome, ${name}!`, () => data.players.push(p));
  sound.play('pop');
  return p.id;
}

function switchView() {
  window.scrollTo(0, 0);
  if (reducedMotion()) return;
  document.getElementById('view').animate(
    [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
    { duration: 200, easing: 'cubic-bezier(.23, 1, .32, 1)' },
  );
}

// Sound for each action; anything not listed gets a soft tap.
const ACTION_SOUND = {
  record: 'open', 'game-menu': 'open', slot: 'open', 'edit-deal': 'open', 'adjust-open': 'open',
  'deal-place': 'chip', 'adjust-save': 'chip', 'start-game': 'chip',
  undo: 'undo', 'undo-deal': 'undo',
  'delete-deal': 'del', 'confirm-run': 'del', 'clear-slot': 'del',
  'shuffle-teams': 'flip', 'swap-teams': 'flip', 'pick-player': 'pop',
  'toggle-sound': null,
};

const actions = {
  tab({ tab }) {
    if (ui.tab === tab) { ui.gameId = null; ui.playerId = null; }
    ui.tab = tab;
    ui.sheet = null;
    render();
    switchView();
  },
  undo,
  'close-sheet': closeSheet,
  'toggle-sound'() { sound.toggle(); render(); },

  // play
  record({ team }) {
    openSheet({ type: 'deal', gameId: data.activeGameId, winner: +team, firstOut: null });
  },
  'deal-winner'({ team }) {
    if (ui.sheet.winner !== +team) { ui.sheet.winner = +team; ui.sheet.firstOut = null; }
    render();
  },
  'deal-first'({ id }) {
    ui.sheet.firstOut = ui.sheet.firstOut === id ? null : id;
    render();
  },
  'deal-place'({ place }) {
    const s = ui.sheet;
    const g = findGame(s.gameId);
    const fields = { winner: s.winner, place: +place, firstOut: s.firstOut };
    ui.sheet = null;
    if (s.dealId) {
      mutate('Hand updated', () => Object.assign(g.deals.find(d => d.id === s.dealId), fields));
      return;
    }
    const o = outcomeOf(g, computeState(g), fields.winner, fields.place);
    const label = o.kind === 'win' ? `${TEAM[fields.winner]} takes the game!`
      : o.kind === 'miss' ? `${TEAM[fields.winner]} won, but A needs a 1-2 or 1-3`
      : `${TEAM[fields.winner]} climbs to ${rank(o.to)}!`;
    mutate(label, () => g.deals.push({ id: uid(), at: Date.now(), ...fields }));
  },
  'edit-deal'({ game, id }) {
    const g = findGame(game);
    const d = g.deals.find(x => x.id === id);
    if (d.type === 'adjust') openSheet({ type: 'adjust', gameId: game, dealId: id, levels: d.levels.slice(), declarer: d.declarer });
    else openSheet({ type: 'deal', gameId: game, dealId: id, winner: d.winner, place: d.place, firstOut: d.firstOut });
  },
  'delete-deal'() {
    const s = ui.sheet;
    const g = findGame(s.gameId);
    ui.sheet = null;
    mutate('Hand deleted', () => { g.deals = g.deals.filter(d => d.id !== s.dealId); });
  },
  'undo-deal'() {
    const g = activeGame();
    if (!g?.deals.length) return;
    mutate('Took back the last hand', () => g.deals.pop());
  },
  'game-menu'() { openSheet({ type: 'menu' }); },
  'adjust-open'() {
    const g = activeGame();
    const st = computeState(g);
    openSheet({ type: 'adjust', gameId: g.id, levels: st.levels.slice(), declarer: st.declarer ?? 0 });
  },
  'adjust-level'({ team, lv }) { ui.sheet.levels[+team] = +lv; render(); },
  'adjust-decl'({ team }) { ui.sheet.declarer = +team; render(); },
  'adjust-save'() {
    const s = ui.sheet;
    const g = findGame(s.gameId);
    const fields = { type: 'adjust', levels: s.levels.slice(), declarer: s.declarer };
    ui.sheet = null;
    if (s.dealId) mutate('Level change updated', () => Object.assign(g.deals.find(d => d.id === s.dealId), fields));
    else mutate('Levels set', () => g.deals.push({ id: uid(), at: Date.now(), ...fields }));
  },
  'abandon-game'() {
    const g = activeGame();
    ui.sheet = null;
    mutate('Game saved to history', () => { g.abandoned = true; data.activeGameId = null; });
  },
  'new-game'() {
    ui.sheet = null;
    ui.draft = null;
    ui.fanDealt = false;
    data.activeGameId = null;
    save();
    ui.tab = 'play';
    render();
    switchView();
  },
  rematch() {
    const g = activeGame();
    ui.draft = newDraft(g.teams);
    ui.draft.rules = { ...g.rules };
    ui.fanDealt = false;
    data.activeGameId = null;
    save();
    render();
    switchView();
  },

  // new game
  slot({ team, seat }) { openSheet({ type: 'pick', team: +team, seat: +seat }); },
  'pick-player'({ id }) {
    ui.draft.teams[ui.sheet.team][ui.sheet.seat] = id;
    closeSheet();
  },
  'clear-slot'({ team, seat }) { ui.draft.teams[+team][+seat] = null; render(); },
  'same-teams'() {
    const prev = lastGame();
    ui.draft.teams = prev.teams.map(t => t.slice());
    ui.draft.rules = { ...prev.rules };
    render();
  },
  'shuffle-teams'() {
    const all = ui.draft.teams.flat();
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    ui.draft.teams = [[all[0], all[1]], [all[2], all[3]]];
    render();
    if (!reducedMotion()) {
      document.querySelectorAll('.slot.filled').forEach((el, i) => el.animate(
        [{ opacity: 0, transform: 'rotateX(80deg)' }, { opacity: 1, transform: 'none' }],
        { duration: 320, delay: i * 50, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'backwards' },
      ));
    }
  },
  'swap-teams'() { ui.draft.teams.reverse(); render(); },
  'rule-14'({ v }) { ui.draft.rules.aPassWith14 = v === '1'; render(); },
  'rule-fails'({ n }) { ui.draft.rules.aMaxFails = +n; render(); },
  'toggle-advanced'() {
    ui.draft.advanced = !ui.draft.advanced;
    if (!ui.draft.advanced) ui.draft.start = { levels: [0, 0], declarer: null };
    render();
  },
  'start-decl'({ team }) { ui.draft.start.declarer = +team; render(); },
  'start-game'() {
    const d = ui.draft;
    const unequal = d.start.levels[0] !== d.start.levels[1];
    const g = {
      id: uid(),
      createdAt: Date.now(),
      teams: d.teams.map(t => t.slice()),
      rules: { ...d.rules },
      start: { levels: d.start.levels.slice(), declarer: unequal ? d.start.declarer : null },
      deals: [],
      abandoned: false,
    };
    ui.draft = null;
    mutate('Cards are dealt. Good luck!', () => { data.games.push(g); data.activeGameId = g.id; });
    switchView();
  },

  // history
  'open-game'({ id }) {
    ui.sheet = null;
    ui.tab = 'history';
    ui.gameId = id;
    render();
    switchView();
  },
  'back-history'() { ui.gameId = null; render(); switchView(); },
  'resume-game'({ id }) {
    const g = findGame(id);
    ui.tab = 'play';
    ui.gameId = null;
    mutate('Back to the table!', () => { g.abandoned = false; data.activeGameId = id; });
    switchView();
  },
  'delete-game'({ id }) {
    openSheet({
      type: 'confirm',
      title: 'Delete this game?',
      body: 'It comes out of history and stats. You can undo right after if you change your mind.',
      label: 'Delete game',
      run: () => {
        ui.gameId = null;
        mutate('Game deleted', () => {
          data.games = data.games.filter(g => g.id !== id);
          if (data.activeGameId === id) data.activeGameId = null;
        });
      },
    });
  },
  'confirm-run'() {
    const run = ui.sheet.run;
    ui.sheet = null;
    run();
  },

  // stats / players
  range({ r }) { ui.range = r; render(); },
  'open-player'({ id }) {
    ui.tab = 'players';
    ui.playerId = id;
    render();
    switchView();
  },
  'back-players'() { ui.playerId = null; render(); switchView(); },
  'archive-player'({ id }) {
    const p = findPlayer(id);
    mutate(p.archived ? `${p.name} is back!` : `${p.name} is hidden`, () => { p.archived = !p.archived; });
  },
  'delete-player'({ id }) {
    const p = findPlayer(id);
    ui.playerId = null;
    mutate(`Deleted ${p.name}`, () => { data.players = data.players.filter(x => x.id !== id); });
  },
  async export() {
    const json = JSON.stringify(data, null, 2);
    const name = `guandan-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Guandan backup' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import() { document.getElementById('import-file').click(); },
};

const forms = {
  'add-player'(fd, form) {
    if (addPlayer(fd.get('name'))) form.querySelector('input')?.focus();
  },
  'add-pick'(fd) {
    const id = addPlayer(fd.get('name'));
    if (!id || !ui.sheet) return;
    ui.draft.teams[ui.sheet.team][ui.sheet.seat] = id;
    closeSheet();
  },
  'rename-player'(fd, form) {
    const p = findPlayer(form.dataset.id);
    const name = String(fd.get('name')).trim().replace(/\s+/g, ' ');
    if (!name || name === p.name) return;
    if (data.players.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) {
      sound.play('nope');
      return toast(`${name} is already at the table`);
    }
    mutate(`Now playing as ${name}`, () => { p.name = name; });
  },
};

document.addEventListener('click', e => {
  sound.unlock();
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  e.preventDefault();
  const sfx = name in ACTION_SOUND ? ACTION_SOUND[name] : 'tap';
  if (sfx) sound.play(sfx);
  fn(el.dataset, el);
});

document.addEventListener('submit', e => {
  const fn = forms[e.target.dataset.form];
  if (!fn) return;
  e.preventDefault();
  fn(new FormData(e.target), e.target);
});

document.addEventListener('change', e => {
  if (e.target.dataset.change === 'start-level') {
    ui.draft.start.levels[+e.target.dataset.team] = +e.target.value;
    if (ui.draft.start.levels[0] === ui.draft.start.levels[1]) ui.draft.start.declarer = null;
    render();
  }
});

document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch { parsed = null; }
  if (!validData(parsed)) { sound.play('nope'); return toast('That file isn’t a Guandan Counter backup'); }
  openSheet({
    type: 'confirm',
    title: 'Replace everything?',
    body: `This backup has ${parsed.players.length} players and ${parsed.games.length} games. It replaces all data on this device.`,
    label: 'Import backup',
    run: () => mutate('Backup imported', () => { data = parsed; }),
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.sheet) closeSheet();
});

// ---------- boot ----------
render();
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
