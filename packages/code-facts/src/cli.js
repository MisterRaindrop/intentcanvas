import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { extractCodeFacts, serializeCodeFacts } from "./extract.js";
import { formatCodeFactsInspection, inspectCodeFacts } from "./inspect.js";
import { prepareCodeFacts } from "./prepare.js";

const HELP = `Usage:
  code-facts prepare [project-root] [options]
  code-facts extract [project-root] [options]
  code-facts inspect [facts.json|-] [--json]

Prepare options:
  --compile-commands, -c <path>  Reuse a specific compile_commands.json
  --work-dir <path>             Private preparation directory
  --output, -o <path>           Write prepared Code Facts (default: stdout)
  --dry-run                     Print the fixed commands without running them
  --no-clang-uml                Prepare compiler and file facts only

Extract options:
  --compile-commands, -c <path>  Use an existing compile_commands.json
  --clang-uml, -u <path>         Ingest an existing clang-uml JSON file
  --output, -o <path>            Write JSON to a file (default: stdout)
  --compact                      Emit compact JSON
  --no-tool-check                Do not inspect PATH for clang-uml

The extractor is read-only: it never runs a build, compiler, or clang-uml.
`;

function optionValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || (value.startsWith("-") && value !== "-")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function parseExtractArguments(arguments_) {
  const options = {};
  let projectRoot;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (["--compile-commands", "-c"].includes(argument)) {
      options.compileCommandsPath = optionValue(arguments_, index, argument);
      index += 1;
    } else if (["--clang-uml", "-u"].includes(argument)) {
      options.clangUmlPath = optionValue(arguments_, index, argument);
      index += 1;
    } else if (["--output", "-o"].includes(argument)) {
      options.output = optionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--compact") {
      options.pretty = false;
    } else if (argument === "--no-tool-check") {
      options.checkToolAvailability = false;
    } else if (["--help", "-h"].includes(argument)) {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (projectRoot === undefined) {
      projectRoot = argument;
    } else {
      throw new TypeError(`Unexpected argument: ${argument}`);
    }
  }
  return { projectRoot: projectRoot ?? process.cwd(), options };
}

function parsePrepareArguments(arguments_) {
  const options = {};
  let projectRoot;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (["--compile-commands", "-c"].includes(argument)) {
      options.compileCommandsPath = optionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--work-dir") {
      options.workDirectory = optionValue(arguments_, index, argument);
      index += 1;
    } else if (["--output", "-o"].includes(argument)) {
      options.output = optionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--no-clang-uml") {
      options.runClangUml = false;
    } else if (["--help", "-h"].includes(argument)) {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (projectRoot === undefined) {
      projectRoot = argument;
    } else {
      throw new TypeError(`Unexpected argument: ${argument}`);
    }
  }
  return { projectRoot: projectRoot ?? process.cwd(), options };
}

function parseInspectArguments(arguments_) {
  let path;
  let json = false;
  let help = false;
  for (const argument of arguments_) {
    if (argument === "--json") json = true;
    else if (["--help", "-h"].includes(argument)) help = true;
    else if (argument.startsWith("-") && argument !== "-") {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (path === undefined) path = argument;
    else throw new TypeError(`Unexpected argument: ${argument}`);
  }
  return { path: path ?? "-", json, help };
}

async function readStandardInput(stdin) {
  let value = "";
  for await (const chunk of stdin) value += chunk;
  return value;
}

export async function runCli(arguments_, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  prepareCodeFactsImpl = prepareCodeFacts
} = {}) {
  const [command, ...rest] = arguments_;
  if (command === undefined || ["--help", "-h", "help"].includes(command)) {
    stdout.write(HELP);
    return 0;
  }

  try {
    if (command === "prepare") {
      const { projectRoot, options } = parsePrepareArguments(rest);
      if (options.help) {
        stdout.write(HELP);
        return 0;
      }
      const prepared = await prepareCodeFactsImpl(projectRoot, options);
      if (options.dryRun) {
        stdout.write(`${JSON.stringify(prepared.plan, null, 2)}\n`);
        return 0;
      }
      const output = serializeCodeFacts(prepared.facts);
      if (options.output === undefined || options.output === "-") stdout.write(output);
      else await writeFile(resolve(options.output), output, { encoding: "utf8", mode: 0o600 });
      stderr.write(`Prepared evidence manifest: ${prepared.manifestPath}\n`);
      return prepared.facts.diagnostics.some((item) => item.severity === "error") ? 2 : 0;
    }

    if (command === "extract") {
      const { projectRoot, options } = parseExtractArguments(rest);
      if (options.help) {
        stdout.write(HELP);
        return 0;
      }
      const facts = await extractCodeFacts(projectRoot, options);
      const output = serializeCodeFacts(facts, { pretty: options.pretty !== false });
      if (options.output === undefined || options.output === "-") stdout.write(output);
      else await writeFile(resolve(options.output), output, "utf8");
      return facts.diagnostics.some((item) => item.severity === "error") ? 2 : 0;
    }

    if (command === "inspect") {
      const options = parseInspectArguments(rest);
      if (options.help) {
        stdout.write(HELP);
        return 0;
      }
      const input = options.path === "-"
        ? await readStandardInput(stdin)
        : await readFile(resolve(options.path), "utf8");
      const summary = inspectCodeFacts(input);
      stdout.write(options.json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `${formatCodeFactsInspection(summary)}\n`);
      return 0;
    }

    throw new TypeError(`Unknown command: ${command}`);
  } catch (error) {
    stderr.write(`code-facts: ${error.message}\n`);
    return 1;
  }
}

export { HELP as CLI_HELP };
