/**
 * The ride's only interface: a card while the pointer is free (click to ride, the keys, the head-bob slider,
 * quality and volume), a line of key hints that fades after the first minute, and nothing at all in photo mode.
 * No HUD bars.
 */
const CSS = `
#ride-ui{position:fixed;inset:0;pointer-events:none;font:14px/1.45 "Segoe UI",system-ui,sans-serif;color:#f3ead8;z-index:20}
#ride-card{position:absolute;left:50%;bottom:9%;transform:translateX(-50%);pointer-events:auto;background:rgba(18,14,10,.62);
  backdrop-filter:blur(6px);border:1px solid rgba(243,234,216,.18);border-radius:10px;padding:16px 22px;min-width:340px;
  max-width:min(92vw,460px);transition:opacity .35s}
#ride-card h2{margin:0 0 6px;font:600 18px/1.2 Georgia,serif;letter-spacing:.04em}
#ride-card .keys{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 12px;opacity:.9}
#ride-card kbd{font:12px ui-monospace,monospace;background:rgba(255,255,255,.12);border-radius:4px;padding:1px 6px}
#ride-card label{display:flex;align-items:center;gap:10px;margin:6px 0}
#ride-card label span{width:92px;opacity:.85}
#ride-card input[type=range]{flex:1;accent-color:#d8b073}
#ride-card select{background:#2a221a;color:#f3ead8;border:1px solid #6b5a44;border-radius:4px;padding:2px 6px}
#ride-card .go{margin-top:10px;text-align:center;font-weight:600;letter-spacing:.06em;color:#ffd99a}
#ride-hint{position:absolute;left:18px;bottom:14px;opacity:.75;font-size:13px;text-shadow:0 1px 2px #000;transition:opacity 2s}
`;

export interface RideSettings { bob: number; volume: number; quality: string }

export class RideUI {
  readonly root = document.createElement('div');
  private card: HTMLDivElement;
  private hint: HTMLDivElement;
  settings: RideSettings;
  hidden = false;
  private shownAt = performance.now();

  constructor(onChange: (s: RideSettings) => void, quality: string) {
    let saved: Partial<RideSettings> = {};
    try { saved = JSON.parse(localStorage.getItem('valley-ride') ?? '{}'); } catch { /* none */ }
    this.settings = { bob: saved.bob ?? 0.6, volume: saved.volume ?? 0.8, quality };
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root.id = 'ride-ui';
    this.card = document.createElement('div');
    this.card.id = 'ride-card';
    this.card.innerHTML = `<h2>The Valley</h2>
      <div class="keys">
        <kbd>W</kbd><div>walk</div><kbd>Shift</kbd><div>trot · hold to gallop</div><kbd>S</kbd><div>rein in</div>
        <kbd>A D</kbd><div>steer</div><kbd>Mouse</kbd><div>look around</div>
        <kbd>C</kbd><div>cinematic camera</div><kbd>P</kbd><div>photo mode</div><kbd>T</kbd><div>time of day</div>
      </div>
      <label><span>Head bob</span><input id="ru-bob" type="range" min="0" max="1" step="0.05"></label>
      <label><span>Volume</span><input id="ru-vol" type="range" min="0" max="1" step="0.05"></label>
      <label><span>Quality</span><select id="ru-q"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
      <div class="go">Click to ride</div>`;
    this.hint = document.createElement('div');
    this.hint.id = 'ride-hint';
    this.hint.textContent = 'W walk · Shift trot (hold: gallop) · A/D steer · C camera · P photo · T time · Esc settings';
    this.root.append(this.card, this.hint);
    document.body.appendChild(this.root);
    const bob = this.card.querySelector('#ru-bob') as HTMLInputElement;
    const vol = this.card.querySelector('#ru-vol') as HTMLInputElement;
    const q = this.card.querySelector('#ru-q') as HTMLSelectElement;
    bob.value = String(this.settings.bob);
    vol.value = String(this.settings.volume);
    q.value = ['high', 'medium', 'low'].includes(quality) ? quality : 'high';
    const save = () => {
      try { localStorage.setItem('valley-ride', JSON.stringify(this.settings)); } catch { /* private mode */ }
      onChange(this.settings);
    };
    bob.oninput = () => { this.settings.bob = Number(bob.value); save(); };
    vol.oninput = () => { this.settings.volume = Number(vol.value); save(); };
    q.onchange = () => {
      this.settings.quality = q.value;
      save();
      const u = new URL(location.href);
      u.searchParams.set('quality', q.value);
      location.href = u.toString();
    };
    // (the card itself takes clicks: a click on it outside the controls also starts the ride)
    this.card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input,select,label')) return;
      document.getElementById('app')?.querySelector('canvas')?.requestPointerLock?.();
    });
    onChange(this.settings);
  }

  update(locked: boolean, photo: boolean, test: boolean) {
    const hide = photo || test;
    this.root.style.display = hide ? 'none' : '';
    this.card.style.opacity = locked ? '0' : '1';
    this.card.style.pointerEvents = locked ? 'none' : 'auto';
    if (locked && performance.now() - this.shownAt > 60000) this.hint.style.opacity = '0';
  }
}
