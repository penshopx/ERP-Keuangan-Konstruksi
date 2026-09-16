export function shouldSeedDemoData(
  env: {
    NODE_ENV?: string;
    SEED_DEMO_DATA?: string;
  },
): boolean {
  return env.NODE_ENV === "development" && env.SEED_DEMO_DATA === "true";
}