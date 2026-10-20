import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RUNNER_PATH = join(process.cwd(), "scripts/e2e/docker-package-install.sh");

type Manager = "bun" | "npm" | "pnpm";
type PackageIdentityOptions = {
  artifactVersion: string;
  nativeContract?: "required" | "not-applicable";
} & Partial<Record<`${Manager}${"Cli" | "Manifest"}`, string>>;

function runPackageIdentity(options: PackageIdentityOptions) {
  const root = tempDirs.make("openclaw-docker-package-identity-");
  const binDir = join(root, "bin");
  const packageDir = join(root, "package");
  const packageTgz = join(root, "candidate.tgz");
  const identityPath = join(root, "identity.json");
  mkdirSync(binDir);
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: options.artifactVersion }),
  );
  const pack = spawnSync("tar", ["-czf", packageTgz, "-C", root, "package"], {
    encoding: "utf8",
  });
  expect(pack.status, pack.stderr).toBe(0);

  const dockerPath = join(binDir, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${1:-}"
shift || true
case "$command" in
  image|run|rm|logs)
    exit 0
    ;;
  exec)
    container="\${1:?missing container}"
    shift
    command_line="$*"
    manager_value() {
      case "$container" in
        *-npm-proof-*) local name="FAKE_NPM_$1" ;;
        *-pnpm-proof-*) local name="FAKE_PNPM_$1" ;;
        *) exit 2 ;;
      esac
      printf '%s' "\${!name}"
    }
    case "$command_line" in
      'test -f /tmp/openclaw-proof-ready') ;;
      'cat /tmp/openclaw-package-root') printf "/fake/pnpm/openclaw" ;;
      'cat /tmp/openclaw-version') manager_value CLI ;;
      *'/tmp/openclaw-bun-proof.json'*)
        case "$command_line" in
          *installedPackageRoot*) printf "/fake/bun/openclaw" ;;
          *installedPackageVersion*) printf "%s" "$FAKE_BUN_MANIFEST" ;;
          *openclawVersion*) printf "%s" "$FAKE_BUN_CLI" ;;
          *openclawPath*) printf "/fake/bun/bin/openclaw" ;;
          *) exit 2 ;;
        esac ;;
      *package.json*) manager_value MANIFEST ;;
      *) exit 2 ;;
    esac
    ;;
  inspect)
    reference="\${!#}"
    printf '[{"Id":"sha256:fake","Image":"sha256:image","Name":"/%s","RepoDigests":[],"State":{"Status":"running"}}]\\n' "$reference"
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(dockerPath, 0o755);

  const result = spawnSync("/bin/bash", [RUNNER_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_BUN_CLI: options.bunCli ?? `OpenClaw ${options.artifactVersion}`,
      FAKE_BUN_MANIFEST: options.bunManifest ?? options.artifactVersion,
      FAKE_NPM_CLI: options.npmCli ?? `OpenClaw ${options.artifactVersion}`,
      FAKE_NPM_MANIFEST: options.npmManifest ?? options.artifactVersion,
      FAKE_PNPM_CLI: options.pnpmCli ?? `OpenClaw ${options.artifactVersion}`,
      FAKE_PNPM_MANIFEST: options.pnpmManifest ?? options.artifactVersion,
      OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
      OPENCLAW_FS_SAFE_NATIVE_CONTRACT: options.nativeContract ?? "required",
      OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH: identityPath,
      OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return {
    identity: result.status === 0 ? JSON.parse(readFileSync(identityPath, "utf8")) : undefined,
    result,
  };
}

describe.skipIf(process.platform === "win32")("Docker package identity report", () => {
  it.each(
    (["npm", "pnpm", "bun"] as const).flatMap((manager) => [
      {
        manager,
        field: "Manifest",
        value: "11.2.30",
        diagnostic: "installed manifest version '11.2.30' != artifact '1.2.3'",
      },
      {
        manager,
        field: "Cli",
        value: "OpenClaw 11.2.30 (wrong)",
        diagnostic: "CLI output parses to '11.2.30'",
      },
    ]),
  )(
    "rejects a stale $manager $field version even when it contains the artifact version",
    ({ manager, field, value, diagnostic }) => {
      const { result } = runPackageIdentity({
        artifactVersion: "1.2.3",
        [`${manager}${field}`]: value,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`[${manager}] ${diagnostic}`);
    },
  );

  it.each([
    { version: "2026.6.21-beta.1+build.7", nativeContract: "not-applicable" },
    { version: "1.2.3-beta-rc.1+build.7", nativeContract: "required" },
  ] as const)(
    "emits complete manager-owned identity for $version with the $nativeContract native contract",
    ({ version, nativeContract }) => {
      const { identity, result } = runPackageIdentity({ artifactVersion: version, nativeContract });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(identity).toMatchObject({ package: { version } });
      const container = (role: string, details: Record<string, string>) => {
        expect(identity.containers).toContainEqual(
          expect.objectContaining({ role, details: expect.objectContaining(details) }),
        );
      };
      container("musl", {
        fsSafeNative: nativeContract === "required" ? "passed" : "not-applicable",
      });
      for (const [role, installedPackageRoot] of [
        ["npm", "/usr/local/lib/node_modules/openclaw"],
        ["pnpm", "/fake/pnpm/openclaw"],
        ["bun", "/fake/bun/openclaw"],
      ] as const) {
        container(role, {
          installedPackageRoot,
          installedPackageVersion: version,
          parsedOpenclawVersion: version,
        });
      }
    },
  );
});
