// What to play next, and what a pass or a miss does to a phrase.
// Ported from the Android app's Scheduler (SlovakDrive): the same rules, without the parts that need a
// microphone judge (there's no Whisper here, so only the learner's own "again" is a miss).
//
//  - a new phrase is taught (heard, said back), then comes back after 3, 10 and 25 cards
//  - then the next session, then 2 days, a week, two weeks, a month, ... (the ladder in DAYS)
//  - a miss sends it back to the start of the learning steps
//  - each due review passed stretches every gap a little, each one missed shrinks them (aims at ~9 in 10 passed)
//  - the first session of a day tests the last study day's phrases before anything new
//  - new phrases a day: the chosen pace, up to half as much again while recall is strong

export const STEPS = [3, 10, 25];
export const DAYS = [0, 0, 2, 7, 14, 30, 60, 120, 240, 365];
export const MASTERED = 4;
export const MAX_ACTIVE = 2;
export const MIN_PACE = 5, MAX_PACE = 40, DEFAULT_PACE = 15;
const RECALL_KEPT = 40;
const STRETCH_PASS = 1.02, STRETCH_FAIL = 0.82, STRETCH_MIN = 0.6, STRETCH_MAX = 4.0;
const MISS_RUN = 3, EASE_CARDS = 8;
const EXTRA_GAP = 40;
const WARMUP_MAX = 40;
const DAY_MS = 86_400_000;
const SESSION_GAP_MS = 30 * 60_000;
const NEXT_SESSION_MS = 3 * 3_600_000;
const DAY_ROLLOVER_MS = 4 * 3_600_000;   // a study day runs 4am to 4am

export function freshProgress() {
  return {
    items: {}, cardCounter: 0, lastActive: 0, streak: 0, lastDay: -1, newToday: 0, capToday: 0,
    recall: [], cardsToday: 0, rightToday: 0, missedToday: 0, warmup: [],
    pace: DEFAULT_PACE, stretch: 1.0, dayCards: [], slow: false,
  };
}

function freshState() {
  return { phase: "NEW", step: 0, dueCard: 0, stage: 0, dueAt: 0, reps: 0, lapses: 0, misses: 0, lastMiss: 0, firstSeen: 0 };
}

export class Scheduler {
  constructor(course, p) {
    this.course = course;
    this.items = course.items;
    this.byId = new Map(course.items.map(i => [i.id, i]));
    this.p = p;
    this.recent = [];
    this.missRun = 0;
    this.easeLeft = 0;
    this.newPtr = 0;
    this.undo = null;
    this.seenAt = new Map();
    this.inWarmup = false;
    this.warmupDone = false;
    for (const st of Object.values(p.items)) if (st.step > STEPS.length - 1) st.step = STEPS.length - 1;
  }

  tz() { return -new Date().getTimezoneOffset() * 60_000; }
  day(now) { return Math.floor((now + this.tz() - DAY_ROLLOVER_MS) / DAY_MS); }
  dayStart(now) { return this.day(now) * DAY_MS - this.tz() + DAY_ROLLOVER_MS; }
  state(id) { return this.p.items[id] || (this.p.items[id] = freshState()); }
  phase(id) { return this.p.items[id]?.phase || "NEW"; }

  newCap() {
    if (!this.p.capToday) {
      const pace = Math.min(MAX_PACE, Math.max(MIN_PACE, this.p.pace));
      const r = this.p.recall;
      const rate = r.length < 15 ? 0 : r.filter(Boolean).length / r.length;
      this.p.capToday = rate >= 0.9 ? Math.floor(pace * 3 / 2) : rate >= 0.8 ? Math.floor(pace * 5 / 4) : pace;
    }
    return this.p.capToday;
  }

