// Shell command policy for planning: adapted from @narumitw/pi-plan-mode (MIT),
// https://github.com/narumiruna/pi-extensions — bash-only subset (no PowerShell).
//
// Semantics: a command is safe iff every `;`/`|`-separated segment is quote-aware
// parsed and passes validation — no redirection/subshells/expansion/chaining, known
// read-only commands, arg-level safety (sed -i, find -exec, sort -o, …), and
// structured git/gh/npm validators. Unknown commands are denied.

export type SafeSubcommands = { [command: string]: string[] | undefined };

const BLOCKED_MUTATING_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
	"tee", "truncate", "dd", "sudo", "su", "kill", "pkill", "killall", "reboot",
	"shutdown", "vim", "vi", "nano", "emacs", "code", "subl",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "remote", "ls-files", "grep",
	"rev-parse", "blame", "describe", "merge-base", "ls-tree", "cat-file",
]);

const SAFE_GH_SUBCOMMAND_PATHS = new Set(["pr view", "pr list", "issue view", "issue list"]);

const READ_ONLY_COMMANDS = new Set([
	"cat", "head", "tail", "grep", "find", "ls", "pwd", "echo", "printf", "wc",
	"sort", "uniq", "diff", "file", "stat", "du", "df", "tree", "which", "whereis",
	"type", "printenv", "uname", "whoami", "id", "date", "uptime", "ps", "jq",
	"rg", "fd", "bat", "eza", "column", "comm", "cut", "nl",
]);

