import {
  Binding, BindingList, ChannelStatusList, DeliveryList, Memory, MemoryExport, MemoryList, MemorySettings, MemoryUsageList,
  OptimizationControlList, OptimizationEvidenceList, OptimizationPolicy, OptimizationPolicyVersionList, OptimizationReport,
  PairingCode, PreviewOptimizationResponse, Project, ProjectList, TestNotificationAccepted,
  type CreateMemoryRequest, type NotificationChannel, type NotificationEventKind, type PreviewOptimizationRequest,
  type RevertOptimizationPolicyRequest, type UpdateMemoryRequest, type UpdateOptimizationPolicyRequest,
} from "@llmcrypto/contracts";
import { call, callNoContent } from "./api";

const enc = encodeURIComponent;

// ---------------------------------------------------------------- optimization (task 19)
export const listControls = (signal?: AbortSignal) => call("GET", "/api/optimization/controls", OptimizationControlList, { signal });
export const getPolicy = (signal?: AbortSignal) => call("GET", "/api/optimization/policy", OptimizationPolicy, { signal });
export const updatePolicy = (body: UpdateOptimizationPolicyRequest, signal?: AbortSignal) =>
  call("PUT", "/api/optimization/policy", OptimizationPolicy, { body, signal, status: 200 });
export const revertPolicy = (body: RevertOptimizationPolicyRequest, signal?: AbortSignal) =>
  call("POST", "/api/optimization/policy/revert", OptimizationPolicy, { body, signal, status: 200 });
export const listPolicyVersions = (signal?: AbortSignal) => call("GET", "/api/optimization/policy/versions?limit=50", OptimizationPolicyVersionList, { signal });
export const previewOptimization = (body: PreviewOptimizationRequest, signal?: AbortSignal) =>
  call("POST", "/api/optimization/preview", PreviewOptimizationResponse, { body, signal, status: 200 });
export const listEvidence = (query: string, signal?: AbortSignal) => call("GET", `/api/optimization/evidence?${query}`, OptimizationEvidenceList, { signal });
export const getReport = (signal?: AbortSignal) => call("GET", "/api/optimization/report", OptimizationReport, { signal });

// ---------------------------------------------------------------- projects and memory (task 20)
export const listProjects = (signal?: AbortSignal) => call("GET", "/api/projects?limit=200", ProjectList, { signal });
export const createProject = (name: string, signal?: AbortSignal) => call("POST", "/api/projects", Project, { body: { name }, signal, status: 201 });
export const listMemories = (projectId: string, signal?: AbortSignal) => call("GET", `/api/projects/${enc(projectId)}/memories?limit=200`, MemoryList, { signal });
export const getMemory = (projectId: string, id: string, signal?: AbortSignal) => call("GET", `/api/projects/${enc(projectId)}/memories/${enc(id)}`, Memory, { signal });
export const createMemory = (projectId: string, body: CreateMemoryRequest, signal?: AbortSignal) =>
  call("POST", `/api/projects/${enc(projectId)}/memories`, Memory, { body, signal, status: 201 });
export const updateMemory = (projectId: string, id: string, body: UpdateMemoryRequest, signal?: AbortSignal) =>
  call("PUT", `/api/projects/${enc(projectId)}/memories/${enc(id)}`, Memory, { body, signal, status: 200 });
export const deleteMemory = (projectId: string, id: string) => callNoContent("DELETE", `/api/projects/${enc(projectId)}/memories/${enc(id)}`);
export const exportMemories = (projectId: string, signal?: AbortSignal) => call("GET", `/api/projects/${enc(projectId)}/memories/export`, MemoryExport, { signal });
export const listMemoryUsage = (projectId: string, query: string, signal?: AbortSignal) =>
  call("GET", `/api/projects/${enc(projectId)}/memories/usage?${query}`, MemoryUsageList, { signal });
export const getMemorySettings = (projectId: string, signal?: AbortSignal) => call("GET", `/api/projects/${enc(projectId)}/memory-settings`, MemorySettings, { signal });
export const updateMemorySettings = (projectId: string, body: { retentionDays: number | null; expectedVersion: number }, signal?: AbortSignal) =>
  call("PUT", `/api/projects/${enc(projectId)}/memory-settings`, MemorySettings, { body, signal, status: 200 });

// ---------------------------------------------------------------- connectivity (task 21)
export const listChannels = (signal?: AbortSignal) => call("GET", "/api/connectivity/channels", ChannelStatusList, { signal });
export const startPairing = (channel: NotificationChannel, signal?: AbortSignal) =>
  call("POST", "/api/connectivity/pairings", PairingCode, { body: { channel }, signal, status: 201 });
export const confirmPairing = (id: string, events: NotificationEventKind[], signal?: AbortSignal) =>
  call("POST", `/api/connectivity/pairings/${enc(id)}/confirm`, Binding, { body: { events }, signal, status: 201 });
export const listBindings = (signal?: AbortSignal) => call("GET", "/api/connectivity/bindings", BindingList, { signal });
export const updateBinding = (id: string, events: NotificationEventKind[], signal?: AbortSignal) =>
  call("PUT", `/api/connectivity/bindings/${enc(id)}`, Binding, { body: { events }, signal, status: 200 });
export const unpairBinding = (id: string) => callNoContent("DELETE", `/api/connectivity/bindings/${enc(id)}`);
export const sendTestMessage = (id: string, signal?: AbortSignal) =>
  call("POST", `/api/connectivity/bindings/${enc(id)}/test`, TestNotificationAccepted, { signal, status: 202 });
export const listDeliveries = (query: string, signal?: AbortSignal) => call("GET", `/api/connectivity/deliveries?${query}`, DeliveryList, { signal });
