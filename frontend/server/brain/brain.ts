import type { Action, BrainInfo, BrainMode, FlyObservation, SpikeFrame, Topology } from "../../shared/protocol";

export interface Decision {
  action: Action;
  frames: SpikeFrame[];
  mbon: { hit: number; stand: number };
}

export interface Reinforcement {
  kind: "pam" | "ppl1" | "none";
  frames: SpikeFrame[];
  /** The fly after learning from this hand. */
  info: BrainInfo;
}

/**
 * The flies' brain as seen by the game. The mock lives in-process; the PyTorch
 * service implements the same contract over WS /ws/brain.
 *
 * All flies share the wiring, but each one (keyed by `fly`) has its own learned
 * weights, so a table's fly learns only from its own hands and a reset touches
 * only that fly. An episode is one hand: any number of `decide` calls followed
 * by one `reward`.
 */
export interface Brain {
  readonly topology: Topology;
  /** A fly's mode and experience; a fly the brain hasn't seen yet starts pretrained. */
  info(fly: string): BrainInfo;
  decide(fly: string, episode: string, observation: FlyObservation, drunk: number): Promise<Decision>;
  reward(fly: string, episode: string, reward: number): Promise<Reinforcement>;
  /** Replaces the fly with a fresh one: pretrained, or naive (random weights). */
  reset(fly: string, mode: BrainMode): Promise<void>;
  /** Called when the topology or brain source changes outside a request (e.g. the PyTorch service comes up). */
  subscribe(listener: () => void): () => void;
}

/** Map with a size cap that forgets the least recently used keys first. */
export class LruMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }

  touch(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return this;
  }
}
