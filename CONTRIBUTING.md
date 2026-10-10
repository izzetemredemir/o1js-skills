# Contributing

Thanks for helping keep AI assistants honest about o1js. The rule that makes this skill useful: **no claim without evidence.**

## Reporting a problem

Open an issue with:
- **Wrong claim:** quote the line, say what o1js actually does, and give the o1js version. A minimal snippet or a failing test is ideal.
- **New pitfall:** the wrong pattern, the fix, and a source (audit finding, issue, or a reproduction).

## Changing the skill

1. **Write or update a test first** in [`skills/o1js/examples/`](skills/o1js/examples/):
   - Runtime behaviour: a `*.test.ts` file using `node:test` and `Mina.LocalBlockchain`.
   - API shape: a `@ts-expect-error` line in [`api-surface/type-checks.ts`](skills/o1js/examples/api-surface/type-checks.ts). It fails the build as soon as the old pattern starts compiling again.
2. **Update the markdown.** Mark tested statements with **[T]** and link the test. If something can't be tested (browser code, protocol behaviour), say so in the text.
3. **Run both suites:**
   ```bash
   npm test             # link check, type check, tests without proofs
   npm run test:proofs  # the same tests with real proofs
   ```
   Some problems only show up with proofs enabled (for example a contract with no methods, or `BatchReducer` settings).
4. **Open a pull request** describing which claim changed and which test backs it.

## Style

- **Target o1js 3.x on Mesa;** mention older versions only to say what changed.
- **Prefer short, concrete wrong/right pairs** over prose.
- **Cite sources:** o1js source or CHANGELOG, official docs, or public audits.
- **Keep `SKILL.md` short.** Details belong in `references/`.

## New o1js releases

CI runs the whole suite against the newest o1js every week. When it fails, the failing test points at the claim to update.
