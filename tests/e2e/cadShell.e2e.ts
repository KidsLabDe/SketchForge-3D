import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OcctKernel } from "occt-wasm";
import { makeHalfSphereSolid, makeHollowHalfSphereSolid } from "@/lib/cadPrimitives";
import { availableShellOpenings, maxShellThickness, shellCadSolid, shellOpenFaces } from "@/lib/cadShell";

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
    expect(availableShellOpenings(cad, [sphere])).toEqual(["closed"]);
    expect(() => shellCadSolid(cad, sphere, 2, "top")).toThrow(/no flat top face/);
  });
});

// Same triangle layout as SketchForge's half-sphere mesh, sewn into a solid the
// way the CAD modifier worker reconstructs tessellated primitives. The editor
// transfers meshes as Float32Array; `float32` reproduces that rounding.
function facetedHalfSphere(steps: number, radius: number, height: number, float32 = false) {
  const lon = steps * 2;
  const lat = Math.round(steps / 2);
  const point = (latIndex: number, lonIndex: number) => {
    const theta = (latIndex / lat) * (Math.PI / 2);
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    const coordinates = [Math.cos(phi) * radius * Math.sin(theta), Math.cos(theta) * height, Math.sin(phi) * radius * Math.sin(theta)];
    return float32 ? Array.from(Float32Array.from(coordinates)) : coordinates;
  };
  const triangles: number[][][] = [];
  for (let x = 0; x < lon; x += 1) triangles.push([[0, height, 0], point(1, x + 1), point(1, x)]);
  for (let y = 1; y < lat; y += 1) {
    for (let x = 0; x < lon; x += 1) {
      const a = point(y, x);
      const b = point(y, x + 1);
      const c = point(y + 1, x + 1);
      const d = point(y + 1, x);
      triangles.push([a, c, d], [a, b, c]);
    }
  }
  for (let x = 0; x < lon; x += 1) triangles.push([[0, 0, 0], point(lat, x), point(lat, x + 1)]);
  const stl = [
    "solid halfsphere",
    ...triangles.map(([a, b, c]) => `facet normal 0 0 0\n outer loop\n  vertex ${a.join(" ")}\n  vertex ${b.join(" ")}\n  vertex ${c.join(" ")}\n endloop\nendfacet`),
    "endsolid halfsphere",
  ].join("\n");
  const faces = cad.getSubShapes(cad.importStl(stl), "face");
  let solid = cad.sewAndSolidify(faces, 1e-5);
  solid = cad.fixShape(solid);
  solid = cad.healSolid(solid, 1e-5);
  solid = cad.fixFaceOrientations(solid);
  return cad.unifySameDomain(solid);
}

describe("faceted half sphere in double precision", () => {
  it("only offers the flat bottom as an opening", () => {
    const halfSphere = facetedHalfSphere(16, 10, 11);
    expect(availableShellOpenings(cad, [halfSphere])).toEqual(["bottom", "closed"]);
  });

  it("hollows into a bowl through the flat bottom", () => {
    const halfSphere = facetedHalfSphere(16, 10, 11);
    const shelled = shellCadSolid(cad, halfSphere, 2, "bottom");
    expect(cad.isValid(shelled)).toBe(true);
    expect(cad.getVolume(shelled)).toBeLessThan(cad.getVolume(halfSphere) * 0.7);
    expectSameBounds(cad.getBoundingBox(shelled, false), cad.getBoundingBox(halfSphere, false));
  });

  it("closes the cavity even when the full inward offset fails", () => {
    const halfSphere = facetedHalfSphere(16, 10, 11);
    const open = shellCadSolid(cad, halfSphere, 2, "bottom");
    const closed = shellCadSolid(cad, halfSphere, 2, "closed");
    expect(cad.isValid(closed)).toBe(true);
    expect(cad.getSubShapes(closed, "solid")).toHaveLength(1);
    expectSameBounds(cad.getBoundingBox(closed, false), cad.getBoundingBox(halfSphere, false));
    // The closed result adds a 2 mm floor under the open bowl's cavity.
    expect(cad.getVolume(closed)).toBeGreaterThan(cad.getVolume(open));
    expect(cad.getVolume(closed)).toBeLessThan(cad.getVolume(halfSphere));
  });
});

describe("faceted half sphere as transferred by the editor", () => {
  it("reports a failed shell instead of returning the unchanged body", () => {
    // Float32 rounding leaves each quad's two triangles almost, but not exactly,
    // coplanar; OpenCascade then returns the input body without an error.
    const halfSphere = facetedHalfSphere(16, 10, 11, true);
    expect(() => shellCadSolid(cad, halfSphere, 2, "bottom")).toThrow(/could not hollow this body/);
  });
});

