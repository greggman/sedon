export interface SocketType {
  id: string;
  color: string;
  description: string;
}

export interface TypeRegistry {
  register(type: SocketType): void;
  allowConversion(from: string, to: string): void;
  get(id: string): SocketType | undefined;
  has(id: string): boolean;
  list(): SocketType[];
  isCompatible(from: string, to: string): boolean;
}

export function createTypeRegistry(): TypeRegistry {
  const types = new Map<string, SocketType>();
  const conversions = new Set<string>();
  const key = (from: string, to: string) => `${from}->${to}`;

  return {
    register(type) {
      if (types.has(type.id)) {
        throw new Error(`type already registered: ${type.id}`);
      }
      types.set(type.id, type);
    },
    allowConversion(from, to) {
      conversions.add(key(from, to));
    },
    get(id) {
      return types.get(id);
    },
    has(id) {
      return types.has(id);
    },
    list() {
      return [...types.values()];
    },
    isCompatible(from, to) {
      return from === to || conversions.has(key(from, to));
    },
  };
}

export const CORE_TYPES: readonly SocketType[] = [
  { id: 'Float', color: '#ff9800', description: 'scalar' },
  { id: 'Int', color: '#ffeb3b', description: 'integer scalar' },
  { id: 'Bool', color: '#ffffff', description: 'boolean' },
  { id: 'String', color: '#bdbdbd', description: 'text string (URL, label, etc.)' },
  { id: 'Vec2', color: '#80deea', description: '2-component vector' },
  { id: 'Vec2i', color: '#4dd0e1', description: '2-component integer vector' },
  { id: 'Vec3', color: '#42a5f5', description: '3-component vector' },
  { id: 'Vec4', color: '#1565c0', description: '4-component vector' },
  { id: 'Quaternion', color: '#5e35b1', description: 'unit quaternion (rotation)' },
  { id: 'Color', color: '#9c27b0', description: 'RGBA color' },
  { id: 'Texture2D', color: '#4caf50', description: 'GPU 2D image' },
  { id: 'Geometry', color: '#e53935', description: 'mesh: positions, normals, uvs, indices' },
  { id: 'Material', color: '#ec407a', description: 'bundle of textures + scalar params' },
  { id: 'Scene', color: '#0288d1', description: 'a renderable scene: list of (geometry, material) entities' },
  { id: 'PointCloud', color: '#9e9e9e', description: 'unstructured points with optional surface normals' },
  { id: 'Vec3Cloud', color: '#7986cb', description: 'per-point Vec3 attribute, paired with a PointCloud' },
  { id: 'FloatCloud', color: '#ffb74d', description: 'per-point Float attribute, paired with a PointCloud' },
  { id: 'BranchGraph', color: '#8d6e63', description: 'tree/plant branch skeleton: graph of branch curves with per-vertex radius' },
  { id: 'Lighting', color: '#fff176', description: 'scene-level sun + ambient lighting params' },
  { id: 'TerrainLayer', color: '#bf7c4d', description: 'one layer of a multi-layer terrain material (albedo + optional normal/height/roughness)' },
  { id: 'Path', color: '#a1887f', description: 'polyline through world space (road, river, …)' },
  { id: 'Polygon', color: '#26a69a', description: '2D polygon on the world XZ plane (closed outer ring + optional inner ring "holes" for canals, parks, lakes)' },
];

export const CORE_CONVERSIONS: readonly [string, string][] = [
  ['Int', 'Float'],
  ['Float', 'Vec2'],
  ['Float', 'Vec3'],
  ['Float', 'Vec4'],
  ['Color', 'Vec4'],
  ['Vec4', 'Color'],
  // Color → Texture2D: a flat colour wired into a texture socket is
  // auto-promoted to a 1×1 texture at eval time (see evaluate.ts's
  // input-resolution loop + getColorTexture in resources.ts). Lets
  // the user skip the boilerplate `core/solid-color` node for the
  // common "this material slot should just be this colour" case.
  // Same machinery powers the inline color picker on unwired
  // Texture2D inputs whose InputDef declares an `[r,g,b,a]` default.
  ['Color', 'Texture2D'],
  // Scalar-to-cloud broadcasting. The for-each-point node mirrors its
  // body subgraph's Float / Vec3 inputs as `*Cloud` sockets so each
  // iteration can read a per-point value, but a constant scalar should
  // still wire cleanly ("every iteration uses this colour / scale /
  // material"). These conversions make a plain Float wire connect to a
  // FloatCloud socket and broadcast at eval time. Compositions cascade:
  // Int → Float → FloatCloud lets an Int source feed a Float-broadcast
  // cloud socket too.
  ['Float', 'FloatCloud'],
  ['Vec3', 'Vec3Cloud'],
];

export function createCoreTypeRegistry(): TypeRegistry {
  const r = createTypeRegistry();
  for (const t of CORE_TYPES) r.register(t);
  for (const [from, to] of CORE_CONVERSIONS) r.allowConversion(from, to);
  return r;
}
