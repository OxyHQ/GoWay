import { useCallback, useEffect, useRef, useState } from 'react';
import {
  blurryFraction,
  coachWarnings,
  initialCoach,
  stepCoach,
  type CoachState,
  type CoachWarning,
} from './coach';
import { advancePlan, startPlan, stepSeconds, type PlanState } from './plan';
import type { FrameSignals } from './sharpness';

const TICK_MS = 250;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The platform-independent half of a guided capture: the step plan, the
 * clocks, and the coach fed by whatever frame signals the platform can give.
 */
export function useGuidedSession() {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [coach, setCoach] = useState<CoachState>(initialCoach);
  const [t, setT] = useState(0);
  const startedAt = useRef<number | null>(null);
  const coachRef = useRef(coach);
  useEffect(() => {
    coachRef.current = coach;
  }, [coach]);

  useEffect(() => {
    if (!plan) return;
    const timer = setInterval(() => setT(now()), TICK_MS);
    return () => clearInterval(timer);
  }, [plan]);

  const start = useCallback(() => {
    const at = now();
    startedAt.current = at;
    setT(at);
    setCoach(initialCoach());
    setPlan(startPlan(at));
  }, []);
  const stop = useCallback(() => setPlan(null), []);
  const next = useCallback(
    () => setPlan((current) => (current ? advancePlan(current, now()) : current)),
    [],
  );
  const sample = useCallback(
    (signals: FrameSignals) => setCoach((current) => stepCoach(current, { t: now(), ...signals })),
    [],
  );
  /** Seconds since Start, read at call time rather than at the last tick. */
  const elapsedNow = useCallback(
    () => (startedAt.current === null ? 0 : (now() - startedAt.current) / 1000),
    [],
  );
  const summary = useCallback(() => ({ blurryFraction: blurryFraction(coachRef.current) }), []);

  const warnings: CoachWarning[] = plan ? coachWarnings(coach, t) : [];
  return {
    plan,
    warnings,
    elapsedSeconds: plan ? Math.max(0, (t - plan.startedAt[0]) / 1000) : 0,
    stepSeconds: plan ? stepSeconds(plan, t) : 0,
    start,
    stop,
    next,
    sample,
    elapsedNow,
    summary,
  };
}

export type GuidedSession = ReturnType<typeof useGuidedSession>;
