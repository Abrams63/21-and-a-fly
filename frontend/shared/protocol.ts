// Messages shared by the Bun server and the React client over WS /ws/game.
import type { Bank } from "./bank";

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type SeatId = "player" | "fly" | "dealer";
export type Outcome = "win" | "lose" | "push";
export type HandStatus = "waiting" | "playing" | "stood" | "bust" | "blackjack";
export type Phase = "idle" | "dealing" | "player" | "fly" | "dealer" | "settled";
export type Action = "hit" | "stand";

export interface HandView {
  /** `null` is a face-down card. */
  cards: (Card | null)[];
  /** Total of the visible cards, `null` while there are none. */
  total: number | null;
  soft: boolean;
  status: HandStatus;
}

export interface SeatScore {
  win: number;
  lose: number;
  push: number;
}

export type Gambler = "player" | "fly";

export interface TableState {
  roundId: number;
  phase: Phase;
  hands: Record<SeatId, HandView>;
  results: Partial<Record<Gambler, Outcome>>;
  score: Record<Gambler, SeatScore>;
  bank: Bank;
  /** Stakes of the current round; the fly always matches your bet. */
  bets: Record<Gambler, number> | null;
  /** Net win/loss of the last settled round. */
  payouts: Partial<Record<Gambler, number>>;
  minBet: number;
  drunk: number;
  brain: BrainInfo;
}

export interface FlyEvictedEvent {
  ruinedNumber: number;
  newNumber: number;
  newBalance: number;
  /** How long the client should play the eviction. */
  replayMs: number;
}

export interface BrainInfo {
  source: "mock" | "python";
  mode: BrainMode;
  /** Python only: where the mushroom-body wiring comes from. */
  wiring?: "hemibrain" | "synthetic";
  /** Hands the fly has learned from since the last reset (incl. pretraining). */
  episodes: number;
}

export type BrainMode = "pretrained" | "naive";

// ---- neural activity ---------------------------------------------------

export type NeuronGroupId = "input" | "kc" | "mbon_hit" | "mbon_stand" | "pam" | "ppl1";

export interface NeuronGroup {
  id: NeuronGroupId;
  /** First neuron index of the group. */
  start: number;
  size: number;
}

export interface Topology {
  count: number;
  groups: NeuronGroup[];
  /** Width of one spike frame (bin) in simulated milliseconds. */
  binMs: number;
}

/** Indices of the neurons that fired in one time bin. */
export type SpikeFrame = number[];

export interface FlyObservation {
  playerSum: number;
  dealerCard: number;
  usableAce: boolean;
}

export interface ThinkEvent {
  roundId: number;
  observation: FlyObservation;
  frames: SpikeFrame[];
  mbon: { hit: number; stand: number };
  action: Action;
  /** How long the client should take to replay the frames. */
  replayMs: number;
}

export interface DopamineEvent {
  roundId: number;
  kind: "pam" | "ppl1" | "none";
  reward: number;
  frames: SpikeFrame[];
  replayMs: number;
}

export interface LogEntry {
  id: number;
  who: SeatId | "system";
  text: string;
}

export type ServerMessage =
  | { type: "hello"; topology: Topology; state: TableState }
  | { type: "state"; state: TableState }
  | { type: "think"; event: ThinkEvent }
  | { type: "dopamine"; event: DopamineEvent }
  | { type: "fly_evicted"; event: FlyEvictedEvent }
  | { type: "log"; entry: LogEntry }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "new_round"; bet: number }
  | { type: "rebuy" }
  | { type: "hit" }
  | { type: "stand" }
  | { type: "set_drunk"; value: number }
  | { type: "reset_brain"; mode: BrainMode };
