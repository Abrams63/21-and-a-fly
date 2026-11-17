import type { Action, BrainInfo, BrainMode, FlyObservation, SpikeFrame, Topology } from "../../shared/protocol";
import type { Decision, Reinforcement } from "./brain";

/** Messages from the Python brain service (WS /ws/brain). */
type PythonMessage =
  | { type: "hello"; topology: Topology; info: BrainInfo; drunk: number }
  | { type: "info"; info: BrainInfo; drunk: number }
  | { type: "decision"; id: number; action: Action; frames: SpikeFrame[]; mbon: Decision["mbon"] }
  | { type: "reinforcement"; id: number; kind: Reinforcement["kind"]; frames: SpikeFrame[]; info: BrainInfo }
  | { type: "ack"; id: number; info: BrainInfo; drunk: number }
  | { type: "error"; id: number | null; message: string };

type Reply = Extract<PythonMessage, { id: number }>;

type Request =
  | { type: "decide"; episode: string; observation: FlyObservation }
  | { type: "reward"; episode: string; reward: number }
  | { type: "reset"; mode: BrainMode }
  | { type: "set_drunk"; value: number };

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
 * when the connection, topology or brain info changes.
 */
export class RemoteBrain {
  connected = false;
  topology: Topology | null = null;
  info: BrainInfo | null = null;
  drunk = 0;

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

  async decide(episode: string, observation: FlyObservation, timeoutMs = 2_000): Promise<Decision> {
    const reply = await this.request({ type: "decide", episode, observation }, timeoutMs);
    if (reply.type !== "decision") throw new Error(`unexpected ${reply.type}`);
    return { action: reply.action, frames: reply.frames, mbon: reply.mbon };
  }

  async reward(episode: string, reward: number, timeoutMs = 2_000): Promise<Reinforcement> {
    const reply = await this.request({ type: "reward", episode, reward }, timeoutMs);
    if (reply.type !== "reinforcement") throw new Error(`unexpected ${reply.type}`);
    this.info = reply.info;
    return { kind: reply.kind, frames: reply.frames };
  }

  async reset(mode: BrainMode): Promise<void> {
    await this.request({ type: "reset", mode }, 5_000);
  }

  async setDrunk(value: number): Promise<void> {
    await this.request({ type: "set_drunk", value }, 2_000);
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
    switch (message.type) {
      case "hello":
        this.topology = message.topology;
        this.info = message.info;
        this.drunk = message.drunk;
        this.connected = true;
        this.retryMs = RETRY_MIN_MS;
        this.announcedDown = false;
        console.log(`🧠 PyTorch brain connected (${message.info.wiring} wiring, ${message.topology.count} neurons)`);
        this.onChange();
        return;
      case "info":
        this.info = message.info;
        this.drunk = message.drunk;
        this.onChange();
        return;
      case "ack":
        this.info = message.info;
        this.drunk = message.drunk;
        break;
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
