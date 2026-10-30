export type ErrorCode = "RUNNER_TAKEN" | "BACKFILL_NOT_FOUND";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class RunnerTakenError extends Error implements ReducerError {
  errorCode = "RUNNER_TAKEN" as ErrorCode;
  constructor(message = "RunnerTakenError") {
    super(message);
  }
}

export class BackfillNotFoundError extends Error implements ReducerError {
  errorCode = "BACKFILL_NOT_FOUND" as ErrorCode;
  constructor(message = "BackfillNotFoundError") {
    super(message);
  }
}

export const errors = {
  RecordRunner: { RunnerTakenError },

  RecordBackfillDocument: { BackfillNotFoundError },
};
