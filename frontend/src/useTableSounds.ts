import { useEffect, useRef, useState } from "react";
import type { FlyEvictedEvent, TableState } from "../shared/protocol";
import { type Cue, tableSound } from "./sound";

const cardsOnTable = (s: TableState) =>
  [...s.player.hands, s.hands.fly, s.hands.dealer].reduce((n, h) => n + h.cards.filter(Boolean).length, 0);

const busts = (s: TableState) => s.player.hands.filter((h) => h.status === "bust").length;

/** What changed between two snapshots of the table, as sounds. */
function cuesFor(prev: TableState, next: TableState): Cue[] {
  const cues: Cue[] = [];
  if (next.roundId > prev.roundId) cues.push("chips");
  if (cardsOnTable(next) > cardsOnTable(prev)) cues.push("card");
  if (busts(next) > busts(prev)) cues.push("bust");
  if (next.phase === "settled" && prev.phase !== "settled") {
    const natural = next.player.hands.length === 1 && next.player.hands[0]?.status === "blackjack";
    const result = next.results.player;
    if (result === "win") cues.push(natural ? "blackjack" : "win");
    else if (result === "lose") cues.push("lose");
    else if (result === "push") cues.push("push");
  }
  return cues;
}

/** Plays table sounds (and phone buzzes) for state changes; returns the on/off switch. */
export function useTableSounds(state: TableState | null, eviction: FlyEvictedEvent | null) {
  const [enabled, setEnabled] = useState(tableSound.enabled);
  const prev = useRef<TableState | null>(null);

  // Audio may only start after the player touches the page.
  useEffect(() => {
    const unlock = () => tableSound.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const before = prev.current;
    prev.current = state;
    if (!before || !state) return;
    for (const cue of cuesFor(before, state)) tableSound.play(cue);
  }, [state]);

  useEffect(() => {
    if (eviction) tableSound.play("fly");
  }, [eviction]);

  const toggle = () => {
    tableSound.setEnabled(!enabled);
    setEnabled(!enabled);
  };
  return { enabled, toggle };
}
