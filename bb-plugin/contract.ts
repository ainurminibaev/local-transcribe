import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
const path = z.string().min(1).max(16384);
export const hostContract = defineRpcContract({
  localCopy: { input: z.object({ source: path, target: path }), output: z.any() },
  lease: { input: z.object({ path, token: z.string().uuid(), expiresAt: z.number(), create: z.boolean() }), output: z.boolean() },
  probe: { input: z.object({ repoPath: path, python: z.string().default('python3') }), output: z.any(), experimental_retryable: true },
  infoMaybe: { input: z.object({ path }), output: z.any(), experimental_retryable: true },
  info: { input: z.object({ path }), output: z.object({ size: z.number(), sha256: z.string() }), experimental_retryable: true },
  read: { input: z.object({ path, offset: z.number().int().nonnegative(), size: z.number().int().positive().max(1048576) }), output: z.string(), experimental_retryable: true },
  begin: { input: z.object({ path, token: z.string().uuid() }), output: z.string() },
  append: { input: z.object({ path, offset: z.number().int().nonnegative(), data: z.string().max(1500000) }), output: z.number() },
  finish: { input: z.object({ path, target: path, sha256: z.string(), size: z.number().int().nonnegative() }), output: z.any() },
  mkdir: { input: z.object({ path }), output: z.boolean() },
});
export const submitSchema = z.object({
  inputHostId: z.string().optional(), inputPath: path,
  outputHostId: z.string().optional(), outputPath: path,
  service: z.string().default('mac'), fallback: z.array(z.string()).max(8).optional(),
  threadId: z.string().optional(), speakers: z.boolean().default(true),
  engine: z.enum(['gigaam', 'whisper']).default('gigaam'),
  speakerCount: z.number().int().min(1).max(32).optional(),
  outputs: z.object({ segments: path.optional(), audio: path.optional(), source: path.optional(), samples: path.optional() }).strict().optional(),
}).strict();
export const rpcContract = defineRpcContract({
  services: { input: z.null(), output: z.any() },
  submit: { input: submitSchema, output: z.any() },
  status: { input: z.object({ jobId: z.string() }).strict(), output: z.any() },
  retryDelivery: { input: z.object({ jobId: z.string() }).strict(), output: z.any() },
  cancel: { input: z.object({ jobId: z.string() }).strict(), output: z.any() },
  copy: { input: z.object({ sourceHostId: z.string(), sourcePath: path, targetHostId: z.string(), targetPath: path }).strict(), output: z.any() },
});
