/**
 * The ride's game interface, kept as quiet as the valley: a title card over the first view, a one-line hint of the
 * controls that fades, a small note as each checkpoint passes, and at the summit "valley crossed" with the ride's
 * time and a quiet way to ride again. No bars, no score, nothing that stays on screen.
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
@media (max-width:560px){#gu-hint{font-size:13px}#gu-hint .sep{margin:0 6px}}
`;

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
    document.body.appendChild(this.root);
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
