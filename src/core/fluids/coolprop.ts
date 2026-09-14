import type { CoolPropModule } from "coolprop-wasm";

let coolpropInstance: CoolPropModule | null = null;
let initPromise: Promise<void> | null = null;

export async function initRealFluids(): Promise<void> {
  if (coolpropInstance) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const mod = await import("coolprop-wasm");
    coolpropInstance = await mod.default();
  })();
  return initPromise;
}

export function realFluidsReady(): boolean {
  return coolpropInstance !== null;
}

export function getCoolProp(): CoolPropModule {
  if (!coolpropInstance) {
    throw new Error(
      "Real fluids not initialized: call await initRealFluids() before solving with real fluids",
    );
  }
  return coolpropInstance;
}
