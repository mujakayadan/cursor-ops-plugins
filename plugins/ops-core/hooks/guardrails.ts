/**
 * Cross-cutting shell guardrails applied to every agent shell command.
 * `deny` = irreversible data loss or disabling safety controls; `ask` = risky but often legitimate.
 * Rules are matched against the whole command with whitespace collapsed and newlines turned into `;`.
 */

import type { Decision, ShellRule } from "../lib/core/types.ts";

const PROTECTED_BRANCHES = "(?:main|master|production|prod|release|develop|trunk)";

// `git` plus global options such as `-C dir` or `--no-pager`, before the subcommand.
const GIT = String.raw`\bgit(?:\.exe)?(?:\s+(?:-C|-c)\s+\S+|\s+--(?:git-dir|work-tree|no-pager|bare)(?:=\S+)?)*\s+`;

// Start of a command: beginning, after a separator or quote (`bash -c "..."`), or after a prefix like sudo.
const CMD = String.raw`(?:^|[;&|(\x60"']\s*|\b(?:sudo|doas|exec|env|nohup|xargs)\s+(?:\S+=\S+\s+)*)`;

// Deletion targets that wipe a whole tree: roots, home, cwd, parent, glob-all, the repo's .git.
const UNIX_TARGET = String.raw`['"]?(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\.\/?\*?|\.\.\/?\*?|\*|\.git\/?|\/(?:etc|usr|bin|sbin|lib|boot|var|home|root|opt|Users|System|Applications)\/?)['"]?`;
const WIN_TARGET = String.raw`['"]?(?:[A-Za-z]:\\?\*?|~[\\/]?|\$HOME|\$env:USERPROFILE|\$env:SystemRoot|\.[\\/]?\*?|\.\.[\\/]?|\*|\.git[\\/]?|[A-Za-z]:\\(?:Windows|Users|Program Files(?: \(x86\))?)\\?)['"]?`;
const END = String.raw`(?=\s|$|;|&|\|)`;

const re = (source: string, flags = "i"): RegExp => new RegExp(source, flags);

// Arguments of the same command (stops at shell separators).
const A = "[^;&|]*";

