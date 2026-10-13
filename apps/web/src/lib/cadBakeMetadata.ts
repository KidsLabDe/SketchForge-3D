import * as THREE from "three";
import type { WorkplaneShape } from "@/types/sketchforge";
import type { CadModifierBoxPrimitive, CadModifierHalfSpherePrimitive } from "@/lib/cadModifierTypes";
import { mirrorSign, resizedImportedCoordinates, shapeDepth, shapeWidth } from "@/lib/workplaneShapes";

export type BakedCadMetadataFrame = {
  centerX: number;
  minY: number;
  centerZ: number;
  width: number;
  depth: number;
  height: number;
  yawDegrees: number;
};

export function cadTransformToMatrix(transform: number[] | undefined) {
  if (!transform || transform.length !== 12 || !transform.every(Number.isFinite)) {
    return new THREE.Matrix4();
  }

  return new THREE.Matrix4().set(
    transform[0], transform[1], transform[2], transform[3],
    transform[4], transform[5], transform[6], transform[7],
    transform[8], transform[9], transform[10], transform[11],
    0, 0, 0, 1,
  );
}

export function cadTransformFromMatrix(matrix: THREE.Matrix4) {
  const elements = matrix.elements;
  return [
    elements[0], elements[4], elements[8], elements[12],
    elements[1], elements[5], elements[9], elements[13],
    elements[2], elements[6], elements[10], elements[14],
  ];
}

function isIdentityCadTransform(transform: number[]) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  return transform.every((value, index) => Math.abs(value - identity[index]) < 1e-9);
}

function allFinitePositive(values: number[]) {
  return values.every((value) => Number.isFinite(value) && value > 0);
}

export function cadModifierPrimitiveForAnalyticBox(shape: WorkplaneShape): CadModifierBoxPrimitive | null {
  if (shape.kind !== "box" || shape.importedMesh || shape.groupedShapes?.length) {
    return null;
  }

  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  if (!allFinitePositive([width, depth, height])) {
    return null;
  }

  const centerY = height / 2;
  const matrix = new THREE.Matrix4()
    .makeTranslation(shape.x, (shape.elevation ?? 0) + centerY, shape.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(shape.rotationX ?? 0),
        THREE.MathUtils.degToRad(shape.rotation ?? 0),
        THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
        "XYZ",
      ),
    ))
    .multiply(new THREE.Matrix4().makeScale(mirrorSign(shape.mirrorX), mirrorSign(shape.mirrorY), mirrorSign(shape.mirrorZ)))
    .multiply(new THREE.Matrix4().makeTranslation(0, -centerY, 0));

  const transform = cadTransformFromMatrix(matrix);
  return {
    kind: "box",
    width,
    depth,
    height,
    transform: isIdentityCadTransform(transform) ? undefined : transform,
  };
}

/**
 * Exact half sphere for shapes whose footprint is circular. Elliptical
 * footprints (width != depth) have no exact OpenCascade primitive here and
 * keep using the tessellated mesh.
 */
export function cadModifierPrimitiveForAnalyticHalfSphere(shape: WorkplaneShape): CadModifierHalfSpherePrimitive | null {
  if (shape.kind !== "halfSphere" || shape.importedMesh || shape.groupedShapes?.length) {
    return null;
  }

  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  if (!allFinitePositive([width, depth, height]) || Math.abs(width - depth) > 1e-6 * Math.max(width, depth)) {
    return null;
  }

  const centerY = height / 2;
  const matrix = new THREE.Matrix4()
    .makeTranslation(shape.x, (shape.elevation ?? 0) + centerY, shape.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(shape.rotationX ?? 0),
        THREE.MathUtils.degToRad(shape.rotation ?? 0),
        THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
        "XYZ",
      ),
    ))
    // The body is symmetric about its Y axis, so mirroring X or Z changes
    // nothing and mirroring Y equals a half turn about X. Keeping the
    // transform rigid preserves the exact sphere surface in OpenCascade, which
    // a general (mirroring) transform would convert to a B-spline.
    .multiply(new THREE.Matrix4().makeRotationX(shape.mirrorY ? Math.PI : 0))
    .multiply(new THREE.Matrix4().makeTranslation(0, -centerY, 0));

  const transform = cadTransformFromMatrix(matrix);
  return {
    kind: "halfSphere",
    radius: width / 2,
    height,
    transform: isIdentityCadTransform(transform) ? undefined : transform,
  };
}

