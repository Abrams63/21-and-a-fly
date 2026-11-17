import { useCallback, useState } from "react";
import type { ClientMessage, DopamineEvent, TableState, ThinkEvent, Topology } from "../shared/protocol";
import styles from "./BrainPanel.module.css";
import { DrunkSlider } from "./DrunkSlider";
import { MbonMeter } from "./MbonMeter";
import { NeuronCanvas, type ReplayProgress } from "./NeuronCanvas";
import type { ActivityBus } from "./useGame";

interface Props {
  topology: Topology;
  activity: ActivityBus;
  state: TableState;
  send: (message: ClientMessage) => void;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function describe(event: ThinkEvent): string {
  const { playerSum, dealerCard, usableAce } = event.observation;
  const dealer = dealerCard === 1 ? "A" : dealerCard;
  const verdict = event.action === "hit" ? "HIT" : "STAND";
  return `sum ${playerSum}${usableAce ? " (soft)" : ""} · dealer shows ${dealer} → ${verdict}`;
}

export function BrainPanel({ topology, activity, state, send }: Props) {
  const [idle, setIdle] = useState(() => !prefersReducedMotion());
  const [meter, setMeter] = useState({ hit: 0, stand: 0 });
  const [verdict, setVerdict] = useState<ThinkEvent | null>(null);
  const [dopamine, setDopamine] = useState<DopamineEvent["kind"] | null>(null);

  const onReplay = useCallback((p: ReplayProgress) => {
    if (p.kind === "think") {
      setMeter({ hit: p.hit, stand: p.stand });
      setVerdict(p.done ? p.event : null);
    } else {
      setDopamine(p.done ? null : p.event.kind);
    }
  }, []);

  // A new round starts with a clean read-out (state adjusted during render, no effect needed).
  const [round, setRound] = useState(state.roundId);
  if (round !== state.roundId) {
    setRound(state.roundId);
    setMeter({ hit: 0, stand: 0 });
    setVerdict(null);
  }

  const roundRunning = state.phase === "fly" || state.phase === "dealer";

  return (
    <section className={styles.panel} data-dopamine={dopamine ?? undefined} aria-labelledby="brain-title">
      <header className={styles.header}>
        <h2 id="brain-title" className={styles.title}>
          Fly brain
        </h2>
        <span className={styles.badge} data-source={state.brain.source}>
          {state.brain.source === "mock" ? "mock · TS" : `PyTorch · ${state.brain.wiring ?? "SNN"}`}
        </span>
        <button type="button" className={styles.ghost} onClick={() => setIdle((v) => !v)}>
          {idle ? "Pause background" : "Background activity"}
        </button>
      </header>

      <NeuronCanvas topology={topology} activity={activity} idle={idle} onReplay={onReplay} />

      <MbonMeter hit={meter.hit} stand={meter.stand} action={verdict?.action ?? null} />

      <p className={styles.verdict} role="status">
        {verdict ? describe(verdict) : state.phase === "fly" ? "counting spikes…" : " "}
        {dopamine === "pam" && <span className={styles.reward}> · PAM dopamine: reward</span>}
        {dopamine === "ppl1" && <span className={styles.punish}> · PPL1 dopamine: punishment</span>}
      </p>

      <div className={styles.tools}>
        <DrunkSlider value={state.drunk} onChange={(value) => send({ type: "set_drunk", value })} />
        <div className={styles.resets}>
          <button
            type="button"
            className={styles.ghost}
            disabled={roundRunning}
            onClick={() => send({ type: "reset_brain", mode: "pretrained" })}
          >
            Retrain
          </button>
          <button
            type="button"
            className={styles.ghost}
            disabled={roundRunning}
            onClick={() => send({ type: "reset_brain", mode: "naive" })}
          >
            Newborn fly
          </button>
        </div>
      </div>
    </section>
  );
}
