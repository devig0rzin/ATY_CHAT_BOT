import { describe, expect, it } from 'vitest';
import { MockAIProvider } from '../src/integrations/openai/provider';
import { aiDecisionSchema } from '../src/schemas/ai.schemas';

describe('AI schema', () => {
  it('validates mock AI decision', async () => {
    const decision = await new MockAIProvider().generateReply({});
    expect(aiDecisionSchema.safeParse(decision).success).toBe(true);
    expect(decision.should_reply).toBe(false);
    expect(decision.intent).toBe('capture_mode');
  });
});