/** Maps a baked primitive's local frame onto the shape's current world placement. */
function bakedPrimitiveMatrix(shape: WorkplaneShape, kind: NonNullable<WorkplaneShape["cadPrimitiveFrame"]>["kind"]) {
  const primitive = shape.cadPrimitiveFrame;
  const frame = primitive?.frame;
  if (!primitive || primitive.kind !== kind || !frame) {
    return null;
  }

  if (!allFinitePositive([
    primitive.width,
    primitive.depth,
    primitive.height,
    frame.width,
    frame.depth,
    frame.height,
    shapeWidth(shape),
    shapeDepth(shape),
    shape.height,
  ])) {
    return null;
  }

  const centerY = shape.height / 2;
  const scaleX = shapeWidth(shape) / frame.width;
  const scaleY = shape.height / frame.height;
  const scaleZ = shapeDepth(shape) / frame.depth;
  const mirrorX = mirrorSign(shape.mirrorX);
  const mirrorY = mirrorSign(shape.mirrorY);
  const mirrorZ = mirrorSign(shape.mirrorZ);
  return new THREE.Matrix4()
    .makeTranslation(shape.x, (shape.elevation ?? 0) + centerY, shape.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(shape.rotationX ?? 0),
        THREE.MathUtils.degToRad(shape.rotation ?? 0),
        THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
        "XYZ",
      ),
    ))
    .multiply(new THREE.Matrix4().makeTranslation(0, -mirrorY * centerY, 0))
    .multiply(new THREE.Matrix4().makeScale(mirrorX * scaleX, mirrorY * scaleY, mirrorZ * scaleZ))
    .multiply(new THREE.Matrix4().makeTranslation(-frame.x, -frame.elevation, -frame.z))
    .multiply(cadTransformToMatrix(frame.sourceTransform));
}

export function cadModifierPrimitiveForBakedShape(shape: WorkplaneShape): CadModifierBoxPrimitive | null {
  const primitive = shape.cadPrimitiveFrame;
  const matrix = bakedPrimitiveMatrix(shape, "box");
  if (!primitive || !matrix) {
    return null;
  }

  const transform = cadTransformFromMatrix(matrix);
  return {
    kind: "box",
    width: primitive.width,
    depth: primitive.depth,
    height: primitive.height,
    transform: isIdentityCadTransform(transform) ? undefined : transform,
  };
}

/**
 * Splits a half sphere placement into exact dimensions and a rigid transform,
 * which keeps the sphere surface analytic in OpenCascade. Works when the local
 * axes stay perpendicular and the base stays circular (rotations, mirrors, and
 * resizes along the dome's own axes); returns null otherwise.
 */
function rigidHalfSpherePrimitive(radius: number, height: number, matrix: THREE.Matrix4): CadModifierHalfSpherePrimitive | null {
  const axisX = new THREE.Vector3();
  const axisY = new THREE.Vector3();
  const axisZ = new THREE.Vector3();
  matrix.extractBasis(axisX, axisY, axisZ);
  const lengthX = axisX.length();
  const lengthY = axisY.length();
  const lengthZ = axisZ.length();
  if (!allFinitePositive([lengthX, lengthY, lengthZ])) return null;
  const tolerance = 1e-6;
  if (Math.abs(lengthX - lengthZ) > tolerance * Math.max(lengthX, lengthZ)) return null;
  axisX.divideScalar(lengthX);
  axisY.divideScalar(lengthY);
  axisZ.divideScalar(lengthZ);
  if (Math.abs(axisX.dot(axisY)) > tolerance || Math.abs(axisY.dot(axisZ)) > tolerance || Math.abs(axisX.dot(axisZ)) > tolerance) return null;
  // Mirroring across the dome's own axis changes nothing, so drop it to keep
  // the transform a proper rotation.
  if (axisX.clone().cross(axisY).dot(axisZ) < 0) axisX.negate();
  const origin = new THREE.Vector3().setFromMatrixPosition(matrix);
  const rigid = new THREE.Matrix4().makeBasis(axisX, axisY, axisZ).setPosition(origin);
  const transform = cadTransformFromMatrix(rigid);
  return {
    kind: "halfSphere",
    radius: radius * lengthX,
    height: height * lengthY,
    transform: isIdentityCadTransform(transform) ? undefined : transform,
  };
}

