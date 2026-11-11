/**
 * The game's own sounds, synthesised: a soft bell for a checkpoint and a slow, warm chord at the summit. Bells are
 * a few inharmonic sine partials with long exponential tails, through a small generated reverb (a decaying noise
 * impulse), so they bloom and fade rather than ping. Quiet: under the valley's ambience, never over it.
 */
let verb: ConvolverNode | null = null;
let verbCtx: BaseAudioContext | null = null;

function reverb(ctx: AudioContext, out: AudioNode) {
  if (verb && verbCtx === ctx) return verb;
  const len = Math.floor(ctx.sampleRate * 3.2);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  verb = ctx.createConvolver();
  verb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  verb.connect(wet).connect(out);
  verbCtx = ctx;
  return verb;
}

/** one bell: f the fundamental, at time `at` (ctx time), level `v` */
function bell(ctx: AudioContext, out: AudioNode, f: number, at: number, v: number, decay = 2.6) {
  const dry = ctx.createGain();
  dry.gain.value = 1;
  dry.connect(out);
  dry.connect(reverb(ctx, out));
  // (partials of a small bell: the hum an octave down, the strike tone, and the inharmonic upper ring)
  const parts: [number, number, number][] = [[0.5, 0.35, 1.3], [1, 1, 1], [2.0, 0.32, 0.6], [2.76, 0.22, 0.45], [5.4, 0.08, 0.22]];
  for (const [r, a, d] of parts) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * r;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(v * a, at + 0.012);
    g.gain.exponentialRampToValueAtTime(1e-4, at + decay * d);
    o.connect(g).connect(dry);
    o.start(at);
    o.stop(at + decay * d + 0.05);
  }
}

/** a checkpoint: two notes, a fifth apart, the second a breath later */
export function chime(ctx: AudioContext, out: AudioNode) {
  const t = ctx.currentTime + 0.02;
  bell(ctx, out, 659.25, t, 0.09);
  bell(ctx, out, 987.77, t + 0.16, 0.06);
}

/** the summit: a slow rolled chord (C major with the ninth), low to high, and a soft pad under it */
export function finale(ctx: AudioContext, out: AudioNode) {
  const t = ctx.currentTime + 0.05;
  [261.63, 392.0, 523.25, 659.25, 587.33 * 2].forEach((f, i) => bell(ctx, out, f, t + i * 0.32, 0.075 - i * 0.008, 4.2));
  for (const f of [130.81, 196.0, 329.63]) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.03, t + 1.6);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 7.5);
    o.connect(lp).connect(g);
    g.connect(out);
    g.connect(reverb(ctx, out));
    o.start(t);
    o.stop(t + 7.6);
  }
}
