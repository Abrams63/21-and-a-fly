import { describe, expect, test } from "bun:test";
import { type Bank, freshBank } from "../../shared/bank";
import type {
  Action,
  BrainInfo,
  BrainMode,
  Card,
  FlyObservation,
  Rank,
  ServerMessage,
  TableState,
} from "../../shared/protocol";
import type { Brain, Decision, Reinforcement } from "../brain/brain";
import { Shoe } from "./cards";
import { Table } from "./table";

/** Deals exactly these cards, in order: you, fly, dealer, you, fly, dealer, then hits. */
class StackedShoe extends Shoe {
  private readonly queue: Card[];

  constructor(ranks: Rank[]) {
    super(1);
    this.queue = ranks.map((rank) => ({ rank, suit: "clubs" }));
  }

  override get needsShuffle(): boolean {
    return false;
  }

  override draw(): Card {
    const card = this.queue.shift();
    if (!card) throw new Error("the stacked shoe ran out");
    return card;
  }
}

/** A fly that always plays `actions` in turn (then stands) and remembers what it was asked. */
class ScriptedBrain implements Brain {
  readonly topology = { count: 0, groups: [], binMs: 5 };
  readonly decisions: { fly: string; observation: FlyObservation; drunk: number }[] = [];
  readonly rewards: { fly: string; reward: number }[] = [];
  readonly resets: { fly: string; mode: BrainMode }[] = [];

  constructor(private readonly actions: Action[] = []) {}

  info(_fly: string): BrainInfo {
    return { source: "mock", mode: "pretrained", episodes: 0 };
  }

  async decide(fly: string, _episode: string, observation: FlyObservation, drunk: number): Promise<Decision> {
    this.decisions.push({ fly, observation, drunk });
    return { action: this.actions.shift() ?? "stand", frames: [], mbon: { hit: 0, stand: 0 } };
  }

  async reward(fly: string, _episode: string, reward: number): Promise<Reinforcement> {
    this.rewards.push({ fly, reward });
    return { kind: "none", frames: [], info: this.info(fly) };
  }

  async reset(fly: string, mode: BrainMode): Promise<void> {
    this.resets.push({ fly, mode });
  }

  subscribe(): () => void {
    return () => {};
  }
}

function setup(ranks: Rank[], bank: Partial<Bank> = {}, actions: Action[] = []) {
  const brain = new ScriptedBrain(actions);
  const messages: ServerMessage[] = [];
  const startBank: Bank = { ...freshBank(), id: "testplayer0000000000", ...bank };
  const table = new Table("t1", brain, startBank, (m) => messages.push(m), { shoe: new StackedShoe(ranks), pace: 0 });
  table.hello();
  const state = (): TableState => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && (m.type === "state" || m.type === "hello")) return m.state;
    }
    throw new Error("no state yet");
  };
  /** Waits until the table reaches one of these phases and nothing is running. */
  const until = async (...phases: TableState["phase"][]) => {
    for (let i = 0; i < 200; i++) {
      if (phases.includes(state().phase)) {
        await Bun.sleep(1);
        if (phases.includes(state().phase)) return state();
      }
      await Bun.sleep(1);
    }
    throw new Error(`table stuck in ${state().phase}`);
  };
  return { table, brain, messages, state, until };
}

