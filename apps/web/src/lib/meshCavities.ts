type Point = readonly [number, number, number];
type Face = readonly [number, number, number];

type ComponentInfo = {
  faces: number[];
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
};

function componentInfo(vertices: readonly Point[], faces: readonly Face[], faceIndices: number[]): ComponentInfo {
  let volume = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  faceIndices.forEach((faceIndex) => {
    const face = faces[faceIndex];
    if (!face) return;
    const [a, b, c] = face.map((index) => vertices[index]);
    if (!a || !b || !c) return;
    volume += (
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
    [a, b, c].forEach((point) => {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    });
  });
  return { faces: faceIndices, volume, min, max };
}

function boundsContain(outer: ComponentInfo, inner: ComponentInfo) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (inner.min[axis] < outer.min[axis] || inner.max[axis] > outer.max[axis]) return false;
  }
  return true;
}

function boundsVolume(info: ComponentInfo) {
  return (info.max[0] - info.min[0]) * (info.max[1] - info.min[1]) * (info.max[2] - info.min[2]);
}

/**
 * Merges the inward-facing skin of an enclosed cavity into the body that
 * contains it. A hollow solid tessellates into two disconnected face sets (the
 * outer skin and the cavity skin); the cavity winds the opposite way, so its
 * signed volume has the opposite sign of the outer bodies. Without this step
 * the cavity would count as a separate printable part.
 */
export function mergeEnclosedCavityComponents(vertices: readonly Point[], faces: readonly Face[], components: number[][]): number[][] {
  if (components.length <= 1) return components;
  const infos = components.map((component) => componentInfo(vertices, faces, component));
  const dominant = infos.reduce((best, info) => Math.abs(info.volume) > Math.abs(best.volume) ? info : best, infos[0]);
  const bodySign = Math.sign(dominant.volume);
  if (bodySign === 0) return components;
  const bodies = infos.filter((info) => Math.sign(info.volume) === bodySign);
  const merged = new Map<ComponentInfo, number[]>(bodies.map((body) => [body, [...body.faces]]));
  const result: number[][] = [];
  infos.forEach((info) => {
    if (merged.has(info)) return;
    const container = bodies
      .filter((body) => boundsContain(body, info))
      .sort((a, b) => boundsVolume(a) - boundsVolume(b))[0];
    if (container) merged.get(container)?.push(...info.faces);
    else result.push(info.faces);
  });
  return [...merged.values(), ...result];
}
