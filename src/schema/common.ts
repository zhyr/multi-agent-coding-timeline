import { z } from 'zod';

/** All package objects keep unknown keys so a newer writer never loses data on round-trip. */
export const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const NonEmpty = z.string().min(1);
export const IsoTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'expected an ISO-8601 / parseable timestamp',
});
export const ShaHex = z.string().regex(/^[0-9a-f]{40,64}$/i, 'expected a hex SHA');
export const Confidence = z.number().min(0).max(1);

export const EvidenceLevelSchema = z.enum(['verified', 'agent_reported', 'inferred', 'unknown']);
export const MatchConfidenceSchema = z.enum(['exact', 'strong', 'candidate', 'none']);
export const CorrelationKindSchema = z.enum([
  'directly_observed',
  'explicit_reference',
  'strongly_supported',
  'time_based_inference',
]);
export const ContentModeSchema = z.enum(['metadata_only', 'summary', 'full']);
export const DedupTierSchema = z.enum(['native_id', 'source_location', 'content_assisted']);
export const OperationSchema = z.enum(['scan', 'merge']);

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .slice(0, 8)
    .join('; ');
  throw new Error(`${label}: ${detail}`);
}

export function firstIssue(schema: z.ZodTypeAny, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  return issue ? `${issue.path.join('.') || '<root>'}: ${issue.message}` : 'invalid';
}
