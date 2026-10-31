/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating IntegrationDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  IntegrationDocument,
  IntegrationGlobalState,
  IntegrationLocalState,
  IntegrationPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): IntegrationGlobalState {
  return {
    kind: null,
    provider: null,
    providerOptions: null,
    intent: {
      generation: 0,
      connectionId: null,
      targetDriveId: null,
      access: null,
      source: null,
      live: {
        enabled: true,
        every: {
          value: 5,
          unit: "MINUTES",
        },
      },
      backfill: {
        enabled: true,
        batch: null,
        items: [],
        pinnedId: null,
      },
      archived: false,
    },
    resources: {
      connectionId: null,
      liveWorkflowId: null,
      backfillWorkflowId: null,
      pluggedItemId: null,
    },
    applied: null,
    check: null,
    checkRequest: null,
    fixes: [],
    runner: null,
    grant: null,
  };
}

export function defaultLocalState(): IntegrationLocalState {
  return {};
}

export function defaultPHState(): IntegrationPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<IntegrationGlobalState>,
): IntegrationGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<IntegrationLocalState>,
): IntegrationLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as IntegrationLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<IntegrationGlobalState>,
  localState?: Partial<IntegrationLocalState>,
): IntegrationPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a IntegrationDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createIntegrationDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<IntegrationGlobalState>;
    local?: Partial<IntegrationLocalState>;
  }>,
): IntegrationDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
