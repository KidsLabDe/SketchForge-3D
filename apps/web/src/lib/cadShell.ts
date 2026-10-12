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

/**
 * Hollows one closed solid with a constant inward wall thickness. "top" and
 * "bottom" remove the flat face(s) on that side so the result is an open
 * container; "closed" keeps the outer skin intact around an enclosed cavity.
 * The outer dimensions never change.
 */
export function shellCadSolid(cad: OcctKernel, solid: ShapeHandle, thickness: number, opening: ShellOpening): ShapeHandle {
  if (!Number.isFinite(thickness) || thickness <= 0) throw new Error("Wall thickness must be greater than zero");
  if (opening === "closed") {
    const inner = cad.offset(solid, -thickness, SHELL_TOLERANCE);
    try {
      const cut = cad.cut(solid, inner);
      const solids = cad.getSubShapes(cut, "solid");
      if (solids.length !== 1) {
        releaseAll(cad, solids);
        return cut;
      }
      cad.release(cut);
      return solids[0];
    } finally {
      releaseAll(cad, [inner]);
    }
  }
  const faces = shellOpenFaces(cad, solid, opening);
  if (faces.length === 0) {
    throw new Error(`This body has no flat ${opening} face to open. Choose another opening or Closed.`);
  }
  try {
    return cad.shell(solid, faces, thickness, SHELL_TOLERANCE);
  } finally {
    releaseAll(cad, faces);
  }
}
