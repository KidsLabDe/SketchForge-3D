import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { isCadModifierWasmMemoryFault } from "@/lib/cadModifierRuntime";
import type { ShellOpening } from "@/types/sketchforge";

const SHELL_TOLERANCE = 1e-3;
const OPEN_FACE_NORMAL_MIN = 0.999;
const OPEN_FACE_PLANE_TOLERANCE = 1e-4;

/** Largest wall thickness that still leaves a cavity inside a body with this bounding box. */
export function maxShellThickness(width: number, depth: number, height: number, opening: ShellOpening) {
  const horizontal = Math.min(width, depth) / 2;
  const vertical = opening === "closed" ? height / 2 : height;
  return Math.max(0, Math.min(horizontal, vertical));
}

/**
 * A WebAssembly trap (for example "memory access out of bounds") leaves the
 * kernel in an undefined state, unlike an OpenCascade exception. Never recover
 * from one locally: rethrow so the worker can reset the kernel.
 */
function rethrowKernelFault(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const name = error instanceof Error ? error.name : "";
  if (isCadModifierWasmMemoryFault(message, name)) throw error;
}

function releaseAll(cad: OcctKernel, handles: ShapeHandle[]) {
  handles.forEach((handle) => {
    try {
      cad.release(handle);
    } catch {
      // A failed topology operation can invalidate temporary handles.
    }
  });
}

// occt-wasm's surfaceNormal already accounts for the face orientation, so the
// result points out of the solid without an extra flip for reversed faces.
function faceOutwardNormalY(cad: OcctKernel, face: ShapeHandle, point: { x: number; y: number; z: number }) {
  const uv = cad.uvFromPoint(face, point);
  const normal = cad.surfaceNormal(face, uv.u, uv.v);
  return normal.y / (Math.hypot(normal.x, normal.y, normal.z) || 1);
}

/**
 * Returns handles to the planar faces of `solid` that lie on its top (+Y) or
 * bottom (-Y) bounding plane and face outward in that direction. SketchForge's
 * scene is Y-up, so these are the faces a user sees as "top" and "bottom".
 */
export function shellOpenFaces(cad: OcctKernel, solid: ShapeHandle, opening: Exclude<ShellOpening, "closed">) {
  const bounds = cad.getBoundingBox(solid, false);
  const planeY = opening === "top" ? bounds.ymax : bounds.ymin;
  const direction = opening === "top" ? 1 : -1;
  const tolerance = Math.max(OPEN_FACE_PLANE_TOLERANCE, (bounds.ymax - bounds.ymin) * 1e-6);
  const faces = cad.getSubShapes(solid, "face");
  const selected: ShapeHandle[] = [];
  faces.forEach((face) => {
    let keep = false;
    try {
      if (cad.surfaceType(face) === "plane") {
        const center = cad.getSurfaceCenterOfMass(face);
        if (Math.abs(center.y - planeY) <= tolerance) {
          keep = faceOutwardNormalY(cad, face, center) * direction >= OPEN_FACE_NORMAL_MIN;
        }
      }
    } catch (error) {
      rethrowKernelFault(error);
      keep = false;
    }
    if (keep) selected.push(face);
    else releaseAll(cad, [face]);
  });
  return selected;
}

function hasOpenFace(cad: OcctKernel, solid: ShapeHandle, opening: Exclude<ShellOpening, "closed">) {
  const faces = shellOpenFaces(cad, solid, opening);
  releaseAll(cad, faces);
  return faces.length > 0;
}

/** Openings every given solid supports. "closed" is always offered. */
export function availableShellOpenings(cad: OcctKernel, solids: ShapeHandle[]): ShellOpening[] {
  const open = (["top", "bottom"] as const).filter((opening) => solids.length > 0 && solids.every((solid) => hasOpenFace(cad, solid, opening)));
  return [...open, "closed"];
}

function singleSolid(cad: OcctKernel, shape: ShapeHandle) {
  const solids = cad.getSubShapes(shape, "solid");
  if (solids.length !== 1) {
    releaseAll(cad, solids);
    return shape;
  }
  cad.release(shape);
  return solids[0];
}

/**
 * Inward offsets come back as a solid, a compound, or sometimes only a closed
 * shell (for example on a box with filleted edges); booleans need a solid.
 */
