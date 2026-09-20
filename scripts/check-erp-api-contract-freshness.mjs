import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "erp-api-contract-"));
const apiClientPath = join(temporaryRoot, "lib/api-client-react");
const erpPath = join(temporaryRoot, "artifacts/construction-erp");
const contractName = "TypecheckContractFreshnessProbe";

async function copy(relativePath) {
  await cp(join(workspaceRoot, relativePath), join(temporaryRoot, relativePath), {
    recursive: true,
  });
}

async function linkNodeModules(relativePath = "") {
  const target = join(workspaceRoot, relativePath, "node_modules");
  const destination = join(temporaryRoot, relativePath, "node_modules");
  await symlink(target, destination, "dir");
}

try {
  const erpPackage = JSON.parse(
    await readFile(
      join(workspaceRoot, "artifacts/construction-erp/package.json"),
      "utf8",
    ),
  );

  if (
    erpPackage.scripts?.pretypecheck !==
    "pnpm --filter @workspace/api-client-react run build"
  ) {
    throw new Error(
      "ERP pretypecheck must build @workspace/api-client-react before running TypeScript.",
    );
  }

  await Promise.all([
    copy("pnpm-workspace.yaml"),
    copy("tsconfig.base.json"),
    copy("lib/api-client-react"),
    mkdir(join(erpPath, "src"), { recursive: true }),
  ]);

  await Promise.all([
    linkNodeModules(),
    writeFile(
      join(temporaryRoot, "package.json"),
      JSON.stringify({ name: "contract-freshness-check", private: true }),
    ),
    writeFile(
      join(erpPath, "package.json"),
      JSON.stringify({
        name: "@workspace/construction-erp",
        private: true,
        type: "module",
        scripts: {
          pretypecheck: erpPackage.scripts.pretypecheck,
          typecheck: erpPackage.scripts.typecheck,
        },
        devDependencies: {
          "@workspace/api-client-react": "workspace:*",
        },
      }),
    ),
    writeFile(
      join(erpPath, "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.base.json",
        include: ["src/**/*"],
        compilerOptions: {
          noEmit: true,
          moduleResolution: "bundler",
        },
        references: [{ path: "../../lib/api-client-react" }],
      }),
    ),
  ]);

  await mkdir(join(erpPath, "node_modules/@workspace"), { recursive: true });
  await symlink(
    apiClientPath,
    join(erpPath, "node_modules/@workspace/api-client-react"),
    "dir",
  );

  const apiIndexPath = join(apiClientPath, "src/index.ts");
  const originalApiIndex = await readFile(apiIndexPath, "utf8");
  await writeFile(
    apiIndexPath,
    `${originalApiIndex}\nexport interface ${contractName} { fresh: true }\n`,
  );
  await writeFile(
    join(erpPath, "src/contract-probe.ts"),
    [
      `import type { ${contractName} } from "@workspace/api-client-react";`,
      `const contract: ${contractName} = { fresh: true };`,
      "void contract;",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    "pnpm",
    ["--filter", "@workspace/construction-erp", "run", "typecheck"],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error("ERP typecheck failed the fresh API contract probe.");
  }

  const declaration = await readFile(
    join(apiClientPath, "dist/index.d.ts"),
    "utf8",
  );
  if (!declaration.includes(contractName)) {
    throw new Error(
      "ERP typecheck passed without refreshing the API client declaration.",
    );
  }

  process.stdout.write(
    "ERP typecheck rebuilds API client declarations before checking the frontend.\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}