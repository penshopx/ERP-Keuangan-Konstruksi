import { defaultDatabaseSuiteStatementTimeoutMs } from "./database-suite-lock";

type DatabaseSuiteEnvironment = Record<string, string | undefined>;

export type SharedDatabaseSuiteConfig = {
  suiteName: string;
  statementTimeoutMs: number;
};

function createSharedDatabaseSuiteConfig(
  suiteName: string,
  timeoutEnvironmentName: string,
  environment: DatabaseSuiteEnvironment,
): SharedDatabaseSuiteConfig {
  return {
    suiteName,
    statementTimeoutMs: Number(
      environment[timeoutEnvironmentName] ?? defaultDatabaseSuiteStatementTimeoutMs,
    ),
  };
}

export function getPersistenceDatabaseSuiteConfig(
  environment: DatabaseSuiteEnvironment = process.env,
) {
  return createSharedDatabaseSuiteConfig(
    "Persistence integration suite",
    "PERSISTENCE_TEST_STATEMENT_TIMEOUT_MS",
    environment,
  );
}

export function getAccessDatabaseSuiteConfig(
  environment: DatabaseSuiteEnvironment = process.env,
) {
  return createSharedDatabaseSuiteConfig(
    "Access integration suite",
    "ACCESS_TEST_STATEMENT_TIMEOUT_MS",
    environment,
  );
}

export function getDemoSeedingDatabaseSuiteConfig(
  environment: DatabaseSuiteEnvironment = process.env,
) {
  return createSharedDatabaseSuiteConfig(
    "Demo seeding suite",
    "DEMO_SEEDING_TEST_STATEMENT_TIMEOUT_MS",
    environment,
  );
}