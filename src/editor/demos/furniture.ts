import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import {
  buildFabricTextureSubgraph,
  buildMetalTextureSubgraph,
  buildWoodTextureSubgraph,
} from './furniture-textures.js';
import {
  buildBookSubgraph,
  buildCushionSubgraph,
  buildDrawerSubgraph,
  buildTaperedLegSubgraph,
  buildWoodPanelSubgraph,
} from './furniture-components.js';
import {
  buildBookshelfSubgraph,
  buildChairSubgraph,
  buildFilingCabinetSubgraph,
  buildSofaSubgraph,
  buildTableSubgraph,
} from './furniture-pieces.js';

// Furniture demo: a "showroom" arrangement of five pieces (chair,
// sofa, table, bookshelf, filing cabinet) on a wood-floor backing,
// with a back wall and a side wall to make the room read as enclosed.
//
// Layout (looking down at the floor, +X right, +Z toward camera):
//
//                 ┌───────── back wall ──────────┐
//   ┌──────────┐  │                              │
//   │ side wall│  │  bookshelf       fcabinet    │
//   │          │  │                              │
//   │          │  │       table                  │
//   │          │  │                              │
//   │          │  │   chair   sofa               │
//   └──────────┘  └──────────────────────────────┘
//                              ⌄
//                          camera
//
// World units are metres throughout.
export function createFurnitureDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const wood = buildWoodTextureSubgraph();
  const fabric = buildFabricTextureSubgraph();
  const metal = buildMetalTextureSubgraph();
  const leg = buildTaperedLegSubgraph();
  const cushion = buildCushionSubgraph();
  const panel = buildWoodPanelSubgraph();
  const drawer = buildDrawerSubgraph();
  const book = buildBookSubgraph();
  const chair = buildChairSubgraph();
  const table = buildTableSubgraph();
  const sofa = buildSofaSubgraph();
  const bookshelf = buildBookshelfSubgraph();
  const fileCabinet = buildFilingCabinetSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // === Floor ============================================================
  // 6×6m wood floor — large enough for the camera framing not to see
  // the edges in default orientation. Slight rotation on the wood-
  // texture seed so the grain runs visibly across the floor (vs. the
  // furniture sharing the same seed).
  const floorWood = addNode(g, 'subgraph/wood-texture', {
    position: { x: 0, y: 0 },
    inputValues: {
      seed: 0.83,
      color_dark: [0.32, 0.20, 0.10, 1],
      color_light: [0.55, 0.38, 0.20, 1],
    },
  });
  const floorMat = addNode(g, 'material/pbr', {
    position: { x: COL, y: 0 },
    inputValues: { roughness: 0.6, metallic: 0 },
  });
  const floorPanel = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 2, y: 0 },
    inputValues: { width: 6.0, depth: 6.0, thickness: 0.05 },
  });
  // Centre at y = -0.025 so the top surface sits at y=0 (the level
  // every furniture piece's base sits on).
  const floorLift = addNode(g, 'scene/transform', {
    position: { x: COL * 3, y: 0 },
    inputValues: { translate: [0, -0.025, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // === Walls ============================================================
  // Wall finish: solid-color cream. Walls are 3m tall; back wall
  // spans 6m wide at z=-3, side wall spans 6m deep at x=-3.
  const wallColor = addNode(g, 'tex/solid-color', {
    position: { x: 0, y: ROW * 2 },
    inputValues: { color: [0.88, 0.85, 0.78, 1], resolution: 4 },
  });
  const wallMat = addNode(g, 'material/pbr', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const backWall = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { width: 6.0, depth: 0.05, thickness: 3.0 },
  });
  // Back wall centred at z=-3 (so its inside face is at z=-2.975);
  // y=1.5 to sit on the floor with top at 3m.
  const backWallLift = addNode(g, 'scene/transform', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: { translate: [0, 1.5, -3.0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const sideWall = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { width: 0.05, depth: 6.0, thickness: 3.0 },
  });
  const sideWallLift = addNode(g, 'scene/transform', {
    position: { x: COL * 3, y: ROW * 3 },
    inputValues: { translate: [-3.0, 1.5, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // === Furniture ========================================================
  // Each piece is the subgraph reference + a transform that places
  // it on the floor in showroom position. Pieces are centred at the
  // origin in their own subgraph with base at y=0, so the X/Z
  // translation is the only placement parameter.
  const chairInst = addNode(g, 'subgraph/chair', {
    position: { x: COL * 5, y: 0 },
  });
  const chairPlace = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: 0 },
    // Front-left of the seating area.
    // Rotate the chair ~25° toward camera (radians, not degrees).
    inputValues: { translate: [-1.2, 0, 0.5], rotate: [0, (-65 * Math.PI) / 180, 0], scale: [1, 1, 1] },
  });

  const tableInst = addNode(g, 'subgraph/table', {
    position: { x: COL * 5, y: ROW * 1.5 },
  });
  const tablePlace = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: ROW * 1.5 },
    // Centre of the seating area, between chair and sofa.
    inputValues: { translate: [0.1, 0, 0.6], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  const sofaInst = addNode(g, 'subgraph/sofa', {
    position: { x: COL * 5, y: ROW * 3 },
  });
  const sofaPlace = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: ROW * 3 },
    // Behind the table, facing camera.
    inputValues: { translate: [0.5, 0, -0.7], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  const bookshelfInst = addNode(g, 'subgraph/bookshelf', {
    position: { x: COL * 5, y: ROW * 4.5 },
  });
  const bookshelfPlace = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: ROW * 4.5 },
    // Against the back wall, left of centre. z=-2.85 keeps the back
    // panel ~12 cm proud of the wall to avoid z-fight on the back.
    inputValues: { translate: [-1.6, 0, -2.75], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  const fileCabinetInst = addNode(g, 'subgraph/filing-cabinet', {
    position: { x: COL * 5, y: ROW * 6 },
  });
  const fileCabinetPlace = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: ROW * 6 },
    // Against the back wall, right of bookshelf.
    inputValues: { translate: [1.5, 0, -2.65], rotate: [0, -1.57, 0], scale: [1, 1, 1] },
  });

  // === Merge ============================================================
  const mergeAll = addNode(g, 'scene/merge', {
    position: { x: COL * 8, y: ROW * 3 },
    extraInputs: Array.from({ length: 10 }, (_, i) => ({
      name: `scene_${i}`,
      type: 'Scene' as const,
      optional: true,
    })),
  });

  // Output — derives lighting from sun direction; rest of the
  // params are output-node defaults.
  const output = addNode(g, 'core/output', {
    position: { x: COL * 10, y: ROW * 3 },
    inputValues: {
      light_direction: [0.45, 0.85, 0.55],
      light_color: [1, 0.96, 0.85, 1],
      light_intensity: 3,
      terrain_tint: [0.42, 0.38, 0.30, 1],
      ambient_intensity: 1.1,
      fog_density: 0,
      bloom_intensity: 0,
    },
  });

  // Floor wiring.
  addEdge(g, { node: floorWood.id, socket: 'basecolor' }, { node: floorMat.id, socket: 'basecolor' });
  addEdge(g, { node: floorWood.id, socket: 'normal' }, { node: floorMat.id, socket: 'normal' });
  addEdge(g, { node: floorMat.id, socket: 'material' }, { node: floorPanel.id, socket: 'material' });
  addEdge(g, { node: floorPanel.id, socket: 'scene' }, { node: floorLift.id, socket: 'scene' });

  // Walls.
  addEdge(g, { node: wallColor.id, socket: 'texture' }, { node: wallMat.id, socket: 'basecolor' });
  addEdge(g, { node: wallMat.id, socket: 'material' }, { node: backWall.id, socket: 'material' });
  addEdge(g, { node: wallMat.id, socket: 'material' }, { node: sideWall.id, socket: 'material' });
  addEdge(g, { node: backWall.id, socket: 'scene' }, { node: backWallLift.id, socket: 'scene' });
  addEdge(g, { node: sideWall.id, socket: 'scene' }, { node: sideWallLift.id, socket: 'scene' });

  // Furniture placement.
  addEdge(g, { node: chairInst.id, socket: 'scene' }, { node: chairPlace.id, socket: 'scene' });
  addEdge(g, { node: tableInst.id, socket: 'scene' }, { node: tablePlace.id, socket: 'scene' });
  addEdge(g, { node: sofaInst.id, socket: 'scene' }, { node: sofaPlace.id, socket: 'scene' });
  addEdge(g, { node: bookshelfInst.id, socket: 'scene' }, { node: bookshelfPlace.id, socket: 'scene' });
  addEdge(g, { node: fileCabinetInst.id, socket: 'scene' }, { node: fileCabinetPlace.id, socket: 'scene' });

  // Merge all.
  const allSources = [
    floorLift, backWallLift, sideWallLift,
    chairPlace, tablePlace, sofaPlace, bookshelfPlace, fileCabinetPlace,
  ];
  allSources.forEach((node, i) => {
    addEdge(g, { node: node.id, socket: 'scene' }, { node: mergeAll.id, socket: `scene_${i}` });
  });

  addEdge(g, { node: mergeAll.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  // Cameras. Main: angled overview of the showroom. Each piece-
  // subgraph gets a close framing centred on its origin so drilling
  // in shows the piece face-on. Texture and component subgraphs get
  // tight framings appropriate to the preview-tile flat or
  // sphere/plane shape.
  const cameras: Record<string, CameraState> = {
    main: {
      yaw: 0.55,
      pitch: 0.25,
      distance: 6.5,
      target: [0, 0.8, -0.5],
    },
    chair: { yaw: 0.5, pitch: 0.20, distance: 1.8, target: [0, 0.45, 0] },
    table: { yaw: 0.5, pitch: 0.20, distance: 1.8, target: [0, 0.30, 0] },
    sofa: { yaw: 0.5, pitch: 0.18, distance: 3.2, target: [0, 0.55, 0] },
    bookshelf: { yaw: 0.4, pitch: 0.15, distance: 2.8, target: [0, 0.9, 0] },
    'filing-cabinet': { yaw: 0.5, pitch: 0.20, distance: 2.3, target: [0, 0.65, 0] },
    'tapered-leg': { yaw: 0.3, pitch: 0.25, distance: 0.9, target: [0, 0.25, 0] },
    cushion: { yaw: 0.3, pitch: 0.30, distance: 1.3, target: [0, 0, 0] },
    'wood-panel': { yaw: 0.3, pitch: 0.40, distance: 2.0, target: [0, 0, 0] },
    drawer: { yaw: 0.3, pitch: 0.25, distance: 1.4, target: [0, 0, 0] },
    book: { yaw: 0.3, pitch: 0.25, distance: 0.6, target: [0, 0, 0] },
    'wood-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
    'fabric-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
    'metal-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
  };

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [
      wood, fabric, metal,
      leg, cushion, panel, drawer, book,
      chair, table, sofa, bookshelf, fileCabinet,
    ],
    cameras,
  };
}
