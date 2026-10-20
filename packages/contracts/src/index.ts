import * as auth from "./auth";
import * as catalog from "./catalog";
import * as deposits from "./deposits";
import * as design from "./design";
import * as errors from "./errors";
import * as exportsMod from "./exports";
import * as keys from "./keys";
import * as connectivity from "./connectivity";
import * as memories from "./memories";
import * as operator from "./operator";
import * as optimization from "./optimization";
import * as projects from "./projects";
import * as repository from "./repository";
import * as usage from "./usage";

export * from "./auth";
export * from "./catalog";
export * from "./common";
export * from "./deposits";
export * from "./design";
export * from "./errors";
export * from "./exports";
export * from "./idempotency";
export * from "./keys";
export * from "./connectivity";
export * from "./memories";
export * from "./operator";
export * from "./optimization";
export * from "./projects";
export * from "./repository";
export * from "./usage";

/**
 * Named schemas shared with openapi.yaml components/schemas. Fixtures reference these names
 * and the contract test asserts the OpenAPI component of the same name accepts the same body.
 */
export const schemaRegistry = {
  WalletChallengeRequest: auth.WalletChallengeRequest,
  WalletChallenge: auth.WalletChallenge,
  WalletSessionRequest: auth.WalletSessionRequest,
  SessionView: auth.SessionView,
  LinkedIdentity: auth.LinkedIdentity,
  PasswordSetupRequest: auth.PasswordSetupRequest,
  PasswordSessionRequest: auth.PasswordSessionRequest,
  PasswordRecoveryRequest: auth.PasswordRecoveryRequest,
  RecoveryCodes: auth.RecoveryCodes,
  PasswordSignupResponse: auth.PasswordSignupResponse,
  TelegramCodeRequest: auth.TelegramCodeRequest,
  TelegramCode: auth.TelegramCode,
  TelegramVerifyRequest: auth.TelegramVerifyRequest,
  TelegramIdentity: auth.TelegramIdentity,
  KeySessionRequest: auth.KeySessionRequest,
  StepUpRequest: auth.StepUpRequest,
  AuthMethods: auth.AuthMethods,
  IdentityList: auth.IdentityList,
  CatalogResponse: catalog.CatalogResponse,
  Balance: usage.Balance,
  CreateKeyRequest: keys.CreateKeyRequest,
  CreateKeyResponse: keys.CreateKeyResponse,
  KeyList: keys.KeyList,
  CreateDepositRequest: deposits.CreateDepositRequest,
  Deposit: deposits.Deposit,
  DepositList: deposits.DepositList,
  PaymentNetworkList: deposits.PaymentNetworkList,
  UsagePage: usage.UsagePage,
  UsageDetail: usage.UsageDetail,
  AgentRunPage: usage.AgentRunPage,
  LedgerPage: usage.LedgerPage,
  CreateExportRequest: exportsMod.CreateExportRequest,
  ExportAccepted: exportsMod.ExportAccepted,
  Job: exportsMod.Job,
  CreateMemoryRequest: memories.CreateMemoryRequest,
  Memory: memories.Memory,
  UpdateMemoryRequest: memories.UpdateMemoryRequest,
  MemoryList: memories.MemoryList,
  MemorySettings: memories.MemorySettings,
  UpdateMemorySettingsRequest: memories.UpdateMemorySettingsRequest,
  MemoryUsageList: memories.MemoryUsageList,
  MemoryExport: memories.MemoryExport,
  CreateProjectRequest: projects.CreateProjectRequest,
  Project: projects.Project,
  ProjectList: projects.ProjectList,
  OptimizationControlList: optimization.OptimizationControlList,
  OptimizationPolicy: optimization.OptimizationPolicy,
  UpdateOptimizationPolicyRequest: optimization.UpdateOptimizationPolicyRequest,
  RevertOptimizationPolicyRequest: optimization.RevertOptimizationPolicyRequest,
  OptimizationPolicyVersionList: optimization.OptimizationPolicyVersionList,
  PreviewOptimizationRequest: optimization.PreviewOptimizationRequest,
  PreviewOptimizationResponse: optimization.PreviewOptimizationResponse,
  OptimizationEvidenceList: optimization.OptimizationEvidenceList,
  OptimizationReport: optimization.OptimizationReport,
  ChannelStatusList: connectivity.ChannelStatusList,
  CreatePairingRequest: connectivity.CreatePairingRequest,
  PairingCode: connectivity.PairingCode,
  ConfirmPairingRequest: connectivity.ConfirmPairingRequest,
  Binding: connectivity.Binding,
  BindingList: connectivity.BindingList,
  UpdateBindingRequest: connectivity.UpdateBindingRequest,
  TestNotificationAccepted: connectivity.TestNotificationAccepted,
  DeliveryList: connectivity.DeliveryList,
  RepositoryImportAccepted: repository.RepositoryImportAccepted,
  RepositoryImport: repository.RepositoryImport,
  RepositoryImportList: repository.RepositoryImportList,
  RepositoryFileList: repository.RepositoryFileList,
  RepositoryEdgeList: repository.RepositoryEdgeList,
  RepositoryGraph: repository.RepositoryGraph,
  RepositoryExport: repository.RepositoryExport,
  CreateDesignRequest: design.CreateDesignRequest,
  CreateDesignRevisionRequest: design.CreateDesignRevisionRequest,
  DesignRevisionAccepted: design.DesignRevisionAccepted,
  Design: design.Design,
  DesignList: design.DesignList,
  DesignExport: design.DesignExport,
  OperatorSession: operator.OperatorSession,
  PaymentReviewList: operator.PaymentReviewList,
  PaymentAlert: operator.PaymentAlert,
  PaymentAlertList: operator.PaymentAlertList,
  ResolveAlertRequest: operator.ResolveAlertRequest,
  StuckReservationList: operator.StuckReservationList,
  LedgerMismatchList: operator.LedgerMismatchList,
  ReconciliationSummary: operator.ReconciliationSummary,
  ProposeAdjustmentRequest: operator.ProposeAdjustmentRequest,
  DecideAdjustmentRequest: operator.DecideAdjustmentRequest,
  Adjustment: operator.Adjustment,
  AdjustmentList: operator.AdjustmentList,
  AuditEventList: operator.AuditEventList,
  FeatureFlags: operator.FeatureFlags,
  ErrorEnvelope: errors.ErrorEnvelope,
} as const;
export type SchemaName = keyof typeof schemaRegistry;
