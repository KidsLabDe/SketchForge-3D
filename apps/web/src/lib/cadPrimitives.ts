import type { OcctKernel, ShapeHandle } from "occt-wasm";

const ORIGIN = { x: 0, y: 0, z: 0 };
const Y_AXIS = { point: ORIGIN, direction: { x: 0, y: 1, z: 0 } };

/**
 * Exact half sphere (or rotational half ellipsoid) standing on the XZ plane
 * with its flat face at y = 0 and its pole at y = height. Built by revolving a
 * quarter circle/ellipse profile around Y, so it has one planar base face and
 * one surface of revolution instead of thousands of facets.
 */
export function makeHalfSphereSolid(cad: OcctKernel, radius: number, height: number): ShapeHandle {
  if (![radius, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("The half sphere has invalid dimensions");
  }
  const temporary: ShapeHandle[] = [];
  try {
    let arc: ShapeHandle;
    let baseX = radius;
    if (Math.abs(radius - height) <= 1e-9 * Math.max(radius, height)) {
      arc = cad.makeArcEdge({ x: radius, y: 0, z: 0 }, { x: radius * Math.SQRT1_2, y: height * Math.SQRT1_2, z: 0 }, { x: 0, y: height, z: 0 });
    } else if (radius > height) {
      arc = cad.makeEllipseArc(ORIGIN, { x: 0, y: 0, z: 1 }, radius, height, 0, Math.PI / 2);
    } else {
      // OpenCascade puts the major axis on local X, so build the tall ellipse
      // lying down from (height, 0) to (0, radius) and turn it upright. A +90°
      // turn about Z maps it onto (0, height) .. (-radius, 0).
      const lying = cad.makeEllipseArc(ORIGIN, { x: 0, y: 0, z: 1 }, height, radius, 0, Math.PI / 2);
      temporary.push(lying);
      arc = cad.rotate(lying, { point: ORIGIN, direction: { x: 0, y: 0, z: 1 } }, Math.PI / 2);
      baseX = -radius;
    }
    temporary.push(arc);
    const axisEdge = cad.makeLineEdge({ x: 0, y: height, z: 0 }, ORIGIN);
    const baseEdge = cad.makeLineEdge(ORIGIN, { x: baseX, y: 0, z: 0 });
    temporary.push(axisEdge, baseEdge);
    const wire = cad.makeWire([arc, axisEdge, baseEdge]);
    temporary.push(wire);
    const face = cad.makeFace(wire);
    temporary.push(face);
    const revolved = cad.revolve(face, Y_AXIS, Math.PI * 2);
    temporary.push(revolved);
    // Heal tolerances before the solid enters offsets and booleans.
    return cad.fixShape(revolved);
  } finally {
    releaseQuietly(cad, temporary);
  }
}

function releaseQuietly(cad: OcctKernel, handles: ShapeHandle[]) {
  handles.forEach((handle) => {
    try {
      cad.release(handle);
    } catch {
      // Temporary construction handles may already be consumed.
    }
  });
}

/** Full ellipse (or circle) with x radius `radius` and y radius `height` in the XY plane. */
function ellipseWire(cad: OcctKernel, radius: number, height: number, temporary: ShapeHandle[]) {
  const z = { x: 0, y: 0, z: 1 };
  let edge: ShapeHandle;
  if (Math.abs(radius - height) <= 1e-9 * Math.max(radius, height)) {
    edge = cad.makeCircleEdge(ORIGIN, z, radius);
  } else if (radius > height) {
    edge = cad.makeEllipseEdge(ORIGIN, z, radius, height);
  } else {
    // Turn the lying ellipse upright with a baked (general) transform. A plain
    // rotation only adds a location, and the later 2D boolean of the offset
    // cavity then came back empty.
    const lying = cad.makeEllipseEdge(ORIGIN, z, height, radius);
    temporary.push(lying);
    edge = cad.generalTransform(lying, [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
  }
  temporary.push(edge);
  const wire = cad.makeWire([edge]);
  temporary.push(wire);
  return wire;
}

function rectangleFace(cad: OcctKernel, minX: number, minY: number, maxX: number, maxY: number, temporary: ShapeHandle[]) {
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].map(([x, y]) => ({ x, y, z: 0 }));
  const edges = corners.map((corner, index) => cad.makeLineEdge(corner, corners[(index + 1) % corners.length]));
  temporary.push(...edges);
  const wire = cad.makeWire(edges);
  temporary.push(wire);
  const face = cad.makeFace(wire);
  temporary.push(face);
  return face;
}

/**
 * Hollow half sphere built from its 2D profile: the outer ellipse is offset
 * inward in its plane, the cavity is subtracted from the quarter profile, and
 * the result is revolved. This avoids 3D offsets and 3D booleans on the curved
 * surface, which OpenCascade handles unreliably for flat (elliptical) domes:
 * results that silently keep the full body, or a corrupted WebAssembly heap.
 * "bottom" opens the flat base; "closed" keeps a base of the wall thickness.
 */
export function makeHollowHalfSphereSolid(cad: OcctKernel, radius: number, height: number, thickness: number, opening: "bottom" | "closed"): ShapeHandle {
  if (![radius, height, thickness].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("The half sphere has invalid dimensions");
  }
  const temporary: ShapeHandle[] = [];
  try {
    const outer = cad.makeFace(ellipseWire(cad, radius, height, temporary));
    temporary.push(outer);
    const outerArea = cad.getSurfaceArea(outer);
    // The offset side depends on the wire orientation, which the rotation used
    // for tall ellipses flips. Pick the side that actually shrinks the profile.
    let inner: ShapeHandle | null = null;
    for (const offset of [-thickness, thickness]) {
      try {
        const innerWire = cad.offsetWire2D(ellipseWire(cad, radius, height, temporary), offset);
        temporary.push(innerWire);
        const candidate = cad.makeFace(innerWire);
        temporary.push(candidate);
        if (cad.getSurfaceArea(candidate) < outerArea) {
          inner = candidate;
          break;
        }
      } catch {
        // An inward offset larger than the profile can fail; try the other side.
      }
    }
    if (!inner) throw new Error("This wall thickness leaves no cavity. Use a thinner wall.");
    const margin = Math.max(radius, height) + thickness + 1;
    const quadrant = cad.intersect(outer, rectangleFace(cad, 0, 0, margin, margin, temporary));
    temporary.push(quadrant);
    const cavity = cad.intersect(inner, rectangleFace(cad, 0, opening === "closed" ? thickness : -margin, margin, margin, temporary));
    temporary.push(cavity);
    const profile = cad.cut(quadrant, cavity);
    temporary.push(profile);
    const faces = cad.getSubShapes(profile, "face");
    temporary.push(...faces);
    if (faces.length !== 1) throw new Error("This wall thickness leaves no cavity. Use a thinner wall.");
    const full = (2 / 3) * Math.PI * radius * radius * height;
    const revolved = cad.revolve(faces[0], Y_AXIS, Math.PI * 2);
    temporary.push(revolved);
    const solid = cad.fixShape(revolved);
    if (!(cad.getVolume(solid) < full * (1 - 1e-6))) {
      releaseQuietly(cad, [solid]);
      throw new Error("This wall thickness leaves no cavity. Use a thinner wall.");
    }
    return solid;
  } finally {
    releaseQuietly(cad, temporary);
  }
}
