type JsonObject = Record<string, unknown>;

function objectOrEmpty(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function removeGatewayAddedMigrationMarkers(
  meta: JsonObject,
  expectedMeta: JsonObject,
): void {
  const value = meta.migrations;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const migrations = value as JsonObject;
  const expectedMigrations = objectOrEmpty(expectedMeta.migrations);
  for (const marker of ["modelPolicyAllowlist", "utilityModelSeparation"]) {
    if (!Object.hasOwn(expectedMigrations, marker) && migrations[marker] === true)
      delete migrations[marker];
  }
  if (!Object.hasOwn(expectedMeta, "migrations") && Object.keys(migrations).length === 0)
    delete meta.migrations;
}