export const GIT_RULES: ShellRule[] = [
  {
    id: "git-reset-hard",
    decision: "deny",
    re: re(`${GIT}reset\\b${A}\\s--hard\\b`, ""),
    reason:
      "`git reset --hard` discards uncommitted work. Use `git stash` or a new branch, or ask the user to run it.",
  },
  {
    id: "git-clean-force",
    decision: "deny",
    re: re(
      `${GIT}clean\\b(?=${A}\\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)${END})(?!${A}\\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)${END})`,
      "",
    ),
    reason:
      "`git clean -f` permanently deletes untracked files. Run `git clean -n` and show the user the list.",
  },
  {
    id: "git-discard-changes",
    decision: "deny",
    re: re(
      `${GIT}(?:checkout\\b(?=${A}(?:\\s--(?:\\s|$)|\\s(?:-f|--force)${END}|\\s\\.${END}))|switch\\b${A}\\s(?:-f|--force|--discard-changes)${END}|restore\\b(?!${A}\\s--staged\\b)|restore\\b${A}\\s--worktree\\b)`,
      "",
    ),
    reason: "This discards uncommitted changes in the working tree. Stash them or ask the user.",
  },
  {
    id: "git-stash-destroy",
    decision: "deny",
    re: re(`${GIT}stash\\s+(?:drop|clear)\\b`, ""),
    reason: "Dropping stashes loses work that is not committed anywhere.",
  },
  {
    id: "git-history-destroy",
    decision: "deny",
    re: re(
      `${GIT}(?:reflog\\s+(?:expire|delete)\\b|gc\\b${A}--prune=(?:now|all)\\b|prune\\b|filter-branch\\b|filter-repo\\b|update-ref\\s+-d\\b)`,
      "",
    ),
    reason:
      "This destroys the reflog or rewrites history, removing the ability to recover commits.",
  },
  {
    id: "git-push-mirror",
    decision: "deny",
    re: re(`${GIT}push\\b${A}\\s--mirror\\b`, ""),
    reason: "`git push --mirror` overwrites and deletes every remote ref.",
  },
  {
    id: "git-force-push-protected",
    decision: "deny",
    re: re(
      `${GIT}push\\b(?=${A}(?:\\s(?:--force\\S*|-f)${END}|\\s\\+\\S+))(?=${A}[\\s:+/]${PROTECTED_BRANCHES}${END})`,
      "i",
    ),
    reason: "Force-pushing to a protected branch is not allowed.",
  },
  {
    id: "git-delete-protected-branch",
    decision: "deny",
    re: re(
      `${GIT}(?:push\\b(?=${A}\\s(?:--delete|-d)\\b)(?=${A}\\s${PROTECTED_BRANCHES}${END})|push\\b${A}\\s:${PROTECTED_BRANCHES}${END}|branch\\b${A}\\s(?:-D|-d|--delete)\\s+(?:\\S+\\s+)*${PROTECTED_BRANCHES}${END})`,
      "i",
    ),
    reason: "Deleting a protected branch is not allowed.",
  },
  {
    id: "git-force-push",
    decision: "ask",
    re: re(`${GIT}push\\b${A}\\s(?:--force|-f)${END}`, ""),
    reason: "Force push rewrites remote history (prefer --force-with-lease).",
  },
  {
    id: "git-push-delete",
    decision: "ask",
    re: re(`${GIT}push\\b(?:${A}\\s(?:--delete|-d)\\b|${A}\\s:\\S+)`, ""),
    reason: "Deleting a remote branch or tag.",
  },
  {
    id: "git-branch-force-delete",
    decision: "ask",
    re: re(`${GIT}branch\\b${A}\\s(?:-D\\b|--delete\\s+--force\\b|--force\\s+--delete\\b)`, ""),
    reason: "Force-deleting a branch can lose unmerged commits.",
  },
  {
    id: "git-hooks-bypass",
    decision: "ask",
    re: re(
      `${GIT}(?:(?:commit|push|merge|rebase|am|cherry-pick|revert)\\b${A}\\s--no-verify\\b|config\\b${A}\\bcore\\.hooksPath\\b)`,
      "",
    ),
    reason: "This bypasses the repository's git hooks (lint, tests, secret scans).",
  },
];

