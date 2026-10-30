import type { IntegrationSetupOperations } from "document-models/integration/v1";
import {
  AlreadyInitializedError,
  NotInitializedError,
  WrongKindError,
} from "../../gen/setup/error.js";

export const integrationSetupOperations: IntegrationSetupOperations = {
  initializeOperation(state, action) {
    if (state.kind)
      throw new AlreadyInitializedError("The integration is set up already");
    state.kind = action.input.kind;
    state.provider = action.input.provider;
  },
  setCalendarSourceOperation(state, action) {
    if (state.kind !== "CALENDAR")
      throw new WrongKindError("Only a calendar integration has calendars");
    state.intent.source = {
      calendars: action.input.allOwned
        ? []
        : action.input.calendars.map((c) => ({
            id: c.id,
            name: c.name ?? null,
          })),
      allOwned: action.input.allOwned,
    };
    state.intent.generation += 1;
  },
  setAccessOperation(state, action) {
    if (!state.kind)
      throw new NotInitializedError("Set up the integration first");
    state.intent.access = action.input.access;
    state.intent.generation += 1;
  },
  setEmailSourceOperation(state, action) {
    if (state.kind !== "EMAIL")
      throw new WrongKindError("Only an email integration has a mailbox");
    state.intent.source = {
      mailbox: action.input.mailbox,
      address: action.input.address ?? null,
      folders: action.input.folders,
    };
    state.intent.generation += 1;
  },
  setTransactionsSourceOperation(state, action) {
    if (state.kind !== "TRANSACTIONS")
      throw new WrongKindError(
        "Only a transactions integration has bank accounts",
      );
    state.intent.source = {
      bankConnectionId: action.input.bankConnectionId,
      accounts: action.input.accounts.map((a) => ({
        accountId: a.accountId,
        accountKey: a.accountKey,
        bankAccountId: a.bankAccountId,
        label: a.label ?? null,
      })),
    };
    state.intent.generation += 1;
  },
  setConnectionOperation(state, action) {
    if (!state.kind)
      throw new NotInitializedError("Set up the integration first");
    state.intent.connectionId = action.input.connectionId ?? null;
    state.intent.generation += 1;
  },
  setGrantOperation(state, action) {
    if (!state.kind)
      throw new NotInitializedError("Set up the integration first");
    state.grant = {
      statement: action.input.statement,
      person: action.input.person,
      grantedAt: action.input.grantedAt,
      expiresAt: action.input.expiresAt,
    };
  },
  clearGrantOperation(state, action) {
    state.grant = null;
  },
};
