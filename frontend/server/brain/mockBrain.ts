import type {
  Action,
  BrainInfo,
  BrainMode,
  FlyObservation,
  NeuronGroup,
  SpikeFrame,
  Topology,
} from "../../shared/protocol";
import { type Brain, type Decision, LruMap, type Reinforcement } from "./brain";

/**
 * In-process stand-in for the PyTorch fly brain, so the web app works on its own.
 *
 * It keeps the mushroom-body shape of the real model: input channels → sparse
 * Kenyon cells (KC) → two MBON pools (hit / stand), with KC→MBON weights trained
 * by a dopamine-like reward signal. Spikes are Poisson samples of the firing
 * rates, binned into 5 ms frames for the client to replay. Every fly shares the
 * wiring and has its own weights.
 */

const INPUTS = 30; // 18 player-sum channels (4..21) + 10 dealer-card channels (1..10) + 2 ace channels
const KC = 600;
const KC_FAN_IN = 7;
const MBON = 16;
const DAN = 10;

const BIN_MS = 5;
const DECIDE_FRAMES = 20; // 100 ms of simulated time
const DOPAMINE_FRAMES = 14;
const LEARNING_RATE = 0.05;
const PRETRAIN_EPISODES = 40_000;
const MAX_FLIES = 2000;
const MAX_OPEN_EPISODES = 512;

const ACTIONS = ["hit", "stand"] as const satisfies readonly Action[];

interface Step {
  active: Uint16Array;
  action: number;
}

interface Fly {
  /** KC→MBON weights, laid out as [kc * 2 + action]. */
  weights: Float32Array;
  mode: BrainMode;
  episodes: number;
}

function buildTopology(): Topology {
  const sizes: [NeuronGroup["id"], number][] = [
    ["input", INPUTS],
    ["kc", KC],
    ["mbon_hit", MBON],
    ["mbon_stand", MBON],
    ["pam", DAN],
    ["ppl1", DAN],
  ];
  const groups: NeuronGroup[] = [];
  let start = 0;
  for (const [id, size] of sizes) {
    groups.push({ id, start, size });
    start += size;
  }
  return { count: start, groups, binMs: BIN_MS };
}

/** Small deterministic PRNG so the KC wiring is the same on every start. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(): number {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function inputChannels(obs: FlyObservation): number[] {
  return [obs.playerSum - 4, 18 + obs.dealerCard - 1, obs.usableAce ? 29 : 28];
}

function randomWeights(): Float32Array {
  const weights = new Float32Array(KC * 2);
  for (let i = 0; i < weights.length; i++) weights[i] = (Math.random() - 0.5) * 0.04;
  return weights;
}

function value(weights: Float32Array, active: Uint16Array, action: number): number {
  if (active.length === 0) return 0;
  let sum = 0;
  for (const k of active) sum += weights[k * 2 + action] ?? 0;
  return sum / active.length;
}

/** Three-factor rule: active KC × chosen MBON × dopamine (reward prediction error). */
function learn(weights: Float32Array, steps: Step[], reward: number): void {
  for (const { active, action } of steps) {
    const delta = LEARNING_RATE * (reward - value(weights, active, action));
    for (const k of active) {
      const w = k * 2 + action;
      weights[w] = (weights[w] ?? 0) + delta;
    }
  }
}

export class MockBrain implements Brain {
  readonly topology = buildTopology();

  private readonly offset = Object.fromEntries(this.topology.groups.map((g) => [g.id, g.start])) as Record<
    NeuronGroup["id"],
    number
  >;

  /** For every KC, the input channels it samples. */
  private readonly kcInputs: Uint8Array;
  private readonly kcCache = new Map<string, Uint16Array>();

  /** Weights every pretrained fly starts from; trained the first time a fly needs them. */
  private pretrained: Float32Array | null = null;
  private readonly flies = new LruMap<string, Fly>(MAX_FLIES);
  private readonly open = new LruMap<string, { fly: string; steps: Step[] }>(MAX_OPEN_EPISODES);

