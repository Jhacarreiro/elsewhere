# Public publication checklist

Before every PR, push or release:

- [ ] Confirm all documents are suitable for public release and distinguish proposals from verified outcomes.
- [ ] Inspect changed files and commit messages for personal/private infrastructure, addresses, runtime details, secrets and operator-specific examples.
- [ ] Run `npm run audit:public` and verify CI succeeds.
- [ ] Keep credentials, paths, deploy config and private run artifacts outside this repository. The one exception is [`examples/baseline-round-8kv859/`](examples/baseline-round-8kv859/README.md): decision records extracted from one finished run, published with the owner's consent after host paths were replaced and every record was read for private details. Raw run artifacts stay private, and a new example needs the same consent and review.
- [ ] Review all reachable public branches/tags and any attachments or generated outputs.
- [ ] Use illustrative data only when clearly identified as synthetic.
