import type { BrainInfo, BrainMode, FlyObservation, Topology } from "../../shared/protocol";
import type { Brain, Decision, Reinforcement } from "./brain";
import { MockBrain } from "./mockBrain";
import { RemoteBrain } from "./remoteBrain";

/**
 * Uses the PyTorch brain when the Python service is up and the in-process TS
 * mock otherwise, so the game never stalls. An episode stays with the brain
 * that started it; if that brain went away, the reward goes to the mock.
 *
 * The mock is only kept up to date while it plays: resets that happen while the
 * PyTorch brain is in charge are remembered and applied (with the mock's
 * pretraining) the first time the mock is needed again.
 */
export class HybridBrain implements Brain {
  private readonly idleMock = new MockBrain(null);
  /** Mode the mock must be reset to before it is used, or null if it is current. */
  private mockResetTo: BrainMode | null = "pretrained";
  private readonly remote: RemoteBrain;
  private readonly listeners = new Set<() => void>();
  private readonly owner = new Map<string, "remote" | "mock">();
  private drunkLevel = 0;

  constructor(url: string) {
    this.remote = new RemoteBrain(url, () => this.remoteChanged());
  }

  private get useRemote(): boolean {
    return this.remote.connected && this.remote.topology !== null;
  }

  get topology(): Topology {
    return (this.remote.connected && this.remote.topology) || this.idleMock.topology;
  }

  info(): BrainInfo {
    return this.useRemote && this.remote.info ? this.remote.info : this.mock.info();
  }

  /** The mock, brought up to date first if resets were skipped while it was idle. */
  private get mock(): MockBrain {
    if (this.mockResetTo) {
      this.idleMock.resetNow(this.mockResetTo);
      this.idleMock.setDrunk(this.drunkLevel);
      this.mockResetTo = null;
    }
    return this.idleMock;
  }

  get drunk(): number {
    return this.drunkLevel;
  }

  setDrunk(value: number): void {
    this.drunkLevel = Math.min(1, Math.max(0, value));
    this.idleMock.setDrunk(this.drunkLevel);
    if (this.useRemote) this.remote.setDrunk(this.drunkLevel).catch(() => {});
  }

  async reset(mode: BrainMode): Promise<void> {
    this.owner.clear();
    if (this.useRemote) {
      this.mockResetTo = mode; // the mock catches up only if it has to play
      await this.remote.reset(mode).catch(() => {});
    } else {
      this.mockResetTo = null;
      await this.idleMock.reset(mode);
    }
  }

  async decide(episode: string, observation: FlyObservation): Promise<Decision> {
    if (this.useRemote && this.owner.get(episode) !== "mock") {
      try {
        const decision = await this.remote.decide(episode, observation);
        this.own(episode, "remote");
        return decision;
      } catch (error) {
        console.warn(`🧠 ${(error as Error).message}; the mock decides this hand`);
      }
    }
    this.own(episode, "mock");
    return this.mock.decide(episode, observation);
  }

  async reward(episode: string, reward: number): Promise<Reinforcement> {
    const owner = this.owner.get(episode);
    this.owner.delete(episode);
    if (owner === "remote" && this.useRemote) {
      try {
        return await this.remote.reward(episode, reward);
      } catch (error) {
        console.warn(`🧠 ${(error as Error).message}; reward replayed by the mock`);
      }
    }
    return this.mock.reward(episode, reward);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private own(episode: string, who: "remote" | "mock"): void {
    this.owner.set(episode, who);
    if (this.owner.size <= 512) return;
    const oldest = this.owner.keys().next();
    if (!oldest.done) this.owner.delete(oldest.value);
  }

  private remoteChanged(): void {
    // A (re)connected service starts with its own state; bring it in line with the game.
    if (this.useRemote && this.remote.drunk !== this.drunkLevel) {
      this.remote.setDrunk(this.drunkLevel).catch(() => {});
    }
    for (const listener of this.listeners) listener();
  }
}
