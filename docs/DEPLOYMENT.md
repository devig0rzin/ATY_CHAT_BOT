# Deployment

Current Cloudflare Worker name:

```text
aty-whatsapp-agent
```

Production workers.dev URL:

```text
https://aty-whatsapp-agent.igor-ameidaalves7.workers.dev
```

Do not deploy during the foundation phase.

Future Git connection path:

```text
Cloudflare Worker -> Settings -> Builds -> Connect -> GitHub
```

The Worker name in `wrangler.jsonc` must remain `aty-whatsapp-agent` so future automatic deployments target the existing Worker.

Before production deployment:

- Create D1 database `aty-whatsapp-agent-db`.
- Add the real D1 `database_id` to the `DB` binding.
- Configure secrets through Cloudflare.
- Finalize UAZAPI webhook authentication from official documentation.
- Provide official UAZAPI docs and one real webhook payload.
- Keep `AI_MODE=mock` until OpenAI behavior has been reviewed.
