# Public publication checklist

Before every PR, push or release:

- [ ] Confirm all documents are suitable for public release and distinguish proposals from verified outcomes.
- [ ] Inspect changed files and commit messages for personal/private infrastructure, addresses, runtime details, secrets and operator-specific examples.
- [ ] Run `npm run audit:public` and verify CI succeeds.
- [ ] Keep credentials, paths, deploy config and private run artifacts outside this repository.
- [ ] Review all reachable public branches/tags and any attachments or generated outputs.
- [ ] Use illustrative data only when clearly identified as synthetic.
