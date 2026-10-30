export type ErrorCode = "NOT_INITIALIZED" | "INVALID_INTERVAL";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class NotInitializedError extends Error implements ReducerError {
  errorCode = "NOT_INITIALIZED" as ErrorCode;
  constructor(message = "NotInitializedError") {
    super(message);
  }
}

export class InvalidIntervalError extends Error implements ReducerError {
  errorCode = "INVALID_INTERVAL" as ErrorCode;
  constructor(message = "InvalidIntervalError") {
    super(message);
  }
}

export const errors = {
  SetLiveEnabled: { NotInitializedError },

  SetLiveInterval: { NotInitializedError, InvalidIntervalError },
};