  constructor() {
    const rand = mulberry32(21);
    this.kcInputs = new Uint8Array(KC * KC_FAN_IN);
    for (let k = 0; k < KC; k++) {
      const picked = new Set<number>();
      while (picked.size < KC_FAN_IN) picked.add(Math.floor(rand() * INPUTS));
      let i = 0;
      for (const ch of picked) this.kcInputs[k * KC_FAN_IN + i++] = ch;
    }
  }

  info(fly: string): BrainInfo {
    const known = this.flies.get(fly);
    return { source: "mock", mode: known?.mode ?? "pretrained", episodes: known?.episodes ?? PRETRAIN_EPISODES };
  }

  async reset(fly: string, mode: BrainMode): Promise<void> {
    for (const [episode, open] of this.open) if (open.fly === fly) this.open.delete(episode);
    this.flies.set(fly, this.newFly(mode));
  }

  /** The mock never changes on its own. */
  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  async decide(fly: string, episode: string, obs: FlyObservation, drunkLevel: number): Promise<Decision> {
    const drunk = Math.min(1, Math.max(0, drunkLevel));
    const { weights } = this.fly(fly);
    const channels = new Set(inputChannels(obs));
    const active = this.activeKcs(obs);
    const kcActive = new Uint8Array(KC);
    for (const k of active) kcActive[k] = 1;

    // Alcohol: weaker KC drive and a noisy read-out of the learned values.
    const noise = gaussian() * 0.6 * drunk;
    const diff = value(weights, active, 0) - value(weights, active, 1) + noise;
    const pHit = ((15 + 85 * sigmoid(6 * diff)) * BIN_MS) / 1000;
    const pStand = ((15 + 85 * sigmoid(-6 * diff)) * BIN_MS) / 1000;

    const frames: SpikeFrame[] = [];
    const mbon = { hit: 0, stand: 0 };
    const o = this.offset;

    for (let f = 0; f < DECIDE_FRAMES; f++) {
      const fired: number[] = [];
      for (let i = 0; i < INPUTS; i++) {
        const p = channels.has(i) ? 0.45 : 0.02 + 0.08 * drunk;
        if (Math.random() < p) fired.push(o.input + i);
      }
      if (f >= 2) {
        for (let k = 0; k < KC; k++) {
          const p = kcActive[k] ? 0.28 * (1 - 0.5 * drunk) : 0.006 + 0.02 * drunk;
          if (Math.random() < p) fired.push(o.kc + k);
        }
      }
      if (f >= 4) {
        for (let m = 0; m < MBON; m++) {
          if (Math.random() < pHit) {
            fired.push(o.mbon_hit + m);
            mbon.hit++;
          }
          if (Math.random() < pStand) {
            fired.push(o.mbon_stand + m);
            mbon.stand++;
          }
        }
      }
      for (let d = 0; d < DAN; d++) {
        if (Math.random() < 0.01) fired.push(o.pam + d);
        if (Math.random() < 0.01) fired.push(o.ppl1 + d);
      }
      frames.push(fired);
    }

    const action = mbon.hit === mbon.stand ? (Math.random() < 0.5 ? 0 : 1) : mbon.hit > mbon.stand ? 0 : 1;

    const open = this.open.touch(episode);
    if (open?.fly === fly) open.steps.push({ active, action });
    else this.open.set(episode, { fly, steps: [{ active, action }] });

    return { action: ACTIONS[action], frames, mbon };
  }

