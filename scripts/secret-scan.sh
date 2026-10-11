#!/usr/bin/env bash
# Secret scan for the git tree. Uses gitleaks when installed; always runs a pattern + env-value grep as well.
# Exit code 1 if anything is found. Never prints the secret values themselves.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fail=0
files=$(git ls-files --cached --others --exclude-standard 2>/dev/null || find . -type f -not -path './node_modules/*' -not -path './.git/*')

if command -v gitleaks >/dev/null 2>&1; then
  echo "== gitleaks (working tree + history)"
  gitleaks detect --source . --no-banner --redact || fail=1
else
  echo "== gitleaks not installed; pattern scan only"
fi

echo "== env-value scan (PAYPAL_*, *_SECRET, *_KEY, *_TOKEN present in this shell)"
for name in $(env | cut -d= -f1 | grep -E '^PAYPAL_|SECRET|_KEY$|TOKEN' || true); do
  val="${!name}"; [ ${#val} -lt 12 ] && continue
  hits=$(printf '%s\n' $files | xargs -r grep -lF -- "$val" 2>/dev/null || true)
  if git rev-parse --git-dir >/dev/null 2>&1 && git log --all -p 2>/dev/null | grep -qF -- "$val"; then hits="$hits git-history"; fi
  if [ -n "$hits" ]; then echo "FOUND value of \$$name in: $hits"; fail=1; else echo "ok: \$$name value not present"; fi
done

echo "== pattern scan"
pat='(access_token\$production|A21AA[A-Za-z0-9_-]{20,}|EL[A-Za-z0-9_-]{60,}|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|api-m\.paypal\.com)'
if printf '%s\n' $files | grep -v -E '^(scripts/secret-scan.sh|package-lock.json)$' | xargs -r grep -nE -- "$pat" 2>/dev/null; then echo "pattern hit(s) above"; fail=1; else echo "ok: no key patterns, no live PayPal API host"; fi
printf '%s\n' $files | grep -E '(^|/)\.env$' && { echo ".env is tracked!"; fail=1; }

[ $fail -eq 0 ] && echo "SECRET SCAN: PASS" || echo "SECRET SCAN: FAIL"
exit $fail
