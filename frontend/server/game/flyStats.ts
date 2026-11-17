import type { Action, FlyObservation, FlyStats } from "../../shared/protocol";
import { basicStrategy, situationKey } from "../../shared/strategy";
import { LruMap } from "../brain/brain";

/** Hands kept for the learning curve. */
const RECENT_HANDS = 200;

/** Tracks how one fly plays: its decisions against basic strategy and its recent results. */
export class FlyStatsTracker {
  private readonly cells = new Map<string, [number, number]>();
  private decisions = 0;
  private agreed = 0;
  private readonly recent: number[] = [];

  decided(observation: FlyObservation, action: Action): void {
    const key = situationKey(observation);
    const cell = this.cells.get(key) ?? [0, 0];
    const agrees = basicStrategy(observation) === action;
    cell[0] += agrees ? 1 : 0;
    cell[1]++;
    this.cells.set(key, cell);
    this.decisions++;
    if (agrees) this.agreed++;
  }

  finished(reward: number): void {
    this.recent.push(Math.sign(reward));
    if (this.recent.length > RECENT_HANDS) this.recent.shift();
  }

  view(): FlyStats {
    return {
      cells: Object.fromEntries([...this.cells].map(([k, [a, n]]) => [k, [a, n]])),
      decisions: this.decisions,
      agreed: this.agreed,
      recent: [...this.recent],
    };
  }
}

/**
 * Stats of every fly this server has seen, by fly key. They live in memory: a
 * restart of the web service starts the stats over (the fly's brain is kept).
 */
export class FlyStatsBook {
  private readonly flies = new LruMap<string, FlyStatsTracker>(2000);

  of(fly: string): FlyStatsTracker {
    const known = this.flies.touch(fly);
    if (known) return known;
    const tracker = new FlyStatsTracker();
    this.flies.set(fly, tracker);
    return tracker;
  }

  /** The fly's brain was reset: it starts its record over. */
  forget(fly: string): void {
    this.flies.delete(fly);
  }
}
