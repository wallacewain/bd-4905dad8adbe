// The lesson player: cards of audio and silences, on a timer (no answer judging on the iPhone),
// with "again" from the screen, the buttons, or headphone/car controls.
import { Scheduler, freshProgress, MIN_PACE, MAX_PACE } from "./sched.js";

const KEY = "bd-progress-v1";
const $ = id => document.getElementById(id);

let course, sched, p;
let card = null, steps = [], at = 0, graded = false, playing = false, run = 0;
let cardStartedAt = 0, prevCard = null;
const audio = new Audio();
audio.preload = "auto";
let wake = null;

// ── Progress: on this phone, in localStorage; backed up by hand ─────────────────────────────

function load() {
  try { return Object.assign(freshProgress(), JSON.parse(localStorage.getItem(KEY) || "{}")); }
  catch { return freshProgress(); }
}
function save() { localStorage.setItem(KEY, JSON.stringify(p)); }

// ── Cards: what's said, and the gaps between ─────────────────────────────────────────────

const ease = () => (p.slow ? 1.4 : 1);
const L = item => item.ms || 1500;   // how long the Bündner takes to say it; every gap is sized from this

function think(item, stage) {
  const base = Math.min(8000, 900 + L(item) * 1.5);
  const f = stage >= 5 ? 0.7 : stage >= 3 ? 0.85 : 1;
  return base * f * ease();
}
const shadow = item => (300 + L(item) * 1.3) * ease();
const firstRate = item => (L(item) >= 2200 ? 0.85 : 1);

function shown(item) { return { main: item.gsw, sub: item.en, lit: item.lit || "" }; }
function asked(item) { return { main: item.en, sub: "", lit: "" }; }

function recall(item, stage) {
  return [
    { clip: item.enClip, part: "PROMPT", ...asked(item), cue: "" },
    { wait: think(item, stage), part: "WAIT", ...asked(item), cue: "Your turn: say it" },
    { clip: item.clip, part: "ANSWER", ...shown(item), cue: "" },
    { wait: shadow(item), part: "ANSWER", ...shown(item), cue: "Say it again" },
  ];
}

function intro(item) {
  const r = firstRate(item);
  return [
    { clip: item.enClip, part: "PROMPT", ...asked(item), cue: "New" },
    { wait: 400, part: "ANSWER", ...shown(item), cue: "New" },
    { clip: item.clip, rate: r, part: "ANSWER", ...shown(item), cue: "New" },
    { wait: shadow(item), part: "ANSWER", ...shown(item), cue: "Say it" },
    { clip: item.clip, part: "ANSWER", ...shown(item), cue: "New" },
    { wait: shadow(item), part: "ANSWER", ...shown(item), cue: "Say it" },
  ];
}

function teach(item, sayEnglish) {
  const out = [{ tone: "blip", part: "ANSWER", ...shown(item), cue: "Again" }];
  if (sayEnglish) out.push({ clip: item.enClip, part: "ANSWER", ...shown(item), cue: "Again" });
  out.push({ wait: 400, part: "ANSWER", ...shown(item), cue: "Again" });
  out.push({ clip: item.clip, rate: firstRate(item), part: "ANSWER", ...shown(item), cue: "Again" });
  out.push({ wait: shadow(item) + 300, part: "ANSWER", ...shown(item), cue: "Say it" });
  return out;
}

function script(c) {
  return c.kind === "INTRO" ? intro(c.item) : recall(c.item, c.stage);
}

// ── Playing ─────────────────────────────────────────────────────────────────────────────────

const sleep = (ms, token) => new Promise(res => {
  const t = setTimeout(res, ms);
  stopWaits.push(() => { clearTimeout(t); res(); });
});
let stopWaits = [];
function cancelWaits() { stopWaits.forEach(f => f()); stopWaits = []; }

let tones;
function tone(kind) {
  tones = tones || new (window.AudioContext || window.webkitAudioContext)();
  const o = tones.createOscillator(), g = tones.createGain();
  o.frequency.value = kind === "ding" ? 1320 : 520;
  g.gain.setValueAtTime(0.0001, tones.currentTime);
  g.gain.exponentialRampToValueAtTime(0.25, tones.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, tones.currentTime + (kind === "ding" ? 0.5 : 0.18));
  o.connect(g).connect(tones.destination);
  o.start(); o.stop(tones.currentTime + 0.55);
  return kind === "ding" ? 450 : 220;
}

function playClip(src, rate, token) {
  return new Promise(res => {
    if (token !== run) return res();
    const done = () => { audio.onended = audio.onerror = null; res(); };
    audio.onended = done;
    audio.onerror = done;
    stopWaits.push(done);
    audio.src = src;
    audio.playbackRate = rate || 1;
    audio.play().catch(done);
  });
}

async function playSteps(list) {
  const token = ++run;
  steps = list;
  for (at = 0; at < steps.length; at++) {
    if (token !== run || !playing) return;
    const s = steps[at];
    show(s);
    if (s.clip) await playClip(s.clip, s.rate, token);
    else if (s.tone) await sleep(tone(s.tone), token);
    else await sleep(s.wait, token);
  }
  if (token === run && playing) cardEnded();
}

function cardEnded() {
  const now = Date.now();
  if (card && !graded) {
    const outcome = sched.grade(card, true, now);
    if (outcome === "GRADUATED" || outcome === "MASTERED") flash("win");
    prevCard = card;
  }
  save();
  nextCard();
}

