import type { z } from 'zod'
import type { AgentRuntimeConfig, MeteorologicalDatasetRecord } from '../schemas/types.js'

export interface ToolManifest {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    language: string;
    homepage?: string;
    endpoint?: string;
    requires?: Record<string, string>;
    tools: ToolManifestEntry[];
}
export interface ToolManifestEntry {
    name: string;
    label: string;
    description: string;
    group: string;
    tags: string[];
    isReadOnly: boolean;
    isDestructive: boolean;
    jsonSchema: Record<string, unknown>;
}
export interface ToolDef {
    name: string;
    label: string;
    description: string;
    prompt: string;
    group: string;
    tags: string[];
    isReadOnly: boolean;
    isDestructive: boolean;
    requiresApproval?: boolean;
    parameters?: z.ZodObject;
    jsonSchema?: Record<string, unknown>;
    handler: ToolHandler;
    providerId?: string;
    language?: string;
}
export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
export interface ToolContext {
    runId: string;
    sessionId: string;
    threadId: string | null;
    runtimeRoot?: string;
    runtimeConfig?: AgentRuntimeConfig;
    state: Map<string, unknown>;
    resolveValueRef(refId: string): ValueRef;
    resolveMeteorologicalDataset?(input: {
        datasetId?: string | null;
        filename?: string | null;
    }): Promise<MeteorologicalDatasetRecord | null>;
    invokeStructuredModel(prompt: string): Promise<Record<string, unknown>>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
}
export interface ToolResult {
    message: string;
    payload: Record<string, unknown>;
    warnings: string[];
    resultId: string;
    source: string;
    valueRefs?: ValueRef[];
    artifacts?: ToolArtifact[];
    provenance?: Record<string, unknown>;
}
export interface ValueRef {
    refId: string;
    kind: string;
    label: string;
    value: unknown;
    unit?: string | null;
    metadata?: Record<string, unknown>;
}
export interface ToolArtifact {
    artifactId: string;
    artifactType: string;
    name: string;
    uri: string;
    relativePath?: string | null;
    metadata?: Record<string, unknown>;
}
export interface ToolProvider {
    manifest: ToolManifest;
    tools(): ToolDef[];
    onInstall?(ctx: InstallContext): Promise<void>;
    onUninstall?(ctx: InstallContext): Promise<void>;
}
export interface InstallContext {
    config: Record<string, string | undefined>;
    state: Map<string, unknown>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
}
