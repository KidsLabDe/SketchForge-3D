import { describe, expect, it } from "vitest";
import { cadModifierPrimitiveForAnalyticHalfSphere, cadTransformToMatrix } from "@/lib/cadBakeMetadata";
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
