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
  { id: 'Vec2', color: '#80deea', description: '2-component vector' },
  { id: 'Vec2i', color: '#4dd0e1', description: '2-component integer vector' },
  { id: 'Vec3', color: '#42a5f5', description: '3-component vector' },
  { id: 'Vec4', color: '#1565c0', description: '4-component vector' },
  { id: 'Quaternion', color: '#5e35b1', description: 'unit quaternion (rotation)' },
  { id: 'Color', color: '#9c27b0', description: 'RGBA color' },
  { id: 'Texture2D', color: '#4caf50', description: 'GPU 2D image' },
  { id: 'Geometry', color: '#e53935', description: 'mesh: positions, normals, uvs, indices' },
  { id: 'Material', color: '#ec407a', description: 'bundle of textures + scalar params' },
  { id: 'PointCloud', color: '#9e9e9e', description: 'unstructured points with optional surface normals' },
  { id: 'Heightfield', color: '#827717', description: '2D scalar field with world bounds + height range' },
];

export const CORE_CONVERSIONS: readonly [string, string][] = [
  ['Int', 'Float'],
  ['Float', 'Vec2'],
  ['Float', 'Vec3'],
  ['Float', 'Vec4'],
  ['Color', 'Vec4'],
  ['Vec4', 'Color'],
];

export function createCoreTypeRegistry(): TypeRegistry {
  const r = createTypeRegistry();
  for (const t of CORE_TYPES) r.register(t);
  for (const [from, to] of CORE_CONVERSIONS) r.allowConversion(from, to);
  return r;
}