  adapt(passed) {
    this.p.stretch = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, this.p.stretch * (passed ? STRETCH_PASS : STRETCH_FAIL)));
  }

  /** The study day starting at [from]: what was met, missed or still being learned that day. */
  warmupList(from) {
    const to = from + DAY_MS, on = t => t >= from && t < to;
    return this.items.filter(it => {
      const st = this.p.items[it.id];
      if (!st) return false;
      const filed = st.phase === "REVIEW" && st.stage > MASTERED;
      return !filed && (st.phase === "LEARNING" || on(st.firstSeen) || on(st.lastMiss));
    }).sort((a, b) => {
      const x = this.p.items[a.id], y = this.p.items[b.id];
      return ((x.phase !== "LEARNING") - (y.phase !== "LEARNING")) || (y.misses - x.misses) || (x.firstSeen - y.firstSeen);
    }).slice(0, WARMUP_MAX).map(it => it.id);
  }

  takeWarmupDone() { const d = this.warmupDone; this.warmupDone = false; return d; }

  /** Call whenever playback starts. True when this is a new session. */
  startSession(now) {
    const p = this.p;
    const fresh = now - p.lastActive > SESSION_GAP_MS;
    const d = this.day(now);
    if (d !== p.lastDay) {
      if (p.lastDay >= 0) p.warmup = this.warmupList(p.lastDay * DAY_MS - this.tz() + DAY_ROLLOVER_MS);
      if (p.lastDay >= 0 && p.cardsToday > 0) { p.dayCards.push(p.cardsToday); if (p.dayCards.length > 7) p.dayCards.shift(); }
      p.streak = d === p.lastDay + 1 ? p.streak + 1 : 1;
      p.lastDay = d;
      p.newToday = 0; p.capToday = 0; p.cardsToday = 0; p.rightToday = 0; p.missedToday = 0;
    }
    if (fresh) {
      for (const st of Object.values(p.items)) if (st.phase === "LEARNING") st.dueCard = p.cardCounter;
      this.missRun = 0; this.easeLeft = 0; this.recent = []; this.undo = null;
    }
    p.lastActive = now;
    return fresh;
  }

  card(kind, item) {
    this.seenAt.set(item.id, this.p.cardCounter);
    const st = this.state(item.id);
    return { kind, item, stage: st.phase === "REVIEW" ? st.stage : 0, reps: st.reps };
  }

  nextNew() {
    while (this.newPtr < this.items.length && this.phase(this.items[this.newPtr].id) !== "NEW") this.newPtr++;
    return this.items[this.newPtr] || null;
  }

  next(now) {
    const p = this.p;
    const c = ++p.cardCounter;
    const last = this.recent[this.recent.length - 1];

    // yesterday's phrases, tested cold after a night's sleep, before anything new
    while (p.warmup.length) {
      const item = this.byId.get(p.warmup.shift());
      const st = item && p.items[item.id];
      if (!st || (st.phase === "REVIEW" && st.stage > MASTERED)) continue;
      this.inWarmup = true;
      return this.card("RECALL", item);
    }
    if (this.inWarmup) { this.inWarmup = false; this.warmupDone = true; }

    const learning = this.items.filter(it => this.phase(it.id) === "LEARNING");
    const dueLearning = learning.filter(it => it.id !== last && this.state(it.id).dueCard <= c)
      .sort((a, b) => this.state(a.id).dueCard - this.state(b.id).dueCard)[0];
    if (dueLearning) return this.card("LEARN", dueLearning);

    const easing = this.easeLeft > 0;
    if (easing) this.easeLeft--;

    const pool = this.items.filter(it => this.phase(it.id) === "REVIEW" && !this.recent.includes(it.id));
    const due = pool.filter(it => this.state(it.id).dueAt <= now);
    const active = learning.filter(it => this.state(it.id).step < 2 && this.state(it.id).lapses === 0).length;
    const room = p.newToday < this.newCap();
    const fresh = !easing && active < MAX_ACTIVE && room ? this.nextNew() : null;

    if (due.length && (!fresh || c % 3 !== 0)) {
      const pick = easing
        ? due.reduce((a, b) => this.state(b.id).stage > this.state(a.id).stage ? b : a)
        : due.reduce((a, b) => {
            const x = this.state(a.id), y = this.state(b.id);
            return (y.stage < x.stage || (y.stage === x.stage && y.dueAt < x.dueAt)) ? b : a;
          });
      return this.card("RECALL", pick);
    }
    if (fresh) return this.card("INTRO", fresh);

    // nothing due and no room for new: extra practice on known phrases (changes nothing in their schedule)
    if (pool.length) return this.card("EXTRA", this.pickExtra(pool, now));
    const anyLearning = learning.filter(it => it.id !== last).sort((a, b) => this.state(a.id).dueCard - this.state(b.id).dueCard)[0];
    if (anyLearning) return this.card("LEARN", anyLearning);
    const n = this.nextNew();
    if (n) return this.card("INTRO", n);
    if (learning[0]) return this.card("LEARN", learning[0]);
    return this.card("EXTRA", this.items[Math.floor(Math.random() * this.items.length)]);
  }

  pickExtra(pool, now) {
    const c = this.p.cardCounter;
    const rested = pool.filter(it => c - (this.seenAt.get(it.id) ?? -EXTRA_GAP) >= EXTRA_GAP);
    if (!rested.length) return pool.reduce((a, b) => (this.seenAt.get(b.id) ?? 0) < (this.seenAt.get(a.id) ?? 0) ? b : a);
    const today = this.dayStart(now);
    const key = it => {
      const st = this.state(it.id);
      return [st.lastMiss < today ? 1 : 0, st.stage, this.seenAt.get(it.id) ?? 0];
    };
    return rested.reduce((a, b) => {
      const x = key(a), y = key(b);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] < x[i] ? b : a;
      return a;
    });
  }

  toReview(st, stage, now) {
    st.phase = "REVIEW";
    st.stage = stage;
    st.dueAt = stage <= 1 ? now + NEXT_SESSION_MS : this.dayStart(now) + Math.max(1, Math.round(DAYS[stage] * this.p.stretch)) * DAY_MS;
  }

  /** "TEACH" when the phrase should be taught again right now. [easy]: she's sure of it: skips a step. */
  grade(card, pass, now, easy = false) {
    const p = this.p, item = card.item, st = this.state(item.id);
    this.undo = { card, state: { ...st }, newToday: p.newToday, cardsToday: p.cardsToday };
    const c = p.cardCounter;
    p.lastActive = now;
    st.reps++;
    p.cardsToday++;
    this.recent.push(item.id);
    if (this.recent.length > 8) this.recent.shift();
    if (!pass) { st.misses++; st.lastMiss = now; }
    if (card.kind !== "INTRO" || !pass) { if (pass) p.rightToday++; else p.missedToday++; }
    if (st.phase !== "NEW") {
      p.recall.push(pass);
      if (p.recall.length > RECALL_KEPT) p.recall.shift();
      if (pass) this.missRun = 0;
      else if (++this.missRun >= MISS_RUN) { this.missRun = 0; this.easeLeft = EASE_CARDS; }
    }

    if (st.phase === "NEW") {
      st.firstSeen = now;
      st.phase = "LEARNING"; st.step = 0; st.dueCard = c + STEPS[0];
      p.newToday++;
      return pass ? "NONE" : "TEACH";
    }
    if (st.phase === "LEARNING") {
      if (!pass) { st.step = 0; st.dueCard = c + STEPS[0]; return "TEACH"; }
      st.step += easy ? 2 : 1;
      if (st.step >= STEPS.length) { this.toReview(st, 1, now); return "GRADUATED"; }
      st.dueCard = c + STEPS[st.step];
      return "NONE";
    }
    // REVIEW: only a due review tests the gap; extra practice says nothing about it
    const test = card.kind !== "EXTRA" && st.dueAt <= now;
    if (!pass) {
      if (test) this.adapt(false);
      st.lapses++;
      st.phase = "LEARNING"; st.step = 1; st.dueCard = c + STEPS[0];
      return "TEACH";
    }
    if (card.kind === "EXTRA" || st.dueAt > now) return "NONE";
    this.adapt(true);
    const was = st.stage;
    const stage = Math.min(st.stage + (easy ? 2 : 1), DAYS.length - 1);
    this.toReview(st, stage, now);
    return was < MASTERED && stage >= MASTERED ? "MASTERED" : "NONE";
  }

  /** The card just gone was let through, but she said "again" a moment after it ended. */
  regradeLastAsMiss(now) {
    const u = this.undo;
    if (!u) return null;
    this.p.items[u.card.item.id] = u.state;
    this.p.newToday = u.newToday;
    this.p.cardsToday = u.cardsToday;
    if (this.recent[this.recent.length - 1] === u.card.item.id) this.recent.pop();
    this.grade(u.card, false, now);
    this.undo = null;
    return u.card.item;
  }

  stats(now) {
    let mastered = 0, known = 0, learning = 0, due = 0;
    for (const it of this.items) {
      const st = this.p.items[it.id];
      if (!st) continue;
      if (st.phase === "LEARNING") learning++;
      else if (st.phase === "REVIEW") { known++; if (st.stage >= MASTERED) mastered++; if (st.dueAt <= now) due++; }
    }
    return { mastered, known, learning, due, total: this.items.length, streak: this.p.streak,
             today: this.p.cardsToday, newToday: this.p.newToday, newCap: this.newCap() };
  }
}
