import { z } from 'zod';

export const arbitraryJsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(arbitraryJsonSchema),
    z.record(arbitraryJsonSchema)
  ])
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
