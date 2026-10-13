import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type { ShellOpening } from "@/types/sketchforge";

const SHELL_TOLERANCE = 1e-3;
const OPEN_FACE_NORMAL_MIN = 0.999;
const OPEN_FACE_PLANE_TOLERANCE = 1e-4;

export const SHELL_OPENINGS: readonly ShellOpening[] = ["top", "bottom", "closed"];

export function isShellOpening(value: unknown): value is ShellOpening {
  return typeof value === "string" && (SHELL_OPENINGS as readonly string[]).includes(value);
}

/** Largest wall thickness that still leaves a cavity inside a body with this bounding box. */
export function maxShellThickness(width: number, depth: number, height: number, opening: ShellOpening) {
  const horizontal = Math.min(width, depth) / 2;
  const vertical = opening === "closed" ? height / 2 : height;
  return Math.max(0, Math.min(horizontal, vertical));
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
    } catch {
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

function isHollowResult(cad: OcctKernel, shape: ShapeHandle, sourceVolume: number) {
  try {
    if (!cad.isValid(shape)) return false;
    const volume = cad.getVolume(shape);
    return volume > 0 && volume < sourceVolume * (1 - 1e-6);
  } catch {
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
  const inner = cad.offset(solid, -thickness, SHELL_TOLERANCE);
  try {
    const result = singleSolid(cad, cad.cut(solid, inner));
    if (!isHollowResult(cad, result, sourceVolume)) {
      releaseAll(cad, [result]);
      throw new Error("The inward offset produced invalid geometry");
    }
    return result;
  } finally {
    releaseAll(cad, [inner]);
  }
}

/**
 * Fallback for bodies whose full inward offset fails, typically faceted meshes
 * where many faces meet in one vertex (the pole of a half sphere). Hollows the
 * body through a flat face, then removes a slab of the wall thickness from the
 * cavity on that side so the opening is closed by a wall of the same size.
 */
function closedByCappedShell(cad: OcctKernel, solid: ShapeHandle, thickness: number, opening: Exclude<ShellOpening, "closed">, sourceVolume: number) {
  const temporary: ShapeHandle[] = [];
  try {
    const open = openShell(cad, solid, thickness, opening);
    temporary.push(open);
    const cavity = cad.cut(solid, open);
    temporary.push(cavity);
    const bounds = cad.getBoundingBox(solid, false);
    const margin = Math.max(1, thickness);
    const slab = cad.makeBoxFromCorners(
      { x: bounds.xmin - margin, y: opening === "top" ? bounds.ymax - thickness : bounds.ymin - margin, z: bounds.zmin - margin },
      { x: bounds.xmax + margin, y: opening === "top" ? bounds.ymax + margin : bounds.ymin + thickness, z: bounds.zmax + margin },
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
  if (opening !== "closed") return openShell(cad, solid, thickness, opening);
  const sourceVolume = cad.getVolume(solid);
  try {
    return closedByOffset(cad, solid, thickness, sourceVolume);
  } catch (offsetError) {
    for (const fallback of ["bottom", "top"] as const) {
      if (!hasOpenFace(cad, solid, fallback)) continue;
      try {
        return closedByCappedShell(cad, solid, thickness, fallback, sourceVolume);
      } catch {
        // Try the other flat side before giving up.
      }
    }
    throw offsetError;
  }
}
