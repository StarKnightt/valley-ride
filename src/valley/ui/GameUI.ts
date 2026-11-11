/**
 * The ride's game interface, kept as quiet as the valley: a title card over the first view, a one-line hint of the
 * controls that fades, a small note as each checkpoint passes, and at the summit "valley crossed" with the ride's
 * time and a quiet way to ride again. No bars, no score. The one thing that stays: four small buttons in the top
 * right corner for the time of day (T steps through them too).
 */
const CSS = `
#game-ui{position:fixed;inset:0;pointer-events:none;z-index:21;color:#f6ecd9;
  font-family:Georgia,"Iowan Old Style","Palatino Linotype",serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
#game-ui .fade{opacity:0;transition:opacity 1.4s ease}
#game-ui .fade.on{opacity:1}
#gu-title{position:absolute;left:0;right:0;top:24%;text-align:center;text-shadow:0 2px 18px rgba(40,20,5,.55),0 1px 2px rgba(0,0,0,.35)}
#gu-title h1{margin:0;font-weight:400;font-size:clamp(40px,8vw,92px);letter-spacing:.14em;text-transform:lowercase}
#gu-title::before,#gu-end::before{content:'';position:absolute;left:50%;top:50%;width:min(900px,96vw);height:260%;transform:translate(-50%,-50%);z-index:-1;
  background:radial-gradient(closest-side,rgba(28,16,6,.34),rgba(28,16,6,.16) 55%,transparent)}
#gu-title .rule{width:min(240px,40vw);height:1px;margin:14px auto 0;background:linear-gradient(90deg,transparent,rgba(246,236,217,.75),transparent)}
#gu-hint{position:absolute;left:50%;bottom:max(7%,calc(env(safe-area-inset-bottom) + 24px));transform:translateX(-50%);
  white-space:nowrap;font:17px/1.4 "Segoe UI",system-ui,sans-serif;letter-spacing:.04em;text-shadow:0 1px 3px rgba(0,0,0,.55)}
#gu-hint kbd{font:600 12px/1 "Segoe UI",system-ui,sans-serif;display:inline-block;min-width:12px;text-align:center;padding:4px 7px;margin:0 3px;
  border:1px solid rgba(246,236,217,.45);border-radius:5px;background:rgba(30,20,12,.28)}
#gu-hint .sep{opacity:.45;margin:0 12px}
#gu-toast{position:absolute;left:0;right:0;top:12%;text-align:center;font-size:clamp(17px,2.2vw,22px);letter-spacing:.12em;
  text-transform:lowercase;text-shadow:0 1px 10px rgba(40,20,5,.6),0 1px 2px rgba(0,0,0,.4)}
#gu-end{position:absolute;left:0;right:0;top:22%;text-align:center;text-shadow:0 2px 18px rgba(40,20,5,.55),0 1px 2px rgba(0,0,0,.35)}
#gu-end h2{margin:0;font-weight:400;font-size:clamp(34px,6vw,70px);letter-spacing:.12em;text-transform:lowercase}
#gu-end .time{margin-top:10px;font-size:clamp(16px,2vw,20px);letter-spacing:.2em;opacity:.85}
#gu-end button{pointer-events:auto;margin-top:34px;background:none;border:0;border-bottom:1px solid rgba(246,236,217,.35);
  color:inherit;font:inherit;font-size:clamp(15px,1.8vw,18px);letter-spacing:.16em;text-transform:lowercase;padding:6px 2px;cursor:pointer;
  opacity:.8;transition:opacity .3s,border-color .3s}
#gu-end button:hover,#gu-end button:focus-visible{opacity:1;border-color:rgba(246,236,217,.9);outline:none}
#gu-end:not(.on) button{pointer-events:none}
#gu-time{position:absolute;top:max(14px,env(safe-area-inset-top));right:max(14px,env(safe-area-inset-right));display:flex;align-items:center;gap:2px;
  padding:3px;border-radius:999px;background:rgba(22,15,9,.34);border:1px solid rgba(246,236,217,.16);backdrop-filter:blur(6px);
  -webkit-backdrop-filter:blur(6px);pointer-events:auto;opacity:.78;transition:opacity .3s}
#gu-time:hover{opacity:1}
#gu-time button{all:unset;box-sizing:border-box;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:#f6ecd9;
  opacity:.62;transition:opacity .2s,background-color .2s}
#gu-time button:hover{opacity:1;background:rgba(246,236,217,.1)}
#gu-time button:focus-visible{opacity:1;outline:1px solid rgba(246,236,217,.7);outline-offset:-2px}
#gu-time button[aria-pressed=true]{opacity:1;background:rgba(246,236,217,.2)}
#gu-time svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
#gu-time kbd{font:600 10px/1 "Segoe UI",system-ui,sans-serif;opacity:.55;padding:0 7px 0 5px;letter-spacing:.02em}
@media (max-width:560px){#gu-hint{font-size:13px}#gu-hint .sep{margin:0 6px}}
`;