function offsetAsSolid(cad: OcctKernel, shape: ShapeHandle, temporary: ShapeHandle[]) {
  const fixed = cad.fixShape(shape);
  temporary.push(fixed);
  if (cad.isSolid(fixed)) return fixed;
  const solids = cad.getSubShapes(fixed, "solid");
  temporary.push(...solids);
  if (solids.length === 1) return solids[0];
  const shells = cad.isShell(fixed) ? [fixed] : cad.getSubShapes(fixed, "shell");
  if (!cad.isShell(fixed)) temporary.push(...shells);
  if (solids.length === 0 && shells.length === 1) {
    const solid = cad.fixShape(cad.makeSolid(shells[0]));
    temporary.push(solid);
    return solid;
  }
  return fixed;
}

function isHollowResult(cad: OcctKernel, shape: ShapeHandle, sourceVolume: number) {
  try {
    if (!cad.isValid(shape)) return false;
    const volume = cad.getVolume(shape);
    return volume > 0 && volume < sourceVolume * (1 - 1e-6);
  } catch (error) {
    rethrowKernelFault(error);
    return false;
  }
}

function openShell(cad: OcctKernel, solid: ShapeHandle, thickness: number, opening: Exclude<ShellOpening, "closed">) {
  const faces = shellOpenFaces(cad, solid, opening);
  if (faces.length === 0) {
    throw new Error(`This body has no flat ${opening} face to open. Choose another opening or Closed.`);
  }
  let result: ShapeHandle;
  try {
    result = cad.shell(solid, faces, thickness, SHELL_TOLERANCE);
  } finally {
    releaseAll(cad, faces);
  }
  // OpenCascade can return the unchanged body instead of throwing, for example
  // on faceted curved meshes whose neighbouring facets are almost coplanar.
  if (!isHollowResult(cad, result, cad.getVolume(solid))) {
    releaseAll(cad, [result]);
    throw new Error("The CAD kernel could not hollow this body. Faceted curved shapes often fail; try a thinner wall or another opening.");
  }
  return result;
}

function closedByOffset(cad: OcctKernel, solid: ShapeHandle, thickness: number, sourceVolume: number) {
  const temporary: ShapeHandle[] = [];
  try {
    const rawInner = cad.offset(solid, -thickness, SHELL_TOLERANCE);
    temporary.push(rawInner);
    const inner = offsetAsSolid(cad, rawInner, temporary);
    const result = singleSolid(cad, cad.cut(solid, inner));
    if (!isHollowResult(cad, result, sourceVolume)) {
      releaseAll(cad, [result]);
      throw new Error("The inward offset produced invalid geometry");
    }
    return result;
  } finally {
    releaseAll(cad, temporary);
  }
}

// On planar and simple analytic faces MakeThickSolid either works or fails in a
// way isHollowResult detects. On free-form faces (for example the elliptical
// surface of revolution of a flat dome) it returned a valid-looking result but
// corrupted the WebAssembly heap, after which every later boolean trapped.
const THICK_SOLID_SAFE_SURFACES = new Set(["plane", "cylinder", "cone", "sphere"]);

function hasFreeFormFace(cad: OcctKernel, solid: ShapeHandle) {
  const faces = cad.getSubShapes(solid, "face");
  try {
    return faces.some((face) => !THICK_SOLID_SAFE_SURFACES.has(cad.surfaceType(face)));
  } finally {
    releaseAll(cad, faces);
  }
}

/**
 * Open shell without MakeThickSolid: hollow the body closed through an inward
 * offset, then punch through the wall on the opening side by extruding the
 * cavity's flat face out of the body. Everywhere except at that punched rim
 * the wall has exactly the requested thickness; the rim is never thinner.
 */
