# Security Policy

admissions-ops is a local-first workspace: it runs on your machine, stores your
files in your own repository, and adds no server, account, or telemetry of its
own. The most important security property is therefore about **your data**, not
a hosted service.

## Do not put applicant data in public places

Real admissions data — names, transcripts, test scores, statements, contact
details — is personal and sensitive.

- **Never paste real applicant data into a public issue, pull request, or
  discussion.** Reproduce problems with the synthetic demo workspace
  (`students/nus-cs/`), the `examples/` fixtures, or freshly invented fake data.
- **Never commit real applicant data to a public repository.** If you use this
  project for a real application, create your copy with **Use this template →
  Private** (see the README quickstart), not a fork. The `.gitignore` keeps real
  `students/*` workspaces untracked by default as a second layer of protection.
- Remember that content you work on is sent to the model provider of whatever AI
  agent you run this in. Review that provider's privacy and retention terms —
  see *Integrity & Disclaimers* in the [README](README.md).

## Reporting a vulnerability or an accidental data exposure

Please report privately — **do not open a public issue** — for:

- a security vulnerability in the scripts, validators, or workflow (for example,
  a path that writes outside the intended workspace, or a validator that can be
  tricked into passing bad data);
- a case where real personal data has accidentally been published in this
  project's own repository or history;
- any other sensitive concern you would not want disclosed publicly first.

**How to report:** use GitHub's private vulnerability reporting — on the
repository's **Security** tab, choose **Report a vulnerability**. This opens a
private security advisory visible only to the maintainer. Please include what
you found, how to reproduce it, and the impact you expect. Do not include real
applicant data in the report; describe it instead.

You can expect an acknowledgement within a few days. This is a small,
best-effort project maintained in spare time — there is no formal SLA, but
data-exposure and workspace-boundary reports are treated as the highest
priority.

## If you accidentally exposed data in *your own* copy

If you pushed real applicant data to your own public repository, deleting the
file in a new commit is **not** enough — it remains in the git history. Make the
repository private immediately, then rewrite history (for example with
`git filter-repo`) or, for a fresh start, delete the repository and re-create it
from the template. Rotate anything credential-like that was exposed.

## Supported versions

Only the latest `main` is supported. Fixes land on `main` and reach the public
distribution through the normal release sync.