const ICONS: Record<string, string> = {
  morning: '<path d="M3 17h18M6.5 17a5.5 5.5 0 0 1 11 0"/><path d="M12 4.5v3M4.6 9.6l2 1.6M19.4 9.6l-2 1.6"/><path d="M5 20.5h14" opacity=".55"/>',
  noon: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  sunset: '<path d="M3 15h18M7 15a5 5 0 0 1 10 0"/><path d="M6 18.5h12M9 21.5h6" opacity=".55"/><path d="M12 5v4M10 7l2 2 2-2"/>',
  night: '<path d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1z"/><path d="M17.2 3.8v2.4M16 5h2.4" stroke-width="1.3"/>',
};

export class GameUI {
  readonly root = document.createElement('div');
  private title: HTMLDivElement;
  private hint: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private end: HTMLDivElement;
  private timeEl: HTMLDivElement;
  private toastT = 0;
  onRideAgain: () => void = () => {};
  /** held hidden (the harness's clean frames) */
  hidden = false;
  /** a time button pressed (or T): the name of the pick */
  onPickTime: (name: 'morning' | 'noon' | 'sunset' | 'night') => void = () => {};
  private timeBar: HTMLDivElement;
  private pick: string | null = 'sunset';

  constructor() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root.id = 'game-ui';
    const el = (id: string, html: string) => {
      const d = document.createElement('div');
      d.id = id;
      d.className = 'fade';
      d.innerHTML = html;
      this.root.appendChild(d);
      return d;
    };
    this.title = el('gu-title', '<h1>valley ride</h1><div class="rule"></div>');
    this.hint = el('gu-hint', '<kbd>W</kbd> ride<span class="sep">·</span><kbd>Shift</kbd> gallop<span class="sep">·</span><kbd>A</kbd><kbd>D</kbd> steer<span class="sep">·</span><kbd>Space</kbd> jump');
    this.toastEl = el('gu-toast', '');
    this.end = el('gu-end', '<h2>valley crossed</h2><div class="time"></div><button type="button">ride again</button>');
    this.timeEl = this.end.querySelector('.time') as HTMLDivElement;
    this.end.querySelector('button')!.addEventListener('click', () => this.onRideAgain());
    this.timeBar = document.createElement('div');
    this.timeBar.id = 'gu-time';
    this.timeBar.setAttribute('role', 'group');
    this.timeBar.setAttribute('aria-label', 'Time of day');
    for (const name of ['morning', 'noon', 'sunset', 'night'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.t = name;
      b.title = name[0].toUpperCase() + name.slice(1);
      b.setAttribute('aria-label', b.title);
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
      // (no focus left on it: Space, the jump, would press it again)
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); this.onPickTime(name); b.blur(); });
      this.timeBar.appendChild(b);
    }
    const k = document.createElement('kbd');
    k.textContent = 'T';
    k.title = 'T steps through the times';
    this.timeBar.appendChild(k);
    this.root.appendChild(this.timeBar);
    this.timePick = 'sunset';
    document.body.appendChild(this.root);
  }

  /** the pick shown pressed (null: none, an hour set some other way) */
  get timePick() { return this.pick as 'morning' | 'noon' | 'sunset' | 'night' | null; }
  set timePick(name: string | null) {
    this.pick = name;
    for (const b of this.timeBar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.t === name));
  }

  set visible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  showTitle(on: boolean) { this.title.classList.toggle('on', on); }
  showHint(on: boolean) { this.hint.classList.toggle('on', on); }

  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    this.toastT = 2.6;
  }

  showEnd(seconds: number | null) {
    if (seconds === null) { this.end.classList.remove('on'); return; }
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    this.timeEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.end.classList.add('on');
  }

  update(dt: number) {
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl.classList.remove('on');
    }
  }
}
