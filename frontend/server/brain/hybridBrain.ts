import type { BrainInfo, BrainMode, FlyObservation, Topology } from "../../shared/protocol";
import { type Brain, type Decision, LruMap, type Reinforcement } from "./brain";
import { MockBrain } from "./mockBrain";
import { RemoteBrain } from "./remoteBrain";

/**
 * Uses the PyTorch brain when the Python service is up and the in-process TS
 * mock otherwise, so the game never stalls. An episode stays with the brain
 * that started it; if that brain went away, the reward goes to the mock.
 *
 * The two brains keep separate flies: a fly the mock has to take over starts
 * from the mock's own pretraining (or random weights, if it was reset to naive).
 */
export class HybridBrain implements Brain {
  private readonly mock = new MockBrain();
  private readonly remote: RemoteBrain;
  private readonly listeners = new Set<() => void>();
  private readonly owner = new LruMap<string, "remote" | "mock">(512);
  /** Mode each fly was last reset to, so the mock can match it if it takes over. */
  private readonly modes = new LruMap<string, BrainMode>(2000);
  /** Resets the PyTorch service missed (it was offline); sent before the fly's next decision there. */
  private readonly remoteMissed = new LruMap<string, BrainMode>(2000);
  /** Flies the mock already knows about (it has created or reset them). */
  private readonly mockKnows = new LruMap<string, true>(2000);

  constructor(url: string) {
    this.remote = new RemoteBrain(url, () => this.remoteChanged());
  }

  private get useRemote(): boolean {
    return this.remote.connected && this.remote.topology !== null;
  }

  get topology(): Topology {
    return (this.remote.connected && this.remote.topology) || this.mock.topology;
  }

  info(fly: string): BrainInfo {
    return (this.useRemote && this.remote.info(fly)) || this.mock.info(fly);
  }

  async reset(fly: string, mode: BrainMode): Promise<void> {
    this.modes.set(fly, mode);
    this.mockKnows.delete(fly); // the mock catches up only if it has to play
    this.remoteMissed.set(fly, mode);
    if (this.useRemote) await this.syncRemote(fly);
    else await this.mockFly(fly);
  }

  async decide(fly: string, episode: string, observation: FlyObservation, drunk: number): Promise<Decision> {
    if (this.useRemote && this.owner.get(episode) !== "mock") {
      try {
        await this.syncRemote(fly);
        const decision = await this.remote.decide(fly, episode, observation, drunk);
        this.owner.set(episode, "remote");
        return decision;
      } catch (error) {
        console.warn(`🧠 ${(error as Error).message}; the mock decides this hand`);
      }
    }
    this.owner.set(episode, "mock");
    await this.mockFly(fly);
    return this.mock.decide(fly, episode, observation, drunk);
  }

  async reward(fly: string, episode: string, reward: number): Promise<Reinforcement> {
    const owner = this.owner.get(episode);
    this.owner.delete(episode);
    if (owner === "remote" && this.useRemote) {
      try {
        return await this.remote.reward(fly, episode, reward);
      } catch (error) {
        console.warn(`🧠 ${(error as Error).message}; reward replayed by the mock`);
      }
    }
    await this.mockFly(fly);
    return this.mock.reward(fly, episode, reward);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends a reset the PyTorch service has not seen yet; it stays queued if the service is still unreachable. */
  private async syncRemote(fly: string): Promise<void> {
    const mode = this.remoteMissed.get(fly);
    if (!mode) return;
    try {
      await this.remote.reset(fly, mode);
      this.remoteMissed.delete(fly);
    } catch {}
  }

  /** Brings the mock's copy of a fly in line with its last reset before the mock uses it. */
  private async mockFly(fly: string): Promise<void> {
    if (this.mockKnows.touch(fly)) return;
    await this.mock.reset(fly, this.modes.get(fly) ?? "pretrained");
    this.mockKnows.set(fly, true);
  }

  private remoteChanged(): void {
    for (const listener of this.listeners) listener();
  }
}
