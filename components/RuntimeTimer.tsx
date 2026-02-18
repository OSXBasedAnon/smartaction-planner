"use client";

import { useEffect, useState } from "react";

type RuntimeTimerProps = {
  running: boolean;
  finishedDurationMs?: number;
};

export function RuntimeTimer({ running, finishedDurationMs }: RuntimeTimerProps) {
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState<number>(performance.now());

  useEffect(() => {
    if (!running) return;
    setStart(performance.now());
    const id = window.setInterval(() => setNow(performance.now()), 50);
    return () => window.clearInterval(id);
  }, [running]);

  if (running && start !== null) {
    return <p className="small">Running... {((now - start) / 1000).toFixed(2)}s</p>;
  }

  if (typeof finishedDurationMs === "number") {
    return <p className="small">Final duration: {(finishedDurationMs / 1000).toFixed(2)}s</p>;
  }

  return <p className="small">Idle</p>;
}