export function readCommand(input: unknown): string {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

export function isSafeCommand(command: string, safeSubcommands: SafeSubcommands = {}): boolean {
	return findBlockedCommandSegment(command, safeSubcommands) === undefined;
}

export function findBlockedCommandSegment(
	command: string,
	safeSubcommands: SafeSubcommands = {},
): string | undefined {
	if (matchesConfiguredSafeSubcommand(command, safeSubcommands)) return undefined;
	const segments = splitShellSegments(command);
	if (!segments || segments.length === 0) return command.trim() || "(empty command)";
	return segments.find((segment) => !isSafeSegment(segment, safeSubcommands));
}

function matchesConfiguredSafeSubcommand(command: string, safeSubcommands: SafeSubcommands): boolean {
	const candidate = command.trimStart();
	return Object.entries(safeSubcommands).some(([configuredCommand, subcommands]) =>
		subcommands?.some((subcommand) => {
			const prefix = `${configuredCommand.trim()} ${subcommand.trim()}`;
			if (!configuredCommand.trim() || !subcommand.trim() || !candidate.startsWith(prefix)) return false;
			const boundary = candidate[prefix.length];
			return boundary === undefined || /[\s;&|<>()]/.test(boundary);
		}),
	);
}

type ArgumentValidator = (args: string[]) => boolean;

function splitShellSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || /[\n\r`]/.test(trimmed)) return undefined;

	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		const character = trimmed[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		// redirection and subshells are always unsafe
		if (character === ">" || character === "<" || character === "(" || character === ")") return undefined;
		const next = trimmed[index + 1];
		if (character === "&" && next !== "&") return undefined;
		const separatorLength =
			character === ";" || character === "|" ? (next === character ? 2 : 1) : character === "&" && next === "&" ? 2 : 0;
		if (separatorLength === 0) continue;
		const segment = trimmed.slice(start, index).trim();
		if (!segment) return undefined;
		segments.push(segment);
		index += separatorLength - 1;
		start = index + 1;
	}
	if (quote || escaped) return undefined;
	const finalSegment = trimmed.slice(start).trim();
	if (!finalSegment) return undefined;
	segments.push(finalSegment);
	return segments;
}

function isSafeSegment(segment: string, safeSubcommands: SafeSubcommands): boolean {
	if (hasShellExpansion(segment) || /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) return false;
	const tokens = shellWords(segment);
	if (!tokens || tokens.length === 0) return false;
	const command = tokens[0]?.toLowerCase();
	if (!command || BLOCKED_MUTATING_COMMANDS.has(command)) return false;
	const args = tokens.slice(1);
	if (!hasSafeArguments(command, args)) return false;
	if (command === "hostname") return args.length === 0;
	if (READ_ONLY_COMMANDS.has(command)) return true;
	return isSafeStructuredCommand(command, args, safeSubcommands);
}

function hasShellExpansion(segment: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of segment) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else if (character === "$" && quote === '"') return true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (["$", "*", "?", "[", "{"].includes(character)) return true;
	}
	return false;
}

function shellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of segment) {
		if (escaped) {
			word += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			continue;
		}
		if (character === "'" || character === '"') quote = character;
		else if (/\s/.test(character)) {
			if (word) words.push(word);
			word = "";
		} else word += character;
	}
	if (quote || escaped) return undefined;
	if (word) words.push(word);
	return words;
}

function hasSafeArguments(command: string, args: string[]): boolean {
	const forbidden = new Set(["-i", "--in-place", "--fix", "--write", "-delete", "--delete"]);
	if (args.some((argument) => forbidden.has(argument))) return false;
	if (
		command === "sed" &&
		args.some(
			(argument) => argument.startsWith("--in-place=") || (/^-[^-]+/.test(argument) && argument.slice(1).includes("i")),
		)
	) {
		return false;
	}
	if (
		command === "find" &&
		args.some((argument) =>
			["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(argument),
		)
	) {
		return false;
	}
	if (command === "date" && args.some((argument) => argument === "-s" || argument.startsWith("--set"))) return false;
	if (
		(command === "sort" || command === "tree") &&
		args.some(
			(argument) =>
				argument === "-o" || (argument.startsWith("-o") && !argument.startsWith("--")) || argument.startsWith("--output"),
		)
	) {
		return false;
	}
	if (
		command === "sort" &&
		args.some(
			(argument) =>
				argument === "-T" ||
				(argument.startsWith("-T") && argument.length > 2) ||
				argument.startsWith("--temporary-directory") ||
				argument.startsWith("--compress-program"),
		)
	) {
		return false;
	}
	if (command === "diff" && args.some((argument) => argument === "--output" || argument.startsWith("--output="))) {
		return false;
	}
	if (command === "uniq" && args.filter((argument) => !argument.startsWith("-")).length > 1) return false;
	if (
		command === "fd" &&
		args.some((argument) =>
			["-x", "-X", "--exec", "--exec-batch"].some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
		)
	) {
		return false;
	}
	if (command === "rg" && args.some((argument) => argument === "--pre" || argument.startsWith("--pre="))) return false;
	if (command === "bat" && args.some((argument) => argument === "--pager" || argument.startsWith("--pager="))) return false;
	return true;
}

const allowReadOnlyArguments: ArgumentValidator = () => true;

function isSafeStructuredCommand(command: string, args: string[], safeSubcommands: SafeSubcommands): boolean {
	if (command === "git") return isSafeGitCommand(args, safeSubcommands);
	if (command === "gh") return isSafeGhCommand(args, safeSubcommands);

	const subcommandIndex = args.findIndex((argument) => !argument.startsWith("-"));
	const subcommand = args[subcommandIndex]?.toLowerCase();
	const subcommandArgs = subcommandIndex >= 0 ? args.slice(subcommandIndex + 1) : [];
	if (command === "sed") {
		const script = args.find((argument) => !argument.startsWith("-"));
		return (
			Boolean(script) &&
			(args.includes("-n") || args.some((argument) => /^-[^-]*n[^-]*$/.test(argument))) &&
			/^\d+(,\d+)?p$/.test(script ?? "")
		);
	}
	if (["node", "python", "python3", "tsc", "biome", "ruff", "ty"].includes(command)) {
		if (args.includes("--version")) return true;
		return (
			command === "tsc" &&
			args.includes("--noEmit") &&
			!args.some(
				(argument) =>
					argument === "--incremental" ||
					argument.startsWith("--incremental=") ||
					argument === "--tsBuildInfoFile" ||
					argument.startsWith("--tsBuildInfoFile=") ||
					argument === "--generateTrace" ||
					argument.startsWith("--generateTrace="),
			)
		);
	}
	if (command === "npm") {
		if (subcommand === "audit" && subcommandArgs.includes("fix")) return false;
		if (["list", "ls", "view", "info", "search", "outdated", "audit", "test"].includes(subcommand ?? "")) return true;
		return subcommand === "run" && ["test", "check", "typecheck", "lint"].includes(args[1] ?? "");
	}
	if (["cargo", "go", "pytest", "vitest", "jest"].includes(command)) {
		return ["test", "check"].includes(subcommand ?? "") || ["pytest", "vitest", "jest"].includes(command);
	}
	return false;
}

function isSafeGitCommand(args: string[], safeSubcommands: SafeSubcommands): boolean {
	// global options like --no-pager are fine; -C outside the cwd is not verifiable here
	let index = 0;
	while (index < args.length && args[index] === "--no-pager") index += 1;
	const subcommand = args[index]?.toLowerCase();
	if (!subcommand || subcommand.startsWith("-")) return false;
	const subcommandArgs = args.slice(index + 1);
	if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
	const subcommandArgsSafe = !subcommandArgs.some(
		(argument) =>
			argument === "--help" ||
			argument === "--show-signature" ||
			argument.startsWith("--show-signature=") ||
			argument.includes("%G") ||
			argument === "--output" ||
			argument.startsWith("--output=") ||
			argument === "--ext-diff" ||
			argument.startsWith("--ext-diff=") ||
			argument === "--textconv" ||
			argument.startsWith("--textconv=") ||
			argument === "--paginate" ||
			argument === "--open-files-in-pager" ||
			argument.startsWith("--open-files-in-pager=") ||
			(subcommand === "grep" && argument.startsWith("-O")),
	);
	if (!subcommandArgsSafe) return false;
	// branch/remote mutate with non-flag args or destructive flags
	if (subcommand === "branch") {
		return (
			subcommandArgs.every((argument) => argument.startsWith("-")) &&
			!subcommandArgs.some(
				(argument) =>
					/^-[^-]*[dDmMcCu]/.test(argument) ||
					matchesLongOptionPrefix(argument, "--delete", "--del") ||
					matchesLongOptionPrefix(argument, "--move", "--mov") ||
					matchesLongOptionPrefix(argument, "--copy", "--cop") ||
					matchesLongOptionPrefix(argument, "--edit-description", "--e") ||
					matchesLongOptionPrefix(argument, "--unset-upstream", "--u") ||
					matchesLongOptionPrefix(argument, "--set-upstream-to", "--set-u") ||
					matchesLongOptionPrefix(argument, "--create-reflog", "--creat"),
			)
		);
	}
	if (subcommand === "remote") {
		const actionIndex = subcommandArgs.findIndex((argument) => !argument.startsWith("-"));
		if (actionIndex < 0) return true;
		const action = subcommandArgs[actionIndex];
		if (action === "get-url") return true;
		if (action !== "show") return false;
		const showArgs = subcommandArgs.slice(actionIndex + 1);
		return !showArgs.includes("--");
	}
	if (subcommand === "cat-file") {
		return !subcommandArgs.some(
			(argument) => matchesLongOptionPrefix(argument, "--filters", "--fi") || matchesLongOptionPrefix(argument, "--textconv", "--t"),
		);
	}
	if (subcommand === "grep") {
		return !subcommandArgs.some(
			(argument) =>
				matchesLongOptionPrefix(argument, "--textconv", "--textc") ||
				matchesLongOptionPrefix(argument, "--open-files-in-pager", "--op") ||
				matchesLongOptionPrefix(argument, "--ext-grep", "--ext"),
		);
	}
	return true;
}

function matchesLongOptionPrefix(argument: string, option: string, shortest: string): boolean {
	const optionName = argument.split("=", 1)[0] ?? "";
	return optionName.length >= shortest.length && option.startsWith(optionName);
}

function isSafeGhCommand(args: string[], _safeSubcommands: SafeSubcommands): boolean {
	const group = args[0]?.toLowerCase();
	const action = args[1]?.toLowerCase();
	if (!group || !action || group.startsWith("-") || action.startsWith("-")) return false;
	const path = `${group} ${action}`;
	if (!SAFE_GH_SUBCOMMAND_PATHS.has(path)) return false;
	// read-only gh invocations must use --json (no pager/web/output escape hatches)
	return !args.slice(2).some(
		(argument) =>
			argument.startsWith("-w") ||
			argument === "--web" ||
			argument.startsWith("--web=") ||
			argument === "--browser" ||
			argument.startsWith("--browser=") ||
			argument === "--paginate" ||
			argument === "--pager" ||
			argument.startsWith("--pager=") ||
			argument === "--output" ||
			argument.startsWith("--output="),
	);
}
