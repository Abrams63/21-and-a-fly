import type { Action, BrainInfo, BrainMode, FlyObservation, SpikeFrame, Topology } from "../../shared/protocol";
import { type Decision, LruMap, type Reinforcement } from "./brain";

/** Messages from the Python brain service (WS /ws/brain). */
type PythonMessage =
  | { type: "hello"; topology: Topology; info: BrainInfo }
  | { type: "decision"; id: number; action: Action; frames: SpikeFrame[]; mbon: Decision["mbon"] }
  | { type: "reinforcement"; id: number; kind: Reinforcement["kind"]; frames: SpikeFrame[]; info: BrainInfo }
  | { type: "ack"; id: number; info: BrainInfo }
  | { type: "error"; id: number | null; message: string };

type Reply = Extract<PythonMessage, { id: number }>;

type Request =
  | { type: "decide"; fly: string; episode: string; observation: FlyObservation; drunk: number }
  | { type: "reward"; fly: string; episode: string; reward: number }
  | { type: "reset"; fly: string; mode: BrainMode };

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 10_000;

/**
 * WebSocket client for the PyTorch brain. Keeps reconnecting in the background;
 * `connected` tells whether it can take requests right now. `onChange` fires
 * when the connection or topology changes.
 */
export class RemoteBrain {
  connected = false;
  topology: Topology | null = null;
  /** What a newly seated fly starts with. */
  newFly: BrainInfo | null = null;
  /** Last known state of each fly, from the service's replies. */
  private readonly flies = new LruMap<string, BrainInfo>(2000);

  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retryMs = RETRY_MIN_MS;
  private announcedDown = false;

  constructor(
    private readonly url: string,
    private readonly onChange: () => void,
  ) {
    this.connect();
  }

  info(fly: string): BrainInfo | null {
    return this.flies.get(fly) ?? this.newFly;
  }

  async decide(fly: string, episode: string, observation: FlyObservation, drunk: number): Promise<Decision> {
    const reply = await this.request({ type: "decide", fly, episode, observation, drunk }, 2_000);
    if (reply.type !== "decision") throw new Error(`unexpected ${reply.type}`);
    return { action: reply.action, frames: reply.frames, mbon: reply.mbon };
  }

  async reward(fly: string, episode: string, reward: number): Promise<Reinforcement> {
    const reply = await this.request({ type: "reward", fly, episode, reward }, 2_000);
    if (reply.type !== "reinforcement") throw new Error(`unexpected ${reply.type}`);
    this.flies.set(fly, reply.info);
    return { kind: reply.kind, frames: reply.frames, info: reply.info };
  }

  async reset(fly: string, mode: BrainMode): Promise<void> {
    const reply = await this.request({ type: "reset", fly, mode }, 5_000);
    if (reply.type === "ack") this.flies.set(fly, reply.info);
  }

  private request(body: Request, timeoutMs: number): Promise<Reply> {
    const socket = this.socket;
    if (!this.connected || !socket) return Promise.reject(new Error("brain service offline"));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`brain service timed out on ${body.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...body, id }));
    });
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      let message: PythonMessage;
      try {
        message = JSON.parse(String(event.data)) as PythonMessage;
      } catch {
        return;
      }
      this.receive(message);
    });

    socket.addEventListener("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("brain service disconnected"));
        this.pending.delete(id);
      }
      if (wasConnected) {
        console.warn("🧠 PyTorch brain disconnected, using the TS mock");
        this.onChange();
      } else if (!this.announcedDown) {
        console.warn(`🧠 PyTorch brain not reachable at ${this.url}, using the TS mock (will keep retrying)`);
      }
      this.announcedDown = true;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    });
  }

  private receive(message: PythonMessage): void {
    if (message.type === "hello") {
      this.topology = message.topology;
      this.newFly = message.info;
      // A restarted service may have forgotten flies; their state comes back with the next reply.
      this.flies.clear();
      this.connected = true;
      this.retryMs = RETRY_MIN_MS;
      this.announcedDown = false;
      console.log(`🧠 PyTorch brain connected (${message.info.wiring} wiring, ${message.topology.count} neurons)`);
      this.onChange();
      return;
    }
    if (message.type === "error" && message.id === null) {
      console.warn(`🧠 brain service error: ${message.message}`);
      return;
    }
    if (message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message);
  }
}