export const DATABASE_RULES: ShellRule[] = [
  {
    id: "sql-drop",
    decision: "deny",
    re: /\bDROP\s+(?:DATABASE|SCHEMA|TABLE|KEYSPACE|OWNED\s+BY|USER|ROLE)\b/i,
    reason: "Dropping databases, schemas, tables or roles is not allowed from the agent.",
  },
  {
    id: "sql-truncate",
    decision: "deny",
    re: /\bTRUNCATE\s+(?:TABLE\b|[\w."`[\]]+\s*(?:;|,|CASCADE\b|RESTART\b|["'`]|$))/i,
    reason: "TRUNCATE deletes every row and cannot be rolled back on most engines.",
  },
  {
    id: "sql-delete-all",
    decision: "deny",
    re: /\bDELETE\s+FROM\s+[\w."`[\]]+\s*(?:;|["'`]|$)/i,
    reason: "DELETE without a WHERE clause removes every row.",
  },
  {
    id: "sql-update-all",
    decision: "ask",
    re: /\bUPDATE\s+[\w."`[\]]+\s+SET\b(?![^;"'`]*\bWHERE\b)/i,
    reason: "UPDATE without a WHERE clause changes every row.",
  },
  {
    id: "sql-alter-drop",
    decision: "ask",
    re: /\bALTER\s+TABLE\b[^;]*\bDROP\b/i,
    reason: "Dropping a column or constraint loses data.",
  },
  {
    id: "nosql-flush",
    decision: "deny",
    re: /\b(?:FLUSHALL|FLUSHDB)\b|\bdropDatabase\s*\(|\bdb\.\w+\.drop\s*\(\s*\)|\bdeleteMany\s*\(\s*\{\s*\}\s*\)/i,
    reason: "Flushing or dropping a key-value or document store is not allowed from the agent.",
  },
  {
    id: "db-cli-drop",
    decision: "deny",
    re: re(
      `${CMD}(?:dropdb|dropuser)\\b|\\bmysqladmin\\b.*\\bdrop\\b|\\bpg_restore\\b.*\\s--clean\\b`,
    ),
    reason:
      "Dropping or overwriting a database from the command line is not allowed from the agent.",
  },
  {
    id: "db-reset",
    decision: "deny",
    re: re(
      [
        String.raw`\bprisma\s+migrate\s+reset\b`,
        String.raw`\bprisma\s+db\s+push\b.*--(?:force-reset|accept-data-loss)\b`,
        String.raw`\b(?:rails|rake|bin\/rails)\s+db:(?:drop|reset|purge|schema:load|truncate_all)\b`,
        String.raw`\bartisan\s+(?:migrate:(?:fresh|reset|refresh)|db:wipe)\b`,
        String.raw`\balembic\s+downgrade\s+base\b`,
        String.raw`\bflyway\b.*\bclean\b`,
        String.raw`\bflywayClean\b`,
        String.raw`\bmanage\.py\s+(?:flush|reset_db|sqlflush)\b`,
        String.raw`\bsupabase\s+db\s+reset\b`,
        String.raw`\bsequelize(?:-cli)?\s+db:drop\b`,
        String.raw`\btypeorm\b.*\bschema:drop\b`,
        String.raw`\bdotnet\s+ef\s+database\s+drop\b`,
        String.raw`\bliquibase\b.*\b(?:dropAll|drop-all)\b`,
        String.raw`\bdrizzle-kit\s+drop\b`,
        String.raw`\bknex\s+migrate:rollback\b.*--all\b`,
        String.raw`\bmix\s+ecto\.(?:drop|reset)\b`,
        String.raw`\b(?:diesel|sqlx)\s+database\s+(?:drop|reset)\b`,
      ].join("|"),
    ),
    reason: "Resetting or dropping a database through a migration tool deletes all data.",
  },
  {
    id: "db-rollback",
    decision: "ask",
    re: /\balembic\s+downgrade\b|\b(?:rails|rake)\s+db:rollback\b|\bartisan\s+migrate:rollback\b|\bknex\s+migrate:(?:rollback|down)\b|\bflyway\b.*\bundo\b|\bprisma\s+migrate\s+resolve\b.*--rolled-back\b|\bsequelize(?:-cli)?\s+db:migrate:undo\b/i,
    reason: "Rolling back migrations can drop columns or tables.",
  },
  {
    id: "cloud-db-delete",
    decision: "deny",
    re: re(
      [
        String.raw`\bgcloud\s+(?:sql\s+(?:instances|databases)|spanner\s+(?:instances|databases)|firestore\s+databases|redis\s+instances|bigtable\s+instances)\s+delete\b`,
        String.raw`\baz\s+(?:sql|postgres|mysql|cosmosdb|redis|mariadb)\b.*\bdelete\b`,
        String.raw`\bneonctl\s+(?:projects?|branches?|databases?)\s+(?:delete|rm)\b`,
        String.raw`\bpscale\s+(?:database|branch)\s+delete\b`,
        String.raw`\bsupabase\s+projects\s+delete\b`,
        String.raw`\bturso\s+db\s+destroy\b`,
        String.raw`\bfly(?:ctl)?\s+(?:postgres|pg|mpg|volumes?|apps?)\s+(?:destroy|delete)\b`,
        String.raw`\bheroku\s+(?:pg:reset|addons:destroy|apps:destroy)\b`,
        String.raw`\batlas\s+clusters?\s+delete\b`,
        String.raw`\bupstash\s+(?:redis|kafka|vector)\s+delete\b`,
      ].join("|"),
    ),
    reason: "Deleting managed databases or their volumes is not allowed from the agent.",
  },
  {
    id: "docker-volume-destroy",
    decision: "deny",
    re: /\b(?:docker|podman)(?:-compose|\s+compose)\s+down\b.*\s(?:-v|--volumes)\b|\b(?:docker|podman)\s+volume\s+(?:rm|remove|prune)\b|\b(?:docker|podman)\s+system\s+prune\b.*--volumes\b/i,
    reason: "Removing container volumes deletes the data of local databases.",
  },
  {
    id: "docker-prune",
    decision: "ask",
    re: /\b(?:docker|podman)\s+(?:system|image|container|builder)\s+prune\b/i,
    reason: "Pruning Docker resources removes images and containers that may be needed.",
  },
  {
    id: "k8s-destroy-data",
    decision: "deny",
    re: /\bkubectl\s+delete\s+(?:ns|namespaces?|pv|pvc|persistentvolumes?|persistentvolumeclaims?|statefulsets?|sts|crds?|customresourcedefinitions?|nodes?)\b|\bkubectl\s+delete\b.*\s--all\b|\bhelm\s+(?:uninstall|delete)\b.*--all\b/i,
    reason:
      "Deleting namespaces, volumes, stateful sets or everything at once is not allowed from the agent.",
  },
  {
    id: "k8s-delete",
    decision: "ask",
    re: /\b(?:kubectl\s+(?:delete|drain|cordon|scale|replace\s+--force)|helm\s+(?:uninstall|delete|rollback))\b/i,
    reason: "Disruptive Kubernetes operation.",
  },
  {
    id: "iac-destroy",
    decision: "deny",
    re: /\b(?:terraform|tofu|terragrunt|pulumi|cdk|cdktf|sst|serverless|sls)\s+(?:run-all\s+)?(?:destroy|remove)\b|\b(?:terraform|tofu)\s+apply\b.*\s-destroy\b/i,
    reason: "Destroying infrastructure is not allowed from the agent; ask the user to run it.",
  },
  {
    id: "iac-unreviewed",
    decision: "ask",
    re: /\b(?:terraform|tofu|terragrunt)\s+(?:apply\b.*-auto-approve|state\s+(?:rm|mv|push|replace-provider)|workspace\s+delete|import|force-unlock)\b|\bpulumi\s+(?:up\b.*(?:--yes|-y)\b|state\s+delete|stack\s+rm)\b|\bcdk\s+deploy\b.*--require-approval[ =]never\b/i,
    reason: "Infrastructure-as-code change without review.",
  },
];

export const FILESYSTEM_RULES: ShellRule[] = [
  {
    id: "rm-tree",
    decision: "deny",
    re: re(
      `\\brm\\b(?=[^;&|]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b)[^;&|]*\\s${UNIX_TARGET}${END}`,
    ),
    reason: "Recursive delete of a root, home, current, parent or .git directory.",
  },
  {
    id: "ps-remove-tree",
    decision: "deny",
    re: re(
      `\\b(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\\b(?=[^;&|]*\\s(?:-r(?:ecurse)?|\\/s)\\b)[^;&|]*\\s${WIN_TARGET}${END}`,
    ),
    reason: "Recursive delete of a drive, home, current, parent, system or .git directory.",
  },
  {
    id: "disk-destroy",
    decision: "deny",
    re: re(
      `${CMD}(?:mkfs(?:\\.\\w+)?|fdisk|sfdisk|parted|wipefs|diskpart|format(?:\\.com)?\\s+[A-Za-z]:)|\\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\\b|\\bdd\\b.*\\bof=\\/dev\\/|>\\s*\\/dev\\/(?:sd|hd|nvme|disk|xvd)`,
    ),
    reason: "Formatting or overwriting disks is not allowed.",
  },
  {
    id: "secure-erase",
    decision: "deny",
    re: re(`${CMD}(?:shred|srm|wipe)\\b|\\bcipher\\s+\\/w\\b|\\bsdelete\\b`),
    reason: "Secure erase makes deleted data unrecoverable.",
  },
  {
    id: "chmod-tree",
    decision: "deny",
    re: re(
      `\\b(?:chmod|chown|chgrp)\\s+(?:-\\w+\\s+)*-[a-zA-Z]*R[a-zA-Z]*\\s+(?:\\S+\\s+)?${UNIX_TARGET}${END}|\\bicacls\\s+[A-Za-z]:\\\\?\\s.*\\/(?:grant|reset)\\b.*\\/t\\b|\\btakeown\\b.*\\/r\\b`,
    ),
    reason: "Recursively changing ownership or permissions of a root or home directory.",
  },
];

export const SYSTEM_RULES: ShellRule[] = [
  {
    id: "system-power",
    decision: "deny",
    re: re(
      `${CMD}(?:shutdown|reboot|halt|poweroff|init\\s+[06])\\b|\\b(?:Stop-Computer|Restart-Computer)\\b|\\bsystemctl\\s+(?:poweroff|reboot|halt|kexec)\\b`,
    ),
    reason: "Shutting down or rebooting the machine is not allowed.",
  },
  {
    id: "kill-everything",
    decision: "deny",
    re: /\bkill\s+-(?:9|KILL)\s+-1\b|\btaskkill\b.*\/IM\s+(?:explorer|svchost|csrss|winlogon|lsass|wininit|services)(?:\.exe)?\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i,
    reason: "Killing every process or critical system processes is not allowed.",
  },
  {
    id: "security-disable",
    decision: "deny",
    re: /\bSet-MpPreference\b.*-Disable\w+\s+(?:\$true|1)\b|\bAdd-MpPreference\b.*-ExclusionPath\b|\bnetsh\s+advfirewall\s+set\b.*\bstate\s+off\b|\bSet-NetFirewallProfile\b.*-Enabled\s+(?:False|\$false|0)\b|\bufw\s+disable\b|\bsetenforce\s+0\b|\bsystemctl\s+(?:stop|disable|mask)\s+(?:firewalld|ufw|apparmor|auditd|nftables)\b|\bspctl\s+--master-disable\b|\bcsrutil\s+disable\b/i,
    reason: "Disabling antivirus, firewalls or OS security controls is not allowed.",
  },
  {
    id: "registry-delete",
    decision: "deny",
    re: /\breg(?:\.exe)?\s+delete\s+HK|\bRemove-Item(?:Property)?\b.*\bHK(?:LM|CU|CR|U|CC):/i,
    reason: "Deleting Windows registry keys is not allowed.",
  },
  {
    id: "execution-policy",
    decision: "ask",
    re: /\bSet-ExecutionPolicy\s+(?:-ExecutionPolicy\s+)?(?:Unrestricted|Bypass)\b/i,
    reason: "Loosening the PowerShell execution policy.",
  },
  {
    id: "pipe-to-shell",
    decision: "ask",
    re: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\|\s*(?:iex|Invoke-Expression)\b/i,
    reason: "Piping a remote script into a shell.",
  },
];

export const RELEASE_RULES: ShellRule[] = [
  {
    id: "package-publish",
    decision: "ask",
    re: /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\b(?:uv|poetry|cargo|hatch|flit)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b|\bgradlew(?:\.bat)?\b.*\bpublish(?!ToMavenLocal)\w*\b|\bmvnw?\b.*\bdeploy\b|\b(?:docker|podman)\s+(?:push|buildx\s+build\b.*--push)\b/i,
    reason: "Publishing a package or image is public and hard to undo.",
  },
];

export const SECRET_RULES: ShellRule[] = [
  {
    id: "secret-file-read",
    decision: "ask",
    re: /\b(?:cat|type|Get-Content|gc|less|more|head|tail|bat|nl|xxd|base64|Copy-Item|cp|scp)\b[^;&|]*(?:\.ssh[\\/]id_|\.ssh[\\/][^\s"']*\.pem|\.aws[\\/]credentials|\.docker[\\/]config\.json|\.kube[\\/]config|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|gcloud[\\/](?:credentials|application_default)|\.azure[\\/](?:accessTokens|msal_token_cache))/i,
    reason: "Reading a credential file into the agent context.",
  },
  {
    id: "secret-token-print",
    decision: "ask",
    re: /\bgh\s+auth\s+token\b|\baws\s+(?:configure\s+export-credentials|sts\s+get-session-token|ecr\s+get-login-password)\b|\bgcloud\s+auth\s+(?:print-access-token|print-identity-token)\b|\baz\s+account\s+get-access-token\b|\bdoctl\s+auth\s+token\b|\bvercel\s+(?:whoami\s+--token|tokens?\s+(?:ls|add))\b/i,
    reason: "Printing an access token into the agent context.",
  },
];

// Paths that hold the guardrails themselves or their configuration.
const GUARD_PATHS = String.raw`(?:\.ops[\\/](?:config\.json|audit)|\.cursor[\\/](?:hooks\.json|hooks[\\/]|plugins[\\/])|ops-core[\\/](?:hooks|lib)[\\/]|[\\/]hooks[\\/]hooks\.json)`;
const WRITE_OPS = String.raw`(?:>|\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|ni|sc|ac|rm|rmdir|mv|cp|del|erase|rd|ren|move|copy|tee|truncate|unlink|ln|mklink|attrib|chmod|icacls)\b|\bsed\s+(?:-\w+\s+)*-i|\b(?:writeFile|appendFile|rmSync|unlinkSync|renameSync|copyFile|cpSync|symlink|WriteAll|AppendAll|write_text|write_bytes|rmtree)\w*)`;

/** Rules that config overrides can never relax. */
export const TAMPER_RULES: ShellRule[] = [
  {
    id: "guard-tamper",
    decision: "deny",
    re: re(`(?=.*${GUARD_PATHS})(?=.*${WRITE_OPS})`),
    reason:
      "Changing or removing the ops guardrails, their config or the audit trail is not allowed from the agent.",
  },
  {
    id: "guard-privileged-env",
    decision: "deny",
    re: /\bOPS_ALLOW_PRIVILEGED\s*=|\$env:OPS_ALLOW_PRIVILEGED\b|\bsetx?\s+OPS_ALLOW_PRIVILEGED\b|\bOPS_CONFIG\s*=|\$env:OPS_CONFIG\b/i,
    reason: "Enabling privileged tools or swapping the ops config is the user's decision.",
  },
];

export const SHELL_RULES: ShellRule[] = [
  ...TAMPER_RULES,
  ...GIT_RULES,
  ...DATABASE_RULES,
  ...FILESYSTEM_RULES,
  ...SYSTEM_RULES,
  ...RELEASE_RULES,
  ...SECRET_RULES,
];

const TAMPER_IDS = new Set(TAMPER_RULES.map((r) => r.id));
const DECISIONS = new Set<unknown>(["allow", "ask", "deny"] satisfies Decision[]);

/** Apply `guardrails.shell.overrides` ({ ruleId: "allow" | "ask" | "deny" }); tamper rules stay deny. */
export function withOverrides(
  rules: ShellRule[],
  overrides: Partial<Record<string, Decision>> = {},
): ShellRule[] {
  return rules
    .map((r) => {
      const o = overrides[r.id];
      if (!o || !DECISIONS.has(o) || TAMPER_IDS.has(r.id)) return r;
      return { ...r, decision: o };
    })
    .filter((r) => r.decision !== "allow");
}

const SEARCH_COMMANDS =
  /^(?:rg|grep|egrep|fgrep|findstr|Select-String|sls|ag|ack|echo|printf|Write-Host|Write-Output|git\s+(?:grep|log|show|diff|blame))\b/i;

/**
 * True when every segment only searches or prints text (e.g. `rg "DROP TABLE" migrations`),
 * so dangerous-looking patterns are arguments, not actions.
 */
export function isTextOnly(command: string): boolean {
  if (/>|\btee\b|`|\$\(/.test(command)) return false;
  const segments = command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every((s) => SEARCH_COMMANDS.test(s.replace(/^&\s*/, "")));
}

const MESSAGE_ARG =
  /(\s(?:-m|--message|--title|--body|--notes|--subject))(=|\s+)("(?:[^"\\]|\\.)*"|'[^']*')/g;

/**
 * Prepare a command for matching: newlines become separators so command-position anchors work,
 * and free-text message arguments (`git commit -m "drop user table"`) are blanked out.
 */
export function normalizeCommand(command: string | undefined): string {
  return (command ?? "").replace(/\r?\n/g, " ; ").replace(MESSAGE_ARG, '$1$2""');
}

/** MCP tools that execute commands or SQL (run_command, execute_sql, query, ...). Their string inputs get the shell rules. */
export const EXEC_TOOL =
  /(?:^|[_-])(?:sql|query|queries|exec|execute|statement|command|commands|shell|bash|terminal|script|run|migrat\w*)(?:[_-]|$)/i;

/** Every string value in an MCP tool input, joined so each is matched like a separate command. */
export function inputStrings(input: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return out.join(" ; ");
}
