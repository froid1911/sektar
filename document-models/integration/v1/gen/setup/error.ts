export type ErrorCode =
  | "ALREADY_INITIALIZED"
  | "NOT_INITIALIZED"
  | "WRONG_KIND";

export interface ReducerError {
  errorCode: ErrorCode;
}

export class AlreadyInitializedError extends Error implements ReducerError {
  errorCode = "ALREADY_INITIALIZED" as ErrorCode;
  constructor(message = "AlreadyInitializedError") {
    super(message);
  }
}

export class NotInitializedError extends Error implements ReducerError {
  errorCode = "NOT_INITIALIZED" as ErrorCode;
  constructor(message = "NotInitializedError") {
    super(message);
  }
}

export class WrongKindError extends Error implements ReducerError {
  errorCode = "WRONG_KIND" as ErrorCode;
  constructor(message = "WrongKindError") {
    super(message);
  }
}

export const errors = {
  Initialize: { AlreadyInitializedError },

  SetAccess: { NotInitializedError },

  SetConnection: { NotInitializedError },

  SetCalendarSource: { WrongKindError },

  SetEmailSource: { WrongKindError },

  SetTransactionsSource: { WrongKindError },

  SetGrant: { NotInitializedError },
};
