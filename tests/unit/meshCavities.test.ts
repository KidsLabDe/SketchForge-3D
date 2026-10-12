import { describe, expect, it } from "vitest";
import { mergeEnclosedCavityComponents } from "@/lib/meshCavities";

type Point = [number, number, number];
type Face = [number, number, number];

// Outward-wound unit cube faces (counter-clockwise seen from outside).
const CUBE_FACES: Face[] = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [2, 3, 7], [2, 7, 6],
  [1, 2, 6], [1, 6, 5],
  [0, 4, 7], [0, 7, 3],
];

function cube(vertices: Point[], faces: Face[], min: number, max: number, inward = false) {
  const offset = vertices.length;
  vertices.push(
    [min, min, min], [max, min, min], [max, max, min], [min, max, min],
    [min, min, max], [max, min, max], [max, max, max], [min, max, max],
  );
  const start = faces.length;
  CUBE_FACES.forEach(([a, b, c]) => faces.push(inward ? [offset + a, offset + c, offset + b] : [offset + a, offset + b, offset + c]));
  return Array.from({ length: CUBE_FACES.length }, (_, index) => start + index);
}

describe("mergeEnclosedCavityComponents", () => {
  it("attaches an inward-facing cavity skin to the body around it", () => {
    const vertices: Point[] = [];
    const faces: Face[] = [];
    const outer = cube(vertices, faces, 0, 10);
    const cavity = cube(vertices, faces, 2, 8, true);
    const merged = mergeEnclosedCavityComponents(vertices, faces, [outer, cavity]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sort((a, b) => a - b)).toEqual([...outer, ...cavity]);
  });

  it("keeps separate outward bodies as separate parts", () => {
    const vertices: Point[] = [];
    const faces: Face[] = [];
    const first = cube(vertices, faces, 0, 1);
    const second = cube(vertices, faces, 3, 4);
    expect(mergeEnclosedCavityComponents(vertices, faces, [first, second])).toHaveLength(2);
  });

  it("keeps an outward body nested inside another body's cavity as its own part", () => {
    const vertices: Point[] = [];
    const faces: Face[] = [];
    const outer = cube(vertices, faces, 0, 10);
    const cavity = cube(vertices, faces, 1, 9, true);
    const loose = cube(vertices, faces, 4, 6);
    const merged = mergeEnclosedCavityComponents(vertices, faces, [outer, cavity, loose]);
    expect(merged).toHaveLength(2);
  });
});