/** Half sphere whose rotation or mirror was baked into a mesh. */
export function cadModifierPrimitiveForBakedHalfSphere(shape: WorkplaneShape): CadModifierHalfSpherePrimitive | null {
  const primitive = shape.cadPrimitiveFrame;
  const matrix = bakedPrimitiveMatrix(shape, "halfSphere");
  if (!primitive || !matrix || Math.abs(primitive.width - primitive.depth) > 1e-6 * Math.max(primitive.width, primitive.depth)) {
    return null;
  }
  return rigidHalfSpherePrimitive(primitive.width / 2, primitive.height, matrix);
}

/**
 * Exact half sphere for Hollow, from the live primitive or from a mesh that
 * still records it. Shapes whose geometry was replaced by a CAD feature keep
 * the faceted path.
 */
export function cadModifierHalfSpherePrimitiveForShape(shape: WorkplaneShape): CadModifierHalfSpherePrimitive | null {
  if (shape.cadBrep || shape.edgeTreatments?.length) return null;
  return cadModifierPrimitiveForAnalyticHalfSphere(shape) ?? cadModifierPrimitiveForBakedHalfSphere(shape);
}

export function bakedBoxSelectionFrame(shape: WorkplaneShape) {
  const primitive = cadModifierPrimitiveForBakedShape(shape);
  if (!primitive || primitive.kind !== "box") {
    return null;
  }
  const matrix = cadTransformToMatrix(primitive.transform);
  const xVector = new THREE.Vector3(primitive.width, 0, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix));
  const yVector = new THREE.Vector3(0, primitive.height, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix));
  const zVector = new THREE.Vector3(0, 0, primitive.depth).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix));
  const width = xVector.length();
  const height = yVector.length();
  const depth = zVector.length();
  if (![width, height, depth].every((value) => Number.isFinite(value) && value > 0.001)) {
    return null;
  }

  const xAxis = xVector.normalize();
  const yAxis = yVector.normalize();
  const zAxis = zVector.normalize();
  const center = new THREE.Vector3(0, primitive.height / 2, 0).applyMatrix4(matrix);
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return {
    center,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
    xAxis,
    yAxis,
    zAxis,
    width,
    height,
    depth,
  };
}

export function cadBrepTransformForShape(shape: WorkplaneShape) {
  const frame = shape.cadBrepFrame;
  if (!frame) return undefined;
  const oldCenter = new THREE.Vector3(frame.x, frame.elevation + frame.height / 2, frame.z);
  const currentCenter = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(shape.rotationX ?? 0),
    THREE.MathUtils.degToRad(shape.rotation ?? 0),
    THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
    "XYZ",
  ));
  const scale = new THREE.Vector3(
    shapeWidth(shape) / Math.max(0.001, frame.width) * mirrorSign(shape.mirrorX),
    shape.height / Math.max(0.001, frame.height) * mirrorSign(shape.mirrorY),
    shapeDepth(shape) / Math.max(0.001, frame.depth) * mirrorSign(shape.mirrorZ),
  );
  const matrix = new THREE.Matrix4()
    .compose(currentCenter, rotation, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-oldCenter.x, -oldCenter.y, -oldCenter.z))
    .multiply(cadTransformToMatrix(frame.sourceTransform));
  const result = cadTransformFromMatrix(matrix);
  return isIdentityCadTransform(result) ? undefined : result;
}