describe("a round", () => {
  test("you stand on 20, the fly on 18, the dealer stands on 19", async () => {
    //            you  fly  dlr  you  fly  dlr
    const t = setup(["K", "10", "10", "Q", "8", "9"]);
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    t.table.handle({ type: "stand" });
    const s = await t.until("settled");
    expect(s.results).toEqual({ player: "win", fly: "lose" });
    expect(s.payouts).toEqual({ player: 10, fly: -10 });
    expect(s.bank.player).toBe(110);
    expect(s.bank.fly).toBe(90);
    expect(s.bank.fliesBeaten).toBe(1);
    expect(t.brain.decisions).toEqual([
      { fly: "testplayer0000000000:1", observation: { playerSum: 18, dealerCard: 10, usableAce: false }, drunk: 0 },
    ]);
    expect(t.brain.rewards).toEqual([{ fly: "testplayer0000000000:1", reward: -1 }]);
  });

  test("the fly hits until it busts, the dealer draws to 17", async () => {
    //            you  fly  dlr  you  fly  dlr  fly  dealer hits
    const t = setup(["10", "10", "6", "7", "2", "10", "K", "2"], {}, ["hit"]);
    t.table.handle({ type: "new_round", bet: 20 });
    await t.until("player");
    t.table.handle({ type: "stand" });
    const s = await t.until("settled");
    expect(s.hands.fly.status).toBe("bust");
    expect(s.hands.dealer.total).toBe(18);
    expect(s.results).toEqual({ player: "lose", fly: "lose" });
    expect(s.bank.player).toBe(80);
  });

  test("a natural pays 3:2, rounded up", async () => {
    const t = setup(["A", "10", "9", "K", "7", "8"]);
    t.table.handle({ type: "new_round", bet: 5 });
    const s = await t.until("settled");
    expect(s.player.hands[0]?.status).toBe("blackjack");
    expect(s.payouts.player).toBe(8);
    expect(s.bank.player).toBe(108);
  });

  test("the dealer's natural ends the round before anyone plays", async () => {
    const t = setup(["10", "10", "A", "9", "9", "K"]);
    t.table.handle({ type: "new_round", bet: 10 });
    const s = await t.until("settled");
    expect(s.hands.dealer.status).toBe("blackjack");
    expect(s.results).toEqual({ player: "lose", fly: "lose" });
    expect(t.brain.decisions).toHaveLength(0);
  });

  test("hitting to 21 stands for you", async () => {
    const t = setup(["5", "10", "10", "6", "8", "7", "K"]);
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    t.table.handle({ type: "hit" });
    const s = await t.until("settled");
    expect(s.player.hands[0]?.total).toBe(21);
    expect(s.results.player).toBe("win");
  });
});

describe("double down and split", () => {
  /** Lets the table finish its current step (it runs with no pauses). */
  const settle = () => Bun.sleep(5);

  test("doubling on 11 takes one card and pays on twice the bet", async () => {
    //            you  fly  dlr  you  fly  dlr  double
    const t = setup(["5", "10", "10", "6", "8", "7", "K"]);
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    expect(t.state().player.canDouble).toBe(true);
    expect(t.state().player.canSplit).toBe(false);
    t.table.handle({ type: "double" });
    const s = await t.until("settled");
    expect(s.player.hands).toEqual([
      expect.objectContaining({ total: 21, bet: 20, doubled: true, result: "win", payout: 20 }),
    ]);
    expect(s.bets?.player).toBe(20);
    expect(s.payouts.player).toBe(20);
    expect(s.bank.player).toBe(120);
  });

  test("you can only double on your first two cards and with chips to cover it", async () => {
    const t = setup(["2", "10", "10", "3", "8", "7", "4"]);
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    t.table.handle({ type: "hit" });
    await settle();
    expect(t.state().player.canDouble).toBe(false);
    t.table.handle({ type: "double" });
    expect(t.state().player.hands[0]?.cards).toHaveLength(3);

    const poor = setup(["5", "10", "10", "6", "8", "7"], { player: 15 });
    poor.table.handle({ type: "new_round", bet: 10 });
    await poor.until("player");
    expect(poor.state().player.canDouble).toBe(false);
  });

  test("a split pair plays as two hands, each settled on its own", async () => {
    //            you  fly  dlr  you  fly  dlr  split: h1  h2  double h1  dealer hits
    const t = setup(["8", "10", "6", "8", "9", "10", "3", "10", "9", "10"]);
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    expect(t.state().player.canSplit).toBe(true);
    t.table.handle({ type: "split" });
    await t.until("player");
    await settle();
    let s = t.state();
    expect(s.player.hands.map((h) => h.total)).toEqual([11, 18]);
    expect(s.player.active).toBe(0);
    expect(s.player.canSplit).toBe(false);
    t.table.handle({ type: "double" });
    await settle();
    expect(t.state().player.active).toBe(1);
    t.table.handle({ type: "stand" });
    s = await t.until("settled");
    expect(s.hands.dealer.status).toBe("bust");
    expect(s.player.hands.map((h) => [h.bet, h.result, h.payout])).toEqual([
      [20, "win", 20],
      [10, "win", 10],
    ]);
    expect(s.bets?.player).toBe(30);
    expect(s.payouts.player).toBe(30);
    expect(s.results.player).toBe("win");
    expect(s.bank.player).toBe(130);
    expect(s.score.player.win).toBe(2);
  });

  test("split aces get one card each, and 21 after a split is not a blackjack", async () => {
    //            you  fly  dlr  you  fly  dlr  split: h1  h2
    const t = setup(["A", "10", "9", "A", "9", "8", "K", "5"]);
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    t.table.handle({ type: "split" });
    const s = await t.until("settled");
    expect(s.player.hands.map((h) => [h.total, h.status, h.result, h.payout])).toEqual([
      [21, "stood", "win", 10],
      [16, "stood", "lose", -10],
    ]);
    expect(s.results.player).toBe("push");
    expect(s.bank.player).toBe(100);
  });

  test("any two ten-value cards make a pair", async () => {
    const tens = setup(["K", "9", "9", "10", "8", "8"]);
    tens.table.handle({ type: "new_round", bet: 10 });
    await tens.until("player");
    expect(tens.state().player.canSplit).toBe(true);

    const mixed = setup(["9", "9", "9", "K", "8", "8"]);
    mixed.table.handle({ type: "new_round", bet: 10 });
    await mixed.until("player");
    expect(mixed.state().player.canSplit).toBe(false);
  });
});