// Some OpenCascade operations corrupt the WebAssembly heap without throwing;
// the next boolean then traps. A plain box cut proves the kernel is intact.
function expectKernelIntact() {
  const cut = cad.cut(cad.makeBox(10, 10, 10), cad.makeBox(5, 5, 5));
  expect(cad.getVolume(cut)).toBeCloseTo(875, 6);
}

describe("exact half sphere", () => {
  it.each([
    [11, 11],
    [15, 8],
    [8, 15],
    [10, 2.5],
  ])("builds radius %s / height %s with a flat base", (radius, height) => {
    const halfSphere = makeHalfSphereSolid(cad, radius, height);
    expect(cad.isValid(halfSphere)).toBe(true);
    expect(cad.getVolume(halfSphere)).toBeCloseTo((2 / 3) * Math.PI * radius * radius * height, 3);
    const bounds = cad.getBoundingBox(halfSphere, false);
    expect(bounds.ymin).toBeCloseTo(0, 6);
    expect(bounds.ymax).toBeCloseTo(height, 6);
    expect(bounds.xmax).toBeCloseTo(radius, 6);
    expect(availableShellOpenings(cad, [halfSphere])).toEqual(["bottom", "closed"]);
  });

  it.each([
    [11, 11],
    [15, 8],
    [8, 15],
    [10, 2.5],
  ])("hollows radius %s / height %s from its profile without harming the kernel", (radius, height) => {
    const solid = makeHalfSphereSolid(cad, radius, height);
    const bounds = cad.getBoundingBox(solid, false);
    const bowl = makeHollowHalfSphereSolid(cad, radius, height, 1, "bottom");
    expectKernelIntact();
    const closed = makeHollowHalfSphereSolid(cad, radius, height, 1, "closed");
    expectKernelIntact();
    [bowl, closed].forEach((result) => {
      expect(cad.isValid(result)).toBe(true);
      expect(cad.getSubShapes(result, "solid")).toHaveLength(1);
      expectSameBounds(cad.getBoundingBox(result, false), bounds);
    });
    expect(cad.getVolume(bowl)).toBeLessThan(cad.getVolume(closed));
    expect(cad.getVolume(closed)).toBeLessThan(cad.getVolume(solid));
  });

  it("leaves a wall of exactly the requested thickness on a true half sphere", () => {
    expect(cad.getVolume(makeHollowHalfSphereSolid(cad, 11, 11, 1, "bottom"))).toBeCloseTo((2 / 3) * Math.PI * (11 ** 3 - 10 ** 3), 3);
    // Closed adds a 1 mm floor under the 10 mm cavity: a disc of radius 10 minus
    // the 1 mm slice of the inner hemisphere it replaces.
    const cavity = (2 / 3) * Math.PI * 1000 - Math.PI * (100 * 1 - 1 / 3);
    expect(cad.getVolume(makeHollowHalfSphereSolid(cad, 11, 11, 1, "closed"))).toBeCloseTo((2 / 3) * Math.PI * 1331 - cavity, 3);
  });

  it("rejects a wall that leaves no cavity", () => {
    expect(() => makeHollowHalfSphereSolid(cad, 20, 1.5, 1, "closed")).toThrow(/leaves no cavity/);
    expectKernelIntact();
  });
});

describe("box with filleted edges", () => {
  function filletedBox(verticalOnly: boolean) {
    const box = cad.makeBox(20, 10, 30);
    const edges = cad.getSubShapes(box, "edge").filter((edge) => {
      if (!verticalOnly) return true;
      const edgeBounds = cad.getBoundingBox(edge, false);
      return edgeBounds.ymax - edgeBounds.ymin > 5;
    });
    return cad.fillet(box, edges, 2);
  }

  it.each([[true], [false]])("hollows open and closed (vertical edges only: %s)", (verticalOnly) => {
    const box = filletedBox(verticalOnly);
    const bounds = cad.getBoundingBox(box, false);
    for (const opening of ["top", "closed"] as const) {
      const shelled = shellCadSolid(cad, box, 1.5, opening);
      expect(cad.isValid(shelled)).toBe(true);
      expect(cad.getVolume(shelled)).toBeLessThan(cad.getVolume(box) * 0.6);
      expectSameBounds(cad.getBoundingBox(shelled, false), bounds);
      expectKernelIntact();
    }
  });
});

describe("maxShellThickness", () => {
  it("limits walls by the smallest horizontal half-size and the open height", () => {
    expect(maxShellThickness(20, 30, 50, "top")).toBe(10);
    expect(maxShellThickness(20, 30, 5, "top")).toBe(5);
    expect(maxShellThickness(20, 30, 5, "closed")).toBe(2.5);
  });
});
