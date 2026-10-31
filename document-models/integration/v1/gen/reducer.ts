import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { IntegrationPHState } from "document-models/integration/v1";
import type {
  AddDateRangeBackfillAction,
  AttachBackfillAction,
  RemoveBackfillAction,
  SetBackfillEnabledAction,
} from "./backfill/actions.js";
import type { ArchiveAction } from "./lifecycle/actions.js";
import type {
  SetLiveEnabledAction,
  SetLiveIntervalAction,
} from "./live/actions.js";
import type {
  RecordBackfillDocumentAction,
  RecordCheckAction,
  RecordResourcesAction,
  RecordRunnerAction,
  RequestCheckAction,
} from "./reconciler/actions.js";
import type {
  ClearGrantAction,
  InitializeAction,
  SetAccessAction,
  SetCalendarSourceAction,
  SetConnectionAction,
  SetEmailSourceAction,
  SetGrantAction,
  SetTransactionsSourceAction,
} from "./setup/actions.js";

import { integrationBackfillOperations } from "../src/reducers/backfill.js";
import { integrationLifecycleOperations } from "../src/reducers/lifecycle.js";
import { integrationLiveOperations } from "../src/reducers/live.js";
import { integrationReconcilerOperations } from "../src/reducers/reconciler.js";
import { integrationSetupOperations } from "../src/reducers/setup.js";

import {
  AddDateRangeBackfillInputSchema,
  ArchiveInputSchema,
  AttachBackfillInputSchema,
  ClearGrantInputSchema,
  InitializeInputSchema,
  RecordBackfillDocumentInputSchema,
  RecordCheckInputSchema,
  RecordResourcesInputSchema,
  RecordRunnerInputSchema,
  RemoveBackfillInputSchema,
  RequestCheckInputSchema,
  SetAccessInputSchema,
  SetBackfillEnabledInputSchema,
  SetCalendarSourceInputSchema,
  SetConnectionInputSchema,
  SetEmailSourceInputSchema,
  SetGrantInputSchema,
  SetLiveEnabledInputSchema,
  SetLiveIntervalInputSchema,
  SetTransactionsSourceInputSchema,
} from "./schema/zod.js";

const schemaMemo = new Map<() => unknown, unknown>();

function memoizedSchema<T>(makeSchema: () => T): T {
  let schema = schemaMemo.get(makeSchema) as T | undefined;
  if (schema === undefined) {
    schema = makeSchema();
    schemaMemo.set(makeSchema, schema);
  }
  return schema;
}

