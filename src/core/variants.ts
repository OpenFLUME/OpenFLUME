/**
 * variants.ts — resolve and record simulation variants.
 *
 * A variant is a sparse patch over the network in the file (the implicit
 * "Base"). Two pure functions, exact inverses of each other over the shapes
 * the editor can produce:
 *
 *   applyVariant(base, spec)      base + patch → the network you edit/solve
 *   diffVariant(base, resolved)   the patch that turns base into resolved
 *
 * Round-trip contract, property-tested:
 *
 *   applyVariant(base, { patch: diffVariant(base, X) }) deep-equals X
 *
 * Robustness contract: a patch that names an element the base no longer has
 * is SKIPPED, never thrown. Base edits and variant patches are authored
 * independently, so dangling references are an ordinary occurrence — the
 * caller can report them (`resolveVariant` returns them) but the model must
 * still open.
 */
import type { NetworkConfig, VariantSpec } from "./schema";

type Patch = NonNullable<VariantSpec["patch"]>;
type EntityKey = "nodes" | "branches" | "solidNodes" | "conductors";

const ENTITY_KEYS: EntityKey[] = [
  "nodes",
  "branches",
  "solidNodes",
  "conductors",
];

type Entity = { id: string } & Record<string, unknown>;

function entityList(config: NetworkConfig, key: EntityKey): Entity[] {
  const list = config[key];
  return Array.isArray(list) ? (list as unknown as Entity[]) : [];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Deep structural equality over JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/**
 * Field-level diff of two objects sharing an id.
 *
 * Nested values are compared but recorded WHOLE: a variant that changes a
 * pipe's diameter records `{ diameter }`, and one that swaps the component
 * type records the whole `component`. Sub-object merging would make a patch
 * unable to express "this key was deleted".
 */
function diffFields(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "id") continue;
    const b = base[key];
    const n = next[key];
    if (deepEqual(b, n)) continue;
    // An absent key is recorded as an explicit undefined so applyVariant can
    // delete it again (JSON drops it; the decoder restores absence).
    patch[key] = n === undefined ? undefined : clone(n);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Apply a field patch to a base entity, deleting explicit-undefined keys. */
function applyFields(base: Entity, patch: Record<string, unknown>): Entity {
  const out: Record<string, unknown> = { ...clone(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = clone(value);
  }
  return out as Entity;
}

export interface VariantResolution {
  config: NetworkConfig;
  /** Patch targets that no longer exist in the base, in patch order. */
  danglingIds: string[];
}

/**
 * The network a variant describes. Always succeeds; `variants` is stripped
 * from the output so a resolved config is an ordinary solvable model.
 */
export function resolveVariant(
  base: NetworkConfig,
  spec: VariantSpec | null | undefined,
): VariantResolution {
  const out = clone(base) as NetworkConfig;
  delete out.variants;
  const patch = spec?.patch;
  if (!patch) return { config: out, danglingIds: [] };

  const dangling: string[] = [];

  // 1. Removals. A removed node takes its incident branches and conductors
  //    with it, exactly as removeNode does in the editor — a variant must
  //    never resolve to a network with dangling endpoints.
  if (patch.removed && patch.removed.length > 0) {
    const removed = new Set(patch.removed);
    const presentIds = new Set(
      ENTITY_KEYS.flatMap((key) => entityList(out, key).map((e) => e.id)),
    );
    for (const id of patch.removed) if (!presentIds.has(id)) dangling.push(id);

    out.nodes = out.nodes.filter((n) => !removed.has(n.id));
    if (out.solidNodes)
      out.solidNodes = out.solidNodes.filter((n) => !removed.has(n.id));
    const survivingNodeIds = new Set([
      ...out.nodes.map((n) => n.id),
      ...(out.solidNodes ?? []).map((n) => n.id),
    ]);
    out.branches = out.branches.filter(
      (b) =>
        !removed.has(b.id) &&
        survivingNodeIds.has(b.from) &&
        survivingNodeIds.has(b.to),
    );
    if (out.conductors)
      out.conductors = out.conductors.filter(
        (c) =>
          !removed.has(c.id) &&
          survivingNodeIds.has(c.from) &&
          survivingNodeIds.has(c.to),
      );
  }

  // 2. Singleton overrides.
  if (patch.settings)
    out.settings = { ...out.settings, ...clone(patch.settings) };
  if (patch.fluid) out.fluid = clone(patch.fluid);

  // 3. Per-entity field overrides.
  for (const key of ENTITY_KEYS) {
    const overrides = patch[key];
    if (!overrides) continue;
    const list = entityList(out, key);
    for (const [id, fields] of Object.entries(overrides)) {
      const index = list.findIndex((e) => e.id === id);
      if (index === -1) {
        dangling.push(id);
        continue;
      }
      list[index] = applyFields(list[index], fields);
    }
    if (list.length > 0 || out[key] !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = list;
    }
  }

  // 4. Additions, appended in patch order.
  if (patch.added) {
    for (const key of ENTITY_KEYS) {
      const additions = patch.added[key];
      if (!additions || additions.length === 0) continue;
      const list = entityList(out, key);
      const present = new Set(list.map((e) => e.id));
      for (const entity of additions as unknown as Entity[]) {
        if (present.has(entity.id)) continue;
        list.push(clone(entity));
      }
      (out as unknown as Record<string, unknown>)[key] = list;
    }
  }

  return { config: out, danglingIds: dangling };
}

/** Convenience wrapper when the caller does not care about dangling ids. */
export function applyVariant(
  base: NetworkConfig,
  spec: VariantSpec | null | undefined,
): NetworkConfig {
  return resolveVariant(base, spec).config;
}

/**
 * The patch that turns `base` into `resolved` — the inverse of applyVariant.
 * Returns undefined when the two describe the same network, so an unmodified
 * variant carries no patch at all.
 */
export function diffVariant(
  base: NetworkConfig,
  resolved: NetworkConfig,
): Patch | undefined {
  const patch: Patch = {};

  const settings = diffFields(
    base.settings as unknown as Record<string, unknown>,
    resolved.settings as unknown as Record<string, unknown>,
  );
  if (settings) patch.settings = settings as Patch["settings"];
  if (!deepEqual(base.fluid, resolved.fluid))
    patch.fluid = clone(resolved.fluid);

  const removed: string[] = [];
  const added: NonNullable<Patch["added"]> = {};

  for (const key of ENTITY_KEYS) {
    const baseList = entityList(base, key);
    const nextList = entityList(resolved, key);
    const nextById = new Map(nextList.map((e) => [e.id, e]));
    const baseIds = new Set(baseList.map((e) => e.id));

    for (const baseEntity of baseList) {
      const next = nextById.get(baseEntity.id);
      if (!next) {
        removed.push(baseEntity.id);
        continue;
      }
      const fields = diffFields(baseEntity, next);
      if (fields) {
        const bucket = patch[key] ?? {};
        bucket[baseEntity.id] = fields;
        patch[key] = bucket;
      }
    }

    const newEntities = nextList.filter((e) => !baseIds.has(e.id));
    if (newEntities.length > 0) {
      (added as Record<string, unknown>)[key] = clone(newEntities);
    }
  }

  if (removed.length > 0) patch.removed = removed;
  if (Object.keys(added).length > 0) patch.added = added;

  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** How many distinct things a variant changes — the outline's "3 changes". */
export function countVariantChanges(spec: VariantSpec): number {
  const patch = spec.patch;
  if (!patch) return 0;
  let n = 0;
  if (patch.settings) n += Object.keys(patch.settings).length;
  if (patch.fluid) n += 1;
  for (const key of ENTITY_KEYS) n += Object.keys(patch[key] ?? {}).length;
  if (patch.added)
    for (const key of ENTITY_KEYS) n += patch.added[key]?.length ?? 0;
  n += patch.removed?.length ?? 0;
  return n;
}

/** One line per change, for the variant hover card. */
export function describeVariantChanges(spec: VariantSpec): string[] {
  const patch = spec.patch;
  if (!patch) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(patch.settings ?? {}))
    lines.push(`settings.${key} = ${JSON.stringify(value)}`);
  if (patch.fluid) lines.push("default fluid replaced");
  for (const key of ENTITY_KEYS) {
    for (const [id, fields] of Object.entries(patch[key] ?? {})) {
      lines.push(`${id}: ${Object.keys(fields).join(", ")}`);
    }
  }
  if (patch.added)
    for (const key of ENTITY_KEYS)
      for (const entity of patch.added[key] ?? [])
        lines.push(`added ${entity.id}`);
  for (const id of patch.removed ?? []) lines.push(`removed ${id}`);
  return lines;
}