describe("the table", () => {
  test("refuses bets you can't cover or outside the limits", async () => {
    const t = setup([], { player: 30 });
    t.table.handle({ type: "new_round", bet: 50 });
    t.table.handle({ type: "new_round", bet: 2 });
    await Bun.sleep(5);
    const errors = t.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(2);
    expect(t.state().phase).toBe("idle");
    expect(t.state().bank.player).toBe(30);
  });

  test("a fly that can't match your bet is replaced by a new fly", async () => {
    const t = setup(["K", "10", "10", "Q", "8", "9"], { fly: 5, player: 400 });
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    const evicted = t.messages.find((m) => m.type === "fly_evicted");
    expect(evicted?.type === "fly_evicted" && evicted.event).toMatchObject({ ruinedNumber: 1, newNumber: 2 });
    const s = t.state();
    expect(s.bank.flyNumber).toBe(2);
    expect(s.bank.fliesRuined).toBe(1);
    expect(s.bank.fly).toBe(400 - 10);
    expect(t.brain.resets).toEqual([{ fly: "testplayer0000000000:2", mode: "pretrained" }]);
  });

  test("the drunk level belongs to the table and reaches the fly", async () => {
    const t = setup(["K", "10", "10", "Q", "8", "9"]);
    t.table.handle({ type: "set_drunk", value: 3 });
    expect(t.state().drunk).toBe(1);
    t.table.handle({ type: "set_drunk", value: 0.4 });
    t.table.handle({ type: "new_round", bet: 10 });
    await t.until("player");
    t.table.handle({ type: "stand" });
    await t.until("settled");
    expect(t.brain.decisions[0]?.drunk).toBe(0.4);
  });

  test("buying back in only works when you are broke", () => {
    const rich = setup([], { player: 50 });
    rich.table.handle({ type: "rebuy" });
    expect(rich.state().bank.player).toBe(50);
    const broke = setup([], { player: 3 });
    broke.table.handle({ type: "rebuy" });
    expect(broke.state().bank.player).toBe(100);
  });

  test("resetting the brain resets only this table's fly", async () => {
    const t = setup([], { flyNumber: 4 });
    t.table.handle({ type: "reset_brain", mode: "naive" });
    await Bun.sleep(5);
    expect(t.brain.resets).toEqual([{ fly: "testplayer0000000000:4", mode: "naive" }]);
  });
});
