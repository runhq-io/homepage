/** Types for the vendored ES5 assignment block (evolveAssign.js). */
export interface AssignableExperiment {
  readonly experimentId: string;
  readonly epoch: number;
  readonly salt: string;
  readonly arms: ReadonlyArray<{ readonly variationId: string; readonly weight: number }>;
}

/** Which arm `subjectKey` (the SDK's anon id) sees, or null when no arm is servable. */
export function evolveAssign(experiment: AssignableExperiment, subjectKey: string): string | null;

/** The subject's position in [0, 1). */
export function evolveRoll(salt: string, experimentId: string, epoch: number, subjectKey: string): number;