  async reward(fly: string, episode: string, reward: number): Promise<Reinforcement> {
    const open = this.open.get(episode);
    this.open.delete(episode);
    const learner = this.fly(fly);
    if (open?.fly === fly && open.steps.length > 0) {
      learn(learner.weights, open.steps, reward);
      learner.episodes++;
    }

    const kind = reward > 0 ? "pam" : reward < 0 ? "ppl1" : "none";
    const frames: SpikeFrame[] = [];
    const o = this.offset;
    for (let f = 0; f < DOPAMINE_FRAMES; f++) {
      const fired: number[] = [];
      const burst = kind === "none" ? 0 : 0.7 * Math.exp(-f / 5);
      for (let d = 0; d < DAN; d++) {
        if (Math.random() < (kind === "pam" ? burst : 0.01)) fired.push(o.pam + d);
        if (Math.random() < (kind === "ppl1" ? burst : 0.01)) fired.push(o.ppl1 + d);
      }
      for (let k = 0; k < KC; k++) {
        if (Math.random() < 0.004) fired.push(o.kc + k);
      }
      frames.push(fired);
    }
    return { kind, frames, info: this.info(fly) };
  }

  // ---- internals ---------------------------------------------------------

  /** The fly with this key; a new one starts pretrained. */
  private fly(key: string): Fly {
    const known = this.flies.touch(key);
    if (known) return known;
    const fly = this.newFly("pretrained");
    this.flies.set(key, fly);
    return fly;
  }

  private newFly(mode: BrainMode): Fly {
    if (mode === "naive") return { weights: randomWeights(), mode, episodes: 0 };
    if (!this.pretrained) this.pretrained = this.pretrain(PRETRAIN_EPISODES);
    return { weights: this.pretrained.slice(), mode, episodes: PRETRAIN_EPISODES };
  }

  /** KCs that receive at least two active input channels: a sparse code of the hand. */
  private activeKcs(obs: FlyObservation): Uint16Array {
    const key = `${obs.playerSum}|${obs.dealerCard}|${obs.usableAce}`;
    const cached = this.kcCache.get(key);
    if (cached) return cached;
    const channels = new Set(inputChannels(obs));
    const active: number[] = [];
    for (let k = 0; k < KC; k++) {
      let drive = 0;
      for (let i = 0; i < KC_FAN_IN; i++) {
        if (channels.has(this.kcInputs[k * KC_FAN_IN + i] ?? -1)) drive++;
      }
      if (drive >= 2) active.push(k);
    }
    const result = Uint16Array.from(active);
    this.kcCache.set(key, result);
    return result;
  }

  /** Offline training on simulated hands (infinite deck, dealer stands on 17). */
  private pretrain(episodes: number): Float32Array {
    const weights = randomWeights();
    const draw = () => Math.min(10, 1 + Math.floor(Math.random() * 13));
    const total = (cards: number[]) => {
      const raw = cards.reduce((a, b) => a + b, 0);
      const soft = cards.includes(1) && raw + 10 <= 21;
      return { sum: soft ? raw + 10 : raw, soft };
    };

    for (let e = 0; e < episodes; e++) {
      const player = [draw(), draw()];
      const upCard = draw();
      const dealer = [upCard, draw()];
      if (total(player).sum === 21 || total(dealer).sum === 21) continue;

      const steps: Step[] = [];
      let bust = false;
      for (;;) {
        const { sum, soft } = total(player);
        const active = this.activeKcs({ playerSum: sum, dealerCard: upCard, usableAce: soft });
        const greedy = value(weights, active, 0) > value(weights, active, 1) ? 0 : 1;
        const action = Math.random() < 0.1 ? (Math.random() < 0.5 ? 0 : 1) : greedy;
        steps.push({ active, action });
        if (action === 1) break;
        player.push(draw());
        if (total(player).sum > 21) {
          bust = true;
          break;
        }
      }

      let reward = -1;
      if (!bust) {
        while (total(dealer).sum < 17) dealer.push(draw());
        const p = total(player).sum;
        const d = total(dealer).sum;
        reward = d > 21 || p > d ? 1 : p === d ? 0 : -1;
      }
      learn(weights, steps, reward);
    }
    return weights;
  }
}
