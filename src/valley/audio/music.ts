// Music bus: one "deck" per playing track; switching crossfades (equal-power ramps, ~3.5 s), never cuts. Looping is
// done by hand: the next pass of the buffer starts `loopXf` s before the end and the two overlap, so the seam is a
// short crossfade instead of a click or a gap. Decoded PCM is large, so at most `keep` buffers stay decoded; the
// compressed bytes are cached and re-decoded on demand.
//
// There is no music yet (GAME.md, round 10): TRACKS is empty and want() ignores any name not listed there. Add a
// track by putting its OGG in public/audio/ and an entry in TRACKS, with its credit in CREDITS.md.

/** the tracks that exist: name -> loops (public/audio/<name>.ogg) */
const TRACKS: Record<string, { loop: boolean }> = {};
export type Track = string;
export const MUSIC = { xf: 3.5, loopXf: 1.2, keep: 3, defaultVol: 0.45 };
/** equal-power fade curves (sin in / cos out), scaled from `from` */
const curve = (dir: 1 | -1, from = 1, n = 48) => Float32Array.from({ length: n }, (_, i) => { const u = i / (n - 1); return from * (dir > 0 ? Math.sin(u * Math.PI / 2) : Math.cos(u * Math.PI / 2)) + 1e-4; });

export interface Music {
  /** call once the AudioContext exists (after the first user gesture) */
  attach(ctx: AudioContext): void;
  /** the track that should be playing (null: silence); crossfades when it changes */
  want(t: Track | null): void;
  volume(music: number, master: number): void;
  readonly current: Track | null;
  /** debug: RMS of the music bus output (dBFS) */
  level(): number;
}

interface Deck { track: Track; gain: GainNode; outG: GainNode; srcs: { s: AudioBufferSourceNode; g: GainNode; end: number }[]; nextAt: number; dead: boolean }

export function createMusic(): Music {
  let ctx: AudioContext | null = null, an: AnalyserNode | null = null, out: GainNode, lp: BiquadFilterNode;
  let wanted: Track | null = null, deck: Deck | null = null, musicVol = MUSIC.defaultVol, masterVol = 1;
  const old: Deck[] = [];
  const bytes = new Map<Track, Promise<ArrayBuffer>>();
  const pcm = new Map<Track, Promise<AudioBuffer>>();
  const used: Track[] = [];
  const BASE = import.meta.env.BASE_URL;
  const loops = (t: Track) => TRACKS[t]?.loop ?? false;

  const fetchBytes = (t: Track) => {
    if (!bytes.has(t)) bytes.set(t, fetch(`${BASE}audio/${t}.ogg`).then((r) => { if (!r.ok) throw new Error(`music ${t}: ${r.status}`); return r.arrayBuffer(); }));
    return bytes.get(t)!;
  };
  const buffer = (t: Track) => {
    const i = used.indexOf(t); if (i >= 0) used.splice(i, 1); used.push(t);
    // evict the least recently wanted decoded buffers (never one that is sounding)
    while (used.length > MUSIC.keep) {
      const v = used.find((x) => x !== deck?.track && !old.some((d) => d.track === x));
      if (!v) break; used.splice(used.indexOf(v), 1); pcm.delete(v);
    }
    if (!pcm.has(t)) pcm.set(t, fetchBytes(t).then((b) => ctx!.decodeAudioData(b.slice(0))));
    return pcm.get(t)!;
  };

  const applyVol = () => { if (ctx) out.gain.setTargetAtTime(musicVol * masterVol, ctx.currentTime, 0.08); };

  function startPass(d: Deck, buf: AudioBuffer, at: number, fadeIn: number) {
    const c = ctx!;
    const s = c.createBufferSource(); s.buffer = buf;
    const g = c.createGain(); s.connect(g).connect(d.gain);
    if (fadeIn > 0) g.gain.setValueCurveAtTime(curve(1), at, fadeIn); else g.gain.setValueAtTime(1, at);
    const dur = buf.duration, end = at + dur;
    if (loops(d.track)) {
      // fade this pass out over the loop crossfade, while the next pass fades in
      g.gain.setValueCurveAtTime(curve(-1), end - MUSIC.loopXf, MUSIC.loopXf);
      d.nextAt = end - MUSIC.loopXf;
    } else d.nextAt = Infinity;
    s.start(at); s.stop(end + 0.05);
    const rec = { s, g, end };
    d.srcs.push(rec);
    s.onended = () => { const i = d.srcs.indexOf(rec); if (i >= 0) d.srcs.splice(i, 1); try { g.disconnect(); } catch { /* */ } };
  }

  async function open(t: Track) {
    const c = ctx!;
    // two stages so the fade-in and a later fade-out never overlap automation on one param
    const d: Deck = { track: t, gain: c.createGain(), outG: c.createGain(), srcs: [], nextAt: Infinity, dead: false };
    d.gain.connect(d.outG).connect(lp);
    d.gain.gain.value = 0.0001;
    deck = d;
    let buf: AudioBuffer;
    try { buf = await buffer(t); } catch (e) { console.warn('[music]', e); return; }
    if (d.dead || deck !== d) return;
    const at = c.currentTime + 0.05;
    d.gain.gain.setValueCurveAtTime(curve(1), at, MUSIC.xf);
    startPass(d, buf, at, 0);
  }
  function close(d: Deck) {
    const c = ctx!, t = c.currentTime;
    d.dead = true;
    d.outG.gain.setValueCurveAtTime(curve(-1), t + 0.01, MUSIC.xf);
    old.push(d);
    setTimeout(() => {
      for (const r of d.srcs) { try { r.s.stop(); } catch { /* */ } }
      try { d.gain.disconnect(); d.outG.disconnect(); } catch { /* */ }
      const i = old.indexOf(d); if (i >= 0) old.splice(i, 1);
    }, (MUSIC.xf + 0.3) * 1000);
  }
  function sync() {
    if (!ctx) return;
    if ((deck?.track ?? null) === wanted) return;
    if (deck) { close(deck); deck = null; }
    if (wanted) void open(wanted);
  }
  // scheduler: queue the next loop pass ahead of its crossfade
  setInterval(() => {
    if (!ctx || !deck || deck.dead || !loops(deck.track)) return;
    if (ctx.currentTime > deck.nextAt - 1.0 && deck.nextAt < Infinity) {
      const d = deck, at = d.nextAt; d.nextAt = Infinity;
      void buffer(d.track).then((buf) => { if (!d.dead) startPass(d, buf, Math.max(at, ctx!.currentTime + 0.02), MUSIC.loopXf); });
    }
  }, 250);

  const M: Music = {
    get current() { return deck?.track ?? null; },
    level() { if (!an) return -120; const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); let q = 0; for (const v of b) q += v * v; return 10 * Math.log10(q / b.length + 1e-12); },
    attach(c) {
      if (ctx) return;
      ctx = c;
      out = c.createGain(); out.gain.value = musicVol * masterVol;
      lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.5;
      lp.connect(out).connect(c.destination);
      an = c.createAnalyser(); an.fftSize = 2048; out.connect(an);
      sync();
    },
    want(t) {
      if (t !== null && !(t in TRACKS)) t = null;
      if (t === wanted) return;
      wanted = t; sync();
    },
    volume(m, master) { musicVol = m; masterVol = master; applyVol(); },
  };
  return M;
}