const stateReducer: StateReducer<IntegrationPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "INITIALIZE": {
      memoizedSchema(InitializeInputSchema).parse(action.input);

      integrationSetupOperations.initializeOperation(
        state.global,
        action as InitializeAction,
        dispatch,
      );

      break;
    }

    case "SET_ACCESS": {
      memoizedSchema(SetAccessInputSchema).parse(action.input);

      integrationSetupOperations.setAccessOperation(
        state.global,
        action as SetAccessAction,
        dispatch,
      );

      break;
    }

    case "SET_CONNECTION": {
      memoizedSchema(SetConnectionInputSchema).parse(action.input);

      integrationSetupOperations.setConnectionOperation(
        state.global,
        action as SetConnectionAction,
        dispatch,
      );

      break;
    }

    case "SET_CALENDAR_SOURCE": {
      memoizedSchema(SetCalendarSourceInputSchema).parse(action.input);

      integrationSetupOperations.setCalendarSourceOperation(
        state.global,
        action as SetCalendarSourceAction,
        dispatch,
      );

      break;
    }

    case "SET_EMAIL_SOURCE": {
      memoizedSchema(SetEmailSourceInputSchema).parse(action.input);

      integrationSetupOperations.setEmailSourceOperation(
        state.global,
        action as SetEmailSourceAction,
        dispatch,
      );

      break;
    }

    case "SET_TRANSACTIONS_SOURCE": {
      memoizedSchema(SetTransactionsSourceInputSchema).parse(action.input);

      integrationSetupOperations.setTransactionsSourceOperation(
        state.global,
        action as SetTransactionsSourceAction,
        dispatch,
      );

      break;
    }

    case "SET_GRANT": {
      memoizedSchema(SetGrantInputSchema).parse(action.input);

      integrationSetupOperations.setGrantOperation(
        state.global,
        action as SetGrantAction,
        dispatch,
      );

      break;
    }

    case "CLEAR_GRANT": {
      memoizedSchema(ClearGrantInputSchema).parse(action.input);

      integrationSetupOperations.clearGrantOperation(
        state.global,
        action as ClearGrantAction,
        dispatch,
      );

      break;
    }

    case "SET_LIVE_ENABLED": {
      memoizedSchema(SetLiveEnabledInputSchema).parse(action.input);

      integrationLiveOperations.setLiveEnabledOperation(
        state.global,
        action as SetLiveEnabledAction,
        dispatch,
      );

      break;
    }

    case "SET_LIVE_INTERVAL": {
      memoizedSchema(SetLiveIntervalInputSchema).parse(action.input);

      integrationLiveOperations.setLiveIntervalOperation(
        state.global,
        action as SetLiveIntervalAction,
        dispatch,
      );

      break;
    }

    case "SET_BACKFILL_ENABLED": {
      memoizedSchema(SetBackfillEnabledInputSchema).parse(action.input);

      integrationBackfillOperations.setBackfillEnabledOperation(
        state.global,
        action as SetBackfillEnabledAction,
        dispatch,
      );

      break;
    }

    case "ADD_DATE_RANGE_BACKFILL": {
      memoizedSchema(AddDateRangeBackfillInputSchema).parse(action.input);

      integrationBackfillOperations.addDateRangeBackfillOperation(
        state.global,
        action as AddDateRangeBackfillAction,
        dispatch,
      );

      break;
    }

    case "ATTACH_BACKFILL": {
      memoizedSchema(AttachBackfillInputSchema).parse(action.input);

      integrationBackfillOperations.attachBackfillOperation(
        state.global,
        action as AttachBackfillAction,
        dispatch,
      );

      break;
    }

    case "REMOVE_BACKFILL": {
      memoizedSchema(RemoveBackfillInputSchema).parse(action.input);

      integrationBackfillOperations.removeBackfillOperation(
        state.global,
        action as RemoveBackfillAction,
        dispatch,
      );

      break;
    }

    case "REQUEST_CHECK": {
      memoizedSchema(RequestCheckInputSchema).parse(action.input);

      integrationReconcilerOperations.requestCheckOperation(
        state.global,
        action as RequestCheckAction,
        dispatch,
      );

      break;
    }

    case "RECORD_RUNNER": {
      memoizedSchema(RecordRunnerInputSchema).parse(action.input);

      integrationReconcilerOperations.recordRunnerOperation(
        state.global,
        action as RecordRunnerAction,
        dispatch,
      );

      break;
    }

    case "RECORD_RESOURCES": {
      memoizedSchema(RecordResourcesInputSchema).parse(action.input);

      integrationReconcilerOperations.recordResourcesOperation(
        state.global,
        action as RecordResourcesAction,
        dispatch,
      );

      break;
    }

    case "RECORD_BACKFILL_DOCUMENT": {
      memoizedSchema(RecordBackfillDocumentInputSchema).parse(action.input);

      integrationReconcilerOperations.recordBackfillDocumentOperation(
        state.global,
        action as RecordBackfillDocumentAction,
        dispatch,
      );

      break;
    }

    case "RECORD_CHECK": {
      memoizedSchema(RecordCheckInputSchema).parse(action.input);

      integrationReconcilerOperations.recordCheckOperation(
        state.global,
        action as RecordCheckAction,
        dispatch,
      );

      break;
    }

    case "ARCHIVE": {
      memoizedSchema(ArchiveInputSchema).parse(action.input);

      integrationLifecycleOperations.archiveOperation(
        state.global,
        action as ArchiveAction,
        dispatch,
      );

      break;
    }

    default:
      return state;
  }
};

export const reducer: Reducer<IntegrationPHState> = createReducer(stateReducer);
