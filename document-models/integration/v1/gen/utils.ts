/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { DocumentModelUtils, PHBaseState, Reducer } from "document-model";
import {
  baseCreateDocument,
  baseLoadFromInputVersioned,
  baseSaveToFileHandle,
  createBaseState,
} from "document-model";
import { integrationUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsIntegrationDocument,
  assertIsIntegrationState,
  isIntegrationDocument,
  isIntegrationState,
} from "./document-schema.js";
import { integrationDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  IntegrationGlobalState,
  IntegrationLocalState,
  IntegrationPHState,
} from "./types.js";

export const initialGlobalState: IntegrationGlobalState = {
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
export const initialLocalState: IntegrationLocalState = {};

export const utils: DocumentModelUtils<IntegrationPHState> = {
  fileExtension: "intg",
  createState(state) {
    return {
      ...createBaseState(state?.auth, { version: 1, ...state?.document }),
      global: { ...initialGlobalState, ...state?.global },
      local: { ...initialLocalState, ...state?.local },
    };
  },
  createDocument(state) {
    return baseCreateDocument(
      utils.createState,
      state,
      integrationDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: integrationUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isIntegrationState(state);
  },
  assertIsStateOfType(state) {
    return assertIsIntegrationState(state);
  },
  isDocumentOfType(document) {
    return isIntegrationDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsIntegrationDocument(document);
  },
};
