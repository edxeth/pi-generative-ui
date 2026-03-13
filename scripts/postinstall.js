import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(process.cwd());
const linuxSourcePath = path.join(rootDir, ".pi/extensions/generative-ui/native/linux/src/main.cc");
const linuxBinDir = path.join(rootDir, ".pi/extensions/generative-ui/native/linux/bin");
const linuxHelperPath = path.join(linuxBinDir, "pi-generative-ui-linux-helper");

const linuxToolchains = [
  {
    name: "gtk4 + webkitgtk-6.0",
    pkgConfigPackages: ["gtk4", "webkitgtk-6.0"],
    libraries: ["libgtk-4.so.1", "libwebkitgtk-6.0.so.4"],
    apt: "sudo apt install -y build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev",
  },
  {
    name: "gtk+-3.0 + webkit2gtk-4.1",
    pkgConfigPackages: ["gtk+-3.0", "webkit2gtk-4.1"],
    libraries: ["libgtk-3.so.0", "libwebkit2gtk-4.1.so.0"],
    apt: "sudo apt install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev",
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function fail(message, extra = "") {
  const suffix = extra ? `\n\n${extra.trim()}` : "";
  throw new Error(`pi-generative-ui Linux helper build failed.\n\n${message.trim()}${suffix}`);
}

function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME) || fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
}

function detectCompiler() {
  return ["c++", "g++", "clang++"].find((candidate) => {
    const result = run("bash", ["-lc", `command -v ${candidate}`]);
    return result.status === 0;
  });
}

function detectRuntimeToolchain() {
  const result = run("ldconfig", ["-p"]);
  const index = `${result.stdout}\n${result.stderr}`;
  return linuxToolchains.find((toolchain) => toolchain.libraries.every((library) => index.includes(library))) ?? null;
}

function ensureLinuxHelper() {
  const compiler = detectCompiler();
  if (!compiler) {
    fail(
      "No C++ compiler was found in PATH.",
      "Install the Ubuntu build toolchain with: sudo apt install -y build-essential pkg-config",
    );
  }

  fs.mkdirSync(linuxBinDir, { recursive: true });
  const compile = run(compiler, [
    "-std=c++20",
    "-O2",
    "-Wall",
    "-Wextra",
    linuxSourcePath,
    "-ldl",
    "-pthread",
    "-o",
    linuxHelperPath,
  ]);

  if (compile.status !== 0) {
    fail(
      "Compilation failed while building the Linux helper.",
      [compile.stdout, compile.stderr].filter(Boolean).join("\n"),
    );
  }

  fs.chmodSync(linuxHelperPath, 0o755);

  const runtimeProbe = run(linuxHelperPath, ["--self-test"]);
  if (runtimeProbe.status !== 0) {
    fail(
      [
        "The compiled Linux helper could not load a supported GTK/WebKitGTK runtime pair.",
        "Attempted pkg-config package pairs:",
        ...linuxToolchains.map((toolchain) => `  - ${toolchain.pkgConfigPackages.join(", ")}`),
      ].join("\n"),
      [
        "Install one of the supported Ubuntu 24 / WSL2 dependency sets:",
        ...linuxToolchains.map((toolchain) => `  - ${toolchain.apt}`),
        isWSL() ? "WSL2 runtime note: WSLg is required to open native widget windows at runtime." : "Linux runtime note: a GUI-capable session is required to open native widget windows at runtime.",
        runtimeProbe.stdout.trim(),
        runtimeProbe.stderr.trim(),
      ].filter(Boolean).join("\n"),
    );
  }

  const detected = detectRuntimeToolchain();
  fs.writeFileSync(
    path.join(linuxBinDir, "build-info.json"),
    `${JSON.stringify(
      {
        backend: "linux-webview",
        helper: path.relative(rootDir, linuxHelperPath),
        toolchain: detected?.name ?? "runtime-detected-at-launch",
        pkgConfigPackages: detected?.pkgConfigPackages ?? null,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(`Built Linux helper: ${path.relative(rootDir, linuxHelperPath)}\n`);
  process.stdout.write(runtimeProbe.stdout);
}

if (process.platform === "linux") {
  ensureLinuxHelper();
}
