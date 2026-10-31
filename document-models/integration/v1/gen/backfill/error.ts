export type ErrorCode =
  | "NOT_INITIALIZED"
  | "DUPLICATE_BACKFILL_ID"
  | "INVALID_RANGE"
  | "UNKNOWN_BACKFILL";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NotInitializedError extends Error implements ReducerError {
  errorCode = "NOT_INITIALIZED" as ErrorCode;
  constructor(message = "NotInitializedError") {
    super(message);
  }
}

export class DuplicateBackfillIdError extends Error implements ReducerError {
  errorCode = "DUPLICATE_BACKFILL_ID" as ErrorCode;
  constructor(message = "DuplicateBackfillIdError") {
    super(message);
  }
}

export class InvalidRangeError extends Error implements ReducerError {
  errorCode = "INVALID_RANGE" as ErrorCode;
  constructor(message = "InvalidRangeError") {
    super(message);
  }
}

export class UnknownBackfillError extends Error implements ReducerError {
  errorCode = "UNKNOWN_BACKFILL" as ErrorCode;
  constructor(message = "UnknownBackfillError") {
    super(message);
  }
}

export const errors = {
  SetBackfillEnabled: { NotInitializedError },

  AddDateRangeBackfill: {
    NotInitializedError,
    DuplicateBackfillIdError,
    InvalidRangeError,
  },

  AttachBackfill: { NotInitializedError, DuplicateBackfillIdError },

  RemoveBackfill: { UnknownBackfillError },
};
