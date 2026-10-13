import { describe, expect, it } from "vitest";
import { bakeCadMetadataForShapeTransform, cadModifierHalfSpherePrimitiveForShape, cadModifierPrimitiveForAnalyticHalfSphere, cadTransformToMatrix } from "@/lib/cadBakeMetadata";
import type { WorkplaneShape } from "@/types/sketchforge";
import * as THREE from "three";

function halfSphere(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "half-sphere",
    name: "Half Sphere",
    kind: "halfSphere",
    color: "#c9009a",
    x: 0,
    z: 0,
    elevation: 0,
    size: 22,
    width: 22,
    depth: 22,
    height: 11,
    rotation: 0,
    steps: 32,
    ...overrides,
  };
}

function transformPoint(transform: number[] | undefined, point: [number, number, number]) {
  return new THREE.Vector3(...point).applyMatrix4(cadTransformToMatrix(transform)).toArray().map((value) => Number(value.toFixed(6)) + 0);
}

describe("cadModifierPrimitiveForAnalyticHalfSphere", () => {
  it("describes an unrotated half sphere without a transform", () => {
    expect(cadModifierPrimitiveForAnalyticHalfSphere(halfSphere())).toEqual({ kind: "halfSphere", radius: 11, height: 11, transform: undefined });
  });

  it("keeps elliptical footprints, groups, and imported meshes on the mesh path", () => {
    expect(cadModifierPrimitiveForAnalyticHalfSphere(halfSphere({ depth: 18 }))).toBeNull();
    expect(cadModifierPrimitiveForAnalyticHalfSphere(halfSphere({ groupedShapes: [halfSphere({ id: "child" })] }))).toBeNull();
    expect(cadModifierPrimitiveForAnalyticHalfSphere(halfSphere({ kind: "sphere" }))).toBeNull();
  });

  it("places the base at the shape position and elevation", () => {
    const primitive = cadModifierPrimitiveForAnalyticHalfSphere(halfSphere({ x: 5, z: -3, elevation: 2 }));
    expect(transformPoint(primitive?.transform, [0, 0, 0])).toEqual([5, 2, -3]);
    expect(transformPoint(primitive?.transform, [0, 11, 0])).toEqual([5, 13, -3]);
  });

  it("turns a Y-mirrored half sphere upside down with a rigid transform", () => {
    const primitive = cadModifierPrimitiveForAnalyticHalfSphere(halfSphere({ mirrorY: true, mirrorX: true }));
    // Pole at the bottom, flat base at the top of the same bounding box.
    expect(transformPoint(primitive?.transform, [0, 11, 0])).toEqual([0, 0, 0]);
    expect(transformPoint(primitive?.transform, [0, 0, 0])).toEqual([0, 11, 0]);
    expect(cadTransformToMatrix(primitive?.transform).determinant()).toBeCloseTo(1, 9);
  });
});

describe("baked half sphere", () => {
  // What the editor stores after a rotation is baked into a mesh: the bounding
  // frame of the baked mesh plus the primitive metadata.
  function bakedHalfSphere(source: WorkplaneShape, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
    const metadata = bakeCadMetadataForShapeTransform(source, { centerX: source.x, minY: source.elevation ?? 0, centerZ: source.z, width: 22, depth: 22, height: 11, yawDegrees: 0 });
    return {
      ...source,
      kind: "mesh",
      rotation: 0,
      rotationX: 0,
      rotationZ: 0,
      importedMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], baseWidth: 22, baseDepth: 22, baseHeight: 11, triangleCount: 1, sourceFormat: "json" },
      cadPrimitiveFrame: metadata.cadPrimitiveFrame,
      ...overrides,
    };
  }

  it("records the half sphere when its rotation is baked", () => {
    const metadata = bakeCadMetadataForShapeTransform(halfSphere({ rotationX: 180 }), { centerX: 0, minY: 0, centerZ: 0, width: 22, depth: 22, height: 11, yawDegrees: 0 });
    expect(metadata.cadPrimitiveFrame?.kind).toBe("halfSphere");
    expect(metadata.cadPrimitiveFrame).toMatchObject({ width: 22, depth: 22, height: 11 });
  });

  it("recovers an upside-down half sphere with a rigid transform", () => {
    const primitive = cadModifierHalfSpherePrimitiveForShape(bakedHalfSphere(halfSphere({ rotationX: 180 })));
    expect(primitive).toMatchObject({ kind: "halfSphere", height: 11 });
    expect(primitive?.kind === "halfSphere" ? primitive.radius : 0).toBeCloseTo(11, 9);
    expect(transformPoint(primitive?.transform, [0, 0, 0])).toEqual([0, 11, 0]);
    expect(transformPoint(primitive?.transform, [0, 11, 0])).toEqual([0, 0, 0]);
    expect(cadTransformToMatrix(primitive?.transform).determinant()).toBeCloseTo(1, 9);
  });

  it("follows resizes along the dome's own axes", () => {
    const primitive = cadModifierHalfSpherePrimitiveForShape(bakedHalfSphere(halfSphere({ rotationX: 180 }), { width: 30, depth: 30, height: 6 }));
    expect(primitive?.kind === "halfSphere" ? primitive.radius : 0).toBeCloseTo(15, 9);
    expect(primitive?.kind === "halfSphere" ? primitive.height : 0).toBeCloseTo(6, 9);
    expect(transformPoint(primitive?.transform, [0, 0, 0])).toEqual([0, 6, 0]);
  });

  it("falls back to the mesh when the base is no longer circular or a CAD feature replaced the geometry", () => {
    expect(cadModifierHalfSpherePrimitiveForShape(bakedHalfSphere(halfSphere({ rotationX: 180 }), { depth: 16 }))).toBeNull();
    expect(cadModifierHalfSpherePrimitiveForShape(bakedHalfSphere(halfSphere({ rotationX: 180 }), { cadBrep: "BREP" }))).toBeNull();
  });
});
