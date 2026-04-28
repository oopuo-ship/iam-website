# Repo-local git hooks

This directory holds repo-tracked git hooks for the IAM website. Per M2 Phase 01
decision **D-04**, we ship a `gitleaks` pre-commit scanner as a defense-in-depth
safeguard against accidentally committing API keys, tokens, or private-key
material. This closes M2 Phase 01 success criterion **SC-6**.

## Why repo-local, not dev-machine-specific

Git does not follow hooks in `.git/hooks/` across clones — each developer would
have to set them up independently, and the gap is where leaks happen. By
tracking hooks in `.githooks/` and wiring `core.hooksPath`, every checkout
(including the production VPS) picks up the same scanner.

## Activation (one-time per checkout)

Run this command from the repo root after cloning:

```bash
git config core.hooksPath .githooks
```

After that, `git commit` will automatically run `gitleaks protect --staged
--redact --verbose` and block the commit if a secret is detected.

The **M2 Phase 02** `bootstrap.sh` will run this command automatically on the
VPS so production deploys inherit the hook without manual setup.

## Requirements

- [`gitleaks`](https://github.com/gitleaks/gitleaks) must be installed and on
  `$PATH`. If missing, the hook exits with an error explaining how to install
  or to re-run `bootstrap.sh`.

Install locally (macOS):

```bash
brew install gitleaks
```

Install locally (Linux):

```bash
# see https://github.com/gitleaks/gitleaks/releases for current version
```

## Do NOT bypass with --no-verify

Per [GUARDRAILS.md](../.planning/M2/GUARDRAILS.md), skipping hooks with
`--no-verify` or `--no-gpg-sign` is prohibited. If the hook blocks a commit,
fix the underlying issue — remove the secret, rotate it, and re-stage. Never
bypass the scanner; that defeats the purpose of SC-6.

## Hook list

| Hook         | Purpose                                          | Decision |
| ------------ | ------------------------------------------------ | -------- |
| `pre-commit` | Run `gitleaks protect --staged` on staged diffs. | D-04     |
