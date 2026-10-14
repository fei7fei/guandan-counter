'use strict';

// ---------- constants ----------
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ACE = 12;
const BUMP = { 2: 3, 3: 2, 4: 1 };                 // partner's finishing place -> levels gained
const STEP_PLACE = { 3: 2, 2: 3, 1: 4 };           // levels gained -> partner's finishing place
const SUIT = ['♦', '♠'];   // red team ♦, so its card never looks like the wild ♥
const STORE_KEY = 'guandan-counter/v1';
const MUTE_KEY = 'guandan-counter/muted';
const LANG_KEY = 'guandan-counter/lang';
const MODE_KEY = 'guandan-counter/mode';
const ZHUAN_KEY = 'guandan-counter/zhuan-v2';      // last stake and currency used in 转蛋
const ZHUAN_KEY_OLD = 'guandan-counter/zhuan';     // from when ¥ was the default
const DAY = 86400000;
const CURRENCIES = ['', '¥', '$'];                 // plain points (the default), RMB, dollars
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- language ----------
// Saved choice first, otherwise follow the device language.
let lang = (() => {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved in STRINGS) return saved;
  } catch (e) { /* ignore */ }
  return /^zh/i.test(navigator.language) ? 'zh' : 'en';
})();

// Look up a string; functions get the extra arguments (names, numbers).
function tr(key, ...args) {
  const v = STRINGS[lang][key] ?? STRINGS.en[key];
  return typeof v === 'function' ? v(...args) : v;
}
const teamName = t => tr('team')[t];

function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = tr('appName');
  document.getElementById('tabs').setAttribute('aria-label', tr('sections'));
  document.querySelectorAll('#tabs [data-tab]').forEach(b => { b.querySelector('.tl').textContent = tr('tabs')[b.dataset.tab]; });
}

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
    toast(tr('storageFail'));
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
  // 'normal' climbs from 2 to A; 'zhuan' (转蛋) stays on 2 and plays for money each hand
  mode: (() => { try { return localStorage.getItem(MODE_KEY) === 'zhuan' ? 'zhuan' : 'normal'; } catch (e) { return 'normal'; } })(),
  statsMode: null, // which mode the Stats tab shows; follows ui.mode until changed there
};

function zhuanPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(ZHUAN_KEY));
    if (p && typeof p.stake === 'number' && CURRENCIES.includes(p.currency)) return p;
    // the old key saved ¥ whether or not anyone picked it, so keep only its stake
    const old = JSON.parse(localStorage.getItem(ZHUAN_KEY_OLD));
    if (old && typeof old.stake === 'number') return { stake: old.stake, currency: '' };
  } catch (e) { /* ignore */ }
  return { stake: 10, currency: '' };
}

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

  function tone(freq, { t = 0, dur = 0.12, type = 'sine', gain = 0.12, slide = null, attack = 0.006, out = null } = {}) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + t;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out || c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  function noise({ t = 0, dur = 0.08, gain = 0.2, freq = 2000, q = 1, to = null, out = null } = {}) {
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
    src.connect(f).connect(g).connect(out || c.destination);
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
    // a little shower of coins for a 转蛋 payout
    coins: () => [0, 0.07, 0.15, 0.22].forEach((t, i) => {
      tone(2637 + i * 220, { t, dur: 0.14, type: 'triangle', gain: 0.06 });
      tone(3951 + i * 160, { t: t + 0.01, dur: 0.09, type: 'sine', gain: 0.03 });
    }),
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
    // a bright rising run on top of the win fanfare
    spring: () => [1046.5, 1174.7, 1318.5, 1568, 2093].forEach((f, i) => tone(f, { t: 0.9 + i * 0.07, dur: 0.25, type: 'sine', gain: 0.07 })),
    undo: () => tone(700, { dur: 0.16, type: 'triangle', gain: 0.09, slide: 330 }),
    del: () => tone(240, { dur: 0.2, type: 'sine', gain: 0.16, slide: 110 }),
    pop: () => tone(700, { dur: 0.1, type: 'sine', gain: 0.12, slide: 1400 }),
    // a soft, low thud for a bomb landing during a 转蛋 hand
    boom: () => {
      noise({ dur: 0.38, gain: 0.32, freq: 380, to: 70, q: 0.7 });
      tone(120, { dur: 0.32, type: 'sine', gain: 0.22, slide: 45 });
    },
    nope: () => { tone(220, { dur: 0.09, type: 'square', gain: 0.04 }); tone(196, { t: 0.1, dur: 0.12, type: 'square', gain: 0.04 }); },
  };

  // Opening tune, timed to the opening animation (times in seconds from its start).
  // It runs through its own volume control so skipping the animation can fade it out.
  let introBus = null;
  let introSkipped = false;
  function introTune({ calm = false, walk = 1.3, step = 0.217, t = 1.54 } = {}) {
    const c = ac();
    introBus = c.createGain();
    introBus.connect(c.destination);
    const out = introBus;
    const pluck = (f, at, gain = 0.07) => tone(f, { t: at, dur: 0.16, type: 'triangle', gain, out });
    const bell = (f, at, gain = 0.055) => {
      tone(f, { t: at, dur: 0.6, type: 'sine', gain, out });
      tone(f * 2, { t: at, dur: 0.3, type: 'sine', gain: gain * 0.3, out });
    };
    // soft C major chord that swells in and lingers under the fade-out
    const chord = (at, dur) => [261.63, 329.63, 392, 523.25].forEach(f => tone(f, { t: at, dur, type: 'sine', gain: 0.035, attack: 0.3, out }));

    if (calm) {
      [783.99, 1046.5, 1318.5, 1567.98].forEach((f, i) => bell(f, 0.4 + i * 0.11, 0.045));
      chord(1.2, 2.2);
      return;
    }
    // waddle: one bouncy note per step, with a bass note underneath
    const walkTune = [523.25, 659.25, 587.33, 698.46, 659.25, 783.99]; // C5 E5 D5 F5 E5 G5
    for (let i = 0; i * step < walk; i++) {
      pluck(walkTune[i % walkTune.length], i * step);
      pluck(walkTune[i % walkTune.length] / 2, i * step, 0.035);
    }
    // the hop: a little boing
    tone(330, { t: walk + 0.1, dur: 0.28, type: 'sine', gain: 0.09, slide: 880, out });
    // each ace flicks out with a rising chime
    [783.99, 1046.5, 1318.5, 1567.98].forEach((f, i) => {
      noise({ t: t + i * 0.08, dur: 0.07, gain: 0.07, freq: 2500, q: 0.8, out });
      bell(f, t + i * 0.08 + 0.02);
    });
    // the suits light up one by one: sparkles
    [2093, 2637, 3136, 4186].forEach((f, i) => tone(f, { t: t + 0.95 + i * 0.11, dur: 0.25, type: 'sine', gain: 0.03, out }));
    chord(t + 0.9, 1.5);
  }

  return {
    play(name, ...args) {
      if (muted || !fx[name]) return;
      try { fx[name](...args); } catch (e) { /* audio unavailable */ }
    },
    unlock() { if (!muted) ac(); },
    // Browsers (iPhone and iPad especially) block sound until the first tap, so the tune only
    // plays if audio is allowed right away. It is never saved up to play late after a tap.
    intro(opts) {
      if (muted) return;
      const c = ac();
      if (!c) return;
      introSkipped = false;
      const go = () => {
        if (introSkipped) return;
        try { introTune(opts); } catch (e) { /* audio unavailable */ }
      };
      if (c.state === 'running') return go();
      const asked = performance.now();
      c.resume().then(() => { if (performance.now() - asked < 250) go(); }).catch(() => {});
    },
    stopIntro() {
      introSkipped = true;
      if (!introBus || !ctx) return;
      introBus.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
      introBus = null;
    },
    // Spoken words use the device's built-in voices, so they work offline too.
    say(text, langTag) {
      if (muted || !window.speechSynthesis) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = langTag;
        const voices = speechSynthesis.getVoices();
        const norm = v => v.lang.replace('_', '-');
        u.voice = voices.find(v => norm(v) === langTag) || voices.find(v => norm(v).startsWith(langTag.slice(0, 2))) || null;
        u.rate = 0.9;
        u.pitch = 1.15;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) { /* speech unavailable */ }
    },
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
const pname = id => findPlayer(id)?.name ?? guestName(id) ?? tr('unknown');
const teamNames = team => team.map(pname).join(' & ');
const findGame = id => data.games.find(g => g.id === id);
// Each mode keeps its own game in progress, so switching modes never loses a game.
const isZhuan = g => g?.mode === 'zhuan';
const activeKey = (mode = ui.mode) => (mode === 'zhuan' ? 'activeZhuanId' : 'activeGameId');
const activeId = () => data[activeKey()] ?? null;
const setActive = (id, mode = ui.mode) => { data[activeKey(mode)] = id; };
const isActiveGame = g => g.id === data.activeGameId || g.id === data.activeZhuanId;
const activeGame = () => {
  const g = findGame(activeId());
  return g && !g.abandoned && !g.finished ? g : null;
};
// Quick games are never kept, except one still being played in the other mode.
const dropGuestGames = () => { data.games = data.games.filter(g => !g.guest || (isActiveGame(g) && isZhuan(g) !== (ui.mode === 'zhuan'))); };
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '-');
const rank = lv => RANKS[lv];
const locale = () => (lang === 'zh' ? 'zh-CN' : undefined);
const fmtDate = t => new Date(t).toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = t => new Date(t).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

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
  toast(tr('undone', u.label));
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

// ---------- 转蛋 money ----------
// Every hand is played on 2. The winning pair each collect stake × (3 for 1-2, 2 for 1-3,
// 1 for 1-4), doubled for each counted bomb and ×4 for four jokers; the losing pair each pay it.
const round2 = n => Math.round(n * 100) / 100;
const handAmount = (g, d) => round2(g.stake * d.mult * 2 ** (d.bombs || 0) * (d.jokers ? 4 : 1));

function fmtMoney(n, cur, { sign = true } = {}) {
  const v = round2(n);
  const abs = Math.abs(v).toLocaleString(locale(), { maximumFractionDigits: 2 });
  const s = !sign || v === 0 ? '' : v > 0 ? '+' : '−';
  return cur ? `${s}${cur}${abs}` : `${s}${abs}`;
}

// Net per player for one game, in its currency.
function zhuanTotals(g) {
  const net = Object.fromEntries(g.seats.map(id => [id, 0]));
  for (const d of g.deals) {
    const amt = handAmount(g, d);
    d.teams.forEach((team, t) => team.forEach(id => { net[id] = round2((net[id] || 0) + (t === d.winner ? amt : -amt)); }));
  }
  return net;
}

// Fewest payments that settle everyone up: biggest debtor pays biggest winner first.
function settleUp(net) {
  const owe = Object.entries(net).filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const get = Object.entries(net).filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const out = [];
  let i = 0, j = 0;
  while (i < owe.length && j < get.length) {
    const pay = round2(Math.min(owe[i].v, get[j].v));
    if (pay > 0) out.push({ from: owe[i].id, to: get[j].id, amount: pay });
    owe[i].v = round2(owe[i].v - pay);
    get[j].v = round2(get[j].v - pay);
    if (owe[i].v <= 0) i++;
    if (get[j].v <= 0) j++;
  }
  return out;
}

// The three ways four players can split into two pairs; the first player always stays Red.
function pairings(seats) {
  const [a, b, c, d] = seats;
  return [[[a, b], [c, d]], [[a, c], [b, d]], [[a, d], [b, c]]];
}
const samePairing = (x, y) => x[0].slice().sort().join() === y[0].slice().sort().join() || x[0].slice().sort().join() === y[1].slice().sort().join();

// Money summed per currency, e.g. { '¥': 120, '$': -15 }.
function fmtNet(net) {
  const parts = Object.entries(net).filter(([, v]) => round2(v) !== 0).map(([c, v]) => fmtMoney(v, c));
  return parts.length ? parts.join(' · ') : '0';
}
const netSum = net => Object.values(net).reduce((a, b) => a + b, 0);
const netClass = net => (netSum(net) > 0 ? 'pos' : netSum(net) < 0 ? 'neg' : '');

function computeZhuanStats(since = 0) {
  const players = {}, pairs = {};
  const blank = () => ({ games: 0, hands: 0, handWins: 0, doubles: 0, firstOuts: 0, net: {} });
  for (const g of data.games) {
    if (!isZhuan(g) || g.guest || g.createdAt < since || !g.deals.length) continue;
    const cur = g.currency;
    for (const id of g.seats) (players[id] ??= blank()).games++;
    for (const d of g.deals) {
      const amt = handAmount(g, d);
      d.teams.forEach((team, t) => {
        const won = t === d.winner;
        const delta = won ? amt : -amt;
        const ids = [...team].sort();
        const pr = (pairs[ids.join('|')] ??= { ids, ...blank() });
        const recs = [pr, ...team.map(id => (players[id] ??= blank()))];
        for (const r of recs) {
          r.hands++;
          if (won) r.handWins++;
          if (won && d.mult === 3) r.doubles++;
          r.net[cur] = round2((r.net[cur] || 0) + delta);
        }
      });
      if (d.firstOut && players[d.firstOut]) players[d.firstOut].firstOuts++;
    }
  }
  return { players, pairs };
}