function nextCard() {
  card = sched.next(Date.now());
  graded = false;
  cardStartedAt = Date.now();
  let lead = [];
  if (sched.takeWarmupDone()) lead = [{ tone: "ding", part: "PRE", main: "Yesterday's done", sub: "Now something new", lit: "", cue: "" }];
  mediaMeta();
  playSteps([...lead, ...script(card)]);
  renderStats();
}

/** Missed it: taught again now; at the very start of a card it was about the one just gone. */
function miss() {
  if (!playing || !card) return;
  const now = Date.now();
  const early = now - cardStartedAt < 1500 && prevCard;
  let target;
  if (early) {
    target = sched.regradeLastAsMiss(now);
    if (!target) return;
  } else {
    if (graded) return;
    sched.grade(card, false, now);
    target = card.item;
  }
  graded = true;
  prevCard = null;
  save();
  flash("miss");
  cancelWaits();
  const heardEnglish = target === card.item && steps[at]?.part !== "PROMPT";
  playSteps(teach(target, !heardEnglish));
  renderStats();
}

/** Skip: to the answer if it hasn't played yet, otherwise to the next card. */
function skip() {
  if (!playing) return;
  const answer = steps.findIndex(s => s.part === "ANSWER");
  cancelWaits();
  if (answer > at) { const rest = steps.slice(answer); playSteps(rest); }
  else { run++; cardEnded(); }
}

async function start() {
  if (playing) return;
  playing = true;
  $("play").textContent = "❚❚";
  try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  const fresh = sched.startSession(Date.now());
  save();
  if (!card || fresh) nextCard(); else playSteps(script(card));   // a paused card starts again from its prompt
}

function pause() {
  playing = false;
  run++;
  cancelWaits();
  audio.pause();
  $("play").textContent = "▶︎";
  $("cue").textContent = "Paused";
  wake?.release?.(); wake = null;
  save();
}

// ── Screen ──────────────────────────────────────────────────────────────────────────────────

function show(s) {
  $("cue").textContent = s.cue || "";
  $("main").textContent = s.main || "";
  $("sub").textContent = s.sub || "";
  $("lit").textContent = s.lit || "";
}

function renderStats() {
  const st = sched.stats(Date.now());
  $("stats").innerHTML =
    `<span><b>${st.known}</b> of ${st.total} learnt</span><span>new today <b>${st.newToday}</b>/${st.newCap}</span>` +
    `<span><b>${st.due}</b> due</span><span>${st.streak} day${st.streak === 1 ? "" : "s"} running</span>`;
}

function flash(kind) {
  document.body.classList.remove("flash-miss", "flash-win");
  void document.body.offsetWidth;
  document.body.classList.add(kind === "miss" ? "flash-miss" : "flash-win");
}

function mediaMeta() {
  if (!("mediaSession" in navigator) || !card) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: card.item.en, artist: "Bündner Deutsch" });
}

function wire() {
  $("play").onclick = () => (playing ? pause() : start());
  $("again").onclick = miss;
  $("next").onclick = skip;
  $("stage").onclick = miss;   // tapping the screen = missed it, like the car app
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", start);
    ms.setActionHandler("pause", pause);
    ms.setActionHandler("previoustrack", miss);
    ms.setActionHandler("nexttrack", skip);
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && playing && !wake) { try { wake = await navigator.wakeLock?.request("screen"); } catch {} }
  });

  // settings
  $("open").onclick = () => { $("sheet").classList.add("open"); };
  $("close").onclick = () => { $("sheet").classList.remove("open"); save(); renderStats(); };
  const pace = $("pace");
  pace.min = MIN_PACE; pace.max = MAX_PACE; pace.value = p.pace;
  const paceText = () => { $("paceText").textContent = `${p.pace} new phrases a day (more on days your recall is strong)`; };
  paceText();
  pace.oninput = () => { p.pace = +pace.value; p.capToday = 0; paceText(); };
  $("slow").checked = p.slow;
  $("slow").onchange = () => { p.slow = $("slow").checked; };
  $("credits").innerHTML = course.credits || "";

  $("backup").onclick = backup;
  $("restore").onclick = () => $("restoreFile").click();
  $("restoreFile").onchange = restore;
  $("offline").onclick = saveOffline;
}

async function backup() {
  save();
  const name = `buendner-progress-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(p)], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Bündner Deutsch progress" }); return; } catch { return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
}

async function restore(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.items) throw new Error("not a progress file");
    pause();
    p = Object.assign(freshProgress(), data);
    save();
    sched = new Scheduler(course, p);
    card = null;
    renderStats();
    $("offText").textContent = "Progress restored.";
  } catch (err) {
    alert("That doesn't look like a progress backup.");
  }
  e.target.value = "";
}

async function saveOffline() {
  const urls = course.items.flatMap(i => [i.clip, i.enClip]);
  const cache = await caches.open("audio-v1");
  let n = 0;
  $("offline").disabled = true;
  for (const u of urls) {
    if (!(await cache.match(u))) { try { await cache.add(u); } catch {} }
    if (++n % 25 === 0) $("offText").textContent = `Saving recordings: ${n} of ${urls.length}…`;
  }
  $("offText").textContent = `All ${urls.length} recordings are saved on this phone.`;
  $("offline").disabled = false;
}

// ── Start up ────────────────────────────────────────────────────────────────────────────────

async function boot() {
  $("loading").textContent = "Loading…";
  course = await (await fetch("course.json", { cache: "no-cache" })).json();
  p = load();
  sched = new Scheduler(course, p);
  navigator.storage?.persist?.();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  wire();
  renderStats();
  $("loading").textContent = "";
  $("go").onclick = () => { $("start").remove(); start(); };
}
boot();