function bakeCadDisplayEdgesForShape(shape: WorkplaneShape, frame: BakedCadMetadataFrame) {
  if (!shape.cadDisplayEdges?.length) {
    return undefined;
  }

  const centerY = shape.height / 2;
  const matrix = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(frame.yawDegrees),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
  const xMirror = mirrorSign(shape.mirrorX);
  const yMirror = mirrorSign(shape.mirrorY);
  const zMirror = mirrorSign(shape.mirrorZ);
  const bakedEdges = shape.cadDisplayEdges.flatMap((edge) => {
    if (edge.points.length < 6) {
      return [];
    }

    const resizedPoints = resizedImportedCoordinates(shape, edge.points);
    const points: number[] = [];
    for (let index = 0; index + 2 < resizedPoints.length; index += 3) {
      const vertex = new THREE.Vector3(
        resizedPoints[index] * xMirror,
        (resizedPoints[index + 1] - centerY) * yMirror,
        resizedPoints[index + 2] * zMirror,
      ).applyMatrix4(matrix);
      const x = vertex.x + shape.x - frame.centerX;
      const y = vertex.y + (shape.elevation ?? 0) + centerY - frame.minY;
      const z = vertex.z + shape.z - frame.centerZ;
      if ([x, y, z].every(Number.isFinite)) {
        points.push(x, y, z);
      }
    }

    return points.length >= 6 ? [{ points }] : [];
  });

  return bakedEdges.length > 0 ? bakedEdges : undefined;
}

function bakeCadPrimitiveFrameForShapeTransform(shape: WorkplaneShape, frame: BakedCadMetadataFrame): WorkplaneShape["cadPrimitiveFrame"] {
  const box = cadModifierPrimitiveForBakedShape(shape) ?? cadModifierPrimitiveForAnalyticBox(shape);
  const halfSphere = box ? null : cadModifierPrimitiveForBakedHalfSphere(shape) ?? cadModifierPrimitiveForAnalyticHalfSphere(shape);
  const primitive = box
    ? { kind: "box" as const, width: box.width, depth: box.depth, height: box.height, transform: box.transform }
    : halfSphere
      ? { kind: "halfSphere" as const, width: halfSphere.radius * 2, depth: halfSphere.radius * 2, height: halfSphere.height, transform: halfSphere.transform }
      : null;
  if (!primitive) {
    return undefined;
  }

  return {
    kind: primitive.kind,
    width: primitive.width,
    depth: primitive.depth,
    height: primitive.height,
    frame: {
      x: frame.centerX,
      z: frame.centerZ,
      elevation: frame.minY,
      width: frame.width,
      depth: frame.depth,
      height: frame.height,
      ...(primitive.transform ? { sourceTransform: primitive.transform } : {}),
    },
  };
}

export function bakeCadMetadataForShapeTransform(shape: WorkplaneShape, frame: BakedCadMetadataFrame) {
  const cadDisplayEdges = bakeCadDisplayEdgesForShape(shape, frame);
  const sourceTransform = cadBrepTransformForShape(shape);
  const cadPrimitiveFrame = bakeCadPrimitiveFrameForShapeTransform(shape, frame);
  const cadBrepFrame = shape.cadBrep && shape.cadBrepFrame
    ? {
        x: frame.centerX,
        z: frame.centerZ,
        elevation: frame.minY,
        width: frame.width,
        depth: frame.depth,
        height: frame.height,
        ...(sourceTransform ? { sourceTransform } : {}),
      }
    : undefined;
  return {
    cadDisplayEdges,
    cadDisplayEdgesVersion: cadDisplayEdges ? (2 as const) : undefined,
    cadBrep: cadBrepFrame ? shape.cadBrep : undefined,
    cadBrepFrame,
    cadPrimitiveFrame,
  };
}