const byMoney = (a, b) => netSum(b.net) - netSum(a.net) || (b.hands ? b.handWins / b.hands : 0) - (a.hands ? a.handWins / a.hands : 0);

// ---------- stats ----------
function addInto(a, b) {
  for (const k in b) a[k] = (a[k] || 0) + b[k];
}

function computeStats(since = 0) {
  const players = {}, pairs = {}, h2h = {};
  const blank = () => ({ games: 0, wins: 0, deals: 0, dealWins: 0, doubles: 0, firstOuts: 0 });

  for (const g of data.games) {
    if (g.guest || isZhuan(g) || g.createdAt < since) continue;
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

// iOS-style navigation: a slim toolbar row (Back on the leading edge, tools on the trailing
// edge), then a large left-aligned title.
function header(title, { back, right = '', modeSwitch = false } = {}) {
  const left = back ? `<button class="back" data-action="${back}">${tr('back')}</button>`
    : modeSwitch ? `<button class="sound-btn mode-btn" data-action="pick-mode" aria-label="${tr('switchMode')}">${tr(ui.mode === 'zhuan' ? 'modeZhuan' : 'modeNormal')} <span>⇄</span></button>` : '';
  const tools = back ? right
    : `<button class="sound-btn help-btn" data-action="rules-open" aria-label="${tr('rulesAria')}">?</button>`
      + `<button class="sound-btn ${sound.muted ? 'off' : ''}" data-action="toggle-sound" aria-label="${tr(sound.muted ? 'soundOn' : 'soundOff')}"><span>♪</span>${tr(sound.muted ? 'off' : 'on')}</button>`
      + `<button class="sound-btn lang-btn" data-action="toggle-lang" aria-label="${tr('langAria')}">${tr('langBtn')}</button>${right}`;
  return `<header class="bar">
    <div class="bar-row"><div class="bar-left">${left}</div><div class="bar-right">${tools}</div></div>
    <h1>${back ? '' : '<img class="bar-logo" src="icons/icon-180.png" alt="">'}<span>${title}</span></h1>
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
  if (isZhuan(g)) return renderPlayZhuan(g);
  const st = computeState(g);
  const done = st.winner !== null;
  const dealNo = g.deals.filter(d => d.type !== 'adjust').length + 1;
  const pl = rank(playLevelOf(st));

  const status = done
    ? `<div class="status champ t${st.winner}">
         <span class="crown">♛</span>
         <strong>${tr('takesGame', teamName(st.winner))}</strong>
         <small>${tr('climbedPastA', esc(teamNames(g.teams[st.winner])))}</small>
       </div>`
    : `<div class="status">
         <span class="deal-no">${tr('dealNo', dealNo)}</span>
         <span class="playing">${tr('playing', pl, st.declarer !== null ? teamName(st.declarer) : null)}</span>
         <span class="wild">${tr('wild', `<span class="wild-card">${pl}<i>♥</i></span>`)}</span>
         ${g.deals.length ? '' : `<span class="tap-inline">${tr('tapCardToWin')}</span>`}
       </div>`;

  const record = done
    ? `<div class="actions-row">
         <button class="btn gold big" data-action="new-game">${tr('dealNew')}</button>
         <button class="btn big" data-action="rematch">${tr('rematch')}</button>
         <button class="btn big" data-action="share-game" data-id="${g.id}">${tr('shareResult')}</button>
       </div>`
    : g.deals.length ? '' : `<p class="hint center tap-hint">${tr('tapCardToWin')}</p>`;

  return `
    ${header(tr('appTitle'), { modeSwitch: true, right: `<button class="icon-btn" data-action="game-menu" aria-label="${tr('gameOptions')}">•••</button>` })}
    <div class="play-grid ${done ? 'done' : ''}">
      <section class="board">
        ${status}
        ${g.guest ? `<p class="hint center guest-note">${tr('guestBadge')}</p>` : ''}
        <div class="teams">${[0, 1].map(t => teamCard(g, st, t, '', !done)).join('')}</div>
        ${record}
        <button class="btn subtle undo-deal" data-action="undo-deal" ${g.deals.length ? '' : 'disabled'}>${tr('undoLast')}</button>
      </section>
      <section class="log panel">
        <h2>${tr('hands')}</h2>
        ${dealLog(g, st)}
      </section>
    </div>`;
}

// ----- Play: 转蛋 -----
function renderPlayZhuan(g) {
  const net = zhuanTotals(g);
  const handNo = g.deals.length + 1;
  return `
    ${header(tr('zhuanTitle'), { modeSwitch: true, right: `<button class="icon-btn" data-action="game-menu" aria-label="${tr('gameOptions')}">•••</button>` })}
    <div class="play-grid zhuan">
      <section class="board">
        <div class="status">
          <span class="deal-no">${tr('handNo', handNo)}</span>
          <span class="wild">${tr('wild', '<span class="wild-card">2<i>♥</i></span>')}</span>
          <span class="stake-pill">${tr('stakeIs', fmtMoney(g.stake, g.currency, { sign: false }))}</span>
        </div>
        ${g.guest ? `<p class="hint center guest-note">${tr('guestBadge')}</p>` : ''}
        ${moneyBoard(g, g.teams, net)}
        ${bombLive(g)}
        <div class="record">
          <div class="record-btns">
            ${[0, 1].map(t => `<button class="chip-btn t${t}" data-action="record" data-team="${t}"><span>${tr('teamWon', teamName(t))}</span></button>`).join('')}
          </div>
        </div>
        <div class="actions-row zhuan-tools">
          <button class="btn" data-action="pairing-open">${tr('changePartners')}</button>
          <button class="btn" data-action="settle-open" ${g.deals.length ? '' : 'disabled'}>${tr('settleUp')}</button>
        </div>
        <button class="btn subtle undo-deal" data-action="undo-deal" ${g.deals.length ? '' : 'disabled'}>${tr('undoLast')}</button>
      </section>
      <section class="log panel">
        <h2>${tr('hands')}</h2>
        ${zhuanLog(g)}
      </section>
    </div>`;
}

// Two pairs on the felt, each player with their running total.
function moneyBoard(g, teams, net) {
  return `<div class="money-board">
    ${[0, 1].map(t => `
      <div class="money-team t${t}">
        <div class="team-head"><span class="suit">${SUIT[t]}</span>${teamName(t)}</div>
        ${teams[t].map(id => `
          <button class="money-row" data-action="rename-seat" data-id="${esc(id)}" data-pid="${esc(id)}" aria-label="${tr('editName')}: ${esc(pname(id))}">
            <span class="avatar">${esc(pname(id).slice(0, 1).toUpperCase())}</span>
            <span class="mr-name">${esc(pname(id))}${PENCIL}</span>
            <span class="money ${net[id] > 0 ? 'pos' : net[id] < 0 ? 'neg' : ''}">${fmtMoney(net[id] || 0, g.currency)}</span>
          </button>`).join('')}
      </div>`).join('')}
  </div>`;
}

const PENCIL = '<svg class="mr-edit" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 2.3a1.6 1.6 0 0 1 2.3 2.3l-8 8-3.1.8.8-3.1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// Bombs get counted the moment they land, so nobody has to remember them when the hand
// ends. The count rides along on the game and fills in the hand sheet.
const liveOf = g => g.live ?? { bombs: 0, jokers: false };
function bombLive(g) {
  const live = liveOf(g);
  const x = 2 ** live.bombs * (live.jokers ? 4 : 1);
  return `<div class="bomb-live">
    <div class="bl-head"><span>${tr('bombsThisHand')}</span><span class="bomb-x ${x > 1 ? 'on' : ''}">${tr('paysX', x)}</span></div>
    <div class="bl-row">
      <button class="mini-step" data-action="live-bomb" data-d="-1" ${live.bombs ? '' : 'disabled'} aria-label="${tr('fewerBombs')}">−</button>
      <button class="bomb-btn ${live.bombs ? 'on' : ''}" data-action="live-bomb" data-d="1" ${live.bombs >= 8 ? 'disabled' : ''} aria-label="${tr('moreBombs')}">
        <span aria-hidden="true">💣</span>${tr('bombBtn')}<b class="bomb-n">${live.bombs}</b>
      </button>
      <button class="chip jokers ${live.jokers ? 'on' : ''}" data-action="live-jokers">${tr('jokersChip')}</button>
    </div>
  </div>`;
}

function zhuanLog(g) {
  if (!g.deals.length) return `<p class="empty">${tr('freshDeckZhuan')}</p>`;
  const rows = g.deals.map((d, i) => {
    const amt = handAmount(g, d);
    const extras = [d.bombs ? `💣×${d.bombs}` : '', d.jokers ? tr('jokersShort') : ''].filter(Boolean).join(' ');
    return `<li class="deal" data-action="edit-deal" data-game="${g.id}" data-id="${d.id}">
      <span class="num">${i + 1}</span>
      <span class="what"><span class="suit t${d.winner}">${SUIT[d.winner]}</span>${esc(teamNames(d.teams[d.winner]))} ×${d.mult}${extras ? ` <span class="muted">${extras}</span>` : ''}${d.firstOut ? `<span class="first">${tr('outFirst', esc(pname(d.firstOut)))}</span>` : ''}</span>
      <span class="res"><span class="money pos">${tr('eachWins', fmtMoney(amt, g.currency))}</span></span>
    </li>`;
  });
  return `<ol class="deals">${rows.reverse().join('')}</ol><p class="hint small">${tr('tapToFix')}</p>`;
}

// While a game is on, each team's card is the button that records "this team won".
function teamCard(g, st, t, size = '', tap = false) {
  const declaring = st.winner === null && st.declarer === t;
  let meta = '';
  if (st.winner === t) meta = `<span class="badge gold">${tr('champions')}</span>`;
  else if (st.levels[t] === ACE && st.winner === null) {
    meta = `<span class="badge hot">${tr('onA', st.fails[t] + 1, g.rules.aMaxFails)}</span>`;
  } else if (declaring) meta = `<span class="badge">${tr('theirLevel')}</span>`;
  const tag = tap ? 'button' : 'div';
  const attrs = tap ? ` data-action="record" data-team="${t}" aria-label="${tr('teamWon', teamName(t))}"` : '';
  return `
    <${tag} class="team t${t} ${tap ? 'tap' : ''} ${declaring ? 'declaring' : ''} ${st.winner === t ? 'champ' : ''}"${attrs}>
      <div class="team-head">${teamName(t)}</div>
      <div class="team-players">${esc(teamNames(g.teams[t]))}</div>
      ${playingCard(st.levels[t], t, size)}
      <div class="team-meta">${meta}</div>
    </${tag}>`;
}

function dealLog(g, st) {
  if (!g.deals.length) return `<p class="empty">${tr('freshDeck')}</p>`;
  let n = 0;
  const rows = g.deals.map((d, i) => {
    const s = st.steps[i];
    if (d.type === 'adjust') {
      return `<li class="deal adjust" data-action="edit-deal" data-game="${g.id}" data-id="${d.id}">
        <span class="num">✎</span>
        <span class="what">${tr('levelsSetTo', rank(d.levels[0]), rank(d.levels[1]))}</span>
        <span class="res"></span>
      </li>`;
    }
    n++;
    let res = '';
    if (s.ignored) res = `<span class="muted">${tr('afterEnd')}</span>`;
    else {
      const ev = s.events.map(e =>
        e.kind === 'win' ? `<b class="gold-text">${tr('gameBang')}</b>` :
        e.kind === 'afail' ? `<span class="warn">${tr('missedA', teamName(e.team), e.n, g.rules.aMaxFails)}</span>` :
        `<span class="warn">${tr('backTo2', teamName(e.team))}</span>`).join(' ');
      const moved = s.before[d.winner] !== s.after[d.winner]
        ? `<span class="mini t${d.winner}">${rank(s.before[d.winner])}</span><span class="arrow">→</span><span class="mini t${d.winner}">${rank(s.after[d.winner])}</span>`
        : '';
      res = moved + ev;
    }
    return `<li class="deal ${s.ignored ? 'ignored' : ''}" data-action="edit-deal" data-game="${g.id}" data-id="${d.id}">
      <span class="num">${n}</span>
      <span class="what"><span class="suit t${d.winner}">${SUIT[d.winner]}</span>${teamName(d.winner)} +${BUMP[d.place]}${d.firstOut ? `<span class="first">${tr('outFirst', esc(pname(d.firstOut)))}</span>` : ''}</span>
      <span class="res">${res}</span>
    </li>`;
  });
  return `<ol class="deals">${rows.reverse().join('')}</ol><p class="hint small">${tr('tapToFix')}</p>`;
}

// ----- New game -----
function newDraft(teams) {
  return {
    teams: teams ? teams.map(t => t.slice()) : [[null, null], [null, null]],
    rules: { aPassWith14: false, aMaxFails: 3 },
    start: { levels: [0, 0], declarer: null },
    advanced: false,
    guest: !teams && guestPref(),        // quick game (the default): typed names, nothing saved
    guestNames: [['', ''], ['', '']],
    ...zhuanPrefs(),                     // 转蛋 stake and currency
  };
}

// Quick game or tracked: remembered from the mode picker or the setup screen.
const GUEST_KEY = 'guandan-counter/quick';
function guestPref() {
  try { return localStorage.getItem(GUEST_KEY) !== '0'; } catch (e) { return true; }
}
function setGuestPref(on) {
  try { localStorage.setItem(GUEST_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

// Quick-game seats aren't real players; the name rides along in the id.
const SEAT_LETTER = ['1', '2', '3', '4'];
const guestId = (t, s, name) => `guest|${t * 2 + s}|${name.trim() || SEAT_LETTER[t * 2 + s]}`;
const guestName = id => (id?.startsWith('guest|') ? id.split('|').slice(2).join('|') : null);

function lastGame() {
  return data.games.filter(g => !g.guest && isZhuan(g) === (ui.mode === 'zhuan')).sort((a, b) => b.createdAt - a.createdAt)[0];
}

function renderNewGame() {
  const d = (ui.draft ??= newDraft());
  const picked = d.teams.flat();
  const ready = d.guest || (picked.every(Boolean) && new Set(picked).size === 4);
  const prev = lastGame();
  const unequal = d.start.levels[0] !== d.start.levels[1];

  const slot = (t, s) => {
    if (d.guest) {
      const letter = SEAT_LETTER[t * 2 + s];
      return `<div class="slot filled"><label class="slot-name"><span class="avatar">${letter}</span><input class="guest-name" data-input="guest-name" data-team="${t}" data-seat="${s}" value="${esc(d.guestNames[t][s])}" placeholder="${letter}" maxlength="20" autocomplete="off" aria-label="${tr('guestSeat', letter)}"></label></div>`;
    }
    const id = d.teams[t][s];
    return id
      ? `<div class="slot filled"><button class="slot-name" data-action="slot" data-team="${t}" data-seat="${s}"><span class="avatar">${esc(pname(id).slice(0, 1).toUpperCase())}</span>${esc(pname(id))}</button><button class="slot-x" data-action="clear-slot" data-team="${t}" data-seat="${s}" aria-label="${tr('remove')}">×</button></div>`
      : `<div class="slot"><button class="slot-name empty" data-action="slot" data-team="${t}" data-seat="${s}"><span class="avatar ghost">+</span>${tr('pickPlayer')}</button></div>`;
  };

  const levelSelect = t => `<select data-change="start-level" data-team="${t}">${RANKS.map((r, i) => `<option value="${i}" ${d.start.levels[t] === i ? 'selected' : ''}>${r}</option>`).join('')}</select>`;

  const zhuan = ui.mode === 'zhuan';
  const fan = `<div class="fan ${ui.fanDealt ? '' : 'deal-in'}" aria-hidden="true">
      ${zhuan ? `${playingCard(0, 1, 'sm')}${playingCard(0, 0, 'sm')}${playingCard(0, 1, 'sm')}`
              : `${playingCard(0, 0, 'sm')}${playingCard(ACE, 1, 'sm')}${playingCard(0, 1, 'sm')}`}
    </div>`;
  ui.fanDealt = true;

  // 转蛋 has no level rules; its setup is the stake and the currency instead
  const stakes = `
      <div class="panel rules">
        <h2>${tr('stakes')}</h2>
        <div class="rule">
          <div><b>${tr('baseStake')}</b></div>
          <div class="stake-row">
            <label class="stake-field"><span>${esc(d.currency)}</span><input type="number" inputmode="decimal" min="0" step="any" data-input="stake" value="${d.stake}" aria-label="${tr('baseStake')}"></label>
            ${[1, 5, 10, 20].map(n => `<button class="chip ${d.stake === n ? 'on' : ''}" data-action="stake-pick" data-v="${n}">${fmtMoney(n, d.currency, { sign: false })}</button>`).join('')}
          </div>
        </div>
        <div class="rule">
          <div><b>${tr('currency')}</b></div>
          <div class="seg">
            ${CURRENCIES.map(c => `<button class="${d.currency === c ? 'on' : ''}" data-action="currency-pick" data-c="${c}">${tr('currencyName')[c || 'pts']}</button>`).join('')}
          </div>
        </div>
      </div>`;

  const startBtn = `<button class="btn gold big full" data-action="start-game" ${ready && (!unequal || d.start.declarer !== null) ? '' : 'disabled'}>${tr('letsPlay')}</button>`;

  // A quick game needs no setup, so its start button comes first and the names and rules
  // below are optional. A tracked game needs players first, so its button follows the teams.
  return `
    ${header(tr(zhuan ? 'newZhuan' : 'newGame'), { modeSwitch: true })}
    <div class="narrow">
      <div class="hero">
        ${fan}
        <h2 class="hero-title">${tr(zhuan ? 'zhuanHero' : 'heroTitle')}</h2>
        ${d.guest ? '' : `<p class="muted">${tr(zhuan ? 'zhuanSub' : 'heroSub')}</p>`}
      </div>
      ${d.guest ? `<div class="quick-start">${startBtn}</div>` : ''}
      <div class="seg">
        <button class="${d.guest ? 'on' : ''}" data-action="draft-mode" data-guest="1">${tr('modeGuest')}</button>
        <button class="${d.guest ? '' : 'on'}" data-action="draft-mode" data-guest="0">${tr('modeSaved')}</button>
      </div>
      ${d.guest ? `<p class="hint center">${tr('guestDesc')}</p>` : ''}
      <div class="new-teams">
        ${[0, 1].map(t => `
          <div class="panel new-team t${t}">
            <div class="team-head"><span class="suit t${t}">${SUIT[t]}</span>${tr('teamFull')[t]}</div>
            ${slot(t, 0)}${slot(t, 1)}
          </div>`).join('')}
      </div>
      <div class="chip-row">
        ${!d.guest && prev && prev.teams.flat().every(id => findPlayer(id) && !findPlayer(id).deleted) ? `<button class="chip" data-action="same-teams">${tr('sameTeams')}</button>` : ''}
        ${d.guest || picked.filter(Boolean).length === 4 ? `<button class="chip" data-action="shuffle-teams">${tr('shuffle')}</button><button class="chip" data-action="swap-teams">${tr('swap')}</button>` : ''}
      </div>

      ${d.guest ? '' : `
      ${!ready ? `<p class="hint center">${tr('pickFour')}</p>` : ''}
      <div class="start-bar">${startBtn}</div>`}

      ${zhuan ? stakes : `<div class="panel rules">
        <h2>${tr('houseRules')}</h2>
        <div class="rule">
          <div><b>${tr('winOnA')}</b><p class="muted">${tr('winOnADesc')}</p></div>
          <div class="seg">
            <button class="${!d.rules.aPassWith14 ? 'on' : ''}" data-action="rule-14" data-v="0">${tr('needs1213')}</button>
            <button class="${d.rules.aPassWith14 ? 'on' : ''}" data-action="rule-14" data-v="1">${tr('anyWin')}</button>
          </div>
        </div>
        <div class="rule">
          <div><b>${tr('missedTries')}</b><p class="muted">${tr('missedTriesDesc')}</p></div>
          <div class="seg">
            ${[0, 3].map(n => `<button class="${d.rules.aMaxFails === n ? 'on' : ''}" data-action="rule-fails" data-n="${n}">${n ? tr('tries', n) : tr('unlimited')}</button>`).join('')}
          </div>
        </div>
        <button class="link" data-action="toggle-advanced">${d.advanced ? '▾' : '▸'} ${tr('inProgress')}</button>
        ${d.advanced ? `
          <div class="rule">
            <div><b>${tr('startLevels')}</b></div>
            <div class="start-levels">${[0, 1].map(t => `<label class="t${t}">${teamName(t)} ${levelSelect(t)}</label>`).join('')}</div>
          </div>
          ${unequal ? `
          <div class="rule">
            <div><b>${tr('whoseNext')}</b></div>
            <div class="seg">
              ${[0, 1].map(t => `<button class="${d.start.declarer === t ? 'on' : ''}" data-action="start-decl" data-team="${t}">${teamName(t)}</button>`).join('')}
            </div>
          </div>` : ''}` : ''}
      </div>`}
    </div>`;
}

// ----- History -----
function renderHistory() {
  if (ui.gameId && findGame(ui.gameId)) return renderGameDetail(findGame(ui.gameId));
  const games = data.games.filter(g => !g.guest).sort((a, b) => b.createdAt - a.createdAt);
  if (!games.length) return `${header(tr('history'))}<div class="narrow"><p class="empty big-empty"><span class="empty-suits">♠ ♥ ♣ ♦</span>${tr('noGames')}</p></div>`;

  let lastDay = '';
  const items = games.map(g => {
    const day = fmtDate(g.createdAt);
    const dayHead = day !== lastDay ? `<li class="day">${day}</li>` : '';
    lastDay = day;
    if (isZhuan(g)) return dayHead + zhuanHistoryRow(g);
    const st = computeState(g);
    const result = st.winner !== null
      ? `<span class="pill t${st.winner}">${tr('teamWon', teamName(st.winner))}</span>`
      : g.abandoned ? `<span class="pill">${tr('endedEarly')}</span>`
      : `<span class="pill live">${tr(isActiveGame(g) ? 'playingNow' : 'unfinished')}</span>`;
    const deals = g.deals.filter(d => d.type !== 'adjust').length;
    return `${dayHead}<li class="game-row" data-action="open-game" data-id="${g.id}">
      <div class="gr-teams">
        ${[0, 1].map(t => `<div class="${st.winner === t ? 'won' : ''}"><span class="mini t${t}">${rank(st.levels[t])}</span>${esc(teamNames(g.teams[t]))}</div>`).join('')}
      </div>
      <div class="gr-meta">${result}<span class="muted">${tr('rowMeta', fmtTime(g.createdAt), deals)}</span></div>
      <button class="icon-btn gr-del" data-action="delete-game" data-id="${g.id}" aria-label="${tr('deleteGame')}">✕</button>
    </li>`;
  });
  return `${header(tr('history'))}<div class="narrow"><ul class="list">${items.join('')}</ul></div>`;
}

function zhuanHistoryRow(g) {
  const net = zhuanTotals(g);
  const order = [...g.seats].sort((a, b) => net[b] - net[a]);
  const status = g.finished ? `<span class="pill zhuan">${tr('modeZhuan')}</span>`
    : `<span class="pill live">${tr(isActiveGame(g) ? 'playingNow' : 'unfinished')}</span>`;
  return `<li class="game-row" data-action="open-game" data-id="${g.id}">
    <div class="gr-money">
      ${order.map(id => `<span><b>${esc(pname(id))}</b> <span class="money ${net[id] > 0 ? 'pos' : net[id] < 0 ? 'neg' : ''}">${fmtMoney(net[id], g.currency)}</span></span>`).join('')}
    </div>
    <div class="gr-meta">${status}<span class="muted">${tr('rowMeta', fmtTime(g.createdAt), g.deals.length)}</span></div>
    <button class="icon-btn gr-del" data-action="delete-game" data-id="${g.id}" aria-label="${tr('deleteGame')}">✕</button>
  </li>`;
}

function settleList(g, net) {
  const pays = settleUp(net);
  return pays.length
    ? `<ul class="settle-list">${pays.map(p => `<li><b>${esc(pname(p.from))}</b><span class="arrow">→</span><b>${esc(pname(p.to))}</b><span class="money">${fmtMoney(p.amount, g.currency, { sign: false })}</span></li>`).join('')}</ul>`
    : `<p class="muted center">${tr('allEven')}</p>`;
}

function renderZhuanDetail(g) {
  const net = zhuanTotals(g);
  const isActive = isActiveGame(g) && !g.finished && !g.abandoned;
  const order = [...g.seats].sort((a, b) => net[b] - net[a]);
  return `
    ${header(fmtDate(g.createdAt), { back: 'back-history' })}
    <div class="narrow">
      <p class="muted center">${tr('detailMeta', fmtTime(g.createdAt), `${tr('modeZhuan')} · ${tr('stakeIs', fmtMoney(g.stake, g.currency, { sign: false }))}`)}</p>
      <section class="panel">
        <h2>${tr('totals')}</h2>
        <ul class="totals-list">${order.map((id, i) => `<li>${i === 0 && net[id] > 0 ? '<span class="crown sm">♛</span>' : ''}<b>${esc(pname(id))}</b><span class="money ${net[id] > 0 ? 'pos' : net[id] < 0 ? 'neg' : ''}">${fmtMoney(net[id], g.currency)}</span></li>`).join('')}</ul>
      </section>
      <section class="panel">
        <h2>${tr('whoPays')}</h2>
        ${settleList(g, net)}
      </section>
      <div class="actions-row">
        ${!isActive && !g.finished ? `<button class="btn gold" data-action="resume-game" data-id="${g.id}">${tr('resumeGame')}</button>` : ''}
        ${isActive ? `<button class="btn gold" data-action="go-play" data-mode="zhuan">${tr('backToTable')}</button>` : ''}
        <button class="btn" data-action="share-game" data-id="${g.id}">${tr('share')}</button>
        <button class="btn danger" data-action="delete-game" data-id="${g.id}">${tr('deleteGame')}</button>
      </div>
      <section class="panel log"><h2>${tr('hands')}</h2>${zhuanLog(g)}</section>
    </div>`;
}

function renderGameDetail(g) {
  if (isZhuan(g)) return renderZhuanDetail(g);
  const st = computeState(g);
  const isActive = g.id === data.activeGameId && !g.abandoned;
  const result = st.winner !== null ? tr('teamWon', teamName(st.winner)) : tr(g.abandoned ? 'endedEarly' : isActive ? 'playingNow' : 'unfinished');
  return `
    ${header(fmtDate(g.createdAt), { back: 'back-history' })}
    <div class="narrow">
      <p class="muted center">${tr('detailMeta', fmtTime(g.createdAt), result)}</p>
      <div class="teams">${[0, 1].map(t => teamCard(g, st, t, 'md')).join('')}</div>
      <div class="actions-row">
        ${st.winner === null && !isActive ? `<button class="btn gold" data-action="resume-game" data-id="${g.id}">${tr('resumeGame')}</button>` : ''}
        ${isActive ? `<button class="btn gold" data-action="go-play" data-mode="normal">${tr('backToTable')}</button>` : ''}
        <button class="btn" data-action="share-game" data-id="${g.id}">${tr(st.winner !== null ? 'shareResult' : 'share')}</button>
        <button class="btn danger" data-action="delete-game" data-id="${g.id}">${tr('deleteGame')}</button>
      </div>
      <section class="panel log"><h2>${tr('hands')}</h2>${dealLog(g, st)}</section>
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
  const sm = ui.statsMode ?? ui.mode;
  const modeSeg = `<div class="seg range">${['normal', 'zhuan'].map(m => `<button class="${sm === m ? 'on' : ''}" data-action="stats-mode" data-m="${m}">${tr(m === 'zhuan' ? 'modeZhuan' : 'modeNormal')}</button>`).join('')}</div>`;
  const seg = modeSeg + `<div class="seg range">${['all', '30', 'today'].map(k => `<button class="${ui.range === k ? 'on' : ''}" data-action="range" data-r="${k}">${tr('ranges')[k]}</button>`).join('')}</div>`;
  if (sm === 'zhuan') return renderZhuanStats(seg);
  const { players, pairs } = computeStats(rangeStart());

  const prow = Object.entries(players).map(([id, s]) => ({ id, ...s })).sort(byRecord);
  const pairRows = Object.values(pairs).sort(byRecord);

  if (!prow.length) return `${header(tr('stats'))}<div class="narrow">${seg}<p class="empty big-empty"><span class="empty-suits">♣ ♦</span>${tr('noStats')}</p></div>`;

  const leader = prow[0].games ? prow[0] : null;
  const bestPair = pairRows[0]?.games ? pairRows[0] : null;

  return `
    ${header(tr('stats'), { right: leader ? `<button class="sound-btn" data-action="share-stats">${tr('share')}</button>` : '' })}
    <div class="narrow">
      ${seg}
      ${leader ? `
      <div class="podium">
        <div class="podium-card">
          <span class="crown">♛</span>
          <span class="muted">${tr('topPlayer')}</span>
          <b>${esc(pname(leader.id))}</b>
          <span>${tr('pctOfGames', pct(leader.wins, leader.games), leader.games)}</span>
        </div>
        ${bestPair ? `<div class="podium-card">
          <span class="crown">♦♠</span>
          <span class="muted">${tr('bestPair')}</span>
          <b>${esc(teamNames(bestPair.ids))}</b>
          <span>${tr('pctOfGames', pct(bestPair.wins, bestPair.games), bestPair.games)}</span>
        </div>` : ''}
      </div>` : ''}
      <section class="panel">
        <h2>${tr('players')}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>${tr('thPlayer')}</th><th>${tr('thGames')}</th><th>${tr('thWin')}</th><th>${tr('thHands')}</th><th>${tr('thOut1')}</th></tr></thead>
          <tbody>${prow.map((s, i) => `
            <tr data-action="open-player" data-id="${s.id}">
              <td class="name">${i === 0 && leader ? '<span class="crown sm">♛</span>' : ''}${esc(pname(s.id))}</td>
              <td>${s.wins}-${s.games - s.wins}</td>
              <td><b>${pct(s.wins, s.games)}</b></td>
              <td>${pct(s.dealWins, s.deals)} <span class="muted">${tr('ofN', s.deals)}</span></td>
              <td>${s.firstOuts}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>${tr('partnerships')}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>${tr('thPair')}</th><th>${tr('thGames')}</th><th>${tr('thWin')}</th><th>${tr('thHands')}</th><th>${tr('th12')}</th></tr></thead>
          <tbody>${pairRows.map(s => `
            <tr>
              <td class="name">${esc(teamNames(s.ids))}</td>
              <td>${s.wins}-${s.games - s.wins}</td>
              <td><b>${pct(s.wins, s.games)}</b></td>
              <td>${pct(s.dealWins, s.deals)} <span class="muted">${tr('ofN', s.deals)}</span></td>
              <td>${s.doubles}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
      <p class="hint small center">${tr('statsNote')}</p>
    </div>`;
}

function renderZhuanStats(seg) {
  const { players, pairs } = computeZhuanStats(rangeStart());
  const prow = Object.entries(players).map(([id, s]) => ({ id, ...s })).filter(s => s.hands).sort(byMoney);
  const pairRows = Object.values(pairs).filter(s => s.hands).sort(byMoney);
  if (!prow.length) return `${header(tr('stats'))}<div class="narrow">${seg}<p class="empty big-empty"><span class="empty-suits">¥ $</span>${tr('noZhuanStats')}</p></div>`;
  const leader = netSum(prow[0].net) > 0 ? prow[0] : null;
  const bestPair = pairRows[0] && netSum(pairRows[0].net) > 0 ? pairRows[0] : null;
  return `
    ${header(tr('stats'), { right: `<button class="sound-btn" data-action="share-stats">${tr('share')}</button>` })}
    <div class="narrow">
      ${seg}
      ${leader ? `
      <div class="podium">
        <div class="podium-card">
          <span class="crown">♛</span>
          <span class="muted">${tr('bigWinner')}</span>
          <b>${esc(pname(leader.id))}</b>
          <span class="money pos">${fmtNet(leader.net)}</span>
        </div>
        ${bestPair ? `<div class="podium-card">
          <span class="crown">♦♠</span>
          <span class="muted">${tr('bestPair')}</span>
          <b>${esc(teamNames(bestPair.ids))}</b>
          <span class="money pos">${fmtNet(bestPair.net)}</span>
        </div>` : ''}
      </div>` : ''}
      <section class="panel">
        <h2>${tr('players')}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>${tr('thPlayer')}</th><th>${tr('thNet')}</th><th>${tr('thHandsWL')}</th><th>${tr('thWin')}</th><th>${tr('tileGames')}</th><th>${tr('thOut1')}</th></tr></thead>
          <tbody>${prow.map((s, i) => `
            <tr data-action="open-player" data-id="${s.id}">
              <td class="name">${i === 0 && leader ? '<span class="crown sm">♛</span>' : ''}${esc(pname(s.id))}</td>
              <td><b class="money ${netClass(s.net)}">${fmtNet(s.net)}</b></td>
              <td>${s.handWins}-${s.hands - s.handWins}</td>
              <td>${pct(s.handWins, s.hands)}</td>
              <td>${s.games}</td>
              <td>${s.firstOuts}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>${tr('partnerships')}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>${tr('thPair')}</th><th>${tr('thNet')}</th><th>${tr('thHandsWL')}</th><th>${tr('thWin')}</th><th>${tr('th12')}</th></tr></thead>
          <tbody>${pairRows.map(s => `
            <tr>
              <td class="name">${esc(teamNames(s.ids))}</td>
              <td><b class="money ${netClass(s.net)}">${fmtNet(s.net)}</b></td>
              <td>${s.handWins}-${s.hands - s.handWins}</td>
              <td>${pct(s.handWins, s.hands)}</td>
              <td>${s.doubles}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
      <p class="hint small center">${tr('zhuanStatsNote')}</p>
    </div>`;
}

// ----- Players -----
function renderPlayers() {
  if (ui.playerId && findPlayer(ui.playerId)) return renderPlayerDetail(findPlayer(ui.playerId));
  const { players: stats } = computeStats();
  const listed = data.players.filter(p => !p.deleted).sort((a, b) => a.name.localeCompare(b.name));
  const active = listed.filter(p => !p.archived);
  const archived = listed.filter(p => p.archived);
  const row = p => {
    const s = stats[p.id];
    return `<li class="player-row" data-action="open-player" data-id="${p.id}">
      <span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <span class="pr-name">${esc(p.name)}</span>
      <span class="muted">${s?.games ? `${s.wins}-${s.games - s.wins}, ${pct(s.wins, s.games)}` : tr('readyToPlay')}</span>
      <button class="icon-btn row-btn" data-action="rename-open" data-id="${p.id}" aria-label="${tr('editName')}">✎</button>
      <button class="icon-btn row-btn del" data-action="delete-player" data-id="${p.id}" aria-label="${tr('deletePlayer')}">✕</button>
    </li>`;
  };
  return `
    ${header(tr('players'))}
    <div class="narrow">
      <form class="add-form" data-form="add-player">
        <label class="sr" for="new-player">${tr('newPlayerName')}</label>
        <input id="new-player" name="name" placeholder="${tr('addPlayerPh')}" autocomplete="off" maxlength="30" required>
        <button class="btn gold">${tr('add')}</button>
      </form>
      ${active.length ? `<ul class="list">${active.map(row).join('')}</ul>` : `<p class="empty big-empty"><span class="empty-suits">♦ ♠</span>${tr('emptyTable')}</p>`}
      ${archived.length ? `<h3 class="sub">${tr('hiddenPlayers')}</h3><ul class="list dim">${archived.map(row).join('')}</ul>` : ''}

      <section class="panel backup">
        <h2>${tr('backup')}</h2>
        <p class="muted">${tr('backupDesc')}</p>
        <div class="actions-row">
          <button class="btn" data-action="export">${tr('exportBackup')}</button>
          <button class="btn" data-action="import">${tr('importBackup')}</button>
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

  const table = (title, rows, emptyMsg) => `
    <section class="panel">
      <h2>${title}</h2>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>${tr('thPlayer')}</th><th>${tr('thGames')}</th><th>${tr('thWin')}</th><th>${tr('thHands')}</th></tr></thead>
        <tbody>${rows.map(r => `<tr data-action="open-player" data-id="${r.other}">
          <td class="name">${esc(pname(r.other))}</td><td>${r.wins}-${r.games - r.wins}</td><td><b>${pct(r.wins, r.games)}</b></td><td>${pct(r.dealWins, r.deals)} <span class="muted">${tr('ofN', r.deals)}</span></td>
        </tr>`).join('')}</tbody></table></div>` : `<p class="muted">${emptyMsg}</p>`}
    </section>`;

  return `
    ${header(esc(p.name), { back: 'back-players' })}
    <div class="narrow">
      <div class="tiles">
        <div class="tile"><span>${tr('tileGames')}</span><b>${s.wins}-${s.games - s.wins}</b></div>
        <div class="tile"><span>${tr('tileWinRate')}</span><b>${pct(s.wins, s.games)}</b></div>
        <div class="tile"><span>${tr('tileHands')}</span><b>${pct(s.dealWins, s.deals)}</b></div>
        <div class="tile"><span>${tr('tileOutFirst')}</span><b>${s.firstOuts}</b></div>
      </div>
      ${table(tr('withPartner'), partners, tr('noPartner'))}
      ${table(tr('vsOpp'), opps, tr('noRivals'))}
      ${zhuanPlayerPanel(p)}
      ${p.deleted ? '' : `<section class="panel">
        <h2>${tr('edit')}</h2>
        <form class="add-form" data-form="rename-player" data-id="${p.id}">
          <label class="sr" for="rename">${tr('name')}</label>
          <input id="rename" name="name" value="${esc(p.name)}" autocomplete="off" maxlength="30" required>
          <button class="btn">${tr('rename')}</button>
        </form>
        <div class="actions-row">
          <button class="btn" data-action="archive-player" data-id="${p.id}">${tr(p.archived ? 'showInList' : 'hideFromNew')}</button>
          <button class="btn danger" data-action="delete-player" data-id="${p.id}">${tr('deletePlayer')}</button>
        </div>
      </section>`}
    </div>`;
}

// A player's 转蛋 money, overall and with each partner. Hidden until they've played it.
function zhuanPlayerPanel(p) {
  const { players, pairs } = computeZhuanStats();
  const s = players[p.id];
  if (!s?.hands) return '';
  const partners = Object.values(pairs)
    .filter(x => x.ids.includes(p.id))
    .map(x => ({ ...x, other: x.ids.find(id => id !== p.id) }))
    .sort(byMoney);
  return `
    <section class="panel">
      <h2>${tr('modeZhuan')}</h2>
      <div class="tiles">
        <div class="tile"><span>${tr('thNet')}</span><b class="money ${netClass(s.net)}">${fmtNet(s.net)}</b></div>
        <div class="tile"><span>${tr('thHandsWL')}</span><b>${s.handWins}-${s.hands - s.handWins}</b></div>
        <div class="tile"><span>${tr('tileHands')}</span><b>${pct(s.handWins, s.hands)}</b></div>
        <div class="tile"><span>${tr('tileGames')}</span><b>${s.games}</b></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>${tr('withPartnerShort')}</th><th>${tr('thNet')}</th><th>${tr('thHandsWL')}</th><th>${tr('thWin')}</th></tr></thead>
        <tbody>${partners.map(r => `<tr data-action="open-player" data-id="${r.other}">
          <td class="name">${esc(pname(r.other))}</td><td><b class="money ${netClass(r.net)}">${fmtNet(r.net)}</b></td><td>${r.handWins}-${r.hands - r.handWins}</td><td>${pct(r.handWins, r.hands)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
}

// ---------- sheets ----------
function openSheet(sheet) {
  ui.sheet = sheet;
  ui.sheetIsNew = true;
  document.getElementById('toast').classList.remove('show'); // it would sit on top of the sheet
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
  const body = { deal: sheetDeal, menu: sheetMenu, adjust: sheetAdjust, pick: sheetPick, confirm: sheetConfirm, rename: sheetRename, seatname: sheetSeatName, rules: sheetRules, pairing: sheetPairing, settle: sheetSettle }[s.type]();
  root.innerHTML = `
    <div class="backdrop ${ui.sheetIsNew ? 'enter' : ''}" data-action="close-sheet"></div>
    <div class="sheet ${ui.sheetIsNew ? 'enter' : ''}" role="dialog" aria-modal="true">
      <div class="grabber"></div>
      ${body}
    </div>`;
  document.body.classList.add('sheet-open');
  ui.sheetIsNew = false;
}

function sheetZhuanDeal() {
  const s = ui.sheet;
  const g = findGame(s.gameId);
  const w = s.winner;
  const editing = Boolean(s.dealId);
  const amount = mult => handAmount(g, { mult, bombs: s.bombs, jokers: s.jokers });
  return `
    ${editing ? `<h2>${tr('fixHand')}</h2>
    <div class="seg big-seg">
      ${[0, 1].map(t => `<button class="t${t} ${w === t ? 'on' : ''}" data-action="deal-winner" data-team="${t}">${SUIT[t]} ${esc(teamNames(s.teams[t]))}</button>`).join('')}
    </div>` : wonTitle(w, esc(teamNames(s.teams[w])))}
    <div class="chip-row">
      ${s.teams[w].map(id => `<button class="chip ${s.firstOut === id ? 'on' : ''}" data-action="deal-first" data-id="${id}" aria-label="${tr('whoFirst')}">${tr('outFirstChip', esc(pname(id)))}</button>`).join('')}
    </div>
    <div class="bomb-row">
      <span class="bomb-label">💣 ×2</span>
      <button class="mini-step" data-action="bomb-step" data-d="-1" ${s.bombs ? '' : 'disabled'} aria-label="${tr('fewerBombs')}">−</button>
      <span class="bomb-count">${s.bombs}</span>
      <button class="mini-step" data-action="bomb-step" data-d="1" ${s.bombs >= 8 ? 'disabled' : ''} aria-label="${tr('moreBombs')}">+</button>
      <button class="chip jokers ${s.jokers ? 'on' : ''}" data-action="jokers-toggle">${tr('jokersChip')}</button>
    </div>
    <div class="gain-btns">
      ${[1, 2, 3].map(n => `<button class="gain-btn money-btn t${w} ${editing && s.mult === n ? 'on' : ''}" data-action="zdeal-save" data-mult="${n}">×${n}<small>${fmtMoney(amount(n), g.currency)}</small></button>`).join('')}
    </div>
    ${editing ? `<button class="btn danger full" data-action="delete-deal">${tr('deleteHand')}</button>` : ''}
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

function sheetPairing() {
  const g = findGame(ui.sheet.gameId);
  return `
    <h2>${tr('changePartners')}</h2>
    <div class="menu">
      ${pairings(g.seats).map((p, i) => `<button class="pairing ${samePairing(p, g.teams) ? 'on' : ''}" data-action="pairing-pick" data-i="${i}">
        <span><span class="suit t0">${SUIT[0]}</span>${esc(teamNames(p[0]))}</span>
        <span class="vs">vs</span>
        <span><span class="suit t1">${SUIT[1]}</span>${esc(teamNames(p[1]))}</span>
      </button>`).join('')}
    </div>
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

function sheetSettle() {
  const g = findGame(ui.sheet.gameId);
  const net = zhuanTotals(g);
  const order = [...g.seats].sort((a, b) => net[b] - net[a]);
  const live = !g.finished;
  return `
    <h2>${tr('settleUp')}</h2>
    <ul class="totals-list">${order.map(id => `<li><b>${esc(pname(id))}</b><span class="money ${net[id] > 0 ? 'pos' : net[id] < 0 ? 'neg' : ''}">${fmtMoney(net[id], g.currency)}</span></li>`).join('')}</ul>
    <p class="label">${tr('whoPays')}</p>
    ${settleList(g, net)}
    <button class="btn" data-action="share-game" data-id="${g.id}">${tr('share')}</button>
    ${live ? `<button class="btn gold full" data-action="finish-zhuan">${tr('finishGame')}</button>` : ''}
    <button class="btn subtle full" data-action="close-sheet">${tr(live ? 'keepPlaying' : 'close')}</button>`;
}

// A new hand opens for the team that was tapped; to pick the other team, close the sheet
// and tap theirs. Fixing an old hand keeps the switch, so a hand logged wrong can be moved.
const wonTitle = (t, who) => `<h2 class="won-title t${t}"><span class="suit">${SUIT[t]}</span>${tr('teamWon', who)}</h2>`;

function sheetDeal() {
  const s = ui.sheet;
  const g = findGame(s.gameId);
  if (isZhuan(g)) return sheetZhuanDeal();
  const w = s.winner;
  const editing = Boolean(s.dealId);

  return `
    ${editing ? `<h2>${tr('fixHand')}</h2>
    <div class="seg big-seg">
      ${[0, 1].map(t => `<button class="t${t} ${w === t ? 'on' : ''}" data-action="deal-winner" data-team="${t}">${SUIT[t]} ${tr('teamWon', teamName(t))}</button>`).join('')}
    </div>` : wonTitle(w, teamName(w))}
    <p class="label">${tr('whoFirst')} <span class="muted">${tr('optional')}</span></p>
    <div class="chip-row">
      ${g.teams[w].map(id => `<button class="chip ${s.firstOut === id ? 'on' : ''}" data-action="deal-first" data-id="${id}">${esc(pname(id))}</button>`).join('')}
    </div>
    <div class="gain-btns">
      ${[1, 2, 3].map(n => `<button class="gain-btn t${w} ${editing && s.step === n ? 'on' : ''}" data-action="deal-save" data-step="${n}">+${n}</button>`).join('')}
    </div>
    ${editing ? `<button class="btn danger full" data-action="delete-deal">${tr('deleteHand')}</button>` : ''}
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

function sheetMenu() {
  const g = activeGame();
  if (isZhuan(g)) {
    return `
    <h2>${tr('gameOptions')}</h2>
    <div class="menu">
      <button data-action="settle-open">${tr('settleUp')}</button>
      <button data-action="pairing-open">${tr('changePartners')}</button>
      ${g.guest ? '' : `<button data-action="open-game" data-id="${g.id}">${tr('seeInHistory')}</button>`}
      <button data-action="finish-zhuan">${tr('finishGame')}<small>${tr(g.guest ? 'endGuestSub' : 'finishSub')}</small></button>
    </div>
    <p class="muted small">${tr('stakeIs', fmtMoney(g.stake, g.currency, { sign: false }))}</p>
    <button class="btn subtle full" data-action="close-sheet">${tr('close')}</button>`;
  }
  const st = computeState(g);
  return `
    <h2>${tr('gameOptions')}</h2>
    <div class="menu">
      ${st.winner === null ? `<button data-action="adjust-open">${tr('setLevels')}<small>${tr('setLevelsSub')}</small></button>` : ''}
      ${g.guest ? '' : `<button data-action="open-game" data-id="${g.id}">${tr('seeInHistory')}</button>`}
      ${st.winner !== null ? '' : g.guest
        ? `<button class="danger" data-action="abandon-game">${tr('endGuest')}<small>${tr('endGuestSub')}</small></button>`
        : `<button class="danger" data-action="abandon-game">${tr('endNoWinner')}<small>${tr('endNoWinnerSub')}</small></button>`}
      <button data-action="new-game">${tr('startNew')}</button>
    </div>
    <p class="muted small">${tr('rulesLine', g.rules.aPassWith14, g.rules.aMaxFails)}</p>
    <button class="btn subtle full" data-action="close-sheet">${tr('close')}</button>`;
}

function sheetAdjust() {
  const s = ui.sheet;
  return `
    <h2>${tr(s.dealId ? 'editLevelChange' : 'setLevels')}</h2>
    ${[0, 1].map(t => `
      <p class="label"><span class="suit t${t}">${SUIT[t]}</span>${tr('teamLevel', teamName(t))}</p>
      <div class="rank-grid">${RANKS.map((r, i) => `<button class="t${t} ${s.levels[t] === i ? 'on' : ''}" data-action="adjust-level" data-team="${t}" data-lv="${i}">${r}</button>`).join('')}</div>`).join('')}
    <p class="label">${tr('whoseNext')}</p>
    <div class="seg">${[0, 1].map(t => `<button class="${s.declarer === t ? 'on' : ''}" data-action="adjust-decl" data-team="${t}">${teamName(t)}</button>`).join('')}</div>
    <button class="btn ink full" data-action="adjust-save">${tr('save')}</button>
    ${s.dealId ? `<button class="btn danger full" data-action="delete-deal">${tr('removeChange')}</button>` : ''}
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

function sheetPick() {
  const d = ui.draft;
  const s = ui.sheet;
  const taken = new Set(d.teams.flat().filter(Boolean));
  const avail = data.players.filter(p => !p.archived && !p.deleted && !taken.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  return `
    <h2><span class="suit t${s.team}">${SUIT[s.team]}</span>${tr('seat', tr('teamFull')[s.team], s.seat + 1)}</h2>
    <form class="add-form" data-form="add-pick">
      <label class="sr" for="pick-new">${tr('newPlayerName')}</label>
      <input id="pick-new" name="name" placeholder="${tr('pickNewPh')}" autocomplete="off" maxlength="30" required>
      <button class="btn ink">${tr('add')}</button>
    </form>
    ${avail.length ? `<div class="pick-list">${avail.map(p => `<button data-action="pick-player" data-id="${p.id}"><span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>${esc(p.name)}</button>`).join('')}</div>`
      : `<p class="muted">${tr(data.players.length ? 'allSeated' : 'noPlayersYet')}</p>`}
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

// Quick-game seats: the name lives in the seat's id, so renaming rewrites the id everywhere.
function sheetSeatName() {
  const s = ui.sheet;
  return `
    <h2>${tr('editName')}</h2>
    <form class="add-form" data-form="rename-seat" data-id="${esc(s.pid)}">
      <label class="sr" for="seat-name">${tr('name')}</label>
      <input id="seat-name" name="name" value="${esc(pname(s.pid))}" autocomplete="off" maxlength="20" required>
      <button class="btn ink">${tr('save')}</button>
    </form>
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

function sheetRename() {
  const p = findPlayer(ui.sheet.playerId);
  return `
    <h2>${tr('editName')}</h2>
    <form class="add-form" data-form="rename-player" data-id="${p.id}">
      <label class="sr" for="rename-sheet">${tr('name')}</label>
      <input id="rename-sheet" name="name" value="${esc(p.name)}" autocomplete="off" maxlength="30" required>
      <button class="btn ink">${tr('save')}</button>
    </form>
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

// How to play, for whichever mode is picked (掼蛋 or 转蛋).
function sheetRules() {
  const sections = tr(ui.mode === 'zhuan' ? 'rulesZhuan' : 'rulesGuandan');
  return `
    <h2>${tr('rulesTitle', ui.mode)}</h2>
    <div class="rules-body">
      ${sections.map(sec => `<section class="rules-sec">
        <h3>${sec.h}</h3>
        <ul>${sec.items.map(it => `<li>${it}</li>`).join('')}</ul>
      </section>`).join('')}
    </div>
    <button class="btn ink full" data-action="close-sheet">${tr('gotIt')}</button>`;
}

function sheetConfirm() {
  const s = ui.sheet;
  return `
    <h2>${s.title}</h2>
    <p>${s.body}</p>
    <button class="btn danger-solid full" data-action="confirm-run">${s.label}</button>
    <button class="btn subtle full" data-action="close-sheet">${tr('cancel')}</button>`;
}

// ---------- feedback: toast, card flips, confetti ----------
let toastTimer = null;
function toast(msg, withUndo = false) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${withUndo ? `<button data-action="undo">${tr('undo')}</button>` : ''}`;
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
  if (isZhuan(g)) return afterRenderZhuan(g);
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
    if (isSpring(g, st)) springBanner(); // its own scene instead of the card confetti
    else celebrate();
  } else if (rose) sound.play('up', rose);
  else if (fell) sound.play('down');

  if (g.deals.length > prev.deals && !reducedMotion()) {
    document.querySelector('.deals .deal')?.animate(
      [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(.23, 1, .32, 1)' },
    );
  }
}

// After a 转蛋 hand: winners' totals pop green with the amount floating up, losers' dip red.
function bombBurst() {
  const btn = document.querySelector('.board .bomb-btn');
  if (!btn || reducedMotion()) return;
  btn.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.06) rotate(-1.5deg)', offset: 0.25 }, { transform: 'scale(.98) rotate(1deg)', offset: 0.55 }, { transform: 'scale(1)' }],
    { duration: 380, easing: 'cubic-bezier(.23, 1, .32, 1)' },
  );
  btn.querySelector('.bomb-n')?.animate(
    [{ transform: 'scale(.6)' }, { transform: 'scale(1.25)', offset: 0.45 }, { transform: 'scale(1)' }],
    { duration: 420, easing: 'cubic-bezier(.23, 1, .32, 1)' },
  );
}

function afterRenderZhuan(g) {
  const net = zhuanTotals(g);
  const prev = ui.shown;
  ui.shown = { id: g.id, net, deals: g.deals.length };
  if (!prev || prev.id !== g.id || !prev.net) return;
  let gained = false, lost = false;
  for (const id of g.seats) {
    const diff = round2(net[id] - (prev.net[id] || 0));
    if (!diff) continue;
    if (diff > 0) gained = true; else lost = true;
    const row = [...document.querySelectorAll('.board .money-row')].find(r => r.dataset.pid === id);
    if (!row) continue;
    const money = row.querySelector('.money');
    if (reducedMotion()) { money.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 220 }); continue; }
    money.animate(
      [{ transform: 'scale(1)' }, { transform: `scale(${diff > 0 ? 1.25 : 0.85})`, offset: 0.35 }, { transform: 'scale(1)' }],
      { duration: 520, easing: 'cubic-bezier(.23, 1, .32, 1)' },
    );
    const f = document.createElement('span');
    f.className = `float-money ${diff > 0 ? 'pos' : 'neg'}`;
    f.textContent = fmtMoney(diff, g.currency);
    row.appendChild(f);
    f.animate(
      diff > 0
        ? [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(-10px)', offset: 0.3 }, { opacity: 0, transform: 'translateY(-34px)' }]
        : [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(6px)', offset: 0.3 }, { opacity: 0, transform: 'translateY(22px)' }],
      { duration: 1200, easing: 'cubic-bezier(.23, 1, .32, 1)' },
    ).onfinish = () => f.remove();
  }
  if (g.deals.length > prev.deals) sound.play('coins');
  else if (gained || lost) sound.play('down');
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

// The winners took the game without the other side winning a single hand.
function isSpring(g, st) {
  if (st.winner === null) return false;
  return !g.deals.some((d, i) => d.type !== 'adjust' && !st.steps[i].ignored && d.winner !== st.winner);
}

function springBanner() {
  const WREATH = ['🌸', '🌿', '🌷', '🌼', '🍃', '🌺', '🌸', '🌿', '🌷', '🌼', '🍃', '🌺', '🌸', '🌿', '🌷', '🌼'];
  const layer = document.createElement('div');
  layer.className = 'spring';
  layer.innerHTML = `
    <div class="spring-glow"></div>
    <div class="spring-center">
      <div class="spring-ring">${WREATH.map((f, i) => `<span style="--a:${(360 / WREATH.length) * i}deg"><i>${f}</i></span>`).join('')}</div>
      <span class="spring-word">${tr('spring')}</span>
    </div>`;
  document.body.appendChild(layer);
  sound.play('spring');
  sound.say(tr('springSay'), lang === 'zh' ? 'zh-CN' : 'en-US');

  const glow = layer.querySelector('.spring-glow');
  const center = layer.querySelector('.spring-center');
  const word = layer.querySelector('.spring-word');
  const ring = layer.querySelector('.spring-ring');
  const TOTAL = 3800;
  setTimeout(() => layer.remove(), TOTAL + 400);

  if (reducedMotion()) {
    layer.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: TOTAL, fill: 'forwards' });
    return;
  }

  glow.animate(
    [{ opacity: 0, transform: 'scale(.4)', easing: 'ease-out' }, { opacity: 1, transform: 'scale(1)', offset: 0.18 }, { opacity: 1, transform: 'scale(1)', offset: 0.8 }, { opacity: 0, transform: 'scale(1.15)' }],
    { duration: TOTAL, fill: 'forwards' },
  );
  // easing lives on each keyframe; on the whole animation it would rush the fade-out
  const pop = 'cubic-bezier(.23, 1, .32, 1)';
  word.animate(
    [
      { opacity: 0, transform: 'scale(.2) rotate(-12deg)', easing: pop },
      { opacity: 1, transform: 'scale(1.15) rotate(3deg)', offset: 0.12, easing: pop },
      { opacity: 1, transform: 'scale(1) rotate(-1deg)', offset: 0.2, easing: 'ease-in-out' },
      { opacity: 1, transform: 'scale(1.05) rotate(0deg)', offset: 0.82, easing: 'ease-in' },
      { opacity: 0, transform: 'scale(1.35)' },
    ],
    { duration: TOTAL, fill: 'forwards' },
  );
  // the wreath blooms flower by flower, turns slowly, then the whole scene fades out
  ring.querySelectorAll('i').forEach((f, i) => f.animate(
    [{ transform: 'scale(0) rotate(-90deg)', opacity: 0 }, { transform: 'scale(1.3) rotate(10deg)', opacity: 1, offset: 0.6 }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }],
    { duration: 520, delay: 180 + i * 70, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'backwards' },
  ));
  ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(50deg)' }], { duration: TOTAL, easing: 'linear', fill: 'forwards' });
  center.animate([{ opacity: 1 }, { opacity: 1, offset: 0.82 }, { opacity: 0 }], { duration: TOTAL, fill: 'forwards' });

  const w = window.innerWidth, h = window.innerHeight;
  // butterflies flutter up and across the screen
  for (let i = 0; i < 4; i++) {
    const b = document.createElement('span');
    b.className = 'spring-fly';
    b.textContent = '🦋';
    layer.appendChild(b);
    const fromLeft = i % 2 === 0;
    const x0 = fromLeft ? -50 : w + 10, x1 = fromLeft ? w + 10 : -50;
    const y0 = h * (0.55 + Math.random() * 0.35), y1 = h * (0.05 + Math.random() * 0.3);
    const flip = fromLeft ? 1 : -1;
    const frames = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      frames.push({
        transform: `translate(${x0 + (x1 - x0) * t}px, ${y0 + (y1 - y0) * t + Math.sin(t * Math.PI * 4) * 30}px) scaleX(${flip}) scaleY(${k % 2 ? 0.75 : 1})`,
        opacity: k === 0 || k === 6 ? 0 : 1,
      });
    }
    b.animate(frames, { duration: 3000 + Math.random() * 600, delay: 150 + i * 260, easing: 'ease-in-out', fill: 'both' });
  }
  // blossoms and leaves drift down
  const DRIFT = ['🌸', '🌸', '🌼', '🍃', '🌸', '🌺'];
  for (let i = 0; i < 34; i++) {
    const p = document.createElement('span');
    p.className = 'petal';
    p.textContent = DRIFT[i % DRIFT.length];
    p.style.left = Math.random() * w + 'px';
    p.style.fontSize = 16 + Math.random() * 18 + 'px';
    layer.appendChild(p);
    const sway = (Math.random() - 0.5) * 240;
    p.animate(
      [{ transform: 'translate(0, -40px) rotate(0deg)', opacity: 0 }, { opacity: 1, offset: 0.1 }, { transform: `translate(${sway}px, ${h + 40}px) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 0.85 }],
      { duration: 2600 + Math.random() * 1200, delay: Math.random() * 700, easing: 'ease-in', fill: 'both' },
    );
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

// ---------- sharing ----------
// Plain text so it pastes cleanly into Messages, WeChat, WhatsApp and the like.
function shareFooter() {
  return location.protocol === 'https:' ? '\n\n' + tr('shareFooter', location.origin + location.pathname) : '';
}

function zhuanShareText(g) {
  const net = zhuanTotals(g);
  const lines = [tr('shareZhuanHead', fmtDate(g.createdAt)), tr('stakeIs', fmtMoney(g.stake, g.currency, { sign: false })), ''];
  [...g.seats].sort((a, b) => net[b] - net[a]).forEach(id => lines.push(`${pname(id)}: ${fmtMoney(net[id], g.currency)}`));
  const pays = settleUp(net);
  if (pays.length) {
    lines.push('', tr('whoPays'));
    pays.forEach(p => lines.push(`${pname(p.from)} → ${pname(p.to)}: ${fmtMoney(p.amount, g.currency, { sign: false })}`));
  }
  lines.push('', tr('shareHands', g.deals.length));
  return lines.join('\n') + shareFooter();
}

function zhuanStatsShareText() {
  const { players } = computeZhuanStats(rangeStart());
  const rows = Object.entries(players).map(([id, s]) => ({ id, ...s })).filter(s => s.hands).sort(byMoney).slice(0, 10);
  const lines = [tr('shareZhuanLeader', tr('ranges')[ui.range]), ''];
  rows.forEach((s, i) => lines.push(`${i === 0 ? '♛ ' : ''}${i + 1}. ${pname(s.id)}: ${fmtNet(s.net)}`));
  return lines.join('\n') + shareFooter();
}

function gameShareText(g) {
  if (isZhuan(g)) return zhuanShareText(g);
  const st = computeState(g);
  const hands = g.deals.filter(d => d.type !== 'adjust').length;
  const lines = [tr('shareGameHead', fmtDate(g.createdAt))];
  lines.push(st.winner !== null ? tr('shareWinner', teamName(st.winner), teamNames(g.teams[st.winner]))
    : g.abandoned ? tr('endedEarly') : tr('shareInProgress'));
  lines.push('');
  for (const t of [0, 1]) lines.push(`${SUIT[t]} ${teamName(t)}  ${teamNames(g.teams[t])}: ${rank(st.levels[t])}`);
  lines.push(tr('shareHands', hands));
  return lines.join('\n') + shareFooter();
}

function statsShareText() {
  if ((ui.statsMode ?? ui.mode) === 'zhuan') return zhuanStatsShareText();
  const { players, pairs } = computeStats(rangeStart());
  const rows = Object.entries(players).map(([id, s]) => ({ id, ...s })).filter(s => s.games).sort(byRecord).slice(0, 10);
  const lines = [tr('shareLeaderHead', tr('ranges')[ui.range]), ''];
  rows.forEach((s, i) => lines.push((i === 0 ? '♛ ' : '') + tr('shareLeaderRow', i + 1, pname(s.id), pct(s.wins, s.games), s.wins, s.games - s.wins)));
  const best = Object.values(pairs).filter(s => s.games).sort(byRecord)[0];
  if (best) lines.push('', tr('shareBestPair', teamNames(best.ids), pct(best.wins, best.games), best.games));
  return lines.join('\n') + shareFooter();
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(tr('copied'));
  } catch (e) {
    toast(tr('shareFail'));
  }
}

// ---------- actions ----------
function addPlayer(name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const existing = data.players.find(p => !p.deleted && p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.archived) mutate(tr('isBack', existing.name), () => { existing.archived = false; });
    else { toast(tr('alreadyAtTable', existing.name)); sound.play('nope'); }
    return existing.id;
  }
  const p = { id: uid(), name, createdAt: Date.now(), archived: false };
  mutate(tr('welcome', name), () => data.players.push(p));
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
  record: 'open', 'game-menu': 'open', slot: 'open', 'edit-deal': 'open', 'adjust-open': 'open', 'rename-open': 'open', 'delete-player': 'open',
  'deal-save': 'chip', 'adjust-save': 'chip', 'start-game': 'chip',
  undo: 'undo', 'undo-deal': 'undo',
  'delete-deal': 'del', 'confirm-run': 'del', 'clear-slot': 'del',
  'shuffle-teams': 'flip', 'swap-teams': 'flip', 'pick-player': 'pop',
  'zdeal-save': null, 'pairing-open': 'open', 'settle-open': 'open', 'pairing-pick': 'flip', 'finish-zhuan': 'chip',
  'jokers-toggle': 'pop', 'pick-mode': 'open', 'choose-mode': 'chip',
  'live-bomb': null, 'live-jokers': null, 'rename-seat': 'open', 'rules-open': 'open',
  'toggle-sound': null, 'toggle-lang': 'flip',
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
  'toggle-lang'() {
    lang = lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
    applyLang();
    render();
  },

  // play
  record({ team }) {
    const g = activeGame();
    if (isZhuan(g)) {
      const live = liveOf(g);
      openSheet({ type: 'deal', gameId: g.id, winner: +team, firstOut: null, teams: g.teams.map(t => t.slice()), bombs: live.bombs, jokers: live.jokers });
      return;
    }
    openSheet({ type: 'deal', gameId: g.id, winner: +team, firstOut: null });
  },
  'bomb-step'({ d }) {
    ui.sheet.bombs = Math.min(8, Math.max(0, ui.sheet.bombs + +d));
    render();
  },
  'jokers-toggle'() { ui.sheet.jokers = !ui.sheet.jokers; render(); },
  'zdeal-save'({ mult }) {
    const s = ui.sheet;
    const g = findGame(s.gameId);
    const fields = { winner: s.winner, teams: s.teams.map(t => t.slice()), mult: +mult, bombs: s.bombs, jokers: s.jokers, firstOut: s.firstOut };
    ui.sheet = null;
    if (s.dealId) {
      mutate(tr('handUpdated'), () => Object.assign(g.deals.find(d => d.id === s.dealId), fields));
      return;
    }
    const amt = handAmount(g, fields);
    mutate(tr('pairWins', teamNames(fields.teams[fields.winner]), fmtMoney(amt, g.currency)), () => {
      g.deals.push({ id: uid(), at: Date.now(), ...fields });
      delete g.live;
    });
  },
  'live-bomb'({ d }) {
    const g = activeGame();
    if (!g) return;
    const live = (g.live = liveOf(g));
    live.bombs = Math.min(8, Math.max(0, live.bombs + +d));
    save();
    render();
    sound.play(+d > 0 ? 'boom' : 'undo');
    if (+d > 0) bombBurst();
  },
  'live-jokers'() {
    const g = activeGame();
    if (!g) return;
    const live = (g.live = liveOf(g));
    live.jokers = !live.jokers;
    save();
    render();
    if (live.jokers) { sound.play('boom'); bombBurst(); } else sound.play('undo');
  },
  'rename-seat'({ id }) {
    if (findPlayer(id)) return openSheet({ type: 'rename', playerId: id });
    openSheet({ type: 'seatname', gameId: activeGame().id, pid: id });
  },
  'pairing-open'() { openSheet({ type: 'pairing', gameId: activeGame().id }); },
  'pairing-pick'({ i }) {
    const g = findGame(ui.sheet.gameId);
    const p = pairings(g.seats)[+i];
    ui.sheet = null;
    if (samePairing(p, g.teams)) return render();
    mutate(tr('partnersChanged'), () => { g.teams = p.map(t => t.slice()); });
  },
  'settle-open'() { openSheet({ type: 'settle', gameId: activeGame().id }); },
  'finish-zhuan'() {
    const g = activeGame();
    ui.sheet = null;
    if (g.guest) {
      mutate(tr('guestEnded'), () => { data.games = data.games.filter(x => x !== g); setActive(null); });
      return;
    }
    mutate(tr('savedToHistory'), () => { g.finished = true; setActive(null); });
    ui.tab = 'history';
    ui.gameId = g.id;
    render();
    switchView();
  },
  'deal-winner'({ team }) {
    if (ui.sheet.winner !== +team) { ui.sheet.winner = +team; ui.sheet.firstOut = null; }
    render();
  },
  'deal-first'({ id }) {
    ui.sheet.firstOut = ui.sheet.firstOut === id ? null : id;
    render();
  },
  'deal-save'({ step }) {
    const s = ui.sheet;
    const g = findGame(s.gameId);
    const fields = { winner: s.winner, place: STEP_PLACE[+step], firstOut: s.firstOut };
    ui.sheet = null;
    if (s.dealId) {
      mutate(tr('handUpdated'), () => Object.assign(g.deals.find(d => d.id === s.dealId), fields));
      return;
    }
    const o = outcomeOf(g, computeState(g), fields.winner, fields.place);
    const tm = teamName(fields.winner);
    const label = o.kind === 'win' ? tr('takesGame', tm)
      : o.kind === 'miss' ? tr('wonButA', tm)
      : tr('climbs', tm, rank(o.to));
    mutate(label, () => g.deals.push({ id: uid(), at: Date.now(), ...fields }));
  },
  'edit-deal'({ game, id }) {
    const g = findGame(game);
    const d = g.deals.find(x => x.id === id);
    if (isZhuan(g)) {
      openSheet({ type: 'deal', gameId: game, dealId: id, winner: d.winner, teams: d.teams.map(t => t.slice()), mult: d.mult, bombs: d.bombs || 0, jokers: Boolean(d.jokers), firstOut: d.firstOut });
      return;
    }
    if (d.type === 'adjust') openSheet({ type: 'adjust', gameId: game, dealId: id, levels: d.levels.slice(), declarer: d.declarer });
    else openSheet({ type: 'deal', gameId: game, dealId: id, winner: d.winner, step: BUMP[d.place], firstOut: d.firstOut });
  },
  'delete-deal'() {
    const s = ui.sheet;
    const g = findGame(s.gameId);
    ui.sheet = null;
    mutate(tr('handDeleted'), () => { g.deals = g.deals.filter(d => d.id !== s.dealId); });
  },
  'undo-deal'() {
    const g = activeGame();
    if (!g?.deals.length) return;
    mutate(tr('tookBack'), () => {
      const d = g.deals.pop();
      // 转蛋: the hand's bombs go back on the counter, ready to record it again
      if (isZhuan(g) && (d.bombs || d.jokers)) g.live = { bombs: d.bombs || 0, jokers: Boolean(d.jokers) };
    });
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
    if (s.dealId) mutate(tr('levelChangeUpdated'), () => Object.assign(g.deals.find(d => d.id === s.dealId), fields));
    else mutate(tr('levelsSet'), () => g.deals.push({ id: uid(), at: Date.now(), ...fields }));
  },
  'abandon-game'() {
    const g = activeGame();
    ui.sheet = null;
    if (g.guest) {
      mutate(tr('guestEnded'), () => { data.games = data.games.filter(x => x !== g); setActive(null); });
      return;
    }
    mutate(tr('savedToHistory'), () => { g.abandoned = true; setActive(null); });
  },
  'new-game'() {
    const prev = activeGame();
    ui.sheet = null;
    ui.draft = newDraft();
    ui.draft.guest = prev ? Boolean(prev.guest) : true; // stay in the mode you were playing
    ui.fanDealt = false;
    setActive(null);
    dropGuestGames(); // quick games are never kept
    save();
    ui.tab = 'play';
    render();
    switchView();
  },
  rematch() {
    const g = activeGame();
    if (g.guest) {
      ui.draft = newDraft();
      ui.draft.guest = true;
      ui.draft.guestNames = g.teams.map(t => t.map(guestName));
    } else {
      ui.draft = newDraft(g.teams.map(t => t.map(id => (findPlayer(id)?.deleted ? null : id))));
    }
    ui.draft.rules = { ...g.rules };
    ui.fanDealt = false;
    setActive(null);
    dropGuestGames();
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
    if (prev.rules) ui.draft.rules = { ...prev.rules };
    if (isZhuan(prev)) Object.assign(ui.draft, { stake: prev.stake, currency: prev.currency });
    render();
  },
  'stake-pick'({ v }) { ui.draft.stake = +v; render(); },
  'currency-pick'({ c }) { ui.draft.currency = c; render(); },
  'draft-mode'({ guest }) { ui.draft.guest = guest === '1'; setGuestPref(ui.draft.guest); render(); },
  'shuffle-teams'() {
    const key = ui.draft.guest ? 'guestNames' : 'teams';
    const all = ui.draft[key].flat();
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    ui.draft[key] = [[all[0], all[1]], [all[2], all[3]]];
    render();
    if (!reducedMotion()) {
      document.querySelectorAll('.slot.filled').forEach((el, i) => el.animate(
        [{ opacity: 0, transform: 'rotateX(80deg)' }, { opacity: 1, transform: 'none' }],
        { duration: 320, delay: i * 50, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'backwards' },
      ));
    }
  },
  'swap-teams'() { ui.draft[ui.draft.guest ? 'guestNames' : 'teams'].reverse(); render(); },
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
    const teams = d.guest ? d.guestNames.map((t, ti) => t.map((name, s) => guestId(ti, s, name))) : d.teams.map(t => t.slice());
    let g;
    if (ui.mode === 'zhuan') {
      const stake = round2(Number(d.stake));
      if (!(stake > 0)) { sound.play('nope'); return toast(tr('needStake')); }
      try { localStorage.setItem(ZHUAN_KEY, JSON.stringify({ stake, currency: d.currency })); } catch (e) { /* ignore */ }
      g = {
        id: uid(),
        createdAt: Date.now(),
        mode: 'zhuan',
        seats: teams.flat(),
        teams,
        stake,
        currency: d.currency,
        deals: [],
        ...(d.guest && { guest: true }),
      };
    } else {
      const unequal = d.start.levels[0] !== d.start.levels[1];
      g = {
        id: uid(),
        createdAt: Date.now(),
        teams,
        rules: { ...d.rules },
        start: { levels: d.start.levels.slice(), declarer: unequal ? d.start.declarer : null },
        deals: [],
        abandoned: false,
        ...(d.guest && { guest: true }),
      };
    }
    ui.draft = null;
    mutate(tr('dealt'), () => {
      dropGuestGames();
      data.games.push(g);
      setActive(g.id);
    });
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
    setMode(isZhuan(g) ? 'zhuan' : 'normal');
    ui.tab = 'play';
    ui.gameId = null;
    mutate(tr('backAtTable'), () => { g.abandoned = false; setActive(id); });
    switchView();
  },
  'go-play'({ mode }) {
    setMode(mode);
    ui.tab = 'play';
    ui.gameId = null;
    render();
    switchView();
  },
  'delete-game'({ id }) {
    openSheet({
      type: 'confirm',
      title: tr('deleteGameTitle'),
      body: tr('deleteGameBody'),
      label: tr('deleteGame'),
      run: () => {
        ui.gameId = null;
        mutate(tr('gameDeleted'), () => {
          data.games = data.games.filter(g => g.id !== id);
          if (data.activeGameId === id) data.activeGameId = null;
          if (data.activeZhuanId === id) data.activeZhuanId = null;
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
  'stats-mode'({ m }) { ui.statsMode = m; render(); },

  // mode: 掼蛋 or 转蛋
  'pick-mode'() { showModePicker(); },
  'rules-open'() { openSheet({ type: 'rules' }); },
  'pick-guest'({ guest }) {
    const on = guest === '1';
    setGuestPref(on);
    if (ui.draft) ui.draft.guest = on;
    const el = document.getElementById('mode-pick');
    el?.querySelectorAll('[data-action="pick-guest"]').forEach(b => b.classList.toggle('on', b.dataset.guest === guest));
    const note = el?.querySelector('.mp-note');
    if (note) note.textContent = tr(on ? 'pickGuestDesc' : 'pickSavedDesc');
  },
  'choose-mode'({ mode }) {
    setMode(mode);
    if (ui.draft && !activeGame()) ui.draft.guest = guestPref();
    hideModePicker();
    ui.tab = 'play';
    ui.gameId = null;
    render();
    switchView();
  },
  'open-player'({ id }) {
    ui.tab = 'players';
    ui.playerId = id;
    render();
    switchView();
  },
  'back-players'() { ui.playerId = null; render(); switchView(); },
  'archive-player'({ id }) {
    const p = findPlayer(id);
    mutate(tr(p.archived ? 'isBack' : 'isHidden', p.name), () => { p.archived = !p.archived; });
  },
  'share-game'({ id }) { shareText(gameShareText(findGame(id))); },
  'share-stats'() { shareText(statsShareText()); },
  'rename-open'({ id }) { openSheet({ type: 'rename', playerId: id }); },
  // A player with games is only flagged, so their past games and stats keep their name.
  'delete-player'({ id }) {
    const p = findPlayer(id);
    const used = data.games.some(g => g.teams.flat().includes(id));
    openSheet({
      type: 'confirm',
      title: tr('deletePlayerTitle', esc(p.name)),
      body: used ? tr('deletePlayerBodyUsed', esc(p.name)) : tr('deletePlayerBody'),
      label: tr('deletePlayer'),
      run: () => {
        ui.playerId = null;
        mutate(tr('deletedPlayer', p.name), () => {
          if (used) findPlayer(id).deleted = true;
          else data.players = data.players.filter(x => x.id !== id);
          if (ui.draft) ui.draft.teams = ui.draft.teams.map(t => t.map(x => (x === id ? null : x)));
        });
      },
    });
  },
  async export() {
    const json = JSON.stringify(data, null, 2);
    const name = `guandan-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: tr('backupShareTitle') }); return; }
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
  'rename-seat'(fd, form) {
    const g = findGame(ui.sheet?.gameId);
    const old = form.dataset.id;
    const name = String(fd.get('name')).trim().replace(/\s+/g, ' ').replace(/\|/g, '/');
    if (!g || !name || name === pname(old)) return closeSheet();
    if (g.seats.some(id => id !== old && pname(id).toLowerCase() === name.toLowerCase())) {
      sound.play('nope');
      return toast(tr('alreadyAtTable', name));
    }
    const nid = `guest|${old.split('|')[1]}|${name}`;
    const swap = id => (id === old ? nid : id);
    ui.sheet = null;
    mutate(tr('nowPlayingAs', name), () => {
      g.seats = g.seats.map(swap);
      g.teams = g.teams.map(t => t.map(swap));
      for (const d of g.deals) {
        d.teams = d.teams.map(t => t.map(swap));
        d.firstOut = d.firstOut && swap(d.firstOut);
      }
    });
  },
  'rename-player'(fd, form) {
    const p = findPlayer(form.dataset.id);
    const name = String(fd.get('name')).trim().replace(/\s+/g, ' ');
    if (!name || name === p.name) return closeSheet();
    if (data.players.some(x => x !== p && !x.deleted && x.name.toLowerCase() === name.toLowerCase())) {
      sound.play('nope');
      return toast(tr('alreadyAtTable', name));
    }
    ui.sheet = null;
    mutate(tr('nowPlayingAs', name), () => { p.name = name; });
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

// Typing a quick-game name only updates the draft, so the field keeps focus.
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input === 'guest-name') ui.draft.guestNames[+el.dataset.team][+el.dataset.seat] = el.value;
  if (el.dataset.input === 'stake') ui.draft.stake = parseFloat(el.value);
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
  if (!validData(parsed)) { sound.play('nope'); return toast(tr('notBackup')); }
  openSheet({
    type: 'confirm',
    title: tr('replaceAll'),
    body: tr('backupBody', parsed.players.length, parsed.games.length),
    label: tr('importBackup'),
    run: () => mutate(tr('backupImported'), () => { data = parsed; }),
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.sheet) closeSheet();
});

// ---------- mode: 掼蛋 or 转蛋 ----------
function setMode(m) {
  if (ui.mode === m) return;
  ui.mode = m;
  ui.statsMode = null;
  ui.shown = null;
  ui.fanDealt = false;
  try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* ignore */ }
}

// Shown right after the opening animation, and from the mode button on the Play screen.
function showModePicker() {
  if (document.getElementById('mode-pick')) return;
  ui.sheet = null;
  renderSheet();
  const el = document.createElement('div');
  el.id = 'mode-pick';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', tr('pickModeTitle'));
  el.innerHTML = `
    <div class="mp-inner">
      <h2 class="mp-title">${tr('pickModeTitle')}</h2>
      <div class="mp-kind">
        <div class="seg mp-seg">
          <button class="${guestPref() ? 'on' : ''}" data-action="pick-guest" data-guest="1">${tr('modeGuest')}</button>
          <button class="${guestPref() ? '' : 'on'}" data-action="pick-guest" data-guest="0">${tr('modeSaved')}</button>
        </div>
        <p class="mp-note">${tr(guestPref() ? 'pickGuestDesc' : 'pickSavedDesc')}</p>
      </div>
      <button class="mode-card ${ui.mode === 'normal' ? 'last' : ''}" data-action="choose-mode" data-mode="normal">
        <span class="mc-cards" aria-hidden="true">${playingCard(0, 0, 'sm')}${playingCard(ACE, 1, 'sm')}</span>
        <span class="mc-text"><b>${tr('modeNormal')}</b><span>${tr('modeNormalSub')}</span></span>
      </button>
      <button class="mode-card ${ui.mode === 'zhuan' ? 'last' : ''}" data-action="choose-mode" data-mode="zhuan">
        <span class="mc-cards" aria-hidden="true">${playingCard(0, 0, 'sm')}<span class="coin">¥</span><span class="coin two">$</span></span>
        <span class="mc-text"><b>${tr('modeZhuan')}</b><span>${tr('modeZhuanSub')}</span></span>
      </button>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('sheet-open');
  if (reducedMotion()) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  [el.querySelector('.mp-title'), el.querySelector('.mp-kind'), ...el.querySelectorAll('.mode-card')].forEach((n, i) => n.animate(
    [{ opacity: 0, transform: 'translateY(24px) scale(.97)' }, { opacity: 1, transform: 'none' }],
    { duration: 420, delay: 80 + i * 90, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'backwards' },
  ));
}

function hideModePicker() {
  const el = document.getElementById('mode-pick');
  if (!el) return;
  document.body.classList.remove('sheet-open');
  el.style.pointerEvents = 'none';
  if (reducedMotion()) { el.remove(); return; }
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' }).onfinish = () => el.remove();
  setTimeout(() => el.remove(), 400); // in case the fade never reports finishing
}

// ---------- opening animation ----------
// The chick waddles in from the side, stops with a hop, two decks' worth of aces fan out
// behind it, the name rises (in both languages), then it all fades into the app.
// A tap anywhere skips straight in.
function runSplash() {
  const el = document.getElementById('splash');
  if (!el) { showModePicker(); return; }
  const FAN = [[-42, 1], [-14, 0], [14, 1], [42, 0]];   // [angle, suit index]
  const other = lang === 'zh' ? 'en' : 'zh';
  el.innerHTML = `
    <div class="splash-stage">
      ${FAN.map(([, t]) => playingCard(ACE, t)).join('')}
      <div class="splash-chick"><img src="icons/chick.png" alt=""></div>
    </div>
    <h1 class="splash-title">${tr('appName')}</h1>
    <p class="splash-alt">${STRINGS[other].appName}</p>
    <p class="splash-tag">${tr('tagline')}</p>
    <div class="splash-suits">${['♠', '♥', '♣', '♦'].map(x => `<span>${x}</span>`).join('')}</div>`;
  const cards = [...el.querySelectorAll('.pcard-wrap')];
  const chick = el.querySelector('.splash-chick');
  const body = chick.querySelector('img');
  const texts = [...el.querySelectorAll('.splash-title, .splash-alt, .splash-tag, .splash-suits')];
  const rest = 'translate(-50%, -50%)';
  const fanned = a => `${rest} rotate(${a}deg) translateY(-34px)`;
  // hidden until the timeline actually starts, so a slow launch never shows a frozen frame
  [chick, ...cards, ...texts].forEach(n => { n.style.opacity = '0'; });
  cards.forEach((c, i) => { c.style.transform = fanned(FAN[i][0]); });

  let done = false;
  const timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const exit = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    sound.stopIntro();
    showModePicker(); // waits underneath while the opening fades away
    el.style.pointerEvents = 'none'; // so the picker can be tapped straight away
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reducedMotion() ? 300 : 450, easing: 'ease-in', fill: 'forwards' })
      .onfinish = () => el.remove();
    setTimeout(() => el.remove(), 700); // in case the fade never reports finishing
    if (!reducedMotion()) el.querySelector('.splash-stage').animate([{ transform: 'none' }, { transform: 'scale(1.08)' }], { duration: 450, fill: 'forwards' });
  };
  el.addEventListener('pointerdown', exit, { once: true });

  const pop = 'cubic-bezier(.23, 1, .32, 1)';
  const fadeIn = (n, delay, extra = {}) => n.animate(
    [{ opacity: 0, ...extra.from }, { opacity: 1, ...extra.to }],
    { duration: extra.duration ?? 520, delay, easing: pop, fill: 'both' },
  );

  // a little cloud of dust left behind at the chick's feet
  const puff = () => {
    const r = chick.getBoundingClientRect();
    const d = document.createElement('span');
    d.className = 'splash-puff';
    d.style.left = r.left + r.width * 0.28 + 'px';
    d.style.top = r.bottom - 14 + 'px';
    el.appendChild(d);
    d.animate(
      [{ opacity: 0.8, transform: 'translate(-50%, -50%) scale(.4)' }, { opacity: 0, transform: 'translate(calc(-50% - 26px), calc(-50% - 10px)) scale(1.6)' }],
      { duration: 650, easing: 'ease-out', fill: 'forwards' },
    ).onfinish = () => d.remove();
  };

  const play = () => {
    if (done) return;
    if (reducedMotion()) {
      // Reduce Motion: still a real animation, but small and soft: pieces glide a short way
      // into place, with no waddling, bouncing, spinning or zooming
      const glide = { from: { transform: 'translateY(14px) scale(.96)' }, to: { transform: 'none' } };
      sound.intro({ calm: true });
      fadeIn(chick, 0, { duration: 800, from: { transform: 'translateX(-40px)' }, to: { transform: 'none' } });
      cards.forEach((c, i) => fadeIn(c, 400 + i * 110, {
        duration: 700,
        from: { transform: `${rest} rotate(${FAN[i][0] * 0.6}deg) translateY(-24px)` },
        to: { transform: fanned(FAN[i][0]) },
      }));
      texts.forEach((t, i) => fadeIn(t, 900 + i * 140, { duration: 600, ...glide }));
      later(exit, 3500);
      return;
    }

    // 1. waddle in from off-screen left: the whole chick slides across while its body
    //    rocks side to side and bobs, one step every 217ms
    const WALK = 1300, STEP = 217;
    sound.intro({ walk: WALK / 1000, step: STEP / 1000, t: (WALK + 240) / 1000 });
    const from = -(window.innerWidth / 2 + 140);
    chick.animate(
      [{ opacity: 1, transform: `translateX(${from}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: WALK, easing: 'cubic-bezier(.3, .1, .5, 1)', fill: 'both' },
    );
    body.animate(
      [
        { transform: 'rotate(-8deg) translateY(0)' },
        { transform: 'rotate(0deg) translateY(-12px)', offset: 0.25 },
        { transform: 'rotate(8deg) translateY(0)', offset: 0.5 },
        { transform: 'rotate(0deg) translateY(-12px)', offset: 0.75 },
        { transform: 'rotate(-8deg) translateY(0)' },
      ],
      { duration: STEP * 2, iterations: WALK / (STEP * 2) },
    );
    for (let t = STEP; t < WALK; t += STEP) later(puff, t);

    // 2. stop with a happy hop and settle
    body.animate(
      [
        { transform: 'none' },
        { transform: 'translateY(4px) scaleY(.92) scaleX(1.05)', offset: 0.2 },
        { transform: 'translateY(-26px) scaleY(1.04)', offset: 0.5 },
        { transform: 'translateY(2px) scaleY(.96)', offset: 0.8 },
        { transform: 'none' },
      ],
      { duration: 520, delay: WALK + 40, easing: 'ease-in-out' },
    );

    // 3. the aces fan out behind it, then the names rise
    const T = WALK + 240;
    cards.forEach((c, i) => fadeIn(c, T + i * 80, {
      duration: 560,
      from: { transform: `${rest} rotate(0deg) translateY(20px) scale(.6)` },
      to: { transform: fanned(FAN[i][0]) },
    }));
    texts.forEach((t, i) => fadeIn(t, T + 300 + i * 100, { from: { transform: 'translateY(16px)' }, to: { transform: 'none' } }));

    // 4. a last flourish: the aces wave, the chick wiggles, the suits light up one by one
    cards.forEach((c, i) => c.animate(
      [{ transform: fanned(FAN[i][0]) }, { transform: `${fanned(FAN[i][0])} translateY(-16px)`, offset: 0.45 }, { transform: fanned(FAN[i][0]) }],
      { duration: 480, delay: T + 820 + i * 90, easing: 'ease-in-out' },
    ));
    body.animate(
      [{ transform: 'none' }, { transform: 'rotate(-7deg)', offset: 0.25 }, { transform: 'rotate(7deg)', offset: 0.6 }, { transform: 'none' }],
      { duration: 600, delay: T + 1100, easing: 'ease-in-out' },
    );
    el.querySelectorAll('.splash-suits span').forEach((x, i) => x.animate(
      [{ transform: 'none', filter: 'none' }, { transform: 'scale(1.45)', filter: 'drop-shadow(0 0 8px rgba(242, 196, 92, .9))', offset: 0.4 }, { transform: 'none', filter: 'none' }],
      { duration: 420, delay: T + 950 + i * 110, easing: 'ease-out' },
    ));
    later(exit, T + 1810);   // fade-out ends at 3.8s
  };

  // Start once the chick image is ready and the screen has really painted. On an iPhone
  // Home Screen launch, script can run while the system launch screen is still up.
  const ready = body.decode ? body.decode().catch(() => {}) : Promise.resolve();
  Promise.race([ready, new Promise(r => setTimeout(r, 900))])
    .then(() => requestAnimationFrame(() => requestAnimationFrame(play)));
}

// ---------- boot ----------
applyLang();
runSplash();
render();
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
