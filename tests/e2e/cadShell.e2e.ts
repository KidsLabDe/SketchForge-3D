import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OcctKernel } from "occt-wasm";
import { maxShellThickness, shellCadSolid, shellOpenFaces } from "@/lib/cadShell";

let cad: OcctKernel;

beforeAll(async () => {
  const wasm = join(dirname(fileURLToPath(import.meta.resolve("occt-wasm"))), "occt-wasm.wasm");
  cad = await OcctKernel.init({ wasm });
});

function expectSameBounds(actual: ReturnType<OcctKernel["getBoundingBox"]>, expected: ReturnType<OcctKernel["getBoundingBox"]>) {
  (["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"] as const).forEach((key) => {
    expect(actual[key]).toBeCloseTo(expected[key], 4);
  });
}

describe("shellCadSolid", () => {
  it("opens the top face of a box with a constant inward wall", () => {
    const box = cad.makeBox(20, 10, 30);
    const shelled = shellCadSolid(cad, box, 2, "top");
    expect(cad.isValid(shelled)).toBe(true);
    expectSameBounds(cad.getBoundingBox(shelled, false), cad.getBoundingBox(box, false));
    // Outer 20x10x30 minus an open-top cavity of 16x8x26.
    expect(cad.getVolume(shelled)).toBeCloseTo(6000 - 16 * 8 * 26, 3);
  });

  it("opens the bottom face of a box", () => {
    const box = cad.makeBox(20, 10, 30);
    const shelled = shellCadSolid(cad, box, 1.5, "bottom");
    expect(cad.isValid(shelled)).toBe(true);
    expect(cad.getVolume(shelled)).toBeCloseTo(6000 - 17 * 8.5 * 27, 3);
    expectSameBounds(cad.getBoundingBox(shelled, false), cad.getBoundingBox(box, false));
  });

  it("keeps a closed outer skin around an enclosed cavity", () => {
    const box = cad.makeBox(20, 10, 30);
    const shelled = shellCadSolid(cad, box, 2, "closed");
    expect(cad.isValid(shelled)).toBe(true);
    expect(cad.getVolume(shelled)).toBeCloseTo(6000 - 16 * 6 * 26, 3);
    expectSameBounds(cad.getBoundingBox(shelled, false), cad.getBoundingBox(box, false));
  });

  it("hollows a cylinder through its top cap", () => {
    // makeCylinder is Z-up; rotate so the axis matches SketchForge's Y-up scene.
    const cylinder = cad.rotate(cad.makeCylinder(10, 20), { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2);
    const shelled = shellCadSolid(cad, cylinder, 2, "top");
    expect(cad.isValid(shelled)).toBe(true);
    expect(cad.getVolume(shelled)).toBeCloseTo(Math.PI * (100 * 20 - 64 * 18), 0);
  });

  it("closes a sphere around a spherical cavity", () => {
    const sphere = cad.makeSphere(10);
    const shelled = shellCadSolid(cad, sphere, 2, "closed");
    expect(cad.isValid(shelled)).toBe(true);
    expect(cad.getVolume(shelled)).toBeCloseTo((4 / 3) * Math.PI * (1000 - 512), 0);
  });

  it("rejects an opening on a side without a flat face", () => {
    const sphere = cad.makeSphere(10);
    expect(shellOpenFaces(cad, sphere, "top")).toHaveLength(0);
    expect(() => shellCadSolid(cad, sphere, 2, "top")).toThrow(/no flat top face/);
  });
});

describe("maxShellThickness", () => {
  it("limits walls by the smallest horizontal half-size and the open height", () => {
    expect(maxShellThickness(20, 30, 50, "top")).toBe(10);
    expect(maxShellThickness(20, 30, 5, "top")).toBe(5);
    expect(maxShellThickness(20, 30, 5, "closed")).toBe(2.5);
  });
});
