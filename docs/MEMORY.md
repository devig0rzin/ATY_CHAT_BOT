# Memory

The memory architecture has three levels.

RAW HISTORY is the `messages` table. It is the durable record and must remain available even when summaries exist.

SHORT TERM is a configurable number of recent messages loaded for future AI context. The environment variable is `AI_RECENT_MESSAGE_LIMIT`, with `12` as the local example.

LONG TERM MEMORY is the `conversation_memory` table. It stores a summary, structured facts, goals, open loops, current intent, version, and the last summarized message reference.

Example long-term memory:

```json
{
  "summary": "Customer is exploring process automation for sales follow-up.",
  "facts": ["Prefers Portuguese", "Works at a services company"],
  "goals": ["Reduce manual WhatsApp follow-up"],
  "open_loops": ["Needs human review of possible integrations"],
  "current_intent": "lead_qualification"
}
```

Vector search is intentionally excluded from the MVP to reduce cost, complexity, and operational surface. The schema can be extended for future RAG after real usage patterns are known.
