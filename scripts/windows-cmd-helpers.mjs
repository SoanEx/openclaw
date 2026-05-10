const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

export function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

export function buildCmdExeCommandLine(command, args) {
  const commandLine = [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
  // cmd.exe /s /c strips quote handling around the command string. When the
  // executable path is quoted, wrap the whole command line so paths under
  // "C:\Program Files" are not split into "C:\Program".
  return commandLine.startsWith('"') ? `"${commandLine}"` : commandLine;
}
