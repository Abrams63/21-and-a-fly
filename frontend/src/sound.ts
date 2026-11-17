// Table sounds, synthesised with Web Audio (no files to load), plus a buzz on phones.

export type Cue = "card" | "chips" | "win" | "lose" | "push" | "blackjack" | "bust" | "fly";

const STORAGE_KEY = "fly21_sound";

/** Vibration patterns (ms) for the moments that matter; phones only. */
const BUZZ: Partial<Record<Cue, number[]>> = {
  blackjack: [40, 60, 40, 60, 80],
  win: [30],
  bust: [120],
  fly: [20, 40, 20, 40, 20, 40, 20],
};

function storedSetting(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

class TableSound {
  private ctx: AudioContext | null = null;
  enabled = storedSetting();

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {}
    if (on) this.unlock();
  }

  /** Browsers only start audio after a user gesture; call this from one. */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  play(cue: Cue): void {
    if (!this.enabled) return;
    const pattern = BUZZ[cue];
    if (pattern && "vibrate" in navigator) navigator.vibrate(pattern);
    const ctx = this.ctx;
    if (ctx?.state !== "running") return;
    const t = ctx.currentTime;
    switch (cue) {
      case "card":
        this.noise(t, 0.05, 2400, 0.18);
        break;
      case "chips":
        this.noise(t, 0.03, 5000, 0.12);
        this.noise(t + 0.05, 0.03, 4200, 0.1);
        break;
      case "win":
        this.tone(t, 660, 0.12, 0.16);
        this.tone(t + 0.1, 880, 0.18, 0.16);
        break;
      case "blackjack":
        [523, 659, 784, 1047].forEach((f, i) => {
          this.tone(t + i * 0.08, f, 0.22, 0.14);
        });
        break;
      case "push":
        this.tone(t, 520, 0.15, 0.1);
        break;
      case "lose":
        this.tone(t, 330, 0.18, 0.14, "triangle");
        this.tone(t + 0.14, 247, 0.26, 0.14, "triangle");
        break;
      case "bust":
        this.tone(t, 180, 0.3, 0.18, "sawtooth", 110);
        break;
      case "fly":
        this.buzz(t, 0.9);
        break;
    }
  }

  private envelope(start: number, length: number, peak: number): GainNode {
    const ctx = this.ctx as AudioContext;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    gain.connect(ctx.destination);
    return gain;
  }

  private tone(start: number, freq: number, length: number, peak: number, type: OscillatorType = "sine", to?: number) {
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, start + length);
    osc.connect(this.envelope(start, length, peak));
    osc.start(start);
    osc.stop(start + length + 0.02);
  }

  /** A short filtered noise burst: a card landing, a chip clicking. */
  private noise(start: number, length: number, freq: number, peak: number) {
    const ctx = this.ctx as AudioContext;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    src.connect(filter).connect(this.envelope(start, length, peak));
    src.start(start);
  }

  /** Wings: a buzzing sawtooth wobbling around 190 Hz. */
  private buzz(start: number, length: number) {
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(190, start);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 23;
    const depth = ctx.createGain();
    depth.gain.value = 25;
    wobble.connect(depth).connect(osc.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    osc.connect(filter).connect(this.envelope(start, length, 0.08));
    for (const node of [osc, wobble]) {
      node.start(start);
      node.stop(start + length + 0.05);
    }
  }
}

export const tableSound = new TableSound();
