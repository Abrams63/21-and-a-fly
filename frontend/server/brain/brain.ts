import type { Action, BrainInfo, BrainMode, FlyObservation, SpikeFrame, Topology } from "../../shared/protocol";

export interface Decision {
  action: Action;
  frames: SpikeFrame[];
  mbon: { hit: number; stand: number };
}

export interface Reinforcement {
  kind: "pam" | "ppl1" | "none";
  frames: SpikeFrame[];
}

/**
 * The fly's brain as seen by the game. The mock lives in-process; the PyTorch
 * service will implement the same contract over WS /ws/brain.
 *
 * An episode is one hand (keyed by `episode`): any number of `decide` calls
 * followed by one `reward`, so several tables can share one fly.
 */
export interface Brain {
  readonly topology: Topology;
  info(): BrainInfo;
  decide(episode: string, observation: FlyObservation): Promise<Decision>;
  reward(episode: string, reward: number): Promise<Reinforcement>;
  get drunk(): number;
  setDrunk(value: number): void;
  reset(mode: BrainMode): Promise<void>;
  /** Called when the topology or brain info changes outside a request (e.g. the PyTorch service comes up). */
  subscribe(listener: () => void): () => void;
}
