/** Types for the vendored ES5 assignment block (evolveAssign.js). */

/** A campaign's lane of the project's traffic pool: in it when start <= pool roll < end. */
export interface TrafficLane {
  readonly start: number;
  readonly end: number;
}

export interface AssignableExperiment {
  readonly experimentId: string;
  readonly epoch: number;
  readonly salt: string;
  /** The run's campaign lane; absent (an API older than lanes) = the whole pool. */
  readonly lane?: TrafficLane;
  readonly arms: ReadonlyArray<{ readonly variationId: string; readonly weight: number }>;
}

/**
 * Which arm `subjectKey` (the SDK's anon id) sees, or null when the subject is
 * outside the run's lane or no arm is servable. `poolSalt` is the serving
 * config's (the project's id). It is undefined only when the config came from
 * an API older than lanes: the block then admits nobody to a narrowed lane and
 * needs no salt for the whole pool — exactly as the SDK does.
 */
export function evolveAssign(experiment: AssignableExperiment, subjectKey: string, poolSalt: string | undefined): string | null;

/** The subject's position in [0, 1). */
export function evolveRoll(salt: string, experimentId: string, epoch: number, subjectKey: string): number;