function openByOffsetPunch(cad: OcctKernel, solid: ShapeHandle, thickness: number, opening: Exclude<ShellOpening, "closed">, sourceVolume: number) {
  const temporary: ShapeHandle[] = [];
  try {
    const rawInner = cad.offset(solid, -thickness, SHELL_TOLERANCE);
    temporary.push(rawInner);
    const inner = offsetAsSolid(cad, rawInner, temporary);
    const cavityFaces = shellOpenFaces(cad, inner, opening);
    temporary.push(...cavityFaces);
    if (cavityFaces.length === 0) throw new Error("The inward offset has no flat face on the opening side");
    let result = cad.cut(solid, inner);
    const reach = (thickness + Math.max(1, thickness)) * (opening === "top" ? 1 : -1);
    for (const face of cavityFaces) {
      const punch = cad.extrude(face, 0, reach, 0);
      temporary.push(punch, result);
      result = cad.cut(result, punch);
    }
    result = singleSolid(cad, result);
    if (!isHollowResult(cad, result, sourceVolume)) {
      releaseAll(cad, [result]);
      throw new Error("The inward offset produced invalid geometry");
    }
    return result;
  } finally {
    releaseAll(cad, temporary);
  }
}

/**
 * Fallback for faceted bodies whose full inward offset fails, typically
 * because many faces meet in one vertex (the pole of a tessellated dome).
 * Hollows the body open through a flat face, then removes a slab of the wall
 * thickness from the cavity on that side, so a wall of the same size closes the
 * opening. Only used without free-form faces: on those, MakeThickSolid can
 * corrupt the kernel and booleans between coincident curved faces can trap.
 */
function closedByCappedShell(cad: OcctKernel, solid: ShapeHandle, thickness: number, side: Exclude<ShellOpening, "closed">, sourceVolume: number) {
  const temporary: ShapeHandle[] = [];
  try {
    const open = openShell(cad, solid, thickness, side);
    temporary.push(open);
    const cavity = cad.cut(solid, open);
    temporary.push(cavity);
    const bounds = cad.getBoundingBox(solid, false);
    const margin = Math.max(1, thickness);
    const slab = cad.makeBoxFromCorners(
      { x: bounds.xmin - margin, y: side === "top" ? bounds.ymax - thickness : bounds.ymin - margin, z: bounds.zmin - margin },
      { x: bounds.xmax + margin, y: side === "top" ? bounds.ymax + margin : bounds.ymin + thickness, z: bounds.zmax + margin },
    );
    temporary.push(slab);
    const closedCavity = cad.cut(cavity, slab);
    temporary.push(closedCavity);
    const result = singleSolid(cad, cad.cut(solid, closedCavity));
    if (!isHollowResult(cad, result, sourceVolume)) {
      releaseAll(cad, [result]);
      throw new Error("The capped shell produced invalid geometry");
    }
    return result;
  } finally {
    releaseAll(cad, temporary);
  }
}

/**
 * Hollows one closed solid with a constant inward wall thickness. "top" and
 * "bottom" remove the flat face(s) on that side so the result is an open
 * container; "closed" keeps the outer skin intact around an enclosed cavity.
 * The outer dimensions never change.
 */
export function shellCadSolid(cad: OcctKernel, solid: ShapeHandle, thickness: number, opening: ShellOpening): ShapeHandle {
  if (!Number.isFinite(thickness) || thickness <= 0) throw new Error("Wall thickness must be greater than zero");
  const sourceVolume = cad.getVolume(solid);
  if (opening !== "closed") {
    if (!hasOpenFace(cad, solid, opening)) {
      throw new Error(`This body has no flat ${opening} face to open. Choose another opening or Closed.`);
    }
    if (hasFreeFormFace(cad, solid)) {
      return openByOffsetPunch(cad, solid, thickness, opening, sourceVolume);
    }
    try {
      return openShell(cad, solid, thickness, opening);
    } catch (thickSolidError) {
      rethrowKernelFault(thickSolidError);
      // MakeThickSolid gives up on some bodies the offset handles, for example
      // a box with all edges filleted (spherical corner patches).
      try {
        return openByOffsetPunch(cad, solid, thickness, opening, sourceVolume);
      } catch (offsetError) {
        rethrowKernelFault(offsetError);
        throw thickSolidError;
      }
    }
  }
  try {
    return closedByOffset(cad, solid, thickness, sourceVolume);
  } catch (offsetError) {
    rethrowKernelFault(offsetError);
    if (hasFreeFormFace(cad, solid)) throw offsetError;
    for (const side of ["bottom", "top"] as const) {
      if (!hasOpenFace(cad, solid, side)) continue;
      try {
        return closedByCappedShell(cad, solid, thickness, side, sourceVolume);
      } catch (error) {
        rethrowKernelFault(error);
        // Try the other flat side before giving up.
      }
    }
    throw offsetError;
  }
}
